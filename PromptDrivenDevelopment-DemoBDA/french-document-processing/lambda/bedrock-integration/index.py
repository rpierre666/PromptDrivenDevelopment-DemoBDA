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
                'reason': f"Document quality status: {quality_status}"
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
            # If no specific template is found, use default
            logger.warning(f"No specific template found for {document_type}, using default")
            return get_default_template_id(document_type)
        
        return response['Item']['templateId']
    
    except Exception as e:
        logger.error(f"Error retrieving template: {str(e)}")
        raise

def get_default_template_id(document_type):
    """Get a default template ID based on document type"""
    # In a real implementation, you might have default templates for each document type
    # For now, return placeholder values
    templates = {
        'PASSPORT': 'french-passport-template',
        'NATIONAL_ID': 'french-national-id-template',
        'DRIVERS_LICENSE': 'french-drivers-license-template',
        'VEHICLE_REGISTRATION': 'french-vehicle-registration-template'
    }
    
    return templates.get(document_type, 'default-french-document-template')

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
        # In a real implementation, you'd parse the specific response format from Bedrock
        extracted_data = {}
        
        # Apply document-specific parsing logic
        if document_type == 'PASSPORT':
            extracted_data = extract_passport_fields(content)
        elif document_type == 'NATIONAL_ID':
            extracted_data = extract_national_id_fields(content)
        elif document_type == 'DRIVERS_LICENSE':
            extracted_data = extract_drivers_license_fields(content)
        elif document_type == 'VEHICLE_REGISTRATION':
            extracted_data = extract_vehicle_registration_fields(content)
        else:
            # Generic extraction
            extracted_data = extract_generic_fields(content)
        
        return extracted_data
        
    except Exception as e:
        logger.error(f"Error parsing Bedrock response: {str(e)}")
        return {}

def extract_passport_fields(content):
    """Extract fields from passport document response"""
    # In a real implementation, you would parse the specific JSON structure
    # or other format returned by Bedrock
    # For this example, we'll return a mock structure
    return {
        'full_name': {
            'value': 'MARTIN DUBOIS',
            'confidence': 0.98
        },
        'date_of_birth': {
            'value': '1985-04-15',
            'confidence': 0.95
        },
        'passport_number': {
            'value': '12AB34567',
            'confidence': 0.99
        },
        'expiration_date': {
            'value': '2030-01-01',
            'confidence': 0.97
        },
        'issuer_name': {
            'value': 'RÉPUBLIQUE FRANÇAISE',
            'confidence': 0.99
        },
        'city_of_issuance': {
            'value': 'PARIS',
            'confidence': 0.94
        }
    }

def extract_national_id_fields(content):
    """Extract fields from national ID document response"""
    # Similar to passport extraction but with ID-specific fields
    return {
        'full_name': {
            'value': 'MARTIN DUBOIS',
            'confidence': 0.98
        },
        'date_of_birth': {
            'value': '1985-04-15',
            'confidence': 0.95
        },
        'id_number': {
            'value': '123456789012',
            'confidence': 0.99
        },
        'expiration_date': {
            'value': '2030-01-01',
            'confidence': 0.97
        },
        'issuer_name': {
            'value': 'RÉPUBLIQUE FRANÇAISE',
            'confidence': 0.99
        },
        'city_of_issuance': {
            'value': 'LYON',
            'confidence': 0.94
        }
    }

def extract_drivers_license_fields(content):
    """Extract fields from driver's license document response"""
    return {
        'full_name': {
            'value': 'MARTIN DUBOIS',
            'confidence': 0.97
        },
        'license_number': {
            'value': 'DL123456789',
            'confidence': 0.98
        },
        'categories': {
            'value': ['B', 'A'],
            'confidence': 0.95
        },
        'issue_date': {
            'value': '2015-06-10',
            'confidence': 0.96
        },
        'expiration_date': {
            'value': '2035-06-10',
            'confidence': 0.96
        },
        'issuer_name': {
            'value': 'PRÉFECTURE DE POLICE',
            'confidence': 0.98
        },
        'city_of_issuance': {
            'value': 'PARIS',
            'confidence': 0.93
        }
    }

def extract_vehicle_registration_fields(content):
    """Extract fields from vehicle registration document response"""
    return {
        'registration_number': {
            'value': 'AB-123-CD',
            'confidence': 0.99
        },
        'first_registration_date': {
            'value': '2018-09-23',
            'confidence': 0.96
        },
        'owner_name': {
            'value': 'MARTIN DUBOIS',
            'confidence': 0.97
        },
        'address': {
            'value': '123 RUE DE LA RÉPUBLIQUE, 75001 PARIS',
            'confidence': 0.92
        },
        'is_owner': {
            'value': True,
            'confidence': 0.95
        },
        'co_holders': {
            'value': [],
            'confidence': 0.99
        },
        'vehicle_make': {
            'value': 'PEUGEOT',
            'confidence': 0.98
        },
        'vehicle_type': {
            'value': '208',
            'confidence': 0.97
        },
        'cnit': {
            'value': 'MRE9X4G0E0A123456',
            'confidence': 0.95
        },
        'commercial_name': {
            'value': '208 ACTIVE',
            'confidence': 0.93
        }
    }

def extract_generic_fields(content):
    """Extract fields from generic document response"""
    # Fallback extraction for unknown document types
    # In a real implementation, you would apply generic extraction logic
    return {}

def store_extraction_results(session_id, document_type, extraction_results):
    """
    Store extraction results in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document processed
    - extraction_results: Results from Bedrock extraction
    """
    try:
        timestamp = datetime.now().isoformat()
        ttl = int((datetime.now().timestamp() + (90 * 24 * 60 * 60)))  # 90 days TTL
        
        # Extract confidence scores for fields
        confidence_scores = {}
        for field, data in extraction_results.get('extractedFields', {}).items():
            if isinstance(data, dict) and 'confidence' in data:
                confidence_scores[field] = data['confidence']
        
        # Calculate overall confidence as average of field confidences
        overall_confidence = 0.0
        if confidence_scores:
            overall_confidence = sum(confidence_scores.values()) / len(confidence_scores)
        
        # Store in DynamoDB
        extraction_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"EXTRACTION#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'timestamp': timestamp,
                'ttl': ttl,
                'templateId': extraction_results.get('templateId', ''),
                'extractedFields': extraction_results.get('extractedFields', {}),
                'confidenceScores': confidence_scores,
                'overallConfidence': overall_confidence,
                'requestId': extraction_results.get('requestId', '')
            }
        )
        
        logger.info(f"Stored extraction results for {session_id}-{document_type}")
        
    except Exception as e:
        logger.error(f"Error storing extraction results: {str(e)}")
        raise

def store_extraction_error(session_id, document_type, error_message):
    """Store extraction error in DynamoDB for tracking"""
    try:
        timestamp = datetime.now().isoformat()
        ttl = int((datetime.now().timestamp() + (30 * 24 * 60 * 60)))  # 30 days TTL
        
        extraction_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"EXTRACTION_ERROR#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'timestamp': timestamp,
                'ttl': ttl,
                'errorMessage': error_message,
                'status': 'ERROR'
            }
        )
        
        logger.info(f"Stored extraction error for {session_id}-{document_type}")
        
    except Exception as e:
        logger.error(f"Error storing extraction error: {str(e)}")
        # Don't raise here to avoid recursive error handling

def emit_extraction_event(session_id, document_type, status, extraction_results, reason=None):
    """Emit event for downstream processing"""
    try:
        timestamp = datetime.now().isoformat()
        
        # Basic event details
        event_detail = {
            'sessionId': session_id,
            'documentType': document_type,
            'extractionStatus': status,
            'timestamp': timestamp
        }
        
        # Add extraction metrics if available
        if extraction_results and 'extractedFields' in extraction_results:
            field_count = len(extraction_results['extractedFields'])
            
            # Calculate overall confidence
            confidence_sum = 0
            confidence_count = 0
            for field, data in extraction_results['extractedFields'].items():
                if isinstance(data, dict) and 'confidence' in data:
                    confidence_sum += data['confidence']
                    confidence_count += 1
            
            overall_confidence = confidence_sum / confidence_count if confidence_count > 0 else 0
            
            event_detail.update({
                'fieldCount': field_count,
                'averageConfidence': overall_confidence
            })
        
        # Add reason if provided
        if reason:
            event_detail['reason'] = reason
        
        # Put event on the event bus
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing-system',
                    'DetailType': 'DocumentExtracted',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
        
        logger.info(f"Emitted extraction event for {session_id}-{document_type} with status {status}")
        
    except Exception as e:
        logger.error(f"Error emitting extraction event: {str(e)}")
        # Don't raise here to avoid affecting the main flow

def emit_error_event(session_id, document_type, error_message):
    """Emit error event"""
    try:
        timestamp = datetime.now().isoformat()
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing-system',
                    'DetailType': 'DocumentProcessingError',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'documentType': document_type,
                        'errorType': 'EXTRACTION_ERROR',
                        'errorMessage': error_message,
                        'timestamp': timestamp
                    }),
                    'EventBusName': event_bus_name
                }
            ]
        )
        
        logger.info(f"Emitted error event for {session_id}-{document_type}")
        
    except Exception as e:
        logger.error(f"Error emitting error event: {str(e)}")
        # Don't raise here to avoid recursive error handling

def summarize_extraction(extraction_results):
    """
    Create a summary of extraction results for the response
    
    Parameters:
    - extraction_results: Full extraction results
    
    Returns:
    - Dictionary with field names and values (without confidence scores)
    """
    summary = {}
    
    for field, data in extraction_results.get('extractedFields', {}).items():
        if isinstance(data, dict) and 'value' in data:
            summary[field] = data['value']
    
    return summary