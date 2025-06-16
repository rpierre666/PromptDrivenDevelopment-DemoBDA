# Bedrock Data Automation Integration Implementation

This document provides the implementation for the Bedrock Data Automation Integration component of the French Official Documents Processing System. This component is the second critical component in our implementation plan, responsible for leveraging AWS Bedrock Data Automation with pre-built templates to extract data from French official documents.

## 1. Component Overview

The Bedrock Data Automation Integration is responsible for:
- Connecting to AWS Bedrock Data Automation service
- Loading and applying appropriate pre-built templates based on document type
- Extracting required fields from French official documents (Passport/ID, Driver's License, Carte Grise)
- Transforming and normalizing extracted data
- Managing template versions and improvements
- Providing extracted data for downstream validation and processing

## 2. Architecture Design

### 2.1 Component Architecture

The Bedrock Data Automation Integration is implemented as an AWS Lambda function that processes pre-processed documents. It interfaces with the Bedrock Data Automation service and provides extracted data back to the orchestration workflow.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ AWS Step        │────▶│ Bedrock           │────▶│ AWS Bedrock Data  │────▶│ Extraction     │
│ Functions       │     │ Integration Lambda │     │ Automation Service│     │ Results Handler│
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ S3 Processed │                                    │ DynamoDB         │
                        │ Documents    │                                    │ Extraction       │
                        │              │                                    │ Results          │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge event from Document Pre-processor
   - Document location in S3
   - Document type metadata

2. **Output**:
   - Extracted document data stored in DynamoDB
   - Extraction status and confidence metrics
   - Event notification for downstream validation

## 3. Implementation

### 3.1 AWS Lambda Function

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
        
        # Parse the JSON response from Bedrock
        # Note: Actual implementation will depend on Bedrock's response format
        # This is a simplified version assuming Bedrock returns a JSON-like structure
        extracted_data = {}
        
        # Parse based on document type
        if document_type in ['PASSPORT', 'NATIONAL_ID']:
            extracted_data = parse_identity_document(content)
        elif document_type == 'DRIVERS_LICENSE':
            extracted_data = parse_drivers_license(content)
        elif document_type == 'VEHICLE_REGISTRATION':
            extracted_data = parse_vehicle_registration(content)
        else:
            logger.warning(f"Unknown document type: {document_type}")
            extracted_data = parse_generic_document(content)
            
        # Validate extracted data against required fields
        validate_extraction(extracted_data, document_type)
        
        return extracted_data
        
    except Exception as e:
        logger.error(f"Error parsing Bedrock response: {str(e)}")
        raise

def parse_identity_document(content):
    """
    Parse identity document (passport or national ID) fields from Bedrock response
    
    This is a simplified implementation. In a real-world scenario, the parsing would be
    more sophisticated based on Bedrock's actual response format.
    """
    # Example parsing logic - adapt based on actual Bedrock response format
    import re
    
    fields = {}
    
    # Extract common identity document fields with confidence scores
    name_match = re.search(r"full[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if name_match:
        fields['full_name'] = {
            'value': name_match.group(1).strip(),
            'confidence': float(name_match.group(2))
        }
        
    dob_match = re.search(r"date[_\s]?of[_\s]?birth:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if dob_match:
        fields['date_of_birth'] = {
            'value': dob_match.group(1).strip(),
            'confidence': float(dob_match.group(2))
        }
    
    # Extract document number based on type hints in the content
    if "passport" in content.lower():
        doc_match = re.search(r"passport[_\s]?number:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
        fields['document_type'] = {'value': 'PASSPORT', 'confidence': 1.0}
    else:
        doc_match = re.search(r"id[_\s]?number:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
        fields['document_type'] = {'value': 'NATIONAL_ID', 'confidence': 1.0}
        
    if doc_match:
        fields['document_number'] = {
            'value': doc_match.group(1).strip(),
            'confidence': float(doc_match.group(2))
        }
    
    # Extract expiration date
    exp_match = re.search(r"expiration[_\s]?date:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if exp_match:
        fields['expiration_date'] = {
            'value': exp_match.group(1).strip(),
            'confidence': float(exp_match.group(2))
        }
    
    # Extract issuer name
    issuer_match = re.search(r"issuer[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if issuer_match:
        fields['issuer_name'] = {
            'value': issuer_match.group(1).strip(),
            'confidence': float(issuer_match.group(2))
        }
    
    # Extract city of issuance
    city_match = re.search(r"city[_\s]?of[_\s]?issuance:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if city_match:
        fields['city_of_issuance'] = {
            'value': city_match.group(1).strip(),
            'confidence': float(city_match.group(2))
        }
        
    return fields

def parse_drivers_license(content):
    """Parse driver's license fields from Bedrock response"""
    import re
    
    fields = {}
    
    # Extract driver's license fields with confidence scores
    name_match = re.search(r"full[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if name_match:
        fields['full_name'] = {
            'value': name_match.group(1).strip(),
            'confidence': float(name_match.group(2))
        }
    
    license_match = re.search(r"license[_\s]?number:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if license_match:
        fields['license_number'] = {
            'value': license_match.group(1).strip(),
            'confidence': float(license_match.group(2))
        }
    
    # Extract categories (may be multiple)
    cat_match = re.search(r"categories:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if cat_match:
        # Split categories by comma or space
        categories = [cat.strip() for cat in re.split(r'[,\s]+', cat_match.group(1)) if cat.strip()]
        fields['categories'] = {
            'value': categories,
            'confidence': float(cat_match.group(2))
        }
    
    # Extract issue date
    issue_match = re.search(r"issue[_\s]?date:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if issue_match:
        fields['issue_date'] = {
            'value': issue_match.group(1).strip(),
            'confidence': float(issue_match.group(2))
        }
    
    # Extract expiration date
    exp_match = re.search(r"expiration[_\s]?date:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if exp_match:
        fields['expiration_date'] = {
            'value': exp_match.group(1).strip(),
            'confidence': float(exp_match.group(2))
        }
    
    # Extract issuer name
    issuer_match = re.search(r"issuer[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if issuer_match:
        fields['issuer_name'] = {
            'value': issuer_match.group(1).strip(),
            'confidence': float(issuer_match.group(2))
        }
    
    # Extract city of issuance
    city_match = re.search(r"city[_\s]?of[_\s]?issuance:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if city_match:
        fields['city_of_issuance'] = {
            'value': city_match.group(1).strip(),
            'confidence': float(city_match.group(2))
        }
    
    return fields

def parse_vehicle_registration(content):
    """Parse vehicle registration (Carte Grise) fields from Bedrock response"""
    import re
    
    fields = {}
    
    # Extract vehicle registration fields with confidence scores
    reg_match = re.search(r"registration[_\s]?number:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if reg_match:
        fields['registration_number'] = {
            'value': reg_match.group(1).strip(),
            'confidence': float(reg_match.group(2))
        }
    
    # Extract first registration date
    first_reg_match = re.search(r"first[_\s]?registration[_\s]?date:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if first_reg_match:
        fields['first_registration_date'] = {
            'value': first_reg_match.group(1).strip(),
            'confidence': float(first_reg_match.group(2))
        }
    
    # Extract owner name
    owner_match = re.search(r"owner[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if owner_match:
        fields['owner_name'] = {
            'value': owner_match.group(1).strip(),
            'confidence': float(owner_match.group(2))
        }
    
    # Extract address
    address_match = re.search(r"address:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if address_match:
        fields['address'] = {
            'value': address_match.group(1).strip(),
            'confidence': float(address_match.group(2))
        }
    
    # Extract is_owner flag
    is_owner_match = re.search(r"is[_\s]?owner:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if is_owner_match:
        is_owner_value = is_owner_match.group(1).strip().lower()
        fields['is_owner'] = {
            'value': is_owner_value in ['true', 'yes', '1'],
            'confidence': float(is_owner_match.group(2))
        }
    
    # Extract co-holders
    co_holders_match = re.search(r"co[_\s]?holders:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if co_holders_match:
        # Split co-holders by comma
        co_holders = [holder.strip() for holder in co_holders_match.group(1).split(',') if holder.strip()]
        fields['co_holders'] = {
            'value': co_holders,
            'confidence': float(co_holders_match.group(2))
        }
    
    # Extract vehicle make
    make_match = re.search(r"vehicle[_\s]?make:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if make_match:
        fields['vehicle_make'] = {
            'value': make_match.group(1).strip(),
            'confidence': float(make_match.group(2))
        }
    
    # Extract vehicle type
    type_match = re.search(r"vehicle[_\s]?type:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if type_match:
        fields['vehicle_type'] = {
            'value': type_match.group(1).strip(),
            'confidence': float(type_match.group(2))
        }
    
    # Extract CNIT (Code National d'Identification du Type)
    cnit_match = re.search(r"cnit:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if cnit_match:
        fields['cnit'] = {
            'value': cnit_match.group(1).strip(),
            'confidence': float(cnit_match.group(2))
        }
    
    # Extract commercial name
    name_match = re.search(r"commercial[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    if name_match:
        fields['commercial_name'] = {
            'value': name_match.group(1).strip(),
            'confidence': float(name_match.group(2))
        }
    
    return fields

def parse_generic_document(content):
    """Parse generic document when type is unknown"""
    # Simple fallback that tries to extract common fields
    import re
    
    fields = {}
    
    # Look for any dates
    date_matches = re.finditer(r"(\w+)[_\s]?date:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    for match in date_matches:
        field_name = match.group(1).lower() + "_date"
        fields[field_name] = {
            'value': match.group(2).strip(),
            'confidence': float(match.group(3))
        }
    
    # Look for any numbers
    number_matches = re.finditer(r"(\w+)[_\s]?number:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    for match in number_matches:
        field_name = match.group(1).lower() + "_number"
        fields[field_name] = {
            'value': match.group(2).strip(),
            'confidence': float(match.group(3))
        }
    
    # Look for name fields
    name_matches = re.finditer(r"(\w+)[_\s]?name:[\s\"]*(.*?)[\"\s]*confidence:[\s]*([\d.]+)", content, re.IGNORECASE)
    for match in name_matches:
        field_name = match.group(1).lower() + "_name"
        fields[field_name] = {
            'value': match.group(2).strip(),
            'confidence': float(match.group(3))
        }
    
    return fields

def validate_extraction(extracted_data, document_type):
    """
    Validate extracted fields against required fields for the document type
    
    Parameters:
    - extracted_data: Dictionary of extracted fields with confidence scores
    - document_type: Type of document being processed
    
    Returns:
    - None, raises exception if validation fails
    """
    # Define required fields by document type
    required_fields = {
        'PASSPORT': ['full_name', 'date_of_birth', 'document_number', 'expiration_date'],
        'NATIONAL_ID': ['full_name', 'date_of_birth', 'document_number', 'expiration_date'],
        'DRIVERS_LICENSE': ['full_name', 'license_number', 'categories', 'expiration_date'],
        'VEHICLE_REGISTRATION': ['registration_number', 'owner_name', 'vehicle_make']
    }
    
    if document_type not in required_fields:
        logger.warning(f"Unknown document type for validation: {document_type}")
        return
    
    # Check if all required fields are present and have sufficient confidence
    missing_fields = []
    low_confidence_fields = []
    
    for field in required_fields[document_type]:
        if field not in extracted_data:
            missing_fields.append(field)
        elif extracted_data[field]['confidence'] < confidence_threshold:
            low_confidence_fields.append(field)
    
    if missing_fields:
        logger.warning(f"Missing required fields for {document_type}: {missing_fields}")
    
    if low_confidence_fields:
        logger.warning(f"Low confidence fields for {document_type}: {low_confidence_fields}")
    
    # If critical fields are missing, consider it a validation failure
    if len(missing_fields) > len(required_fields[document_type]) / 3:  # If more than 1/3 of fields are missing
        raise ValueError(f"Too many required fields missing for {document_type}: {missing_fields}")

def store_extraction_results(session_id, document_type, extraction_results):
    """Store document extraction results in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        extraction_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"EXTRACTION#{document_type}",
                'sessionId': session_id,
                'documentType': document_type,
                'extractedFields': extraction_results['extractedFields'],
                'templateId': extraction_results['templateId'],
                'requestId': extraction_results['requestId'],
                'processingTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 7776000))  # 90 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing extraction results: {str(e)}")
        raise

def store_extraction_error(session_id, document_type, error_message):
    """Store document extraction error in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        extraction_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#EXTRACTION#{document_type}#{timestamp}",
                'sessionId': session_id,
                'documentType': document_type,
                'errorMessage': error_message,
                'errorTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 2592000))  # 30 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing extraction error: {str(e)}")

def emit_extraction_event(session_id, document_type, status, extraction_results, reason=None):
    """Emit document extraction event to EventBridge"""
    event_detail = {
        'sessionId': session_id,
        'documentType': document_type,
        'extractionStatus': status,
        'timestamp': datetime.now().isoformat()
    }
    
    # Add reason if provided
    if reason:
        event_detail['reason'] = reason
    
    # Add summary of extracted fields if completed
    if status == "COMPLETED" and extraction_results:
        event_detail['extractedFieldsSummary'] = summarize_extraction(extraction_results)
    
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.bedrock-integration',
                    'DetailType': 'DocumentExtracted',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': 'document-processing-bus'
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting event: {str(e)}")

def emit_error_event(session_id, document_type, error_message):
    """Emit document extraction error event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.bedrock-integration',
                    'DetailType': 'DocumentExtractionError',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'documentType': document_type,
                        'errorMessage': error_message,
                        'timestamp': datetime.now().isoformat()
                    }),
                    'EventBusName': 'document-processing-bus'
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting error event: {str(e)}")

def summarize_extraction(extraction_results):
    """Create a summary of extracted fields for event details"""
    summary = {}
    
    if 'extractedFields' in extraction_results:
        for field, data in extraction_results['extractedFields'].items():
            # Only include fields with good confidence
            if data['confidence'] >= confidence_threshold:
                summary[field] = data['value']
    
    return summary
```

### 3.2 AWS CDK Infrastructure

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export class BedrockIntegrationStack extends cdk.Stack {
  public readonly bedrockIntegrationFunction: lambda.Function;
  public readonly extractionTable: dynamodb.Table;
  public readonly templateTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table for extraction results
    this.extractionTable = new dynamodb.Table(this, 'ExtractionResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Create DynamoDB table for template management
    this.templateTable = new dynamodb.Table(this, 'TemplateTable', {
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // Populate template table with default templates
    const templateData = [
      { documentType: 'PASSPORT', templateId: 'passport-template-v1', status: 'ACTIVE', version: '1.0' },
      { documentType: 'NATIONAL_ID', templateId: 'national-id-template-v1', status: 'ACTIVE', version: '1.0' },
      { documentType: 'DRIVERS_LICENSE', templateId: 'drivers-license-template-v1', status: 'ACTIVE', version: '1.0' },
      { documentType: 'VEHICLE_REGISTRATION', templateId: 'vehicle-reg-template-v1', status: 'ACTIVE', version: '1.0' }
    ];
    
    templateData.forEach((template, index) => {
      new cdk.CustomResource(this, `DefaultTemplate${index}`, {
        serviceToken: new lambda.Function(this, `TemplateWriter${index}`, {
          runtime: lambda.Runtime.NODEJS_18_X,
          code: lambda.Code.fromInline(`
            exports.handler = async (event) => {
              const AWS = require('aws-sdk');
              const dynamoDB = new AWS.DynamoDB.DocumentClient();
              const response = { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || Date.now().toString() };
              
              try {
                if (event.RequestType === 'Create' || event.RequestType === 'Update') {
                  await dynamoDB.put({
                    TableName: '${this.templateTable.tableName}',
                    Item: ${JSON.stringify(template)}
                  }).promise();
                }
                return response;
              } catch (error) {
                console.error('Error:', error);
                response.Status = 'FAILED';
                response.Reason = error.message;
                return response;
              }
            };
          `),
          handler: 'index.handler',
        }).functionArn,
      });
    });

    // Create Lambda function for Bedrock Data Automation integration
    this.bedrockIntegrationFunction = new lambda.Function(this, 'BedrockIntegrationFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/bedrock-integration'),
      handler: 'index.lambda_handler',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      environment: {
        EXTRACTION_TABLE_NAME: this.extractionTable.tableName,
        TEMPLATE_TABLE_NAME: this.templateTable.tableName,
        KNOWLEDGE_BASE_ID: 'your-knowledge-base-id', // Replace with actual knowledge base ID or use parameter
        CONFIDENCE_THRESHOLD: '0.7',  // Minimum confidence score for extracted fields
      },
    });

    // Grant permissions
    this.extractionTable.grantWriteData(this.bedrockIntegrationFunction);
    this.templateTable.grantReadData(this.bedrockIntegrationFunction);
    
    // Grant Bedrock Data Automation permissions
    this.bedrockIntegrationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:RetrieveAndGenerate',
          'bedrock:InvokeModel'
        ],
        resources: ['*'], // Scope down in production
      })
    );
    
    // Grant S3 read permissions (to read processed documents)
    this.bedrockIntegrationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: ['arn:aws:s3:::*/*'], // Scope down in production
      })
    );
    
    // Grant EventBridge permissions
    this.bedrockIntegrationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*'], // Scope down in production
      })
    );

    // EventBridge rule to trigger Bedrock Integration Lambda from Pre-processor events
    const documentProcessedRule = new events.Rule(this, 'DocumentProcessedRule', {
      eventPattern: {
        source: ['document-processing.pre-processor'],
        detailType: ['DocumentProcessed'],
      },
      targets: [new targets.LambdaFunction(this.bedrockIntegrationFunction)],
    });

    // EventBridge rule for extraction errors
    const extractionErrorRule = new events.Rule(this, 'ExtractionErrorRule', {
      eventPattern: {
        source: ['document-processing.bedrock-integration'],
        detailType: ['DocumentExtractionError'],
      },
      targets: [
        // Add target for handling extraction errors
        // For example, an SQS queue for manual review
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'ExtractionTableName', {
      value: this.extractionTable.tableName,
      description: 'The name of the DynamoDB table for extraction results',
    });
    
    new cdk.CfnOutput(this, 'TemplateTableName', {
      value: this.templateTable.tableName,
      description: 'The name of the DynamoDB table for template management',
    });
  }
}
```

## 4. Template Management

### 4.1 Template Structure

Templates in Bedrock Data Automation for French documents are defined with the following structure:

1. **Template Metadata**
   - Template ID
   - Document type
   - Version
   - Creation date
   - Last updated date
   - Status (ACTIVE, DEPRECATED, TESTING)

2. **Field Definitions**
   - Field name
   - Expected format (date, text, number, etc.)
   - Validation rules
   - Extraction hints (location, formatting, etc.)

3. **Document Layout**
   - Key regions of interest
   - Expected field positions
   - Reference points

### 4.2 Template Versioning Strategy

The system implements a versioning strategy to manage template updates:

1. **Development Process**
   - New templates are created with status 'TESTING'
   - Templates are validated against sample documents
   - Accuracy metrics are tracked and compared with existing templates

2. **Activation Process**
   - When a new template meets quality thresholds, it is marked as 'ACTIVE'
   - Previous active template is marked as 'DEPRECATED'
   - System continues using deprecated templates for a transition period

3. **Rollback Process**
   - If issues are detected with a new template, the system can revert to the previous version
   - Rollback triggers are based on extraction quality metrics

## 5. Field Extraction and Normalization

### 5.1 Data Extraction Strategy

The Bedrock Data Automation service extracts data from documents using trained models and templates:

1. **Template Application**
   - The system selects the appropriate template based on document type
   - Template guides the extraction process

2. **Field Extraction**
   - Text recognition extracts raw field values
   - Field positions and formatting hints improve accuracy
   - Confidence scores are assigned to each extracted field

3. **Validation**
   - Extracted fields are validated against expected formats
   - Format-specific validation (dates, numbers, etc.)
   - Required fields are checked for presence

### 5.2 Data Normalization

Extracted data is normalized to ensure consistency:

1. **Date Normalization**
   - All dates converted to ISO 8601 format (YYYY-MM-DD)
   - Different date formats (DD/MM/YYYY, MM/DD/YYYY) are handled

2. **Name Normalization**
   - Consistent capitalization
   - Handling of accented characters
   - Separation of first and last names

3. **Address Normalization**
   - Structured format with separate fields for street, city, postal code
   - Abbreviation expansion
   - Format standardization

### 5.3 Error Handling

The system handles various extraction errors:

1. **Missing Fields**
   - Detection of missing required fields
   - Confidence thresholds for partial extraction
   - Fallback to human review when necessary

2. **Low Confidence Extractions**
   - Flagging of fields with low confidence scores
   - Alternative extraction attempts
   - Human review triggers

3. **Format Errors**
   - Detection of incorrectly formatted fields
   - Correction attempts using formatting rules
   - Validation failure reporting

## 6. Testing and Evaluation

### 6.1 Testing Approach

The Bedrock Integration component is thoroughly tested using:

1. **Unit Testing**
   - Individual parsing functions
   - Error handling mechanisms
   - Template selection logic

2. **Integration Testing**
   - End-to-end flow from pre-processed document to extraction results
   - EventBridge event handling
   - DynamoDB storage functionality

3. **Accuracy Testing**
   - Known document samples with verified field values
   - Measurement of extraction accuracy
   - Confidence score evaluation

### 6.2 Evaluation Metrics

The system's extraction performance is evaluated using:

1. **Field Extraction Accuracy**
   - Percentage of correctly extracted fields
   - Field-specific accuracy rates
   - Error rates by field and document type

2. **Confidence Score Analysis**
   - Distribution of confidence scores
   - Correlation between confidence and accuracy
   - Threshold optimization

3. **Processing Time**
   - Total extraction time
   - Response time breakdown
   - Template application efficiency

## 7. Operation and Monitoring

### 7.1 Monitoring Setup

The Bedrock Integration component is monitored using:

1. **CloudWatch Metrics**
   - Extraction success/failure rate
   - Processing time
   - API call volume

2. **CloudWatch Alarms**
   - High failure rate alerts
   - Long processing time alerts
   - Service health monitoring

3. **Custom Metrics**
   - Field extraction quality by document type
   - Average confidence scores
   - Template performance metrics

### 7.2 Operational Procedures

Standard operating procedures for the Bedrock Integration component:

1. **Template Updates**
   - Testing procedure for new templates
   - Activation process
   - Monitoring period after activation
   - Rollback procedure

2. **Error Handling**
   - Manual review process for failed extractions
   - Correction workflow
   - Feedback loop for template improvement

3. **Performance Tuning**
   - Regular evaluation of confidence thresholds
   - Optimization of parsing rules
   - Template refinement based on error patterns

## 8. Future Enhancements

1. **Machine Learning Enhancements**
   - Custom model training for French document types
   - Feedback loop for continuous improvement
   - Adaptive confidence thresholds

2. **Advanced Template Management**
   - Automatic template version testing
   - A/B testing of template variations
   - Document version detection and adaptation

3. **Integration Improvements**
   - Direct API for real-time extraction
   - Batch processing capabilities
   - Enhanced error correction workflows

## 9. Security Considerations

1. **Data Protection**
   - Encryption of extracted personal data
   - Minimal storage of sensitive information
   - Secure handling of document images

2. **Access Control**
   - Role-based access to templates and extraction results
   - Audit logging of template changes
   - Principle of least privilege for all components

3. **Compliance**
   - GDPR compliance for personal data handling
   - Retention policies for extracted data
   - Data minimization practices