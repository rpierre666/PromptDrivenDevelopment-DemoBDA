# Verification Aggregator Implementation

This document provides the implementation for the Verification Aggregator component of the French Official Documents Processing System. This component is responsible for combining the results from document processing and facial verification to determine the overall verification status of customer documents.

## 1. Component Overview

The Verification Aggregator is responsible for:
- Aggregating results from document processing and facial verification
- Applying business rules to determine the overall verification status
- Coordinating post-processing activities (reporting, database updates, document storage)
- Managing the workflow for multi-document verification sessions
- Handling verification outcomes based on configurable business policies
- Emitting events for downstream processes

## 2. Architecture Design

### 2.1 Component Architecture

The Verification Aggregator is implemented as an AWS Lambda function that processes events from document validation and facial verification services. It serves as a central coordination point for determining the overall status of a verification session.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Verification      │────▶│ Business Rules    │────▶│ Status          │
│ Event Bus       │     │ Aggregator Lambda │     │ Engine            │     │ Determination   │
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ DynamoDB     │                                    │ EventBridge      │
                        │ Session      │                                    │ Downstream       │
                        │ Status       │                                    │ Events           │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Document Validation Service
   - EventBridge events from Facial Verification Service
   - Session status and metadata

2. **Output**:
   - Verification session status stored in DynamoDB
   - Events for downstream services (Report Generator, Database Updater, Storage Manager)
   - Notification events for client applications

## 3. Implementation

### 3.1 AWS Lambda Function

```python
import json
import os
import boto3
import uuid
from datetime import datetime
import logging
from enum import Enum
from typing import Dict, List, Any, Optional

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
session_table = dynamodb.Table(os.environ['SESSION_TABLE_NAME'])
validation_table = dynamodb.Table(os.environ['VALIDATION_TABLE_NAME'])
verification_table = dynamodb.Table(os.environ['VERIFICATION_TABLE_NAME'])
eventbridge = boto3.client('events')
sqs = boto3.client('sqs')

# Environment variables
event_bus_name = os.environ['EVENT_BUS_NAME']
manual_review_queue_url = os.environ.get('MANUAL_REVIEW_QUEUE_URL')

# Document type enums
class DocumentType(str, Enum):
    PASSPORT = "PASSPORT"
    NATIONAL_ID = "NATIONAL_ID"
    DRIVERS_LICENSE = "DRIVERS_LICENSE"
    VEHICLE_REGISTRATION = "VEHICLE_REGISTRATION"

# Verification status enums
class VerificationStatus(str, Enum):
    PENDING = "PENDING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    MANUAL_REVIEW = "MANUAL_REVIEW"

def lambda_handler(event, context):
    """
    Lambda function that aggregates validation and verification results
    to determine overall verification status
    
    Parameters:
    - event: EventBridge event from document validation or facial verification
    - context: Lambda context
    
    Returns:
    - Aggregated verification status and next steps
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Determine event type
        detail_type = event.get('detail-type', '')
        
        # Extract session ID from event
        session_id = event.get('detail', {}).get('sessionId')
        
        if not session_id:
            logger.error("No session ID found in event")
            return {
                'statusCode': 400,
                'error': "No session ID found in event"
            }

        # Process based on event type
        if detail_type == 'DocumentValidationCompleted':
            document_type = event.get('detail', {}).get('documentType')
            validation_status = event.get('detail', {}).get('validationStatus')
            
            # Update session with document validation result
            update_document_validation_status(session_id, document_type, validation_status)
            
        elif detail_type == 'FacialVerificationCompleted':
            document_type = event.get('detail', {}).get('documentType')
            verification_status = event.get('detail', {}).get('verificationStatus')
            
            # Update session with facial verification result
            update_facial_verification_status(session_id, document_type, verification_status)
        
        # Check if all required verifications are complete
        session_status = get_session_status(session_id)
        
        # If session is complete, determine the overall verification status
        if is_session_complete(session_status):
            overall_status = determine_overall_status(session_id, session_status)
            
            # Update session with overall status
            update_session_overall_status(session_id, overall_status)
            
            # Trigger downstream processes
            trigger_post_processing(session_id, overall_status)
            
            return {
                'statusCode': 200,
                'sessionId': session_id,
                'overallStatus': overall_status,
                'message': f"Verification session {session_id} is complete with status {overall_status}"
            }
        else:
            return {
                'statusCode': 200,
                'sessionId': session_id,
                'message': f"Verification session {session_id} is still in progress"
            }
            
    except Exception as e:
        logger.error(f"Error in verification aggregation: {str(e)}")
        
        # Store error in DynamoDB for tracking
        if 'session_id' in locals():
            store_aggregation_error(session_id, str(e))
        
        # Emit error event
        if 'session_id' in locals():
            emit_error_event(session_id, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_session_status(session_id: str) -> Dict:
    """
    Retrieve current session status from DynamoDB
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Dictionary containing session status
    """
    try:
        response = session_table.get_item(
            Key={
                'sessionId': session_id
            }
        )
        
        if 'Item' not in response:
            # Create new session if it doesn't exist
            default_status = create_default_session(session_id)
            return default_status
        
        return response['Item']
    
    except Exception as e:
        logger.error(f"Error retrieving session status: {str(e)}")
        raise

def create_default_session(session_id: str) -> Dict:
    """Create a default session entry if one doesn't exist"""
    timestamp = datetime.now().isoformat()
    
    default_status = {
        'sessionId': session_id,
        'createdAt': timestamp,
        'updatedAt': timestamp,
        'status': VerificationStatus.PENDING.value,
        'documentStatus': {
            DocumentType.PASSPORT.value: VerificationStatus.PENDING.value,
            DocumentType.NATIONAL_ID.value: VerificationStatus.PENDING.value,
            DocumentType.DRIVERS_LICENSE.value: VerificationStatus.PENDING.value,
            DocumentType.VEHICLE_REGISTRATION.value: VerificationStatus.PENDING.value
        },
        'facialVerificationStatus': {
            DocumentType.PASSPORT.value: VerificationStatus.PENDING.value,
            DocumentType.NATIONAL_ID.value: VerificationStatus.PENDING.value,
            DocumentType.DRIVERS_LICENSE.value: VerificationStatus.PENDING.value
        },
        'requiredDocuments': [
            # One of these is required (Passport OR National ID)
            DocumentType.PASSPORT.value,
            DocumentType.NATIONAL_ID.value,
            # These two are always required
            DocumentType.DRIVERS_LICENSE.value,
            DocumentType.VEHICLE_REGISTRATION.value
        ]
    }
    
    try:
        session_table.put_item(Item=default_status)
        return default_status
    except Exception as e:
        logger.error(f"Error creating default session: {str(e)}")
        raise

def update_document_validation_status(session_id: str, document_type: str, validation_status: str) -> None:
    """
    Update session with document validation results
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document being validated
    - validation_status: Validation status result
    """
    timestamp = datetime.now().isoformat()
    
    try:
        session_table.update_item(
            Key={
                'sessionId': session_id
            },
            UpdateExpression="SET documentStatus.#docType = :status, updatedAt = :timestamp",
            ExpressionAttributeNames={
                '#docType': document_type
            },
            ExpressionAttributeValues={
                ':status': validation_status,
                ':timestamp': timestamp
            }
        )
    except Exception as e:
        logger.error(f"Error updating document validation status: {str(e)}")
        raise

def update_facial_verification_status(session_id: str, document_type: str, verification_status: str) -> None:
    """
    Update session with facial verification results
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document used for facial verification
    - verification_status: Facial verification status result
    """
    timestamp = datetime.now().isoformat()
    
    try:
        session_table.update_item(
            Key={
                'sessionId': session_id
            },
            UpdateExpression="SET facialVerificationStatus.#docType = :status, updatedAt = :timestamp",
            ExpressionAttributeNames={
                '#docType': document_type
            },
            ExpressionAttributeValues={
                ':status': verification_status,
                ':timestamp': timestamp
            }
        )
    except Exception as e:
        logger.error(f"Error updating facial verification status: {str(e)}")
        raise

def is_session_complete(session_status: Dict) -> bool:
    """
    Check if all required verifications for a session are complete
    
    Parameters:
    - session_status: Current session status
    
    Returns:
    - Boolean indicating whether session processing is complete
    """
    required_documents = session_status.get('requiredDocuments', [])
    document_status = session_status.get('documentStatus', {})
    facial_verification_status = session_status.get('facialVerificationStatus', {})
    
    # Check if we have at least one identity document (Passport OR National ID)
    has_identity_document = False
    
    if DocumentType.PASSPORT.value in required_documents and document_status.get(DocumentType.PASSPORT.value) != VerificationStatus.PENDING.value:
        has_identity_document = True
    elif DocumentType.NATIONAL_ID.value in required_documents and document_status.get(DocumentType.NATIONAL_ID.value) != VerificationStatus.PENDING.value:
        has_identity_document = True
        
    if not has_identity_document:
        return False
        
    # Check that all required documents are processed
    for doc_type in required_documents:
        # Skip passport check if national ID is provided and vice versa
        if doc_type == DocumentType.PASSPORT.value and document_status.get(DocumentType.NATIONAL_ID.value) != VerificationStatus.PENDING.value:
            continue
        if doc_type == DocumentType.NATIONAL_ID.value and document_status.get(DocumentType.PASSPORT.value) != VerificationStatus.PENDING.value:
            continue
            
        if document_status.get(doc_type) == VerificationStatus.PENDING.value:
            return False
            
    # Check facial verification for at least one identity document
    has_facial_verification = False
    
    if facial_verification_status.get(DocumentType.PASSPORT.value) != VerificationStatus.PENDING.value:
        has_facial_verification = True
    elif facial_verification_status.get(DocumentType.NATIONAL_ID.value) != VerificationStatus.PENDING.value:
        has_facial_verification = True
    elif facial_verification_status.get(DocumentType.DRIVERS_LICENSE.value) != VerificationStatus.PENDING.value:
        has_facial_verification = True
        
    if not has_facial_verification:
        return False
        
    return True

def determine_overall_status(session_id: str, session_status: Dict) -> str:
    """
    Determine overall verification status based on all results
    
    Parameters:
    - session_id: Session identifier
    - session_status: Current session status
    
    Returns:
    - Overall verification status
    """
    document_status = session_status.get('documentStatus', {})
    facial_verification_status = session_status.get('facialVerificationStatus', {})
    
    # Get all document validation statuses
    document_statuses = []
    for doc_type, status in document_status.items():
        # Skip documents that weren't submitted
        if status == VerificationStatus.PENDING.value:
            continue
        document_statuses.append(status)
    
    # Get all facial verification statuses
    facial_statuses = []
    for doc_type, status in facial_verification_status.items():
        # Skip documents that weren't submitted
        if status == VerificationStatus.PENDING.value:
            continue
        facial_statuses.append(status)
    
    # Apply business rules to determine overall status
    
    # Rule 1: If any document or facial verification FAILED, the overall status is FAILED
    if VerificationStatus.FAILED.value in document_statuses or VerificationStatus.FAILED.value in facial_statuses:
        return VerificationStatus.FAILED.value
        
    # Rule 2: If any document or facial verification requires MANUAL_REVIEW, the overall status is MANUAL_REVIEW
    if VerificationStatus.MANUAL_REVIEW.value in document_statuses or VerificationStatus.MANUAL_REVIEW.value in facial_statuses:
        return VerificationStatus.MANUAL_REVIEW.value
        
    # Rule 3: If all verifications PASSED, the overall status is PASSED
    if all(status == VerificationStatus.PASSED.value for status in document_statuses + facial_statuses):
        return VerificationStatus.PASSED.value
        
    # Rule 4: If we get here, something is still PENDING
    return VerificationStatus.PENDING.value

def update_session_overall_status(session_id: str, overall_status: str) -> None:
    """
    Update session with the overall verification status
    
    Parameters:
    - session_id: Session identifier
    - overall_status: Overall verification status
    """
    timestamp = datetime.now().isoformat()
    
    try:
        session_table.update_item(
            Key={
                'sessionId': session_id
            },
            UpdateExpression="SET #status = :status, completedAt = :timestamp, updatedAt = :timestamp",
            ExpressionAttributeNames={
                '#status': 'status'
            },
            ExpressionAttributeValues={
                ':status': overall_status,
                ':timestamp': timestamp
            }
        )
    except Exception as e:
        logger.error(f"Error updating overall session status: {str(e)}")
        raise

def trigger_post_processing(session_id: str, overall_status: str) -> None:
    """
    Trigger downstream processes based on verification results
    
    Parameters:
    - session_id: Session identifier
    - overall_status: Overall verification status
    """
    try:
        # Emit event for report generation
        emit_event(
            'VerificationCompleted',
            {
                'sessionId': session_id,
                'overallStatus': overall_status,
                'timestamp': datetime.now().isoformat(),
                'nextStep': 'REPORT_GENERATION'
            }
        )
        
        # Emit event for customer database update
        if overall_status == VerificationStatus.PASSED.value:
            emit_event(
                'CustomerDataUpdateRequired',
                {
                    'sessionId': session_id,
                    'overallStatus': overall_status,
                    'timestamp': datetime.now().isoformat(),
                    'nextStep': 'DATABASE_UPDATE'
                }
            )
        
        # Emit event for document storage
        emit_event(
            'DocumentStorageRequired',
            {
                'sessionId': session_id,
                'overallStatus': overall_status,
                'timestamp': datetime.now().isoformat(),
                'nextStep': 'DOCUMENT_STORAGE'
            }
        )
        
        # Queue for manual review if needed
        if overall_status == VerificationStatus.MANUAL_REVIEW.value:
            queue_for_manual_review(session_id)
    
    except Exception as e:
        logger.error(f"Error triggering post-processing: {str(e)}")
        raise

def emit_event(detail_type: str, detail: Dict) -> None:
    """
    Emit event to EventBridge event bus
    
    Parameters:
    - detail_type: Type of event
    - detail: Event details
    """
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.verification-aggregator',
                    'DetailType': detail_type,
                    'Detail': json.dumps(detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting event: {str(e)}")
        raise

def emit_error_event(session_id: str, error_message: str) -> None:
    """
    Emit error event to EventBridge event bus
    
    Parameters:
    - session_id: Session identifier
    - error_message: Error message
    """
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.verification-aggregator',
                    'DetailType': 'VerificationAggregationError',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'errorMessage': error_message,
                        'timestamp': datetime.now().isoformat()
                    }),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting error event: {str(e)}")

def store_aggregation_error(session_id: str, error_message: str) -> None:
    """
    Store aggregation error in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - error_message: Error message
    """
    timestamp = datetime.now().isoformat()
    
    try:
        session_table.update_item(
            Key={
                'sessionId': session_id
            },
            UpdateExpression="SET lastError = :error, lastErrorTimestamp = :timestamp",
            ExpressionAttributeValues={
                ':error': error_message,
                ':timestamp': timestamp
            }
        )
    except Exception as e:
        logger.error(f"Error storing aggregation error: {str(e)}")

def queue_for_manual_review(session_id: str) -> None:
    """
    Queue session for manual review
    
    Parameters:
    - session_id: Session identifier
    """
    if not manual_review_queue_url:
        logger.warning(f"Manual review queue URL not configured, skipping")
        return
        
    try:
        # Get validation results
        validation_results = get_validation_results(session_id)
        
        # Get verification results
        verification_results = get_verification_results(session_id)
        
        # Create manual review request
        manual_review_request = {
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'validationResults': validation_results,
            'verificationResults': verification_results,
            'reviewType': 'FULL_VERIFICATION',
            'priority': 'NORMAL'
        }
        
        # Send to SQS queue
        sqs.send_message(
            QueueUrl=manual_review_queue_url,
            MessageBody=json.dumps(manual_review_request),
            MessageAttributes={
                'SessionId': {
                    'DataType': 'String',
                    'StringValue': session_id
                },
                'ReviewType': {
                    'DataType': 'String',
                    'StringValue': 'FULL_VERIFICATION'
                }
            }
        )
        
        logger.info(f"Queued session {session_id} for manual review")
    
    except Exception as e:
        logger.error(f"Error queueing for manual review: {str(e)}")

def get_validation_results(session_id: str) -> Dict:
    """
    Get document validation results for a session
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Dictionary of validation results
    """
    results = {}
    
    try:
        # Query validation results by session ID
        response = validation_table.query(
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        if 'Items' in response:
            for item in response['Items']:
                doc_type = item.get('documentType')
                if doc_type:
                    results[doc_type] = {
                        'status': item.get('validationStatus'),
                        'confidence': item.get('validationConfidence'),
                        'timestamp': item.get('validationTimestamp')
                    }
        
        return results
    
    except Exception as e:
        logger.error(f"Error retrieving validation results: {str(e)}")
        return {}

def get_verification_results(session_id: str) -> Dict:
    """
    Get facial verification results for a session
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Dictionary of verification results
    """
    results = {}
    
    try:
        # Query verification results by session ID
        response = verification_table.query(
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        if 'Items' in response:
            for item in response['Items']:
                doc_type = item.get('documentType')
                if doc_type:
                    results[doc_type] = {
                        'status': item.get('verificationStatus'),
                        'similarityScore': item.get('similarityScore'),
                        'confidenceLevel': item.get('confidenceLevel'),
                        'timestamp': item.get('verificationTimestamp')
                    }
        
        return results
    
    except Exception as e:
        logger.error(f"Error retrieving verification results: {str(e)}")
        return {}
```

### 3.2 AWS CDK Infrastructure

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class VerificationAggregatorStack extends cdk.Stack {
  public readonly aggregatorFunction: lambda.Function;
  public readonly sessionTable: dynamodb.Table;
  public readonly manualReviewQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table for session tracking
    this.sessionTable = new dynamodb.Table(this, 'SessionTable', {
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Create SQS queue for manual reviews
    this.manualReviewQueue = new sqs.Queue(this, 'ManualReviewQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ManualReviewDLQ', {
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3
      }
    });
    
    // Create EventBridge event bus (or use existing one)
    const documentProcessingBus = events.EventBus.fromEventBusName(
      this, 
      'DocumentProcessingBus',
      'document-processing-bus'  // Must match the name in previous stacks
    );

    // Create Lambda function for verification aggregation
    this.aggregatorFunction = new lambda.Function(this, 'AggregatorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/verification-aggregator'),
      handler: 'index.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        SESSION_TABLE_NAME: this.sessionTable.tableName,
        VALIDATION_TABLE_NAME: 'validation-results-table',  // From Document Validator stack
        VERIFICATION_TABLE_NAME: 'verification-results-table',  // From Facial Verification Evaluator stack
        EVENT_BUS_NAME: documentProcessingBus.eventBusName,
        MANUAL_REVIEW_QUEUE_URL: this.manualReviewQueue.queueUrl
      }
    });

    // Grant permissions to the aggregator function
    this.sessionTable.grantReadWriteData(this.aggregatorFunction);
    this.manualReviewQueue.grantSendMessages(this.aggregatorFunction);
    
    // Grant access to validation and verification tables
    this.aggregatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:GetItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/validation-results-table`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/verification-results-table`
        ]
      })
    );
    
    // Grant EventBridge permissions
    this.aggregatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );

    // Create EventBridge rules to trigger aggregator
    const documentValidationRule = new events.Rule(this, 'DocumentValidationRule', {
      eventPattern: {
        source: ['document-processing.validation'],
        detailType: ['DocumentValidationCompleted']
      },
      targets: [new targets.LambdaFunction(this.aggregatorFunction)]
    });
    
    const facialVerificationRule = new events.Rule(this, 'FacialVerificationRule', {
      eventPattern: {
        source: ['document-processing.facial-verification'],
        detailType: ['FacialVerificationCompleted']
      },
      targets: [new targets.LambdaFunction(this.aggregatorFunction)]
    });
    
    // Create EventBridge rules for downstream services
    const verificationCompletedRule = new events.Rule(this, 'VerificationCompletedRule', {
      eventPattern: {
        source: ['document-processing.verification-aggregator'],
        detailType: ['VerificationCompleted']
      },
      // Targets will be added in subsequent stacks
    });
    
    const customerDataUpdateRule = new events.Rule(this, 'CustomerDataUpdateRule', {
      eventPattern: {
        source: ['document-processing.verification-aggregator'],
        detailType: ['CustomerDataUpdateRequired']
      },
      // Targets will be added in subsequent stacks
    });
    
    const documentStorageRule = new events.Rule(this, 'DocumentStorageRule', {
      eventPattern: {
        source: ['document-processing.verification-aggregator'],
        detailType: ['DocumentStorageRequired']
      },
      // Targets will be added in subsequent stacks
    });

    // Outputs
    new cdk.CfnOutput(this, 'SessionTableName', {
      value: this.sessionTable.tableName,
      description: 'The name of the DynamoDB table for verification sessions',
    });
    
    new cdk.CfnOutput(this, 'ManualReviewQueueUrl', {
      value: this.manualReviewQueue.queueUrl,
      description: 'The URL of the SQS queue for manual reviews',
    });
    
    new cdk.CfnOutput(this, 'AggregatorFunctionArn', {
      value: this.aggregatorFunction.functionArn,
      description: 'The ARN of the verification aggregator Lambda function',
    });
  }
}
```

## 4. Verification Strategy

### 4.1 Verification Aggregation Approach

The Verification Aggregator implements a comprehensive strategy for determining the overall verification status:

1. **Verification Completeness Check**:
   - Ensures all required documents have been processed
   - Verifies facial verification has been completed for at least one identity document
   - Confirms that at least one form of identity document has been processed

2. **Rule-Based Status Determination**:
   - Hierarchical rules for overall status determination
   - Failure in any component results in overall failure
   - Manual review requirement in any component triggers overall manual review
   - All components must pass for overall pass status

3. **Required Documents Handling**:
   - Identity document flexibility (Passport OR National ID)
   - Mandatory documents (Driver's License AND Vehicle Registration)
   - Support for partial session processing before completion

4. **Coordination of Downstream Processes**:
   - Report generation for all verification outcomes
   - Customer database updates only for passed verifications
   - Document storage for all processing sessions
   - Manual review routing where required

### 4.2 Document Requirements Logic

The component implements flexible document requirements logic:

1. **Identity Document Options**:
   - Either Passport OR National ID must be successfully processed
   - Facial verification must be successful for at least one document with a photo

2. **Mandatory Documents**:
   - Driver's License must be successfully processed
   - Vehicle Registration (Carte Grise) must be successfully processed

3. **Dynamic Requirements Support**:
   - Configurable required document list per session
   - Support for conditional document requirements
   - Special case handling for unusual document combinations

### 4.3 Status Aggregation Rules

The system applies the following status aggregation rules:

1. **Rule Priority**:
   - FAILED status takes highest priority (any failure results in overall failure)
   - MANUAL_REVIEW status takes second priority
   - PASSED status requires all checks to pass
   - PENDING status indicates incomplete processing

2. **Cross-Document Validation**:
   - Consistency check between identity documents and driver's license
   - Name matching across all documents
   - Correlation of address information between documents

3. **Verification Confidence Levels**:
   - Aggregated confidence score based on individual verifications
   - Confidence thresholds for automatic approval
   - Low confidence triggers for manual review

## 5. Session Management

### 5.1 Session State Tracking

The Verification Aggregator maintains comprehensive session state:

1. **Session Documents**:
   - Tracking of all submitted and processed documents
   - Document processing status (Pending, Processed, Failed)
   - Document validation results and confidence scores

2. **Verification Results**:
   - Status of facial verification for each document
   - Cross-document verification results
   - Aggregated verification status

3. **Processing Metadata**:
   - Session creation and update timestamps
   - Processing duration metrics
   - Error tracking and recovery information

### 5.2 Session Lifecycle Management

The component manages the complete lifecycle of verification sessions:

1. **Session Creation**:
   - Automatic creation of sessions when first document is submitted
   - Default required documents configuration
   - Initial PENDING status for all verifications

2. **Session Progress Tracking**:
   - Continuous updates as documents are processed
   - Progress indicators for client applications
   - Timeout handling for incomplete sessions

3. **Session Completion**:
   - Detection of session completion
   - Final status determination
   - Triggering of downstream processes
   - Session archival with appropriate retention period

## 6. Testing and Evaluation

### 6.1 Testing Approach

The Verification Aggregator is tested using:

1. **Unit Testing**:
   - Verification rules logic testing
   - Status determination functions
   - Document requirements validation

2. **Integration Testing**:
   - End-to-end session flow testing
   - Multi-document processing scenarios
   - Error handling and recovery testing

3. **Scenario Testing**:
   - Common verification scenarios
   - Edge cases with unusual document combinations
   - Error scenarios and recovery paths

### 6.2 Test Cases

The component includes test cases for:

1. **Happy Path Scenarios**:
   - Complete successful verification
   - Mixed results requiring manual review
   - Complete failed verification

2. **Edge Cases**:
   - Partial document submissions
   - Out-of-order document processing
   - Multiple identity documents
   - Retried verifications

3. **Error Cases**:
   - Missing documents
   - Incomplete sessions
   - Service failures during processing

## 7. Monitoring and Operations

### 7.1 Monitoring Metrics

The Verification Aggregator exposes the following metrics:

1. **Session Metrics**:
   - Session completion rate
   - Average session processing time
   - Session status distribution (Passed/Failed/Manual Review)

2. **Document Processing Metrics**:
   - Document processing success rate
   - Document validation confidence scores
   - Document type distribution

3. **Operational Metrics**:
   - Function invocation count
   - Error rate
   - DynamoDB operation latency

### 7.2 Alerting Configuration

1. **Critical Alerts**:
   - High error rate
   - Extended processing times
   - DynamoDB throttling
   - EventBridge delivery failures

2. **Warning Alerts**:
   - Elevated manual review rate
   - Increased session abandonment
   - Above-threshold processing duration
   - Queue depth for manual reviews

### 7.3 Operational Procedures

1. **Manual Review Process**:
   - Queue monitoring and prioritization
   - Review assignment workflow
   - Verification resolution process
   - Feedback loop for system improvement

2. **Error Handling**:
   - Procedures for investigating failed verifications
   - Recovery steps for incomplete sessions
   - Service degradation response

## 8. Security and Compliance

### 8.1 GDPR Compliance

The component ensures GDPR compliance through:

1. **Data Minimization**:
   - Only essential session data is stored
   - No direct storage of personal data
   - Reference to documents rather than document content

2. **Retention Management**:
   - Appropriate TTL configuration for session data
   - Automated cleanup of expired sessions
   - Audit trail maintenance

### 8.2 Security Controls

The component implements security through:

1. **Access Controls**:
   - Least-privilege IAM roles
   - Specific permissions for each operation
   - No direct access to document contents

2. **Data Protection**:
   - Encryption of all stored data
   - Secure transit using TLS
   - No caching of personal information

3. **Audit Trail**:
   - Comprehensive logging of all verification decisions
   - Immutable event records
   - User attribution for all actions

## 9. Future Enhancements

1. **Machine Learning Integration**:
   - Anomaly detection for unusual verification patterns
   - Automated threshold adjustments based on historical data
   - Continuous improvement of verification rules

2. **Advanced Aggregation Logic**:
   - Weighted verification scores
   - Risk-based verification requirements
   - Adaptive document requirements based on risk profiles

3. **Performance Optimizations**:
   - Caching of frequently accessed session information
   - Batch processing for high-volume scenarios
   - Parallel processing of document validations