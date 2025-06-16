# CDK Document Validation Service Implementation

This document provides the AWS CDK implementation for the Document Validation Service Lambda function, which is the third critical component in the French Document Processing System. This implementation validates the data extracted by the Bedrock Data Automation Integration against business rules and expected formats.

## Overview

The Document Validation Service Lambda function is responsible for:
- Validating extracted fields against business rules and expected formats
- Verifying data consistency across fields
- Flagging potential errors or inconsistencies
- Providing confidence scores for extracted data
- Routing documents to manual review when necessary

## Implementation Steps

### 1. Create Lambda Stack

Create a new file named `lib/lambda-validator-stack.ts` with the following content:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdaValidatorStackProps extends cdk.StackProps {
  // References to resources from previous stacks
  documentMetadataTable: dynamodb.ITable;
  extractionTable: dynamodb.ITable;
  eventBus: events.IEventBus;
}

export class LambdaValidatorStack extends cdk.Stack {
  public readonly validatorFunction: lambda.Function;
  public readonly validationResultsTable: dynamodb.Table;
  public readonly manualReviewQueue: sqs.Queue;
  
  constructor(scope: Construct, id: string, props: LambdaValidatorStackProps) {
    super(scope, id, props);

    // Create log group with appropriate retention
    const logGroup = new logs.LogGroup(this, 'ValidatorLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    
    // Create DynamoDB table for validation results
    this.validationResultsTable = new dynamodb.Table(this, 'ValidationResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    
    // Add GSI for validation status queries
    this.validationResultsTable.addGlobalSecondaryIndex({
      indexName: 'ValidationStatusIndex',
      partitionKey: { name: 'validationStatus', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    
    // Create SQS queue for manual review cases
    this.manualReviewQueue = new sqs.Queue(this, 'ManualReviewQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ManualReviewDLQ', {
          retentionPeriod: cdk.Duration.days(14),
          encryption: sqs.QueueEncryption.KMS_MANAGED
        }),
        maxReceiveCount: 3
      }
    });

    // Create Lambda function
    this.validatorFunction = new lambda.Function(this, 'DocumentValidatorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/document-validator')),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        EXTRACTION_TABLE_NAME: props.extractionTable.tableName,
        VALIDATION_TABLE_NAME: this.validationResultsTable.tableName,
        MANUAL_REVIEW_QUEUE_URL: this.manualReviewQueue.queueUrl,
        VALIDATION_THRESHOLD: '0.7',
        EVENT_BUS_NAME: props.eventBus.eventBusName
      },
      logGroup: logGroup,
      description: 'Validates extracted document data against business rules'
    });

    // Grant necessary permissions
    props.extractionTable.grantReadData(this.validatorFunction);
    this.validationResultsTable.grantReadWriteData(this.validatorFunction);
    this.manualReviewQueue.grantSendMessages(this.validatorFunction);
    
    // Grant permission to put events on the event bus
    props.eventBus.grantPutEventsTo(this.validatorFunction);
    
    // Create EventBridge rule to trigger Lambda when documents are extracted
    const extractionRule = new events.Rule(this, 'DocumentExtractedRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['document-processing-system'],
        detailType: ['DocumentExtracted']
      },
      description: 'Triggers validation when documents are extracted by Bedrock'
    });

    // Add the Lambda function as a target for the rule
    extractionRule.addTarget(new targets.LambdaFunction(this.validatorFunction));
    
    // Define outputs
    new cdk.CfnOutput(this, 'ValidatorFunctionName', {
      value: this.validatorFunction.functionName,
      description: 'The name of the document validator Lambda function'
    });
    
    new cdk.CfnOutput(this, 'ValidationResultsTableName', {
      value: this.validationResultsTable.tableName,
      description: 'The name of the DynamoDB table for validation results'
    });
    
    new cdk.CfnOutput(this, 'ManualReviewQueueUrl', {
      value: this.manualReviewQueue.queueUrl,
      description: 'The URL of the SQS queue for manual review cases'
    });
  }
}
```

### 2. Update Main CDK App

Update the `bin/french-document-processing-system.ts` file to include the validator stack:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { LambdaPreprocessorStack } from '../lib/lambda-preprocessor-stack';
import { LambdaBedrockStack } from '../lib/lambda-bedrock-stack';
import { LambdaValidatorStack } from '../lib/lambda-validator-stack';

const app = new cdk.App();

// Define environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'eu-west-1'  // Default to EU region for French documents
};

// Create the storage stack
const storageStack = new StorageStack(app, 'FrenchDocProcessingStorageStack', {
  env: env,
  description: 'Storage infrastructure for French document processing system'
});

// Create the Lambda preprocessor stack
const lambdaPreprocessorStack = new LambdaPreprocessorStack(app, 'FrenchDocProcessingPreprocessorStack', {
  env: env,
  description: 'Document preprocessing Lambda functions for French document processing system',
  rawDocumentsBucket: storageStack.rawDocumentsBucket,
  processedDocumentsBucket: storageStack.processedDocumentsBucket,
  documentMetadataTable: storageStack.documentMetadataTable
});

// Create the Lambda Bedrock integration stack
const lambdaBedrockStack = new LambdaBedrockStack(app, 'FrenchDocProcessingBedrockStack', {
  env: env,
  description: 'Bedrock Data Automation integration for French document processing system',
  processedDocumentsBucket: storageStack.processedDocumentsBucket,
  documentMetadataTable: storageStack.documentMetadataTable,
  verificationResultsTable: storageStack.verificationResultsTable,
  eventBus: lambdaPreprocessorStack.eventBus
});

// Create the Lambda validator stack
const lambdaValidatorStack = new LambdaValidatorStack(app, 'FrenchDocProcessingValidatorStack', {
  env: env,
  description: 'Document validation service for French document processing system',
  documentMetadataTable: storageStack.documentMetadataTable,
  extractionTable: lambdaBedrockStack.extractionTable, // Note: This assumes extractionTable is exposed from the Bedrock stack
  eventBus: lambdaPreprocessorStack.eventBus
});

// Define stack dependencies
lambdaPreprocessorStack.addDependency(storageStack);
lambdaBedrockStack.addDependency(lambdaPreprocessorStack);
lambdaValidatorStack.addDependency(lambdaBedrockStack);
```

### 3. Create the Lambda Function Implementation

Create the directory structure for the Lambda function:

```bash
mkdir -p lambda/document-validator
```

Create a file `lambda/document-validator/index.py` with the implementation:

```python
import json
import os
import boto3
import re
import uuid
from datetime import datetime
import logging
from decimal import Decimal

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')
extraction_table = dynamodb.Table(os.environ['EXTRACTION_TABLE_NAME'])
validation_table = dynamodb.Table(os.environ['VALIDATION_TABLE_NAME'])
sqs = boto3.client('sqs')
eventbridge = boto3.client('events')

# Environment variables
manual_review_queue_url = os.environ['MANUAL_REVIEW_QUEUE_URL']
validation_threshold = float(os.environ['VALIDATION_THRESHOLD'])
event_bus_name = os.environ['EVENT_BUS_NAME']

def lambda_handler(event, context):
    """
    Lambda function that validates extracted document data against business rules
    
    Parameters:
    - event: EventBridge event from Bedrock Data Automation Integration
    - context: Lambda context
    
    Returns:
    - Validation results including pass/fail status and confidence scores
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse event details
        event_detail = event['detail']
        session_id = event_detail.get('sessionId')
        document_type = event_detail.get('documentType')
        extraction_status = event_detail.get('extractionStatus')
        
        # Only validate documents that completed extraction
        if extraction_status != "COMPLETED":
            logger.info(f"Document {session_id}-{document_type} not ready for validation. Status: {extraction_status}")
            return {
                'statusCode': 200,
                'validationStatus': 'SKIPPED',
                'reason': f"Document extraction status: {extraction_status}"
            }
        
        # Get extracted document data
        extracted_data = get_extracted_data(session_id, document_type)
        if not extracted_data or 'extractedFields' not in extracted_data:
            logger.error(f"No extracted data found for {session_id}-{document_type}")
            return {
                'statusCode': 400,
                'validationStatus': 'FAILED',
                'reason': "No extracted data found"
            }
        
        # Validate document data
        validation_results = validate_document(extracted_data['extractedFields'], document_type)
        
        # Store validation results
        store_validation_results(session_id, document_type, validation_results)
        
        # Determine if manual review is needed
        if validation_results['validationStatus'] == 'MANUAL_REVIEW':
            queue_for_manual_review(session_id, document_type, extracted_data['extractedFields'], validation_results)
        
        # Emit event for downstream processing
        emit_validation_event(session_id, document_type, validation_results)
        
        return {
            'statusCode': 200,
            'validationStatus': validation_results['validationStatus'],
            'sessionId': session_id,
            'documentType': document_type,
            'validationDetails': validation_results['validationDetails'],
            'manualReviewRequired': validation_results['validationStatus'] == 'MANUAL_REVIEW'
        }
        
    except Exception as e:
        logger.error(f"Error validating document: {str(e)}")
        
        # Store error in DynamoDB for tracking
        if 'session_id' in locals() and 'document_type' in locals():
            store_validation_error(session_id, document_type, str(e))
        
        # Emit error event
        if 'session_id' in locals() and 'document_type' in locals():
            emit_error_event(session_id, document_type, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_extracted_data(session_id, document_type):
    """
    Retrieve extracted document data from DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    
    Returns:
    - Dictionary containing extracted document data
    """
    try:
        response = extraction_table.get_item(
            Key={
                'pk': f"SESSION#{session_id}",
                'sk': f"EXTRACTION#{document_type}"
            }
        )
        
        if 'Item' not in response:
            logger.warning(f"No extraction data found for {session_id}-{document_type}")
            return None
        
        return response['Item']
    
    except Exception as e:
        logger.error(f"Error retrieving extracted data: {str(e)}")
        raise

def validate_document(extracted_fields, document_type):
    """
    Validate extracted document fields against business rules
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    - document_type: Type of document being validated
    
    Returns:
    - Dictionary containing validation results
    """
    validation_details = {}
    validation_errors = []
    manual_review_triggers = []
    field_validations = []
    overall_confidence = 1.0
    
    # Apply document-specific validation rules
    if document_type in ['PASSPORT', 'NATIONAL_ID']:
        field_validations = validate_identity_document(extracted_fields)
    elif document_type == 'DRIVERS_LICENSE':
        field_validations = validate_drivers_license(extracted_fields)
    elif document_type == 'VEHICLE_REGISTRATION':
        field_validations = validate_vehicle_registration(extracted_fields)
    else:
        logger.warning(f"Unknown document type for validation: {document_type}")
        field_validations = validate_generic_document(extracted_fields)
    
    # Collect validation results
    for validation in field_validations:
        field_name = validation['field']
        validation_details[field_name] = validation
        
        if not validation['valid']:
            validation_errors.append({
                'field': field_name,
                'error': validation['reason'],
                'severity': validation['severity']
            })
        
        if validation['requiresManualReview']:
            manual_review_triggers.append({
                'field': field_name,
                'reason': validation['reason']
            })
        
        # Update overall confidence
        if 'confidence' in validation:
            overall_confidence = min(overall_confidence, validation['confidence'])
    
    # Cross-field validations
    cross_field_validations = perform_cross_field_validations(extracted_fields, document_type)
    for validation in cross_field_validations:
        validation_details[validation['name']] = validation
        
        if not validation['valid']:
            validation_errors.append({
                'fields': validation['fields'],
                'error': validation['reason'],
                'severity': validation['severity']
            })
        
        if validation['requiresManualReview']:
            manual_review_triggers.append({
                'fields': validation['fields'],
                'reason': validation['reason']
            })
    
    # Determine overall validation status
    validation_status = 'PASSED'
    
    if manual_review_triggers:
        validation_status = 'MANUAL_REVIEW'
    elif any(error['severity'] == 'HIGH' for error in validation_errors):
        validation_status = 'FAILED'
    elif validation_errors and overall_confidence < validation_threshold:
        validation_status = 'MANUAL_REVIEW'
    
    return {
        'validationStatus': validation_status,
        'validationDetails': validation_details,
        'validationErrors': validation_errors,
        'manualReviewTriggers': manual_review_triggers,
        'overallConfidence': overall_confidence
    }

def validate_identity_document(extracted_fields):
    """
    Validate fields from a passport or national ID
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    
    Returns:
    - Array of validation results for each field
    """
    validations = []
    
    # Validate full name
    if 'full_name' in extracted_fields:
        field_data = extracted_fields['full_name']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value and len(value) > 3)
        
        validations.append({
            'field': 'full_name',
            'valid': valid,
            'confidence': confidence,
            'severity': 'HIGH' if not valid else 'LOW',
            'reason': None if valid else "Name missing or too short",
            'requiresManualReview': not valid
        })
    else:
        validations.append({
            'field': 'full_name',
            'valid': False,
            'confidence': 0,
            'severity': 'HIGH',
            'reason': "Required field missing",
            'requiresManualReview': True
        })
    
    # Validate date of birth
    if 'date_of_birth' in extracted_fields:
        field_data = extracted_fields['date_of_birth']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        dob_valid, dob_reason = validate_date(value)
        
        validations.append({
            'field': 'date_of_birth',
            'valid': dob_valid,
            'confidence': confidence,
            'severity': 'HIGH' if not dob_valid else 'LOW',
            'reason': dob_reason,
            'requiresManualReview': not dob_valid
        })
    else:
        validations.append({
            'field': 'date_of_birth',
            'valid': False,
            'confidence': 0,
            'severity': 'HIGH',
            'reason': "Required field missing",
            'requiresManualReview': True
        })
    
    # Validate ID number or passport number
    id_field = 'passport_number' if 'passport_number' in extracted_fields else 'id_number'
    
    if id_field in extracted_fields:
        field_data = extracted_fields[id_field]
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value and len(value) >= 5)
        
        validations.append({
            'field': id_field,
            'valid': valid,
            'confidence': confidence,
            'severity': 'HIGH' if not valid else 'LOW',
            'reason': None if valid else "ID number missing or too short",
            'requiresManualReview': not valid
        })
    else:
        validations.append({
            'field': id_field,
            'valid': False,
            'confidence': 0,
            'severity': 'HIGH',
            'reason': "Required field missing",
            'requiresManualReview': True
        })
    
    # Validate expiration date
    if 'expiration_date' in extracted_fields:
        field_data = extracted_fields['expiration_date']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        exp_valid, exp_reason = validate_date(value)
        
        validations.append({
            'field': 'expiration_date',
            'valid': exp_valid,
            'confidence': confidence,
            'severity': 'MEDIUM' if not exp_valid else 'LOW',
            'reason': exp_reason,
            'requiresManualReview': not exp_valid
        })
    
    return validations

def validate_drivers_license(extracted_fields):
    """
    Validate fields from a driver's license
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    
    Returns:
    - Array of validation results for each field
    """
    validations = []
    
    # Validate full name
    if 'full_name' in extracted_fields:
        field_data = extracted_fields['full_name']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value and len(value) > 3)
        
        validations.append({
            'field': 'full_name',
            'valid': valid,
            'confidence': confidence,
            'severity': 'HIGH' if not valid else 'LOW',
            'reason': None if valid else "Name missing or too short",
            'requiresManualReview': not valid
        })
    else:
        validations.append({
            'field': 'full_name',
            'valid': False,
            'confidence': 0,
            'severity': 'HIGH',
            'reason': "Required field missing",
            'requiresManualReview': True
        })
    
    # Validate license number
    if 'license_number' in extracted_fields:
        field_data = extracted_fields['license_number']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value and len(value) >= 5)
        
        validations.append({
            'field': 'license_number',
            'valid': valid,
            'confidence': confidence,
            'severity': 'HIGH' if not valid else 'LOW',
            'reason': None if valid else "License number missing or too short",
            'requiresManualReview': not valid
        })
    else:
        validations.append({
            'field': 'license_number',
            'valid': False,
            'confidence': 0,
            'severity': 'HIGH',
            'reason': "Required field missing",
            'requiresManualReview': True
        })
    
    # Validate categories
    if 'categories' in extracted_fields:
        field_data = extracted_fields['categories']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value)
        
        validations.append({
            'field': 'categories',
            'valid': valid,
            'confidence': confidence,
            'severity': 'MEDIUM' if not valid else 'LOW',
            'reason': None if valid else "Categories missing",
            'requiresManualReview': not valid and confidence < 0.8
        })
    
    # Validate expiration date
    if 'expiration_date' in extracted_fields:
        field_data = extracted_fields['expiration_date']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        exp_valid, exp_reason = validate_date(value)
        
        validations.append({
            'field': 'expiration_date',
            'valid': exp_valid,
            'confidence': confidence,
            'severity': 'MEDIUM' if not exp_valid else 'LOW',
            'reason': exp_reason,
            'requiresManualReview': not exp_valid
        })
    
    return validations

def validate_vehicle_registration(extracted_fields):
    """
    Validate fields from a vehicle registration (Carte Grise)
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    
    Returns:
    - Array of validation results for each field
    """
    validations = []
    
    # Validate registration number
    if 'registration_number' in extracted_fields:
        field_data = extracted_fields['registration_number']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        # French registration format: AA-123-AA or similar
        reg_pattern = r'^[A-Z]{2}-\d{3}-[A-Z]{2}$'
        pattern_valid = bool(re.match(reg_pattern, value))
        
        # Even if pattern doesn't match exactly, we check if it's at least present
        value_present = bool(value and len(value) >= 5)
        
        validations.append({
            'field': 'registration_number',
            'valid': value_present,
            'formatValid': pattern_valid,
            'confidence': confidence,
            'severity': 'HIGH' if not value_present else ('MEDIUM' if not pattern_valid else 'LOW'),
            'reason': None if value_present else "Registration number missing or too short",
            'requiresManualReview': not value_present or (not pattern_valid and confidence < 0.9)
        })
    else:
        validations.append({
            'field': 'registration_number',
            'valid': False,
            'confidence': 0,
            'severity': 'HIGH',
            'reason': "Required field missing",
            'requiresManualReview': True
        })
    
    # Validate owner name
    if 'owner_name' in extracted_fields:
        field_data = extracted_fields['owner_name']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value and len(value) > 3)
        
        validations.append({
            'field': 'owner_name',
            'valid': valid,
            'confidence': confidence,
            'severity': 'MEDIUM' if not valid else 'LOW',
            'reason': None if valid else "Owner name missing or too short",
            'requiresManualReview': not valid and confidence < 0.8
        })
    
    # Validate vehicle make
    if 'vehicle_make' in extracted_fields:
        field_data = extracted_fields['vehicle_make']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value)
        
        validations.append({
            'field': 'vehicle_make',
            'valid': valid,
            'confidence': confidence,
            'severity': 'MEDIUM' if not valid else 'LOW',
            'reason': None if valid else "Vehicle make missing",
            'requiresManualReview': not valid and confidence < 0.7
        })
    
    # Validate CNIT
    if 'cnit' in extracted_fields:
        field_data = extracted_fields['cnit']
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        # CNIT is typically alphanumeric
        valid = bool(value and len(value) >= 5)
        
        validations.append({
            'field': 'cnit',
            'valid': valid,
            'confidence': confidence,
            'severity': 'MEDIUM' if not valid else 'LOW',
            'reason': None if valid else "CNIT missing or too short",
            'requiresManualReview': not valid and confidence < 0.8
        })
    
    return validations

def validate_generic_document(extracted_fields):
    """
    Validate fields for an unknown document type
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    
    Returns:
    - Array of validation results for each field
    """
    validations = []
    
    # For unknown document types, we perform generic validations
    for field_name, field_data in extracted_fields.items():
        value = field_data.get('value', '')
        confidence = field_data.get('confidence', 0.5)
        
        valid = bool(value)
        
        validations.append({
            'field': field_name,
            'valid': valid,
            'confidence': confidence,
            'severity': 'LOW',
            'reason': None if valid else f"Field {field_name} is empty",
            'requiresManualReview': not valid and confidence < 0.6
        })
    
    return validations

def perform_cross_field_validations(extracted_fields, document_type):
    """
    Perform validations across multiple fields
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    - document_type: Type of document being validated
    
    Returns:
    - Array of cross-field validation results
    """
    validations = []
    
    if document_type in ['PASSPORT', 'NATIONAL_ID']:
        # Cross-validate name with other fields
        if 'full_name' in extracted_fields and ('passport_number' in extracted_fields or 'id_number' in extracted_fields):
            name_field = extracted_fields['full_name']
            name_value = name_field.get('value', '')
            name_confidence = name_field.get('confidence', 0.5)
            
            id_field_name = 'passport_number' if 'passport_number' in extracted_fields else 'id_number'
            id_field = extracted_fields[id_field_name]
            id_confidence = id_field.get('confidence', 0.5)
            
            # If both confidences are low, recommend manual review
            combined_confidence = (name_confidence + id_confidence) / 2
            requires_review = combined_confidence < 0.75
            
            validations.append({
                'name': 'identity_consistency',
                'fields': ['full_name', id_field_name],
                'valid': True,  # We can't really validate consistency automatically without a reference
                'confidence': combined_confidence,
                'severity': 'LOW',
                'reason': None if not requires_review else "Low confidence in identity fields, please verify",
                'requiresManualReview': requires_review
            })
    
    elif document_type == 'DRIVERS_LICENSE':
        # Cross-validate name with license number
        if 'full_name' in extracted_fields and 'license_number' in extracted_fields:
            name_field = extracted_fields['full_name']
            name_confidence = name_field.get('confidence', 0.5)
            
            license_field = extracted_fields['license_number']
            license_confidence = license_field.get('confidence', 0.5)
            
            # If both confidences are low, recommend manual review
            combined_confidence = (name_confidence + license_confidence) / 2
            requires_review = combined_confidence < 0.75
            
            validations.append({
                'name': 'license_identity_consistency',
                'fields': ['full_name', 'license_number'],
                'valid': True,  # We can't really validate consistency automatically without a reference
                'confidence': combined_confidence,
                'severity': 'LOW',
                'reason': None if not requires_review else "Low confidence in license identity fields, please verify",
                'requiresManualReview': requires_review
            })
    
    elif document_type == 'VEHICLE_REGISTRATION':
        # Cross-validate registration number with vehicle make
        if 'registration_number' in extracted_fields and 'vehicle_make' in extracted_fields:
            reg_field = extracted_fields['registration_number']
            reg_confidence = reg_field.get('confidence', 0.5)
            
            make_field = extracted_fields['vehicle_make']
            make_confidence = make_field.get('confidence', 0.5)
            
            # If both confidences are low, recommend manual review
            combined_confidence = (reg_confidence + make_confidence) / 2
            requires_review = combined_confidence < 0.75
            
            validations.append({
                'name': 'vehicle_consistency',
                'fields': ['registration_number', 'vehicle_make'],
                'valid': True,  # We can't really validate consistency automatically without a reference
                'confidence': combined_confidence,
                'severity': 'LOW',
                'reason': None if not requires_review else "Low confidence in vehicle fields, please verify",
                'requiresManualReview': requires_review
            })
    
    return validations

def validate_date(date_str):
    """
    Validate a date string
    
    Parameters:
    - date_str: String representation of a date
    
    Returns:
    - Tuple of (is_valid, error_reason)
    """
    if not date_str:
        return False, "Date is empty"
    
    # Try multiple date formats
    formats = [
        "%Y-%m-%d",
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d.%m.%Y",
        "%Y/%m/%d"
    ]
    
    for fmt in formats:
        try:
            datetime.strptime(date_str, fmt)
            return True, None
        except ValueError:
            continue
    
    return False, "Invalid date format"

def store_validation_results(session_id, document_type, validation_results):
    """
    Store validation results in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - validation_results: Dictionary containing validation results
    """
    timestamp = datetime.now().isoformat()
    
    try:
        # Convert any Decimal objects to floats for JSON serialization
        validation_results_clean = json.loads(
            json.dumps(validation_results, default=lambda x: float(x) if isinstance(x, Decimal) else x)
        )
        
        validation_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"VALIDATION#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'validationTimestamp': timestamp,
                'validationStatus': validation_results['validationStatus'],
                'validationDetails': validation_results_clean.get('validationDetails', {}),
                'validationErrors': validation_results_clean.get('validationErrors', []),
                'manualReviewTriggers': validation_results_clean.get('manualReviewTriggers', []),
                'overallConfidence': validation_results_clean.get('overallConfidence', 0),
                'ttl': int((datetime.now().timestamp() + 90 * 24 * 60 * 60))  # 90 days expiry
            }
        )
    except Exception as e:
        logger.error(f"Error storing validation results: {str(e)}")
        raise

def store_validation_error(session_id, document_type, error_message):
    """
    Store error information in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - error_message: Error message
    """
    timestamp = datetime.now().isoformat()
    
    try:
        validation_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#VALIDATION#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'errorTimestamp': timestamp,
                'errorMessage': error_message,
                'stage': 'VALIDATION',
                'ttl': int((datetime.now().timestamp() + 30 * 24 * 60 * 60))  # 30 days expiry
            }
        )
    except Exception as e:
        logger.error(f"Error storing error information: {str(e)}")

def queue_for_manual_review(session_id, document_type, extracted_fields, validation_results):
    """
    Queue document for manual review
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - extracted_fields: Dictionary of extracted fields
    - validation_results: Dictionary containing validation results
    """
    try:
        message_body = {
            'sessionId': session_id,
            'documentType': document_type,
            'extractedFields': extracted_fields,
            'validationResults': validation_results,
            'timestamp': datetime.now().isoformat()
        }
        
        sqs.send_message(
            QueueUrl=manual_review_queue_url,
            MessageBody=json.dumps(message_body),
            MessageAttributes={
                'DocumentType': {
                    'DataType': 'String',
                    'StringValue': document_type
                },
                'SessionId': {
                    'DataType': 'String',
                    'StringValue': session_id
                }
            }
        )
        
        logger.info(f"Queued {session_id}-{document_type} for manual review")
    except Exception as e:
        logger.error(f"Error queuing for manual review: {str(e)}")

def emit_validation_event(session_id, document_type, validation_results):
    """
    Emit event for document validation pipeline
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - validation_results: Dictionary containing validation results
    """
    try:
        # Convert any Decimal objects to floats for JSON serialization
        validation_status = validation_results['validationStatus']
        overall_confidence = float(validation_results['overallConfidence']) if isinstance(validation_results['overallConfidence'], Decimal) else validation_results['overallConfidence']
        
        detail = {
            'sessionId': session_id,
            'documentType': document_type,
            'validationStatus': validation_status,
            'overallConfidence': overall_confidence,
            'timestamp': datetime.now().isoformat()
        }
        
        if validation_status == 'MANUAL_REVIEW':
            detail['manualReviewTriggerCount'] = len(validation_results.get('manualReviewTriggers', []))
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing-system',
                    'DetailType': 'DocumentValidationCompleted',
                    'Detail': json.dumps(detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting validation event: {str(e)}")

def emit_error_event(session_id, document_type, error_message):
    """
    Emit error event
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document being processed
    - error_message: Error message
    """
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing-system',
                    'DetailType': 'DocumentProcessingError',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'documentType': document_type,
                        'errorMessage': error_message,
                        'component': 'DocumentValidator',
                        'timestamp': datetime.now().isoformat()
                    }),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting error event: {str(e)}")
```

### 4. Create Requirements File

Create a file `lambda/document-validator/requirements.txt` with the library dependencies:

```
boto3>=1.26.0
```

### 5. Build and Deploy

```bash
# Build and deploy the CDK stack
npm run build
cdk deploy FrenchDocProcessingValidatorStack --require-approval never
```

## Key Technical Considerations

1. **Validation Logic**:
   - Comprehensive field validation for each document type
   - Cross-field validations to check consistency between fields
   - Support for manual review when confidence is low

2. **Event-Driven Architecture**:
   - EventBridge rule triggers the Lambda when documents are extracted
   - Events are emitted for downstream processing after validation
   - Error handling events for system monitoring

3. **Manual Review Workflow**:
   - SQS queue for routing documents to manual review
   - Dead-letter queue for handling failed processing attempts
   - Detailed error information for manual reviewers

4. **Data Storage**:
   - DynamoDB table with TTL for validation results
   - Efficient query patterns using composite primary keys
   - Global secondary index for status-based queries

5. **Security Considerations**:
   - IAM roles follow principle of least privilege
   - Queue encryption for manual review data
   - Input validation and error handling

## Next Steps

After deploying the Document Validation Service component, the next steps in the implementation plan would be:

1. **Test the Three Core Components**:
   - Verify document preprocessing is working correctly
   - Confirm Bedrock Data Automation is extracting fields
   - Ensure validation logic is correctly identifying issues

2. **Implement the Facial Verification Components**:
   - Create the Facial Image Extractor
   - Implement the Facial Verification Evaluator
   - Set up integration with AWS Rekognition

3. **Design a Manual Review Interface**:
   - Create a web interface for reviewing flagged documents
   - Implement resolution workflows
   - Set up notifications for review tasks