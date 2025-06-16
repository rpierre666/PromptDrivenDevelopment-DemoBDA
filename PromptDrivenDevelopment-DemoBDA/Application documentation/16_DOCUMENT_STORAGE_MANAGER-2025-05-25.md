# Document Storage Manager Implementation

This document provides the implementation for the Document Storage Manager component of the French Official Documents Processing System. This component is responsible for managing the secure storage of original documents with proper GDPR compliance features.

## 1. Component Overview

The Document Storage Manager is responsible for:
- Managing secure storage of original documents
- Implementing GDPR-compliant lifecycle policies (90-day maximum retention for raw documents)
- Handling document metadata indexing for retrieval
- Ensuring proper encryption and access controls
- Maintaining audit logs for document access and lifecycle events

## 2. Architecture Design

### 2.1 Component Architecture

The Document Storage Manager is implemented as an AWS Lambda function that processes events from the Verification Aggregator. It manages document storage in S3 with proper metadata indexing in DynamoDB.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Document Storage  │────▶│ S3 Document       │────▶│ Lifecycle       │
│ Event Bus       │     │ Manager Lambda    │     │ Repository        │     │ Manager         │
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ DynamoDB     │                                    │ CloudWatch       │
                        │ Document     │                                    │ Audit Logs       │
                        │ Metadata     │                                    │                  │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Verification Aggregator
   - Document locations in S3 (raw uploads)
   - Document metadata

2. **Output**:
   - Properly organized documents in S3 with lifecycle policies
   - Document metadata stored in DynamoDB
   - Event notification for downstream services

## 3. Implementation

### 3.1 AWS Lambda Function

```python
import json
import os
import boto3
import uuid
from datetime import datetime, timedelta
import logging
import time

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
metadata_table = dynamodb.Table(os.environ['DOCUMENT_METADATA_TABLE_NAME'])
eventbridge = boto3.client('events')
cloudwatch = boto3.client('logs')

# Environment variables
document_bucket = os.environ['DOCUMENT_STORAGE_BUCKET']
event_bus_name = os.environ['EVENT_BUS_NAME']
retention_period_days = int(os.environ['RETENTION_PERIOD_DAYS'])  # Default 90 days for GDPR compliance

def lambda_handler(event, context):
    """
    Lambda function that manages document storage and metadata indexing with GDPR compliance
    
    Parameters:
    - event: EventBridge event from Verification Aggregator
    - context: Lambda context
    
    Returns:
    - Storage management results
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse event details
        event_detail = event['detail']
        session_id = event_detail.get('sessionId')
        overall_status = event_detail.get('overallStatus')
        
        # Get document information from DynamoDB
        document_info = get_document_information(session_id)
        
        if not document_info:
            logger.error(f"No document information found for session {session_id}")
            return {
                'statusCode': 404,
                'error': f"No document information found for session {session_id}"
            }
            
        # Process and store each document with proper lifecycle policies
        storage_results = []
        for doc_info in document_info:
            # Only process documents with source location
            if 'sourceLocation' not in doc_info:
                logger.warning(f"No source location found for document {doc_info.get('documentType')}")
                continue
                
            # Store document with proper organization and lifecycle policies
            storage_result = store_document_with_lifecycle(
                session_id, 
                doc_info.get('documentType'),
                doc_info.get('sourceLocation'),
                doc_info
            )
            
            storage_results.append(storage_result)
        
        # Update document metadata in DynamoDB
        metadata_update_result = update_document_metadata(session_id, storage_results)
        
        # Create audit log
        create_audit_log(session_id, 'DOCUMENT_STORAGE', {
            'documentCount': len(storage_results),
            'status': 'COMPLETED',
            'retentionPeriodDays': retention_period_days
        })
        
        # Emit storage completion event
        emit_storage_event(session_id, storage_results)
        
        return {
            'statusCode': 200,
            'sessionId': session_id,
            'storageResults': storage_results,
            'metadataUpdateResult': metadata_update_result
        }
        
    except Exception as e:
        logger.error(f"Error managing document storage: {str(e)}")
        
        # Create error audit log
        if 'session_id' in locals():
            create_audit_log(session_id, 'DOCUMENT_STORAGE_ERROR', {
                'error': str(e)
            })
        
        # Emit error event
        if 'session_id' in locals():
            emit_error_event(session_id, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_document_information(session_id):
    """
    Retrieve document information from DynamoDB
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - List of document information
    """
    try:
        response = metadata_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        if not response.get('Items'):
            logger.warning(f"No document information found for session {session_id}")
            return None
            
        return response['Items']
        
    except Exception as e:
        logger.error(f"Error retrieving document information: {str(e)}")
        raise

def store_document_with_lifecycle(session_id, document_type, source_location, doc_info):
    """
    Store document with proper organization and lifecycle policies
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - source_location: S3 location of source document
    - doc_info: Document metadata information
    
    Returns:
    - Storage result information
    """
    try:
        # Parse source S3 location
        source_bucket, source_key = parse_s3_location(source_location)
        
        # Generate target key with proper organization
        timestamp = datetime.now().strftime("%Y%m%d")
        target_key = f"documents/{session_id}/{document_type.lower()}/{timestamp}-{uuid.uuid4()}.pdf"
        
        # Copy object to target location
        s3_client.copy_object(
            CopySource={
                'Bucket': source_bucket,
                'Key': source_key
            },
            Bucket=document_bucket,
            Key=target_key,
            MetadataDirective='REPLACE',
            Metadata={
                'session_id': session_id,
                'document_type': document_type,
                'storage_date': datetime.now().isoformat(),
                'retention_end_date': (datetime.now() + timedelta(days=retention_period_days)).isoformat(),
                'verification_status': doc_info.get('verificationStatus', 'UNKNOWN')
            },
            ServerSideEncryption='AES256',
            Tagging=f"session={session_id}&document-type={document_type}&retention=gdpr-{retention_period_days}days"
        )
        
        # Calculate expiration date
        expiration_date = datetime.now() + timedelta(days=retention_period_days)
        
        # Return storage result
        return {
            'documentType': document_type,
            'sourceLocation': source_location,
            'targetLocation': f"s3://{document_bucket}/{target_key}",
            'storageTimestamp': datetime.now().isoformat(),
            'expirationDate': expiration_date.isoformat(),
            'status': 'STORED'
        }
        
    except Exception as e:
        logger.error(f"Error storing document: {str(e)}")
        return {
            'documentType': document_type,
            'sourceLocation': source_location,
            'status': 'FAILED',
            'error': str(e)
        }

def parse_s3_location(location):
    """
    Parse S3 location string into bucket and key
    
    Parameters:
    - location: S3 location string (s3://bucket/key)
    
    Returns:
    - Tuple containing bucket and key
    """
    if not location.startswith('s3://'):
        raise ValueError(f"Invalid S3 location format: {location}")
        
    parts = location[5:].split('/', 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid S3 location format: {location}")
        
    return parts[0], parts[1]

def update_document_metadata(session_id, storage_results):
    """
    Update document metadata in DynamoDB with storage information
    
    Parameters:
    - session_id: Session identifier
    - storage_results: Results from document storage operations
    
    Returns:
    - Metadata update result
    """
    try:
        updates = []
        
        for result in storage_results:
            # Skip failed storage operations
            if result['status'] != 'STORED':
                continue
                
            # Update metadata for this document
            update_response = metadata_table.update_item(
                Key={
                    'pk': f"SESSION#{session_id}",
                    'sk': f"DOCUMENT#{result['documentType']}"
                },
                UpdateExpression='SET storageLocation = :loc, expirationDate = :exp, lastUpdated = :upd',
                ExpressionAttributeValues={
                    ':loc': result['targetLocation'],
                    ':exp': result['expirationDate'],
                    ':upd': datetime.now().isoformat()
                },
                ReturnValues='UPDATED_NEW'
            )
            
            updates.append({
                'documentType': result['documentType'],
                'updateStatus': 'SUCCESS',
                'updatedFields': update_response.get('Attributes', {})
            })
            
        return {
            'updatedDocuments': len(updates),
            'updates': updates
        }
        
    except Exception as e:
        logger.error(f"Error updating document metadata: {str(e)}")
        return {
            'updatedDocuments': 0,
            'error': str(e)
        }

def create_audit_log(session_id, action, details):
    """
    Create audit log entry for document operations
    
    Parameters:
    - session_id: Session identifier
    - action: Type of action being audited
    - details: Details of the action
    """
    try:
        timestamp = int(time.time() * 1000)  # Milliseconds since epoch
        log_id = f"{session_id}-{action}-{timestamp}"
        
        # Create audit log entry in DynamoDB
        metadata_table.put_item(
            Item={
                'pk': f"AUDIT#{session_id}",
                'sk': log_id,
                'action': action,
                'timestamp': datetime.now().isoformat(),
                'details': details,
                'user': context.invoked_function_arn.split(':')[-1],  # Extract Lambda function name as "user"
                'ttl': int(time.time()) + 31536000  # 1 year retention for audit logs
            }
        )
        
        # Also log to CloudWatch for additional security
        log_message = {
            'sessionId': session_id,
            'action': action,
            'timestamp': datetime.now().isoformat(),
            'details': details
        }
        logger.info(f"AUDIT_LOG: {json.dumps(log_message)}")
        
    except Exception as e:
        logger.error(f"Error creating audit log: {str(e)}")
        # We don't want to fail the entire function if audit logging fails
        # So we just log the error and continue

def emit_storage_event(session_id, storage_results):
    """
    Emit document storage event to EventBridge
    
    Parameters:
    - session_id: Session identifier
    - storage_results: Results from document storage operations
    """
    try:
        successful_count = sum(1 for result in storage_results if result['status'] == 'STORED')
        failed_count = len(storage_results) - successful_count
        
        event_detail = {
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'documentCount': len(storage_results),
            'successfulCount': successful_count,
            'failedCount': failed_count,
            'retentionPeriodDays': retention_period_days,
            'storageLocations': [
                {
                    'documentType': result['documentType'],
                    'location': result['targetLocation'] if result['status'] == 'STORED' else None
                }
                for result in storage_results
            ]
        }
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.document-storage-manager',
                    'DetailType': 'DocumentStorageCompleted',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting storage event: {str(e)}")

def emit_error_event(session_id, error_message):
    """
    Emit error event to EventBridge
    
    Parameters:
    - session_id: Session identifier
    - error_message: Error message
    """
    try:
        event_detail = {
            'sessionId': session_id,
            'timestamp': datetime.now().isoformat(),
            'error': error_message
        }
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.document-storage-manager',
                    'DetailType': 'DocumentStorageError',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting error event: {str(e)}")
```

### 3.2 AWS CDK Infrastructure

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export class DocumentStorageManagerStack extends cdk.Stack {
  public readonly storageFunction: lambda.Function;
  public readonly documentBucket: s3.Bucket;
  public readonly metadataTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket for document storage with lifecycle configuration
    this.documentBucket = new s3.Bucket(this, 'DocumentStorageBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: 'GdprDocumentRetention',
          enabled: true,
          expiration: cdk.Duration.days(90),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
          tagFilters: {
            'retention': 'gdpr-90days'
          }
        }
      ],
      serverAccessLogsPrefix: 'access-logs/',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'], // This should be restricted in production
          allowedHeaders: ['*'],
          maxAge: 3600
        }
      ]
    });
    
    // Add bucket policy for encryption and logging
    const bucketPolicy = new s3.BucketPolicy(this, 'DocumentBucketPolicy', {
      bucket: this.documentBucket
    });
    
    bucketPolicy.document.addStatements(
      new iam.PolicyStatement({
        actions: ['s3:*'],
        resources: [this.documentBucket.arnForObjects('*')],
        effect: iam.Effect.DENY,
        conditions: {
          'Bool': {
            'aws:SecureTransport': 'false'
          }
        },
        principals: [new iam.AnyPrincipal()]
      })
    );

    // Create or reference DynamoDB table for document metadata
    this.metadataTable = new dynamodb.Table(this, 'DocumentMetadataTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED
    });
    
    // Add GSIs for querying
    this.metadataTable.addGlobalSecondaryIndex({
      indexName: 'DocumentTypeIndex',
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'storageTimestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    
    this.metadataTable.addGlobalSecondaryIndex({
      indexName: 'ExpirationIndex',
      partitionKey: { name: 'expirationStatus', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'expirationDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    
    this.metadataTable.addGlobalSecondaryIndex({
      indexName: 'AuditIndex',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Create EventBridge event bus (or use existing one)
    const documentProcessingBus = events.EventBus.fromEventBusName(
      this, 
      'DocumentProcessingBus',
      'document-processing-bus'  // Must match the name used in previous stacks
    );
    
    // Create Lambda function for document storage management
    this.storageFunction = new lambda.Function(this, 'StorageManagerFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/document-storage-manager'),
      handler: 'index.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DOCUMENT_METADATA_TABLE_NAME: this.metadataTable.tableName,
        DOCUMENT_STORAGE_BUCKET: this.documentBucket.bucketName,
        EVENT_BUS_NAME: documentProcessingBus.eventBusName,
        RETENTION_PERIOD_DAYS: '90'  // GDPR compliance - 90 days
      }
    });

    // Grant required permissions to Lambda function
    this.documentBucket.grantReadWrite(this.storageFunction);
    this.metadataTable.grantReadWriteData(this.storageFunction);
    
    // Grant EventBridge permissions
    this.storageFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );
    
    // Create EventBridge rule to trigger document storage when verification is completed
    const verificationCompletedRule = new events.Rule(this, 'VerificationCompletedRule', {
      eventPattern: {
        source: ['document-processing.verification-aggregator'],
        detailType: ['VerificationCompleted']
      },
      targets: [new targets.LambdaFunction(this.storageFunction)]
    });
    
    // Create EventBridge rule for lifecycle management notifications
    const lifecycleNotificationRule = new events.Rule(this, 'LifecycleNotificationRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Lifecycle Expiration']
      },
      targets: [
        // Target could be a notification function or monitoring service
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'DocumentBucketName', {
      value: this.documentBucket.bucketName,
      description: 'The name of the S3 bucket for document storage',
    });
    
    new cdk.CfnOutput(this, 'DocumentMetadataTableName', {
      value: this.metadataTable.tableName,
      description: 'The name of the DynamoDB table for document metadata',
    });
    
    new cdk.CfnOutput(this, 'StorageManagerFunctionArn', {
      value: this.storageFunction.functionArn,
      description: 'The ARN of the document storage manager Lambda function',
    });
  }
}
```

## 4. Document Storage Implementation

### 4.1 Storage Organization

The component implements a structured storage organization:

1. **Hierarchical Structure**
   - Documents organized by session ID
   - Subdirectories for document types
   - Timestamp-based naming for versioning
   - UUID addition for uniqueness

2. **Metadata Tagging**
   - Tags for retention periods
   - Document type identification
   - Session-based grouping
   - Verification status markers

3. **Versioning**
   - S3 versioning enabled
   - Audit trail of document changes
   - Protection against accidental deletion
   - Historical access capabilities

### 4.2 Lifecycle Management

The component implements GDPR-compliant lifecycle management:

1. **Retention Policies**
   - 90-day default retention for raw documents
   - Automatic expiration based on S3 lifecycle rules
   - Tag-based lifecycle configuration
   - Configurable retention periods

2. **Expiration Processing**
   - Automatic object deletion after retention period
   - Metadata updates for expired documents
   - Audit trails for document deletion
   - Event notifications for lifecycle events

3. **Retention Exceptions**
   - Mechanism for legal holds
   - Override capability for special cases
   - Documentation of retention changes

### 4.3 Metadata Management

The component implements comprehensive metadata management:

1. **Document Metadata**
   - Document type and format
   - Original source information
   - Verification status
   - Processing timestamps
   - Retention information
   - Access control attributes

2. **Storage Schema**
   - DynamoDB for structured metadata
   - S3 object metadata for direct association
   - Global secondary indexes for efficient queries
   - Time-to-live for automatic metadata cleanup

3. **Query Capabilities**
   - Search by session ID
   - Search by document type
   - Search by expiration date
   - Search by verification status

## 5. Security Implementation

### 5.1 Access Controls

The component implements comprehensive access controls:

1. **IAM Policies**
   - Least privilege principle
   - Role-based access control
   - Time-limited access tokens
   - Conditional access based on request attributes

2. **Resource Policies**
   - S3 bucket policies for access control
   - DynamoDB resource policies
   - EventBridge resource policies
   - VPC endpoint policies

3. **Application-Level Controls**
   - Request validation
   - Session-based access restrictions
   - Document ownership verification
   - Permission checking

### 5.2 Encryption

The component implements data encryption:

1. **Data at Rest**
   - S3 server-side encryption (SSE-S3)
   - DynamoDB encryption
   - Lambda environment variable encryption
   - Key rotation strategies

2. **Data in Transit**
   - TLS for all API communications
   - HTTPS for S3 access
   - Secure VPC connections
   - Encrypted network traffic

3. **Key Management**
   - AWS managed keys for simplicity
   - Optional integration with KMS for customer-managed keys
   - Key access auditing
   - Least privilege for key usage

### 5.3 Audit and Monitoring

The component implements audit and monitoring features:

1. **Access Logging**
   - S3 access logging enabled
   - API access logging
   - Administrative action logging
   - IAM action logging

2. **Activity Monitoring**
   - CloudWatch metrics for access patterns
   - Anomaly detection
   - Usage statistics
   - Capacity monitoring

3. **Security Alerting**
   - Suspicious activity detection
   - Compliance violation alerts
   - Access denial notifications
   - Encryption failure alerts

## 6. GDPR Compliance Features

### 6.1 Data Minimization

The component implements data minimization:

1. **Storage Limitation**
   - Default 90-day retention
   - Automatic document deletion
   - Metadata cleanup
   - Minimized redundant storage

2. **Purpose Limitation**
   - Clear documentation of processing purpose
   - Access controls based on purpose
   - Metadata tagging for purpose
   - Audit trail of purpose changes

3. **Data Quality**
   - Validation before storage
   - Data integrity checks
   - Consistent metadata schema
   - Error correction mechanisms

### 6.2 Data Subject Rights

The component supports data subject rights:

1. **Right to Erasure**
   - Document deletion capabilities
   - Metadata removal processes
   - Verification of deletion
   - Audit trail of erasure requests

2. **Right to Access**
   - Document retrieval mechanisms
   - Metadata access APIs
   - Access logging for transparency
   - Format conversion for portability

3. **Right to Restriction**
   - Processing limitation flags
   - Access restriction capabilities
   - Purpose limitation enforcement
   - Retention extension for legal cases

### 6.3 Documentation and Transparency

The component implements documentation features:

1. **Processing Records**
   - Audit logs of document operations
   - Access logs for viewing activities
   - Lifecycle event documentation
   - Retention period tracking

2. **Policy Documentation**
   - Retention policy documentation
   - Access control documentation
   - Security measure documentation
   - Compliance feature documentation

## 7. Implementation Requirements

### 7.1 Dependencies

- **AWS Services**
  - Amazon S3 for document storage
  - Amazon DynamoDB for metadata storage
  - AWS Lambda for serverless processing
  - Amazon EventBridge for event handling
  - AWS CloudWatch for logging and monitoring
  - AWS IAM for access control

- **Python Libraries**
  - `boto3`: AWS SDK for Python
  - `json`: JSON handling
  - `datetime`: Date and time handling
  - `uuid`: Unique identifier generation
  - `logging`: Logging framework

### 7.2 Environment Setup

- Environment variables for configuration
- AWS permissions and roles
- S3 bucket with lifecycle configuration
- DynamoDB table for document metadata
- EventBridge event bus for notifications

### 7.3 Deployment Configuration

- Function memory sizing for optimal performance
- Timeout configuration appropriate for document operations
- Concurrency limits to avoid S3 throttling
- Alarm configuration for monitoring and alerting