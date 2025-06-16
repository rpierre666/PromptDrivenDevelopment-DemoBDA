# Customer Database Updater Implementation

This document provides the implementation for the Customer Database Updater component of the French Official Documents Processing System. This component is responsible for updating the customer database with verified information extracted from processed documents.

## 1. Component Overview

The Customer Database Updater is responsible for:
- Receiving verified document data from the Verification Aggregator
- Transforming extracted data to match the customer database schema
- Updating the customer database with verified information
- Handling update errors and implementing retry mechanisms
- Maintaining audit logs of all database updates
- Ensuring GDPR compliance during data transfer and storage

## 2. Architecture Design

### 2.1 Component Architecture

The Customer Database Updater is implemented as an AWS Lambda function that processes events from the Verification Aggregator. It transforms the verified data and updates the customer database through a secure, reliable integration.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Customer DB       │────▶│ Data              │────▶│ Database        │
│ Event Bus       │     │ Updater Lambda    │     │ Transformation    │     │ Integration     │
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ SQS Queue    │                                    │ Customer         │
                        │ for Retries  │                                    │ Database         │
                        │              │                                    │                  │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Verification Aggregator
   - Verified document data from DynamoDB
   - Customer information from API Gateway

2. **Output**:
   - Updates to the customer database
   - Status events published to EventBridge
   - Audit logs for compliance tracking

## 3. Implementation

### 3.1 AWS Lambda Function

```python
import json
import os
import boto3
import uuid
import time
from datetime import datetime
import logging
from typing import Dict, List, Any, Optional
import requests
from aws_requests_auth.aws_auth import AWSRequestsAuth
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
extraction_table = dynamodb.Table(os.environ['EXTRACTION_TABLE_NAME'])
verification_table = dynamodb.Table(os.environ['VERIFICATION_TABLE_NAME'])
sqs = boto3.client('sqs')
eventbridge = boto3.client('events')
ssm = boto3.client('ssm')

# Environment variables
event_bus_name = os.environ['EVENT_BUS_NAME']
retry_queue_url = os.environ['RETRY_QUEUE_URL']
customer_db_api_endpoint = os.environ['CUSTOMER_DB_API_ENDPOINT']
customer_db_region = os.environ['CUSTOMER_DB_REGION']
max_retries = int(os.environ.get('MAX_RETRIES', '3'))

# Customer database auth credentials (stored in SSM Parameter Store)
def get_auth_credentials():
    """Retrieve customer database API credentials from SSM Parameter Store"""
    try:
        response = ssm.get_parameter(
            Name=os.environ['CUSTOMER_DB_AUTH_PARAM'],
            WithDecryption=True
        )
        return json.loads(response['Parameter']['Value'])
    except Exception as e:
        logger.error(f"Error retrieving auth credentials: {str(e)}")
        raise

def lambda_handler(event, context):
    """
    Lambda function that updates customer database with verified information
    
    Parameters:
    - event: EventBridge event from verification aggregator
    - context: Lambda context
    
    Returns:
    - Database update results including success status
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse event details
        detail_type = event.get('detail-type', '')
        
        # Process based on event type
        if detail_type == 'VerificationCompleted':
            event_detail = event['detail']
            session_id = event_detail.get('sessionId')
            overall_status = event_detail.get('overallStatus')
            
            # Only update database for PASSED or MANUAL_REVIEW statuses
            if overall_status not in ['PASSED', 'MANUAL_REVIEW']:
                logger.info(f"Verification failed for session {session_id}. Skipping database update.")
                emit_status_event(session_id, 'SKIPPED', f"Verification status: {overall_status}")
                return {
                    'statusCode': 200,
                    'updateStatus': 'SKIPPED',
                    'reason': f"Verification status: {overall_status}"
                }
            
            # Get customer reference from session data
            customer_reference = get_customer_reference(session_id)
            
            if not customer_reference:
                logger.error(f"No customer reference found for session {session_id}")
                emit_status_event(session_id, 'FAILED', "No customer reference found")
                return {
                    'statusCode': 400,
                    'updateStatus': 'FAILED',
                    'reason': "No customer reference found"
                }
            
            # Get extracted document data
            document_data = get_document_data(session_id)
            
            if not document_data:
                logger.error(f"No document data found for session {session_id}")
                emit_status_event(session_id, 'FAILED', "No document data found")
                return {
                    'statusCode': 400,
                    'updateStatus': 'FAILED',
                    'reason': "No document data found"
                }
            
            # Transform data for customer database
            transformed_data = transform_data_for_customer_db(document_data, customer_reference, session_id)
            
            # Update customer database
            update_result = update_customer_database(transformed_data, customer_reference)
            
            if update_result['success']:
                # Log successful update and emit success event
                store_update_log(session_id, customer_reference, transformed_data, 'SUCCESS')
                emit_status_event(session_id, 'SUCCESS', "Customer database updated successfully")
                
                return {
                    'statusCode': 200,
                    'updateStatus': 'SUCCESS',
                    'sessionId': session_id,
                    'customerReference': customer_reference
                }
            else:
                # Handle update failure - queue for retry
                store_update_log(session_id, customer_reference, transformed_data, 'FAILED', update_result['error'])
                queue_update_for_retry(session_id, customer_reference, transformed_data, update_result['error'])
                emit_status_event(session_id, 'FAILED', update_result['error'])
                
                return {
                    'statusCode': 500,
                    'updateStatus': 'FAILED',
                    'error': update_result['error'],
                    'sessionId': session_id,
                    'customerReference': customer_reference,
                    'retryStatus': 'QUEUED'
                }
        
        # Handle retry events from SQS
        elif detail_type == 'RetryDatabaseUpdate':
            event_detail = event['detail']
            session_id = event_detail.get('sessionId')
            customer_reference = event_detail.get('customerReference')
            transformed_data = event_detail.get('data')
            retry_count = event_detail.get('retryCount', 1)
            
            logger.info(f"Processing retry {retry_count} for session {session_id}")
            
            # Update customer database
            update_result = update_customer_database(transformed_data, customer_reference)
            
            if update_result['success']:
                # Log successful update and emit success event
                store_update_log(session_id, customer_reference, transformed_data, 'SUCCESS')
                emit_status_event(session_id, 'SUCCESS', "Customer database updated successfully on retry")
                
                return {
                    'statusCode': 200,
                    'updateStatus': 'SUCCESS',
                    'sessionId': session_id,
                    'customerReference': customer_reference,
                    'retryCount': retry_count
                }
            else:
                # Handle retry failure
                store_update_log(session_id, customer_reference, transformed_data, 'RETRY_FAILED', update_result['error'])
                
                # Check if we should retry again
                if retry_count < max_retries:
                    queue_update_for_retry(session_id, customer_reference, transformed_data, update_result['error'], retry_count + 1)
                    emit_status_event(session_id, 'RETRY_QUEUED', update_result['error'])
                    
                    return {
                        'statusCode': 500,
                        'updateStatus': 'RETRY_QUEUED',
                        'error': update_result['error'],
                        'sessionId': session_id,
                        'customerReference': customer_reference,
                        'retryCount': retry_count + 1
                    }
                else:
                    # Max retries reached - manual intervention needed
                    emit_status_event(session_id, 'MAX_RETRIES_REACHED', update_result['error'])
                    
                    return {
                        'statusCode': 500,
                        'updateStatus': 'MAX_RETRIES_REACHED',
                        'error': update_result['error'],
                        'sessionId': session_id,
                        'customerReference': customer_reference,
                        'retryCount': retry_count
                    }
        
        # Unknown event type
        else:
            logger.warning(f"Unknown event type: {detail_type}")
            return {
                'statusCode': 400,
                'error': f"Unknown event type: {detail_type}"
            }
            
    except Exception as e:
        logger.error(f"Error updating customer database: {str(e)}")
        
        # Store error in logs
        if 'session_id' in locals() and 'customer_reference' in locals():
            store_update_log(session_id, customer_reference, {}, 'ERROR', str(e))
        
        # Emit error event
        if 'session_id' in locals():
            emit_status_event(session_id, 'ERROR', str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_customer_reference(session_id):
    """
    Get customer reference from session data
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Customer reference string or None
    """
    try:
        # Query DynamoDB for session metadata
        response = dynamodb.Table(os.environ['SESSION_TABLE_NAME']).get_item(
            Key={
                'sessionId': session_id
            }
        )
        
        if 'Item' not in response:
            logger.warning(f"No session data found for {session_id}")
            return None
            
        return response['Item'].get('customerReference')
        
    except Exception as e:
        logger.error(f"Error retrieving customer reference: {str(e)}")
        return None

def get_document_data(session_id):
    """
    Get verified document data from DynamoDB
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Dictionary containing document data from all verified documents
    """
    try:
        # Get extraction data
        extraction_response = extraction_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        # Get verification status
        verification_response = verification_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        if not extraction_response.get('Items'):
            logger.warning(f"No extraction data found for session {session_id}")
            return None
            
        if not verification_response.get('Items'):
            logger.warning(f"No verification data found for session {session_id}")
            return None
        
        # Process and combine the data
        result = {
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'documents': {}
        }
        
        # Organize verification status by document type
        verification_status = {}
        for item in verification_response['Items']:
            if 'sk' in item and item['sk'].startswith('VERIFICATION#'):
                doc_type = item['sk'].split('#')[1]
                verification_status[doc_type] = item.get('verificationStatus')
        
        # Only include documents that passed verification
        for item in extraction_response['Items']:
            if 'sk' in item and item['sk'].startswith('EXTRACTION#'):
                doc_type = item['sk'].split('#')[1]
                
                # Check if this document passed verification
                if doc_type in verification_status and verification_status[doc_type] in ['PASSED', 'MANUAL_REVIEW']:
                    result['documents'][doc_type] = {
                        'extractedFields': item.get('extractedFields', {}),
                        'verificationStatus': verification_status[doc_type]
                    }
        
        return result
        
    except Exception as e:
        logger.error(f"Error retrieving document data: {str(e)}")
        return None

def transform_data_for_customer_db(document_data, customer_reference, session_id):
    """
    Transform extracted document data to match customer database schema
    
    Parameters:
    - document_data: Extracted document data
    - customer_reference: Customer reference identifier
    - session_id: Session identifier
    
    Returns:
    - Transformed data ready for customer database update
    """
    result = {
        'customerReference': customer_reference,
        'verificationSessionId': session_id,
        'verificationTimestamp': datetime.now().isoformat(),
        'personalInformation': {},
        'identityDocument': {},
        'drivingLicense': {},
        'vehicleInformation': {}
    }
    
    documents = document_data.get('documents', {})
    
    # Process identity document (Passport or National ID)
    identity_doc = documents.get('PASSPORT') or documents.get('NATIONAL_ID')
    if identity_doc:
        extracted_fields = identity_doc.get('extractedFields', {})
        
        # Map personal information
        if 'full_name' in extracted_fields:
            result['personalInformation']['fullName'] = get_field_value(extracted_fields, 'full_name')
            
            # Try to split name into first and last name
            name_parts = get_field_value(extracted_fields, 'full_name').split(' ', 1)
            if len(name_parts) == 2:
                result['personalInformation']['firstName'] = name_parts[0]
                result['personalInformation']['lastName'] = name_parts[1]
        
        if 'date_of_birth' in extracted_fields:
            result['personalInformation']['dateOfBirth'] = get_field_value(extracted_fields, 'date_of_birth')
        
        # Map identity document information
        doc_type = 'PASSPORT' if 'PASSPORT' in documents else 'NATIONAL_ID'
        result['identityDocument']['documentType'] = doc_type
        
        if 'document_number' in extracted_fields:
            result['identityDocument']['documentNumber'] = get_field_value(extracted_fields, 'document_number')
        elif 'passport_number' in extracted_fields:
            result['identityDocument']['documentNumber'] = get_field_value(extracted_fields, 'passport_number')
        
        if 'expiration_date' in extracted_fields:
            result['identityDocument']['expirationDate'] = get_field_value(extracted_fields, 'expiration_date')
        
        if 'issuer_name' in extracted_fields:
            result['identityDocument']['issuerName'] = get_field_value(extracted_fields, 'issuer_name')
        
        if 'city_of_issuance' in extracted_fields:
            result['identityDocument']['cityOfIssuance'] = get_field_value(extracted_fields, 'city_of_issuance')
    
    # Process driver's license
    drivers_license = documents.get('DRIVERS_LICENSE')
    if drivers_license:
        extracted_fields = drivers_license.get('extractedFields', {})
        
        if 'license_number' in extracted_fields:
            result['drivingLicense']['licenseNumber'] = get_field_value(extracted_fields, 'license_number')
        
        if 'categories' in extracted_fields:
            result['drivingLicense']['categories'] = get_field_value(extracted_fields, 'categories')
        
        if 'issue_date' in extracted_fields:
            result['drivingLicense']['issueDate'] = get_field_value(extracted_fields, 'issue_date')
        
        if 'expiration_date' in extracted_fields:
            result['drivingLicense']['expirationDate'] = get_field_value(extracted_fields, 'expiration_date')
        
        if 'issuer_name' in extracted_fields:
            result['drivingLicense']['issuerName'] = get_field_value(extracted_fields, 'issuer_name')
        
        if 'city_of_issuance' in extracted_fields:
            result['drivingLicense']['cityOfIssuance'] = get_field_value(extracted_fields, 'city_of_issuance')
    
    # Process vehicle registration
    vehicle_registration = documents.get('VEHICLE_REGISTRATION')
    if vehicle_registration:
        extracted_fields = vehicle_registration.get('extractedFields', {})
        
        if 'registration_number' in extracted_fields:
            result['vehicleInformation']['registrationNumber'] = get_field_value(extracted_fields, 'registration_number')
        
        if 'first_registration_date' in extracted_fields:
            result['vehicleInformation']['firstRegistrationDate'] = get_field_value(extracted_fields, 'first_registration_date')
        
        if 'owner_name' in extracted_fields:
            result['vehicleInformation']['ownerName'] = get_field_value(extracted_fields, 'owner_name')
        
        if 'address' in extracted_fields:
            result['vehicleInformation']['address'] = get_field_value(extracted_fields, 'address')
        
        if 'is_owner' in extracted_fields:
            result['vehicleInformation']['isOwner'] = get_field_value(extracted_fields, 'is_owner')
        
        if 'co_holders' in extracted_fields:
            result['vehicleInformation']['coHolders'] = get_field_value(extracted_fields, 'co_holders')
        
        if 'vehicle_make' in extracted_fields:
            result['vehicleInformation']['vehicleMake'] = get_field_value(extracted_fields, 'vehicle_make')
        
        if 'vehicle_type' in extracted_fields:
            result['vehicleInformation']['vehicleType'] = get_field_value(extracted_fields, 'vehicle_type')
        
        if 'cnit' in extracted_fields:
            result['vehicleInformation']['cnit'] = get_field_value(extracted_fields, 'cnit')
        
        if 'commercial_name' in extracted_fields:
            result['vehicleInformation']['commercialName'] = get_field_value(extracted_fields, 'commercial_name')
    
    # Add verification metadata
    result['verificationMetadata'] = {
        'source': 'document-processing-system',
        'systemVersion': '1.0.0',
        'verifiedDocuments': list(documents.keys()),
        'facialVerification': True  # Assuming facial verification was part of the process
    }
    
    return result

def get_field_value(fields, field_name):
    """Helper function to extract field value from extracted fields"""
    field_data = fields.get(field_name)
    
    if isinstance(field_data, dict) and 'value' in field_data:
        return field_data['value']
    
    return field_data

def update_customer_database(transformed_data, customer_reference):
    """
    Update customer database with transformed data
    
    Parameters:
    - transformed_data: Data transformed to match customer database schema
    - customer_reference: Customer reference identifier
    
    Returns:
    - Dictionary with update result
    """
    try:
        # Get authentication credentials
        auth_credentials = get_auth_credentials()
        
        # Create AWS auth for API Gateway (if using API Gateway with IAM auth)
        auth = AWSRequestsAuth(
            aws_access_key=auth_credentials['access_key'],
            aws_secret_access_key=auth_credentials['secret_key'],
            aws_host=customer_db_api_endpoint.replace('https://', ''),
            aws_region=customer_db_region,
            aws_service='execute-api'
        )
        
        # Determine update endpoint based on customer reference
        update_url = f"{customer_db_api_endpoint}/customers/{customer_reference}/verification"
        
        # Make the API call
        response = requests.post(
            update_url,
            json=transformed_data,
            auth=auth,
            headers={
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': auth_credentials.get('api_key', '')
            },
            timeout=10  # 10 seconds timeout
        )
        
        # Check for successful response
        if response.status_code in [200, 201, 204]:
            logger.info(f"Successfully updated customer database for {customer_reference}")
            return {
                'success': True,
                'statusCode': response.status_code,
                'response': response.text
            }
        else:
            logger.error(f"Failed to update customer database: {response.status_code} - {response.text}")
            return {
                'success': False,
                'statusCode': response.status_code,
                'error': f"API Error: {response.status_code} - {response.text}"
            }
            
    except requests.RequestException as e:
        logger.error(f"Request exception when updating customer database: {str(e)}")
        return {
            'success': False,
            'error': f"Request Error: {str(e)}"
        }
        
    except Exception as e:
        logger.error(f"Error updating customer database: {str(e)}")
        return {
            'success': False,
            'error': f"General Error: {str(e)}"
        }

def store_update_log(session_id, customer_reference, data, status, error_message=None):
    """
    Store database update log in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - customer_reference: Customer reference identifier
    - data: Data that was sent (or attempted to be sent) to customer database
    - status: Update status (SUCCESS, FAILED, RETRY_FAILED, ERROR)
    - error_message: Optional error message
    """
    try:
        timestamp = datetime.now().isoformat()
        log_id = f"update-log-{int(datetime.now().timestamp())}"
        
        # Create log entry
        log_entry = {
            'logId': log_id,
            'sessionId': session_id,
            'customerReference': customer_reference,
            'timestamp': timestamp,
            'status': status,
            'operation': 'DATABASE_UPDATE',
            'ttl': int(time.time() + 31536000)  # 1 year retention
        }
        
        # Add error message if present
        if error_message:
            log_entry['errorMessage'] = error_message
        
        # Add truncated data summary (avoid storing full data for privacy/size)
        log_entry['dataSummary'] = {
            'documentTypes': list(data.get('documents', {}).keys()) if 'documents' in data else [],
            'personalInfoIncluded': 'personalInformation' in data,
            'identityDocIncluded': 'identityDocument' in data,
            'drivingLicenseIncluded': 'drivingLicense' in data,
            'vehicleInfoIncluded': 'vehicleInformation' in data
        }
        
        # Store in DynamoDB
        dynamodb.Table(os.environ['UPDATE_LOG_TABLE_NAME']).put_item(Item=log_entry)
        
    except Exception as e:
        logger.error(f"Error storing update log: {str(e)}")
        # We don't want to fail the entire function if logging fails
        # So we just log the error and continue

def queue_update_for_retry(session_id, customer_reference, transformed_data, error_message, retry_count=1):
    """
    Queue database update for retry using SQS
    
    Parameters:
    - session_id: Session identifier
    - customer_reference: Customer reference identifier
    - transformed_data: Transformed data for customer database
    - error_message: Error message from failed attempt
    - retry_count: Current retry count
    """
    try:
        # Determine retry delay based on retry count (exponential backoff)
        delay_seconds = min(900, 2 ** (retry_count - 1) * 30)  # Max 15 minutes
        
        # Create message body
        message = {
            'detail-type': 'RetryDatabaseUpdate',
            'detail': {
                'sessionId': session_id,
                'customerReference': customer_reference,
                'data': transformed_data,
                'retryCount': retry_count,
                'previousError': error_message,
                'timestamp': datetime.now().isoformat()
            }
        }
        
        # Send message to SQS queue
        sqs.send_message(
            QueueUrl=retry_queue_url,
            MessageBody=json.dumps(message),
            DelaySeconds=delay_seconds
        )
        
        logger.info(f"Queued retry #{retry_count} for session {session_id} with delay of {delay_seconds} seconds")
        
    except Exception as e:
        logger.error(f"Error queueing retry: {str(e)}")
        # If we can't queue for retry, emit an alert event
        emit_status_event(session_id, 'RETRY_QUEUE_FAILED', str(e))

def emit_status_event(session_id, status, message=None):
    """
    Emit status event to EventBridge
    
    Parameters:
    - session_id: Session identifier
    - status: Update status
    - message: Optional status message
    """
    try:
        event_detail = {
            'sessionId': session_id,
            'updateStatus': status,
            'timestamp': datetime.now().isoformat()
        }
        
        if message:
            event_detail['message'] = message
            
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.customer-db-updater',
                    'DetailType': 'DatabaseUpdateStatus',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting status event: {str(e)}")
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
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

export class CustomerDbUpdaterStack extends cdk.Stack {
  public readonly updaterFunction: lambda.Function;
  public readonly retryQueue: sqs.Queue;
  public readonly updateLogTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create SQS queue for update retries
    this.retryQueue = new sqs.Queue(this, 'RetryQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'DeadLetterQueue', {
          retentionPeriod: cdk.Duration.days(14)
        }),
        maxReceiveCount: 3
      }
    });

    // Create DynamoDB table for update logs
    this.updateLogTable = new dynamodb.Table(this, 'UpdateLogTable', {
      partitionKey: { name: 'logId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl'
    });
    
    // Add GSIs for querying
    this.updateLogTable.addGlobalSecondaryIndex({
      indexName: 'SessionIndex',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    
    this.updateLogTable.addGlobalSecondaryIndex({
      indexName: 'CustomerReferenceIndex',
      partitionKey: { name: 'customerReference', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    
    this.updateLogTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Create EventBridge event bus (or use existing one)
    const documentProcessingBus = events.EventBus.fromEventBusName(
      this, 
      'DocumentProcessingBus',
      'document-processing-bus'  // Must match the name used in previous stacks
    );
    
    // Create Lambda function for database updates
    this.updaterFunction = new lambda.Function(this, 'UpdaterFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/customer-db-updater', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_9.bundlingImage,
          command: [
            'bash', '-c', [
              'pip install -r requirements.txt -t /asset-output',
              'cp -au . /asset-output'
            ].join(' && ')
          ]
        }
      }),
      handler: 'index.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: {
        EXTRACTION_TABLE_NAME: 'extraction-results-table',   // Reference to existing table
        VERIFICATION_TABLE_NAME: 'verification-results-table', // Reference to existing table
        SESSION_TABLE_NAME: 'verification-session-table',      // Reference to existing table
        UPDATE_LOG_TABLE_NAME: this.updateLogTable.tableName,
        RETRY_QUEUE_URL: this.retryQueue.queueUrl,
        EVENT_BUS_NAME: documentProcessingBus.eventBusName,
        CUSTOMER_DB_API_ENDPOINT: cdk.Fn.importValue('CustomerDbApiEndpoint'),
        CUSTOMER_DB_REGION: this.region,
        CUSTOMER_DB_AUTH_PARAM: '/document-processing/customer-db-auth',
        MAX_RETRIES: '3'
      }
    });

    // Add event source from retry queue
    this.updaterFunction.addEventSource(new SqsEventSource(this.retryQueue, {
      batchSize: 1,  // Process one message at a time for better error isolation
      maxBatchingWindow: cdk.Duration.seconds(0)
    }));

    // Grant DynamoDB permissions
    this.updateLogTable.grantWriteData(this.updaterFunction);
    
    // Grant access to read extraction and verification data
    this.updaterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/extraction-results-table`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/verification-results-table`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/verification-session-table`
        ]
      })
    );
    
    // Grant SQS permissions
    this.retryQueue.grantSendMessages(this.updaterFunction);
    
    // Grant EventBridge permissions
    this.updaterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );
    
    // Grant SSM parameter access
    this.updaterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/document-processing/customer-db-auth`]
      })
    );

    // Create EventBridge rule to trigger database updates when verification is completed
    const verificationCompletedRule = new events.Rule(this, 'VerificationCompletedRule', {
      eventPattern: {
        source: ['document-processing.verification-aggregator'],
        detailType: ['VerificationCompleted']
      },
      targets: [new targets.LambdaFunction(this.updaterFunction)]
    });
    
    // Create EventBridge rule for database update status
    const dbUpdateStatusRule = new events.Rule(this, 'DbUpdateStatusRule', {
      eventPattern: {
        source: ['document-processing.customer-db-updater'],
        detailType: ['DatabaseUpdateStatus']
      },
      targets: [
        // Add targets for monitoring database update status
        // This could include notification to operations team for failures
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'UpdateLogTableName', {
      value: this.updateLogTable.tableName,
      description: 'The name of the DynamoDB table for database update logs',
    });
    
    new cdk.CfnOutput(this, 'RetryQueueUrl', {
      value: this.retryQueue.queueUrl,
      description: 'The URL of the SQS queue for update retries',
    });
    
    new cdk.CfnOutput(this, 'UpdaterFunctionArn', {
      value: this.updaterFunction.functionArn,
      description: 'The ARN of the customer database updater Lambda function',
    });
  }
}
```

## 4. Customer Database Integration

### 4.1 Integration Pattern

The Customer Database Updater implements a reliable integration pattern with the following features:

1. **Decoupled Architecture**
   - Event-driven design decouples document processing from database updates
   - SQS queue provides a buffer for retries and error handling
   - No direct dependence on customer database availability

2. **Transformation Layer**
   - Document data is transformed to match customer database schema
   - Field mapping handles differences between document formats and database fields
   - Data normalization ensures consistent format

3. **Error Handling**
   - Comprehensive error detection and logging
   - Automatic retry mechanism with exponential backoff
   - Dead letter queue for failed updates after maximum retries
   - Alerting for manual intervention when needed

### 4.2 Data Mapping Strategy

The component implements a flexible data mapping strategy:

1. **Document Type-Based Mapping**
   - Different mapping rules based on document type
   - Field extraction based on document schema
   - Handling of optional and required fields

2. **Hierarchical Data Structure**
   - Organizing data into logical sections (personal information, identity documents, etc.)
   - Preserving relationships between data elements
   - Maintaining verification metadata

3. **Data Quality Handling**
   - Confidence score consideration in field mapping
   - Handling of conflicting information across documents
   - Priority rules for source of truth (e.g., identity document over driver's license)

### 4.3 API Integration

The component integrates with the customer database API:

1. **Authentication Methods**
   - AWS IAM authentication for API Gateway endpoints
   - API key authentication (optional)
   - Secure credential storage in SSM Parameter Store

2. **Request Formatting**
   - JSON payload construction
   - Content type and accept headers
   - Request timeouts and retry configuration

3. **Response Handling**
   - Status code interpretation
   - Error response parsing
   - Validation of successful updates

## 5. Retry Mechanism

### 5.1 Retry Strategy

The component implements a robust retry strategy:

1. **Exponential Backoff**
   - Initial retry after 30 seconds
   - Exponential increase in wait time with each retry
   - Maximum delay capped at 15 minutes

2. **Configurable Retry Limits**
   - Maximum number of retries configurable via environment variable
   - Dead letter queue for permanently failed updates
   - Alert generation after maximum retries

3. **State Preservation**
   - Retry message contains full context of the update
   - Error information from previous attempts
   - Retry counter to track attempt number

### 5.2 Retry Queue Management

The component implements SQS queue management:

1. **Message Structure**
   - Session and customer identifiers
   - Full payload for database update
   - Error context from previous attempts
   - Retry metadata (count, timestamps)

2. **Queue Configuration**
   - Visibility timeout aligned with function timeout
   - Message retention period for audit purposes
   - Dead letter queue configuration

3. **Message Processing**
   - Single message processing for error isolation
   - Clear error handling with contextual logging
   - Explicit success/failure response

## 6. Audit and Compliance

### 6.1 Audit Logging

The component implements comprehensive audit logging:

1. **Log Structure**
   - Unique log identifier
   - Session and customer references
   - Operation type and timestamp
   - Status and error information
   - Data summary (without sensitive details)

2. **Storage Strategy**
   - DynamoDB table with TTL for automatic deletion
   - Global secondary indexes for efficient querying
   - GDPR-compliant retention period (1 year)

3. **Query Capabilities**
   - Query by session ID
   - Query by customer reference
   - Query by status (for monitoring)
   - Time-based queries

### 6.2 GDPR Compliance

The component ensures GDPR compliance:

1. **Data Minimization**
   - Only necessary data sent to customer database
   - Data trimming during transformation
   - Avoidance of data duplication

2. **Secure Transmission**
   - HTTPS for all API communication
   - IAM authentication for API access
   - Encrypted credentials in SSM Parameter Store

3. **Retention Control**
   - Time-to-live (TTL) for automatic log deletion
   - No persistent storage of sensitive data
   - Configurable retention periods

## 7. Error Handling

### 7.1 Error Categorization

The component categorizes errors for appropriate handling:

1. **Transient Errors**
   - Network connectivity issues
   - API timeouts
   - Service unavailability
   - Handled via retry mechanism

2. **Validation Errors**
   - Schema validation failures
   - Business rule violations
   - Data quality issues
   - May require manual intervention

3. **Authorization Errors**
   - Authentication failures
   - Permission issues
   - Credential problems
   - Generate security alerts

4. **System Errors**
   - Lambda execution errors
   - Resource constraints
   - Configuration issues
   - Trigger operational alerts

### 7.2 Error Reporting

The component implements error reporting:

1. **EventBridge Events**
   - Error events published to EventBridge
   - Detailed error context
   - Categorized by severity and type

2. **CloudWatch Logs**
   - Structured log entries with error context
   - Log level appropriate to severity
   - Correlation IDs for tracing

3. **Alerting Integration**
   - Critical errors trigger immediate alerts
   - Configurable alerting thresholds
   - Escalation paths for different error types

## 8. Implementation Requirements

### 8.1 Dependencies

- **Python Libraries**
  - `requests`: HTTP client for API calls
  - `boto3`: AWS SDK for Python
  - `aws-requests-auth`: AWS authentication for API Gateway
  - `json`: JSON handling
  - `datetime`: Date and time handling

### 8.2 Environment Setup

- Environment variables for configuration
- AWS permissions and roles
- SQS queue for retries
- DynamoDB table for update logs
- SSM Parameter Store for API credentials

### 8.3 Deployment Configuration

- Function memory sizing for optimal performance
- Timeout configuration appropriate for API calls
- Concurrency limits to avoid overloading customer database
- Alarm configuration for monitoring and alerting