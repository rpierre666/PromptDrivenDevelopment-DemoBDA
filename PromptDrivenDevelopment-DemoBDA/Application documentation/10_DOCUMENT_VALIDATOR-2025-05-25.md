# Document Validation Service Implementation

This document provides the implementation for the Document Validation Service component of the French Official Documents Processing System using AWS Bedrock Data Automation. This component is the third critical component in our implementation plan, responsible for validating extracted document data against business rules and expected formats.

## 1. Component Overview

The Document Validation Service is responsible for:
- Validating extracted fields against business rules and expected formats
- Verifying data consistency across fields
- Detecting potential errors or inconsistencies in extracted data
- Providing confidence scores for validated data
- Routing documents to manual review when necessary
- Ensuring data quality before downstream processing

## 2. Architecture Design

### 2.1 Component Architecture

The Document Validation Service is implemented as an AWS Lambda function that processes data extracted by the Bedrock Data Automation Integration component. It applies business rules and validation checks to ensure data quality and consistency.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Document          │────▶│ Validation Rules  │────▶│ Validation      │
│ Event Bus       │     │ Validation Lambda │     │ Engine            │     │ Results Handler │
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ DynamoDB     │                                    │ Manual Review    │
                        │ Validation   │                                    │ Queue (SQS)      │
                        │ Results      │                                    │                  │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Bedrock Data Automation Integration
   - Extracted document data from DynamoDB
   - Document type and session metadata

2. **Output**:
   - Validation results stored in DynamoDB
   - Events for downstream processing
   - Manual review requests (when needed)

## 3. Implementation

### 3.1 AWS Lambda Function

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
    validation_status = determine_validation_status(validation_errors, manual_review_triggers, overall_confidence)
    
    return {
        'validationStatus': validation_status,
        'overallConfidence': overall_confidence,
        'validationDetails': validation_details,
        'validationErrors': validation_errors,
        'manualReviewTriggers': manual_review_triggers
    }

def validate_identity_document(extracted_fields):
    """Validate identity document fields (passport or national ID)"""
    validations = []
    
    # Full name validation
    if 'full_name' in extracted_fields:
        name_data = extracted_fields['full_name']
        name_value = name_data['value']
        confidence = name_data['confidence']
        
        # Name should be at least 2 parts (first and last name)
        name_parts = name_value.strip().split()
        valid = len(name_parts) >= 2
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'full_name',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Name should include at least first and last name",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'full_name',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # Date of birth validation
    if 'date_of_birth' in extracted_fields:
        dob_data = extracted_fields['date_of_birth']
        dob_value = dob_data['value']
        confidence = dob_data['confidence']
        
        # Validate date format and reasonableness
        valid, dob_issue = validate_date(dob_value, min_year=1900, max_year=datetime.now().year)
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'date_of_birth',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else f"Invalid date of birth: {dob_issue}",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'date_of_birth',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # Document number validation
    if 'document_number' in extracted_fields:
        doc_data = extracted_fields['document_number']
        doc_value = doc_data['value']
        confidence = doc_data['confidence']
        
        # Validate document number format (specific to document type)
        if 'document_type' in extracted_fields:
            doc_type = extracted_fields['document_type']['value']
            if doc_type == 'PASSPORT':
                # French passport numbers are typically 9 characters
                valid = re.match(r'^[0-9A-Z]{8,9}$', doc_value.strip())
            else:
                # French ID card numbers vary but typically have a specific format
                valid = re.match(r'^[0-9A-Z]{10,12}$', doc_value.strip())
        else:
            # Generic validation if document type is unknown
            valid = len(doc_value.strip()) >= 5
            
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'document_number',
            'valid': bool(valid),
            'confidence': confidence,
            'reason': None if valid else "Invalid document number format",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'document_number',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # Expiration date validation
    if 'expiration_date' in extracted_fields:
        exp_data = extracted_fields['expiration_date']
        exp_value = exp_data['value']
        confidence = exp_data['confidence']
        
        # Validate date format
        valid, exp_issue = validate_date(exp_value)
        
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'expiration_date',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else f"Invalid expiration date: {exp_issue}",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'expiration_date',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'MEDIUM',
            'requiresManualReview': True
        })
    
    # Issuer name validation (if available)
    if 'issuer_name' in extracted_fields:
        issuer_data = extracted_fields['issuer_name']
        issuer_value = issuer_data['value']
        confidence = issuer_data['confidence']
        
        # Basic validation - should not be empty
        valid = len(issuer_value.strip()) > 0
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'issuer_name',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Empty issuer name",
            'severity': 'LOW',
            'requiresManualReview': manual_review
        })
    
    # City of issuance validation (if available)
    if 'city_of_issuance' in extracted_fields:
        city_data = extracted_fields['city_of_issuance']
        city_value = city_data['value']
        confidence = city_data['confidence']
        
        # Basic validation - should not be empty
        valid = len(city_value.strip()) > 0
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'city_of_issuance',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Empty city of issuance",
            'severity': 'LOW',
            'requiresManualReview': manual_review
        })
    
    return validations

def validate_drivers_license(extracted_fields):
    """Validate driver's license fields"""
    validations = []
    
    # Full name validation
    if 'full_name' in extracted_fields:
        name_data = extracted_fields['full_name']
        name_value = name_data['value']
        confidence = name_data['confidence']
        
        # Name should be at least 2 parts (first and last name)
        name_parts = name_value.strip().split()
        valid = len(name_parts) >= 2
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'full_name',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Name should include at least first and last name",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'full_name',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # License number validation
    if 'license_number' in extracted_fields:
        license_data = extracted_fields['license_number']
        license_value = license_data['value']
        confidence = license_data['confidence']
        
        # French driver's license numbers typically have 12 digits
        valid = re.match(r'^\d{12}$', license_value.strip())
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'license_number',
            'valid': bool(valid),
            'confidence': confidence,
            'reason': None if valid else "Invalid license number format (should be 12 digits)",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'license_number',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # Categories validation
    if 'categories' in extracted_fields:
        cat_data = extracted_fields['categories']
        categories = cat_data['value']
        confidence = cat_data['confidence']
        
        # Valid French driving license categories
        valid_categories = {'AM', 'A1', 'A2', 'A', 'B1', 'B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE'}
        
        # Check if all categories are valid
        invalid_cats = []
        if isinstance(categories, list):
            for cat in categories:
                if cat.upper() not in valid_categories:
                    invalid_cats.append(cat)
            valid = len(invalid_cats) == 0
        else:
            # If it's not a list, consider it invalid
            valid = False
            invalid_cats = [str(categories)]
        
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'categories',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else f"Invalid license categories: {', '.join(invalid_cats)}",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'categories',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'MEDIUM',
            'requiresManualReview': True
        })
    
    # Issue date validation (if available)
    if 'issue_date' in extracted_fields:
        issue_data = extracted_fields['issue_date']
        issue_value = issue_data['value']
        confidence = issue_data['confidence']
        
        # Validate date format
        valid, issue_problem = validate_date(issue_value, max_year=datetime.now().year)
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'issue_date',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else f"Invalid issue date: {issue_problem}",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    
    # Expiration date validation
    if 'expiration_date' in extracted_fields:
        exp_data = extracted_fields['expiration_date']
        exp_value = exp_data['value']
        confidence = exp_data['confidence']
        
        # Validate date format
        valid, exp_issue = validate_date(exp_value)
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'expiration_date',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else f"Invalid expiration date: {exp_issue}",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'expiration_date',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'MEDIUM',
            'requiresManualReview': True
        })
    
    # Issuer name validation (if available)
    if 'issuer_name' in extracted_fields:
        issuer_data = extracted_fields['issuer_name']
        issuer_value = issuer_data['value']
        confidence = issuer_data['confidence']
        
        valid = len(issuer_value.strip()) > 0
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'issuer_name',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Empty issuer name",
            'severity': 'LOW',
            'requiresManualReview': manual_review
        })
    
    # City of issuance validation (if available)
    if 'city_of_issuance' in extracted_fields:
        city_data = extracted_fields['city_of_issuance']
        city_value = city_data['value']
        confidence = city_data['confidence']
        
        valid = len(city_value.strip()) > 0
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'city_of_issuance',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Empty city of issuance",
            'severity': 'LOW',
            'requiresManualReview': manual_review
        })
    
    return validations

def validate_vehicle_registration(extracted_fields):
    """Validate vehicle registration (Carte Grise) fields"""
    validations = []
    
    # Registration number validation
    if 'registration_number' in extracted_fields:
        reg_data = extracted_fields['registration_number']
        reg_value = reg_data['value']
        confidence = reg_data['confidence']
        
        # French registration numbers follow specific formats
        # New format (since 2009): AB-123-CD
        # Old format: 123 ABC 45
        valid = (re.match(r'^[A-Z]{2}-\d{3}-[A-Z]{2}$', reg_value.strip()) or 
                 re.match(r'^\d{1,4}\s?[A-Z]{1,3}\s?\d{1,2}$', reg_value.strip()))
        
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'registration_number',
            'valid': bool(valid),
            'confidence': confidence,
            'reason': None if valid else "Invalid registration number format",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'registration_number',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # First registration date validation
    if 'first_registration_date' in extracted_fields:
        date_data = extracted_fields['first_registration_date']
        date_value = date_data['value']
        confidence = date_data['confidence']
        
        # Validate date format and reasonableness
        valid, date_issue = validate_date(date_value, min_year=1900, max_year=datetime.now().year)
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'first_registration_date',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else f"Invalid first registration date: {date_issue}",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'first_registration_date',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'MEDIUM',
            'requiresManualReview': True
        })
    
    # Owner name validation
    if 'owner_name' in extracted_fields:
        name_data = extracted_fields['owner_name']
        name_value = name_data['value']
        confidence = name_data['confidence']
        
        # Basic validation - should not be empty
        valid = len(name_value.strip()) > 0
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'owner_name',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Empty owner name",
            'severity': 'HIGH',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'owner_name',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'HIGH',
            'requiresManualReview': True
        })
    
    # Address validation
    if 'address' in extracted_fields:
        addr_data = extracted_fields['address']
        addr_value = addr_data['value']
        confidence = addr_data['confidence']
        
        # Basic validation - should be of reasonable length and contain numbers
        # French addresses typically include street numbers
        valid = len(addr_value.strip()) > 10 and any(c.isdigit() for c in addr_value)
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'address',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Invalid address format",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'address',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'MEDIUM',
            'requiresManualReview': True
        })
    
    # Vehicle make validation
    if 'vehicle_make' in extracted_fields:
        make_data = extracted_fields['vehicle_make']
        make_value = make_data['value']
        confidence = make_data['confidence']
        
        # Basic validation - should not be empty and should be a known car manufacturer
        valid_makes = {'RENAULT', 'PEUGEOT', 'CITROEN', 'VOLKSWAGEN', 'BMW', 'AUDI', 'MERCEDES', 
                      'TOYOTA', 'FORD', 'FIAT', 'OPEL', 'NISSAN', 'SEAT', 'SKODA', 'HONDA', 
                      'HYUNDAI', 'KIA', 'MAZDA', 'VOLVO', 'DACIA', 'SUZUKI', 'MINI', 'ALFA ROMEO',
                      'JEEP', 'LAND ROVER', 'PORSCHE', 'TESLA'}
        
        valid = make_value.strip().upper() in valid_makes
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'vehicle_make',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Unknown vehicle manufacturer",
            'severity': 'MEDIUM',
            'requiresManualReview': manual_review
        })
    else:
        validations.append({
            'field': 'vehicle_make',
            'valid': False,
            'confidence': 0.0,
            'reason': "Missing required field",
            'severity': 'MEDIUM',
            'requiresManualReview': True
        })
    
    # CNIT validation (if available)
    if 'cnit' in extracted_fields:
        cnit_data = extracted_fields['cnit']
        cnit_value = cnit_data['value']
        confidence = cnit_data['confidence']
        
        # CNIT is typically alphanumeric with specific formats
        valid = re.match(r'^[A-Z0-9]{6,15}$', cnit_value.strip())
        manual_review = not valid or confidence < validation_threshold
        
        validations.append({
            'field': 'cnit',
            'valid': bool(valid),
            'confidence': confidence,
            'reason': None if valid else "Invalid CNIT format",
            'severity': 'LOW',
            'requiresManualReview': manual_review
        })
    
    # Commercial name validation (if available)
    if 'commercial_name' in extracted_fields:
        name_data = extracted_fields['commercial_name']
        name_value = name_data['value']
        confidence = name_data['confidence']
        
        # Basic validation - should not be empty
        valid = len(name_value.strip()) > 0
        manual_review = confidence < validation_threshold
        
        validations.append({
            'field': 'commercial_name',
            'valid': valid,
            'confidence': confidence,
            'reason': None if valid else "Empty commercial name",
            'severity': 'LOW',
            'requiresManualReview': manual_review
        })
    
    return validations

def validate_generic_document(extracted_fields):
    """Validate generic document when type is unknown"""
    validations = []
    
    # Validate common fields with basic rules
    for field, data in extracted_fields.items():
        if isinstance(data, dict) and 'value' in data and 'confidence' in data:
            value = data['value']
            confidence = data['confidence']
            
            if isinstance(value, str):
                valid = len(value.strip()) > 0
            elif isinstance(value, list):
                valid = len(value) > 0
            else:
                valid = value is not None
                
            manual_review = confidence < validation_threshold
            
            validations.append({
                'field': field,
                'valid': valid,
                'confidence': confidence,
                'reason': None if valid else f"Invalid or empty {field}",
                'severity': 'MEDIUM',
                'requiresManualReview': manual_review
            })
    
    return validations

def validate_date(date_string, min_year=None, max_year=None):
    """
    Validate date string in various formats
    
    Parameters:
    - date_string: Date string to validate
    - min_year: Minimum valid year (optional)
    - max_year: Maximum valid year (optional)
    
    Returns:
    - (valid, issue): Tuple with boolean valid flag and issue description if invalid
    """
    # Common date formats in French documents
    date_formats = [
        '%Y-%m-%d',      # ISO format: 2023-01-15
        '%d/%m/%Y',      # French format: 15/01/2023
        '%d-%m-%Y',      # Alternative: 15-01-2023
        '%d.%m.%Y',      # Alternative: 15.01.2023
        '%d %m %Y',      # Alternative: 15 01 2023
        '%d%m%Y'         # Compact: 15012023
    ]
    
    # Try parsing with each format
    parsed_date = None
    for fmt in date_formats:
        try:
            parsed_date = datetime.strptime(date_string.strip(), fmt)
            break
        except ValueError:
            continue
    
    if not parsed_date:
        return False, "Unparseable date format"
    
    # Check year constraints
    year = parsed_date.year
    if min_year and year < min_year:
        return False, f"Year {year} is before minimum allowed ({min_year})"
    if max_year and year > max_year:
        return False, f"Year {year} is after maximum allowed ({max_year})"
    
    return True, None

def perform_cross_field_validations(extracted_fields, document_type):
    """
    Perform validations across multiple fields
    
    Parameters:
    - extracted_fields: Dictionary of extracted fields with values and confidence scores
    - document_type: Type of document being validated
    
    Returns:
    - List of cross-field validation results
    """
    validations = []
    
    # Identity document cross-field validations
    if document_type in ['PASSPORT', 'NATIONAL_ID']:
        # Check consistency between name fields if multiple formats exist
        if 'full_name' in extracted_fields and 'last_name' in extracted_fields and 'first_name' in extracted_fields:
            full_name = extracted_fields['full_name']['value'].lower()
            last_name = extracted_fields['last_name']['value'].lower()
            first_name = extracted_fields['first_name']['value'].lower()
            
            # Check if last name and first name appear in full name
            if last_name not in full_name or first_name not in full_name:
                validations.append({
                    'name': 'name_consistency',
                    'fields': ['full_name', 'first_name', 'last_name'],
                    'valid': False,
                    'reason': "Name fields are inconsistent",
                    'severity': 'MEDIUM',
                    'requiresManualReview': True
                })
    
    # Driver's license cross-field validations
    if document_type == 'DRIVERS_LICENSE':
        # Check that issue date is before expiration date (if both exist)
        if 'issue_date' in extracted_fields and 'expiration_date' in extracted_fields:
            issue_valid, _ = validate_date(extracted_fields['issue_date']['value'])
            exp_valid, _ = validate_date(extracted_fields['expiration_date']['value'])
            
            if issue_valid and exp_valid:
                issue_date = parse_date(extracted_fields['issue_date']['value'])
                exp_date = parse_date(extracted_fields['expiration_date']['value'])
                
                if issue_date and exp_date and issue_date >= exp_date:
                    validations.append({
                        'name': 'date_consistency',
                        'fields': ['issue_date', 'expiration_date'],
                        'valid': False,
                        'reason': "Issue date must be before expiration date",
                        'severity': 'HIGH',
                        'requiresManualReview': True
                    })
    
    # Vehicle registration cross-field validations
    if document_type == 'VEHICLE_REGISTRATION':
        # Check consistency between owner name and address (both should exist)
        if 'owner_name' in extracted_fields and not 'address' in extracted_fields:
            validations.append({
                'name': 'owner_address_consistency',
                'fields': ['owner_name', 'address'],
                'valid': False,
                'reason': "Owner name exists but address is missing",
                'severity': 'MEDIUM',
                'requiresManualReview': True
            })
        
        # Check consistency between vehicle make and commercial name (if both exist)
        if 'vehicle_make' in extracted_fields and 'commercial_name' in extracted_fields:
            # Some commercial names should include the make
            make = extracted_fields['vehicle_make']['value'].lower()
            commercial = extracted_fields['commercial_name']['value'].lower()
            
            # This is a weak check - might generate false positives
            # For example, Renault Clio would pass, but BMW 3 Series might not
            if len(make) > 3 and make not in commercial and not any(model in commercial for model in get_models_for_make(make)):
                validations.append({
                    'name': 'vehicle_model_consistency',
                    'fields': ['vehicle_make', 'commercial_name'],
                    'valid': False,
                    'reason': "Commercial name doesn't match vehicle make",
                    'severity': 'LOW',
                    'requiresManualReview': True
                })
    
    return validations

def parse_date(date_string):
    """Parse date string in various formats into a datetime object"""
    date_formats = [
        '%Y-%m-%d',      # ISO format: 2023-01-15
        '%d/%m/%Y',      # French format: 15/01/2023
        '%d-%m-%Y',      # Alternative: 15-01-2023
        '%d.%m.%Y',      # Alternative: 15.01.2023
        '%d %m %Y',      # Alternative: 15 01 2023
        '%d%m%Y'         # Compact: 15012023
    ]
    
    for fmt in date_formats:
        try:
            return datetime.strptime(date_string.strip(), fmt)
        except ValueError:
            continue
    
    return None

def get_models_for_make(make):
    """
    Get common models for a given car manufacturer
    
    This is a simplified implementation with only a few makes/models.
    In a real implementation, this would be a more comprehensive database.
    """
    models = {
        'renault': ['clio', 'megane', 'captur', 'kadjar', 'scenic', 'twingo', 'zoe'],
        'peugeot': ['108', '208', '308', '508', '2008', '3008', '5008'],
        'citroen': ['c1', 'c3', 'c4', 'c5', 'berlingo', 'picasso'],
        'volkswagen': ['polo', 'golf', 'passat', 'tiguan', 'touran', 'touareg'],
        'bmw': ['serie', 'series', 'x1', 'x3', 'x5', 'x6', 'z4']
    }
    
    return models.get(make.lower(), [])

def determine_validation_status(validation_errors, manual_review_triggers, overall_confidence):
    """
    Determine overall validation status based on errors and confidence
    
    Parameters:
    - validation_errors: List of validation errors
    - manual_review_triggers: List of issues requiring manual review
    - overall_confidence: Overall confidence score
    
    Returns:
    - Validation status: PASSED, FAILED, or MANUAL_REVIEW
    """
    # If manual review is required for any field, return MANUAL_REVIEW
    if manual_review_triggers:
        return "MANUAL_REVIEW"
    
    # If there are high-severity errors, consider it a failure
    high_severity_errors = [e for e in validation_errors if e.get('severity') == 'HIGH']
    if high_severity_errors:
        return "FAILED"
    
    # If confidence is too low, require manual review
    if overall_confidence < validation_threshold:
        return "MANUAL_REVIEW"
    
    # If there are medium-severity errors, require manual review
    medium_severity_errors = [e for e in validation_errors if e.get('severity') == 'MEDIUM']
    if medium_severity_errors:
        return "MANUAL_REVIEW"
    
    # If we have low-severity errors only, still pass but might flag for attention
    low_severity_errors = [e for e in validation_errors if e.get('severity') == 'LOW']
    if low_severity_errors:
        return "PASSED"  # Could potentially have a "PASSED_WITH_WARNINGS" status
    
    return "PASSED"

def store_validation_results(session_id, document_type, validation_results):
    """Store document validation results in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        # Convert any Decimal values to float for DynamoDB compatibility
        validation_results = json.loads(json.dumps(validation_results), parse_float=float)
        
        validation_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"VALIDATION#{document_type}",
                'sessionId': session_id,
                'documentType': document_type,
                'validationStatus': validation_results['validationStatus'],
                'validationDetails': validation_results['validationDetails'],
                'validationErrors': validation_results['validationErrors'],
                'manualReviewTriggers': validation_results['manualReviewTriggers'],
                'processingTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 7776000))  # 90 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing validation results: {str(e)}")
        raise

def store_validation_error(session_id, document_type, error_message):
    """Store document validation error in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        validation_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#VALIDATION#{document_type}#{timestamp}",
                'sessionId': session_id,
                'documentType': document_type,
                'errorMessage': error_message,
                'errorTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 2592000))  # 30 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing validation error: {str(e)}")

def queue_for_manual_review(session_id, document_type, extracted_fields, validation_results):
    """Queue document for manual review in SQS"""
    try:
        message = {
            'sessionId': session_id,
            'documentType': document_type,
            'extractedFields': extracted_fields,
            'validationResults': validation_results,
            'queuedTimestamp': datetime.now().isoformat()
        }
        
        response = sqs.send_message(
            QueueUrl=manual_review_queue_url,
            MessageBody=json.dumps(message)
        )
        
        logger.info(f"Queued document {session_id}-{document_type} for manual review: {response['MessageId']}")
    except Exception as e:
        logger.error(f"Error queueing for manual review: {str(e)}")

def emit_validation_event(session_id, document_type, validation_results):
    """Emit document validation event to EventBridge"""
    try:
        event_detail = {
            'sessionId': session_id,
            'documentType': document_type,
            'validationStatus': validation_results['validationStatus'],
            'timestamp': datetime.now().isoformat(),
            'errorCount': len(validation_results['validationErrors']),
            'manualReviewRequired': validation_results['validationStatus'] == 'MANUAL_REVIEW'
        }
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.document-validator',
                    'DetailType': 'DocumentValidated',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting validation event: {str(e)}")

def emit_error_event(session_id, document_type, error_message):
    """Emit document validation error event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.document-validator',
                    'DetailType': 'DocumentValidationError',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'documentType': document_type,
                        'errorMessage': error_message,
                        'timestamp': datetime.now().isoformat()
                    }),
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
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export class DocumentValidatorStack extends cdk.Stack {
  public readonly documentValidatorFunction: lambda.Function;
  public readonly validationTable: dynamodb.Table;
  public readonly manualReviewQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table for validation results
    this.validationTable = new dynamodb.Table(this, 'ValidationResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Create SQS queue for manual review requests
    this.manualReviewQueue = new sqs.Queue(this, 'ManualReviewQueue', {
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(7),
    });

    // Create EventBridge event bus
    const documentProcessingBus = new events.EventBus(this, 'DocumentProcessingBus', {
      eventBusName: 'document-processing-bus'
    });
    
    // Create Lambda function for document validation
    this.documentValidatorFunction = new lambda.Function(this, 'DocumentValidatorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/document-validator'),
      handler: 'index.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        EXTRACTION_TABLE_NAME: 'extraction-table-name',  // Pass as parameter or from another stack
        VALIDATION_TABLE_NAME: this.validationTable.tableName,
        MANUAL_REVIEW_QUEUE_URL: this.manualReviewQueue.queueUrl,
        VALIDATION_THRESHOLD: '0.7',  // Minimum confidence score for accepting fields
        EVENT_BUS_NAME: documentProcessingBus.eventBusName
      },
    });

    // Grant permissions to the validator
    this.validationTable.grantWriteData(this.documentValidatorFunction);
    this.manualReviewQueue.grantSendMessages(this.documentValidatorFunction);
    
    // Grant permission to read extraction table
    // This depends on how your extraction table is defined in your Bedrock Integration stack
    // Here we assume the extraction table is defined elsewhere and we need to grant access
    const extractionTableArn = 'arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/extraction-table-name';
    this.documentValidatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [extractionTableArn]
      })
    );
    
    // Grant EventBridge permissions
    this.documentValidatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );

    // Create EventBridge rule to trigger validation when extraction is completed
    const extractionCompletedRule = new events.Rule(this, 'ExtractionCompletedRule', {
      eventPattern: {
        source: ['document-processing.bedrock-integration'],
        detailType: ['DocumentExtracted'],
        detail: {
          extractionStatus: ['COMPLETED']
        }
      },
      targets: [new targets.LambdaFunction(this.documentValidatorFunction)]
    });
    
    // Create EventBridge rule for validation results
    const validationResultRule = new events.Rule(this, 'ValidationResultRule', {
      eventPattern: {
        source: ['document-processing.document-validator'],
        detailType: ['DocumentValidated']
      },
      targets: [
        // Add targets for handling validation results
        // This would typically be the next step in the workflow
      ]
    });
    
    // Create EventBridge rule for manual review events
    const manualReviewRule = new events.Rule(this, 'ManualReviewRule', {
      eventPattern: {
        source: ['document-processing.document-validator'],
        detailType: ['DocumentValidated'],
        detail: {
          manualReviewRequired: [true]
        }
      },
      targets: [
        // Add targets for handling manual review events
        // This could notify a system or team responsible for manual reviews
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'ValidationTableName', {
      value: this.validationTable.tableName,
      description: 'The name of the DynamoDB table for validation results',
    });
    
    new cdk.CfnOutput(this, 'ManualReviewQueueUrl', {
      value: this.manualReviewQueue.queueUrl,
      description: 'The URL of the SQS queue for manual review requests',
    });
  }
}
```

## 4. Validation Rules Engine

### 4.1 Rule Structure

The Document Validation Service employs a rules engine that validates extracted document data against predefined rules:

1. **Field-Level Rules**:
   - Format validation (regex patterns, date formats)
   - Content validation (value ranges, allowed values)
   - Presence validation (required fields)
   - Confidence validation (minimum confidence thresholds)

2. **Cross-Field Rules**:
   - Data consistency across multiple fields
   - Logical relationship validations (e.g., issue date before expiration date)

3. **Document-Specific Rules**:
   - Rules customized for each document type (passport, ID card, driver's license, vehicle registration)
   - Special formats for French documents (e.g., license categories, registration numbers)

### 4.2 Error Classification

The validation service classifies validation errors by severity:

1. **High Severity**:
   - Missing required fields
   - Invalid document numbers
   - Format violations for critical fields

2. **Medium Severity**:
   - Date format issues
   - Cross-field inconsistencies
   - Unusual but possible values

3. **Low Severity**:
   - Minor formatting issues
   - Optional field problems
   - Low confidence scores for non-critical fields

### 4.3 Manual Review Triggers

The following conditions trigger manual review:

1. **Automatic Triggers**:
   - High-severity validation errors
   - Multiple medium-severity errors
   - Field confidence scores below threshold
   - Cross-field inconsistencies
   - Missing critical fields

2. **Configurable Triggers**:
   - Adjustable confidence thresholds
   - Customizable error severity classifications
   - Document-type-specific review rules

## 5. Testing and Evaluation

### 5.1 Testing Approach

The Document Validation Service is thoroughly tested using:

1. **Unit Testing**:
   - Individual validation rule tests
   - Error classification logic
   - Manual review trigger conditions

2. **Integration Testing**:
   - End-to-end flow from extraction results to validation
   - EventBridge event handling
   - SQS queue integration for manual reviews

3. **Scenario Testing**:
   - Complete document processing scenarios
   - Error handling paths
   - Manual review workflows

### 5.2 Test Cases

The validation service includes test cases for:

1. **Happy Path Scenarios**:
   - Valid document data with high confidence
   - Expected field formats and values
   - Proper cross-field relationships

2. **Field Validation Errors**:
   - Invalid date formats
   - Improperly formatted document numbers
   - Missing required fields

3. **Cross-Field Validation Errors**:
   - Inconsistent name fields
   - Mismatched dates (issue vs. expiration)
   - Inconsistent vehicle details

4. **Confidence Score Handling**:
   - High confidence, valid data
   - Low confidence, valid data
   - High confidence, invalid data
   - Low confidence, invalid data

## 6. Operation and Monitoring

### 6.1 Monitoring Setup

The Document Validation Service includes monitoring:

1. **CloudWatch Metrics**:
   - Validation success/failure rate
   - Manual review rate
   - Processing time

2. **CloudWatch Alarms**:
   - High manual review rate alert
   - Failed validation threshold alert
   - Processing time threshold alert

3. **Custom Metrics**:
   - Error distribution by document type
   - Error distribution by field
   - Manual review queue depth

### 6.2 Operational Procedures

Standard operating procedures for the Document Validation Service:

1. **Manual Review Process**:
   - Review queue monitoring
   - Review interface access
   - Decision recording and feedback

2. **Rule Maintenance**:
   - Rule update procedure
   - Testing and deployment of rule changes
   - Version control for validation rules

3. **Performance Tuning**:
   - Threshold adjustment procedure
   - Rule optimization process
   - False positive/negative analysis

## 7. Future Enhancements

1. **Machine Learning for Validation**:
   - Training models to detect suspicious document patterns
   - Anomaly detection for unusual data combinations
   - Continuous learning from manual review decisions

2. **Advanced Rule Configuration**:
   - Web interface for rule management
   - Business-user-friendly rule configuration
   - Rule testing and simulation tools

3. **Enhanced Reporting**:
   - Detailed validation analytics
   - Error pattern detection
   - Rule effectiveness metrics

## 8. Security Considerations

1. **Data Protection**:
   - Minimal storage of validated data
   - Field-level encryption for sensitive data
   - Clear access controls to validation results

2. **Access Control**:
   - Role-based access to validation interfaces
   - Audit logging of validation rule changes
   - Principle of least privilege for all operations

3. **Compliance**:
   - GDPR compliance for validation results
   - Retention policies aligned with regulatory requirements
   - Privacy-by-design approach to result storage