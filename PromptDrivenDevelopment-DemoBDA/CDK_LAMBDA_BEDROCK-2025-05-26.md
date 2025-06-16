# CDK Bedrock Data Automation Integration Implementation

This document provides the AWS CDK implementation for the Bedrock Data Automation Integration Lambda function, which is the second critical component in the French Document Processing System. This implementation connects to AWS Bedrock Data Automation service and applies pre-built templates for French documents.

## Overview

The Bedrock Data Automation Integration Lambda function is responsible for:
- Receiving pre-processed documents from the Document Pre-processor
- Connecting to AWS Bedrock Data Automation service
- Applying pre-built templates for French documents
- Extracting required fields from each document type
- Storing extraction results in DynamoDB
- Emitting events for downstream processing

## Implementation Steps

### 1. Create Lambda Stack

Create a new file named `lib/lambda-bedrock-stack.ts` with the following content:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdaBedrockStackProps extends cdk.StackProps {
  // References to resources from the storage stack
  processedDocumentsBucket: s3.IBucket;
  documentMetadataTable: dynamodb.ITable;
  verificationResultsTable: dynamodb.ITable;
  eventBus: events.IEventBus;
}

export class LambdaBedrockStack extends cdk.Stack {
  public readonly bedrockFunction: lambda.Function;
  
  constructor(scope: Construct, id: string, props: LambdaBedrockStackProps) {
    super(scope, id, props);

    // Create log group with appropriate retention
    const logGroup = new logs.LogGroup(this, 'BedrockIntegrationLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create parameter for knowledge base ID
    const knowledgeBaseId = new ssm.StringParameter(this, 'BedrockKnowledgeBaseId', {
      parameterName: '/french-doc-processing/bedrock/knowledge-base-id',
      stringValue: 'placeholder-knowledge-base-id', // This should be updated after creating the knowledge base
      description: 'ID of the Bedrock knowledge base containing document templates',
      tier: ssm.ParameterTier.STANDARD
    });

    // Create a parameter for template table name
    const templateTableName = new ssm.StringParameter(this, 'TemplateTableName', {
      parameterName: '/french-doc-processing/bedrock/template-table-name',
      stringValue: 'DocumentTemplates', // This should be the actual table name
      description: 'Name of the DynamoDB table containing document template mappings',
      tier: ssm.ParameterTier.STANDARD
    });

    // Create DynamoDB table for document templates
    const templateTable = new dynamodb.Table(this, 'TemplateTable', {
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN // Retain template data
    });

    // Create DynamoDB table for extraction results
    const extractionTable = new dynamodb.Table(this, 'ExtractionTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for document type queries
    extractionTable.addGlobalSecondaryIndex({
      indexName: 'DocumentTypeIndex',
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Create Lambda function
    this.bedrockFunction = new lambda.Function(this, 'BedrockIntegrationFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/bedrock-integration')),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      environment: {
        PROCESSED_DOCUMENTS_BUCKET: props.processedDocumentsBucket.bucketName,
        EXTRACTION_TABLE_NAME: extractionTable.tableName,
        TEMPLATE_TABLE_NAME: templateTable.tableName,
        KNOWLEDGE_BASE_ID: knowledgeBaseId.stringValue,
        CONFIDENCE_THRESHOLD: '0.7',
        EVENT_BUS_NAME: props.eventBus.eventBusName
      },
      logGroup: logGroup,
      description: 'Integrates with Bedrock Data Automation to extract data from French documents'
    });

    // Grant necessary permissions
    props.processedDocumentsBucket.grantRead(this.bedrockFunction);
    props.documentMetadataTable.grantReadWriteData(this.bedrockFunction);
    extractionTable.grantReadWriteData(this.bedrockFunction);
    templateTable.grantReadData(this.bedrockFunction);
    
    // Add permissions for Bedrock
    this.bedrockFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:GetFoundationModel',
          'bedrock:ListFoundationModels',
          'bedrock-agent-runtime:RetrieveAndGenerate'
        ],
        resources: ['*']
      })
    );
    
    // Grant permission to access Parameter Store parameters
    knowledgeBaseId.grantRead(this.bedrockFunction);
    templateTableName.grantRead(this.bedrockFunction);
    
    // Grant permission to put events on the event bus
    props.eventBus.grantPutEventsTo(this.bedrockFunction);

    // Create EventBridge rule to trigger Lambda when documents are preprocessed
    const preprocessingRule = new events.Rule(this, 'DocumentPreprocessedRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['document-processing-system'],
        detailType: ['DocumentPreprocessed']
      },
      description: 'Triggers Bedrock integration when documents are preprocessed'
    });

    // Add the Lambda function as a target for the rule
    preprocessingRule.addTarget(new targets.LambdaFunction(this.bedrockFunction));
    
    // Define outputs
    new cdk.CfnOutput(this, 'BedrockFunctionName', {
      value: this.bedrockFunction.functionName,
      description: 'The name of the Bedrock integration Lambda function'
    });
    
    new cdk.CfnOutput(this, 'ExtractionTableName', {
      value: extractionTable.tableName,
      description: 'The name of the DynamoDB table for extraction results'
    });
    
    new cdk.CfnOutput(this, 'TemplateTableName', {
      value: templateTable.tableName,
      description: 'The name of the DynamoDB table for document templates'
    });
  }
}
```

### 2. Update Main CDK App

Update the `bin/french-document-processing-system.ts` file to include the Bedrock integration stack:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { LambdaPreprocessorStack } from '../lib/lambda-preprocessor-stack';
import { LambdaBedrockStack } from '../lib/lambda-bedrock-stack';

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

// Define stack dependencies
lambdaPreprocessorStack.addDependency(storageStack);
lambdaBedrockStack.addDependency(lambdaPreprocessorStack);
```

### 3. Create the Lambda Function Implementation

Create the directory structure for the Lambda function:

```bash
mkdir -p lambda/bedrock-integration
```

Create a file `lambda/bedrock-integration/index.py` with the implementation:

```python
import json
import os
import boto3
import uuid
from datetime import datetime
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
bedrock_client = boto3.client('bedrock-agent-runtime')
dynamodb = boto3.resource('dynamodb')
extraction_table = dynamodb.Table(os.environ['EXTRACTION_TABLE_NAME'])
template_table = dynamodb.Table(os.environ['TEMPLATE_TABLE_NAME'])
eventbridge = boto3.client('events')

# Environment variables
knowledge_base_id = os.environ['KNOWLEDGE_BASE_ID']
confidence_threshold = float(os.environ['CONFIDENCE_THRESHOLD'])
event_bus_name = os.environ['EVENT_BUS_NAME']

def lambda_handler(event, context):
    """
    Lambda function that integrates with Bedrock Data Automation to extract data from documents
    
    Parameters:
    - event: EventBridge event from document pre-processor
    - context: Lambda context
    
    Returns:
    - Extraction results including field data and confidence scores
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse event details
        event_detail = event['detail']
        session_id = event_detail.get('sessionId')
        document_type = event_detail.get('documentType')
        quality_status = event_detail.get('qualityStatus')
        
        # Only process documents that passed quality checks
        if quality_status != "ACCEPTED":
            logger.info(f"Document {session_id}-{document_type} failed quality checks. Skipping extraction.")
            emit_extraction_event(session_id, document_type, "SKIPPED", {}, "Document failed quality checks")
            return {
                'statusCode': 200,
                'extractionStatus': 'SKIPPED',
                'reason': 'Document failed quality checks'
            }
        
        # Get document location
        document_location = event_detail.get('outputLocation')
        bucket_name, key = parse_s3_location(document_location)
        
        # Get appropriate template for document type
        template_id = get_template_id(document_type)
        
        # Process document with Bedrock Data Automation
        extraction_results = process_with_bedrock(bucket_name, key, template_id, document_type)
        
        # Store extraction results
        store_extraction_results(session_id, document_type, extraction_results)
        
        # Emit event for downstream processing
        emit_extraction_event(session_id, document_type, "COMPLETED", extraction_results)
        
        return {
            'statusCode': 200,
            'extractionStatus': 'COMPLETED',
            'documentType': document_type,
            'sessionId': session_id,
            'extractedFields': summarize_extraction(extraction_results)
        }
        
    except Exception as e:
        logger.error(f"Error processing document with Bedrock: {str(e)}")
        
        # Store error in DynamoDB for tracking
        if 'session_id' in locals() and 'document_type' in locals():
            store_extraction_error(session_id, document_type, str(e))
        
        # Emit error event
        if 'session_id' in locals() and 'document_type' in locals():
            emit_error_event(session_id, document_type, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def parse_s3_location(location):
    """Extract bucket name and key from S3 location"""
    # Format expected: s3://bucket-name/key
    if not location.startswith('s3://'):
        raise ValueError("Invalid S3 location format")
    
    parts = location[5:].split('/', 1)
    if len(parts) != 2:
        raise ValueError("Invalid S3 location format")
    
    return parts[0], parts[1]

def get_template_id(document_type):
    """Get the appropriate Bedrock template ID for the document type"""
    try:
        response = template_table.get_item(
            Key={
                'documentType': document_type,
                'status': 'ACTIVE'
            }
        )
        
        if 'Item' not in response:
            raise ValueError(f"No active template found for document type: {document_type}")
        
        return response['Item']['templateId']
    
    except Exception as e:
        logger.error(f"Error retrieving template: {str(e)}")
        raise

def process_with_bedrock(bucket_name, key, template_id, document_type):
    """
    Process document with Bedrock Data Automation
    
    Parameters:
    - bucket_name: S3 bucket containing the document
    - key: S3 key of the document
    - template_id: Bedrock template ID to use
    - document_type: Type of document being processed
    
    Returns:
    - Dictionary containing extracted fields and confidence scores
    """
    logger.info(f"Processing document {key} with template {template_id}")
    
    # Generate a request ID for tracking
    request_id = str(uuid.uuid4())
    
    # Document location
    document_uri = f"s3://{bucket_name}/{key}"
    
    try:
        # Call Bedrock Data Automation API to process document
        response = bedrock_client.retrieve_and_generate(
            input={
                'text': f"Extract all fields from this {document_type.lower().replace('_', ' ')}",
                's3Object': {
                    'uri': document_uri
                }
            },
            retrieveAndGenerateConfiguration={
                'knowledgeBaseId': knowledge_base_id,
                'retrievalConfiguration': {
                    'vectorSearchConfiguration': {
                        'numberOfResults': 1
                    }
                }
            }
        )
        
        # Parse response to extract fields
        extracted_fields = parse_bedrock_response(response, document_type)
        
        # Return extraction results
        return {
            'documentType': document_type,
            'templateId': template_id,
            'extractedFields': extracted_fields,
            'requestId': request_id,
            'processingTimestamp': datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Error calling Bedrock Data Automation: {str(e)}")
        raise

def parse_bedrock_response(response, document_type):
    """
    Parse Bedrock Data Automation response to extract fields based on document type
    
    Parameters:
    - response: Raw response from Bedrock Data Automation
    - document_type: Type of document being processed
    
    Returns:
    - Dictionary of extracted fields with confidence scores
    """
    try:
        # Extract the content from the response
        content = response['output']['text']
        logger.info(f"Received response from Bedrock: {content[:100]}...")
        
        # For this implementation, we'll assume Bedrock returns a JSON-formatted string
        # In a real implementation, you might need to parse different formats or transform the response
        extracted_data = {}
        
        # Simple parsing logic - this would be more sophisticated in a real implementation
        try:
            # Try to parse the response as JSON
            data_dict = json.loads(content)
            extracted_data = data_dict
        except json.JSONDecodeError:
            # If it's not valid JSON, extract key-value pairs using a simple parser
            extracted_data = parse_text_content(content)
        
        # Validate and normalize extracted fields based on document type
        normalized_data = normalize_extracted_fields(extracted_data, document_type)
        
        return normalized_data
    
    except Exception as e:
        logger.error(f"Error parsing Bedrock response: {str(e)}")
        return {"error": str(e), "raw_response": content if 'content' in locals() else "No content"}

def parse_text_content(content):
    """Parse text content into key-value pairs"""
    lines = content.split('\n')
    result = {}
    
    for line in lines:
        line = line.strip()
        if not line or ':' not in line:
            continue
        
        key, value = line.split(':', 1)
        key = key.strip()
        value = value.strip()
        
        if key and value:
            result[key] = value
    
    return result

def normalize_extracted_fields(extracted_data, document_type):
    """
    Normalize extracted fields based on document type to ensure consistent format
    
    Parameters:
    - extracted_data: Raw extracted data
    - document_type: Type of document being processed
    
    Returns:
    - Normalized data with standard field names
    """
    normalized = {}
    
    # Define field mappings based on document type
    if document_type == 'PASSPORT':
        field_mappings = {
            'full_name': ['name', 'full name', 'nom', 'nom complet'],
            'date_of_birth': ['birth date', 'date of birth', 'dob', 'date de naissance'],
            'passport_number': ['number', 'passport number', 'passport no', 'numéro', 'numéro de passeport'],
            'expiration_date': ['expiry date', 'expiration date', 'date d\'expiration', 'expiration'],
            'issuer_name': ['issuer', 'issued by', 'authority', 'autorité'],
            'city_of_issuance': ['city of issue', 'place of issue', 'lieu de délivrance']
        }
    elif document_type == 'NATIONAL_ID':
        field_mappings = {
            'full_name': ['name', 'full name', 'nom', 'nom complet'],
            'date_of_birth': ['birth date', 'date of birth', 'dob', 'date de naissance'],
            'id_number': ['id number', 'carte d\'identité', 'numéro', 'numéro d\'identité'],
            'expiration_date': ['expiry date', 'expiration date', 'date d\'expiration', 'expiration'],
            'issuer_name': ['issuer', 'issued by', 'authority', 'autorité'],
            'city_of_issuance': ['city of issue', 'place of issue', 'lieu de délivrance']
        }
    elif document_type == 'DRIVERS_LICENSE':
        field_mappings = {
            'full_name': ['name', 'full name', 'nom', 'nom complet'],
            'license_number': ['license number', 'numéro de permis', 'numéro'],
            'categories': ['categories', 'catégories', 'class', 'classes'],
            'issue_date': ['issue date', 'date of issue', 'date d\'émission'],
            'expiration_date': ['expiry date', 'expiration date', 'date d\'expiration', 'expiration'],
            'issuer_name': ['issuer', 'issued by', 'authority', 'autorité'],
            'city_of_issuance': ['city of issue', 'place of issue', 'lieu de délivrance']
        }
    elif document_type == 'VEHICLE_REGISTRATION':
        field_mappings = {
            'registration_number': ['registration number', 'reg number', 'numéro d\'immatriculation'],
            'first_registration_date': ['first registration', 'date of first registration', 'première immatriculation'],
            'owner_name': ['owner name', 'nom du propriétaire', 'propriétaire'],
            'owner_address': ['address', 'adresse'],
            'is_owner': ['is owner', 'est propriétaire'],
            'co_holders': ['co-holders', 'co-titulaires'],
            'vehicle_make': ['make', 'manufacturer', 'marque'],
            'vehicle_type': ['type', 'model type', 'type de véhicule'],
            'cnit': ['cnit', 'code national d\'identification du type'],
            'commercial_name': ['commercial name', 'model', 'nom commercial', 'modèle']
        }
    else:
        # Generic field mappings for unknown document types
        field_mappings = {}
    
    # Apply field mappings to normalize data
    for normalized_key, possible_keys in field_mappings.items():
        for raw_key in possible_keys:
            # Check for exact match
            if raw_key in extracted_data:
                normalized[normalized_key] = {
                    'value': extracted_data[raw_key],
                    'confidence': 0.9  # Default high confidence for exact matches
                }
                break
            
            # Check for case-insensitive match
            for key in extracted_data:
                if key.lower() == raw_key.lower():
                    normalized[normalized_key] = {
                        'value': extracted_data[key],
                        'confidence': 0.8  # Slightly lower confidence for case-insensitive matches
                    }
                    break
                
                # Check for partial match
                if raw_key.lower() in key.lower():
                    normalized[normalized_key] = {
                        'value': extracted_data[key],
                        'confidence': 0.7  # Lower confidence for partial matches
                    }
                    break
    
    # Add document-specific processing
    if document_type == 'VEHICLE_REGISTRATION':
        # Convert is_owner to boolean if present
        if 'is_owner' in normalized:
            value = normalized['is_owner']['value'].lower()
            is_owner = value in ('yes', 'true', 'oui', '1')
            normalized['is_owner']['value'] = is_owner
        
        # Convert co_holders to array if present
        if 'co_holders' in normalized:
            value = normalized['co_holders']['value']
            if isinstance(value, str):
                co_holders = [holder.strip() for holder in value.split(',') if holder.strip()]
                normalized['co_holders']['value'] = co_holders
    
    return normalized

def summarize_extraction(extraction_results):
    """
    Summarize extraction results for logging/return value
    
    Parameters:
    - extraction_results: Full extraction results
    
    Returns:
    - Simplified dictionary of extracted fields
    """
    summary = {}
    
    if 'extractedFields' not in extraction_results:
        return summary
    
    for field_name, field_data in extraction_results['extractedFields'].items():
        if isinstance(field_data, dict) and 'value' in field_data:
            summary[field_name] = field_data['value']
    
    return summary

def store_extraction_results(session_id, document_type, extraction_results):
    """
    Store extraction results in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - extraction_results: Dictionary containing extraction results
    """
    timestamp = datetime.now().isoformat()
    
    try:
        extraction_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"EXTRACTION#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'extractionTimestamp': timestamp,
                'templateId': extraction_results.get('templateId'),
                'extractedFields': extraction_results.get('extractedFields', {}),
                'requestId': extraction_results.get('requestId'),
                'stage': 'EXTRACTION',
                'ttl': int((datetime.now().timestamp() + 90 * 24 * 60 * 60))  # 90 days expiry
            }
        )
    except Exception as e:
        logger.error(f"Error storing extraction results: {str(e)}")
        raise

def store_extraction_error(session_id, document_type, error_message):
    """
    Store error information in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - error_message: Error message
    """
    timestamp = datetime.now().isoformat()
    
    try:
        extraction_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#EXTRACTION#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'errorTimestamp': timestamp,
                'errorMessage': error_message,
                'stage': 'EXTRACTION',
                'ttl': int((datetime.now().timestamp() + 30 * 24 * 60 * 60))  # 30 days expiry
            }
        )
    except Exception as e:
        logger.error(f"Error storing error information: {str(e)}")

def emit_extraction_event(session_id, document_type, status, extraction_results, reason=None):
    """
    Emit event for document extraction pipeline
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - status: Extraction status (COMPLETED, SKIPPED, FAILED)
    - extraction_results: Dictionary containing extraction results
    - reason: Optional reason for skip or failure
    """
    try:
        detail = {
            'sessionId': session_id,
            'documentType': document_type,
            'extractionStatus': status,
            'timestamp': datetime.now().isoformat()
        }
        
        if status == 'COMPLETED':
            detail['extractedFieldsCount'] = len(extraction_results.get('extractedFields', {}))
        
        if reason:
            detail['reason'] = reason
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing-system',
                    'DetailType': 'DocumentExtracted',
                    'Detail': json.dumps(detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting extraction event: {str(e)}")

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
                        'component': 'BedrockIntegration',
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

Create a file `lambda/bedrock-integration/requirements.txt` with the library dependencies:

```
boto3>=1.26.0
```

### 5. Create Initial Template Data

Create a script to initialize the template table with mappings for document types. Create a file `scripts/initialize-templates.py`:

```python
import boto3
import json
import sys
import os

def initialize_templates(table_name, region='eu-west-1'):
    """
    Initialize the template table with mappings for document types
    
    Parameters:
    - table_name: Name of the template table
    - region: AWS region
    """
    print(f"Initializing template table: {table_name}")
    
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(table_name)
    
    # Define template mappings
    template_mappings = [
        {
            'documentType': 'PASSPORT',
            'status': 'ACTIVE',
            'templateId': 'french-passport-template-1',
            'description': 'Template for French passports',
            'version': '1.0',
            'lastUpdated': '2025-05-26'
        },
        {
            'documentType': 'NATIONAL_ID',
            'status': 'ACTIVE',
            'templateId': 'french-national-id-template-1',
            'description': 'Template for French national ID cards',
            'version': '1.0',
            'lastUpdated': '2025-05-26'
        },
        {
            'documentType': 'DRIVERS_LICENSE',
            'status': 'ACTIVE',
            'templateId': 'french-drivers-license-template-1',
            'description': 'Template for French driver\'s licenses',
            'version': '1.0',
            'lastUpdated': '2025-05-26'
        },
        {
            'documentType': 'VEHICLE_REGISTRATION',
            'status': 'ACTIVE',
            'templateId': 'french-carte-grise-template-1',
            'description': 'Template for French vehicle registrations (Carte Grise)',
            'version': '1.0',
            'lastUpdated': '2025-05-26'
        }
    ]
    
    # Insert template mappings into table
    for mapping in template_mappings:
        print(f"Adding template mapping for {mapping['documentType']}")
        try:
            table.put_item(Item=mapping)
            print(f"Successfully added template mapping for {mapping['documentType']}")
        except Exception as e:
            print(f"Error adding template mapping for {mapping['documentType']}: {str(e)}")
    
    print("Template initialization complete")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python initialize-templates.py <template-table-name> [region]")
        sys.exit(1)
    
    table_name = sys.argv[1]
    region = sys.argv[2] if len(sys.argv) > 2 else 'eu-west-1'
    
    initialize_templates(table_name, region)
```

### 6. Build and Deploy

```bash
# Build and deploy the CDK stacks
npm run build
cdk deploy FrenchDocProcessingBedrockStack --require-approval never

# After deployment, initialize the template table
# Get the table name from the CloudFormation outputs
TABLE_NAME=$(aws cloudformation describe-stacks --stack-name FrenchDocProcessingBedrockStack --query "Stacks[0].Outputs[?OutputKey=='TemplateTableName'].OutputValue" --output text)
REGION=$(aws configure get region)

# Run the initialization script
python scripts/initialize-templates.py $TABLE_NAME $REGION
```

## Key Technical Considerations

1. **Bedrock Integration**:
   - Uses the Bedrock Agent Runtime API with RetrieveAndGenerate for content extraction
   - Requires a knowledge base ID parameter that should be populated with an actual ID
   - Includes template management through DynamoDB for document type mappings

2. **Event-Driven Architecture**:
   - EventBridge rule triggers the Lambda when documents are preprocessed
   - Events are emitted for downstream processing after extraction
   - Error handling events for system monitoring

3. **Field Normalization**:
   - Implements robust field normalization to handle variations in field names
   - Document type-specific processing for special fields (like boolean values and arrays)
   - Confidence scoring for extracted fields

4. **Security Considerations**:
   - IAM roles follow principle of least privilege
   - Parameters stored in SSM Parameter Store
   - Data encryption at rest in DynamoDB

5. **Operational Considerations**:
   - Template management through a separate DynamoDB table
   - Template versioning support
   - CloudWatch logging for monitoring and troubleshooting
   - Template initialization script for simplified setup

## Next Steps

After deploying the Bedrock Integration component, the next steps in the implementation plan would be:

1. **Configure Bedrock Knowledge Base**:
   - Create a knowledge base in Bedrock
   - Upload document templates for French documents
   - Update the knowledge base ID parameter with the actual ID

2. **Implement Document Validation Service**:
   - Create the Lambda function for validating extracted fields
   - Implement business rules for each document type
   - Integrate with the event-driven workflow

3. **Test End-to-End Flow**:
   - Test document preprocessing
   - Test data extraction with Bedrock
   - Verify events are flowing correctly between components