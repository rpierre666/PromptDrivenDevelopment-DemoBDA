# Report Generator Service Implementation

This document provides the implementation for the Report Generator Service component of the French Official Documents Processing System. This component is responsible for creating comprehensive verification reports based on the aggregated verification results.

## 1. Component Overview

The Report Generator Service is responsible for:
- Creating standardized verification reports based on verification results
- Including extracted document data in reports
- Formatting reports for internal use
- Supporting multiple output formats (JSON, PDF)
- Storing reports with appropriate metadata
- Ensuring GDPR compliance in report content and storage

## 2. Architecture Design

### 2.1 Component Architecture

The Report Generator Service is implemented as an AWS Lambda function that processes verification data from DynamoDB and generates standardized reports. It integrates with various AWS services to create, store, and manage reports.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Report Generator  │────▶│ Report Templates  │────▶│ Report          │
│ Event Bus       │     │ Lambda            │     │ Service           │     │ Formatter       │
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ S3 Report    │                                    │ DynamoDB Report  │
                        │ Storage      │                                    │ Metadata         │
                        │              │                                    │                  │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Verification Aggregator
   - Verification results from DynamoDB
   - Document extraction data from DynamoDB

2. **Output**:
   - Reports stored in S3
   - Report metadata stored in DynamoDB
   - Event notification with report URLs

## 3. Implementation

### 3.1 AWS Lambda Function

```python
import json
import os
import boto3
import uuid
import io
from datetime import datetime
import logging
import base64
from fpdf import FPDF
from botocore.exceptions import ClientError
from typing import Dict, List, Any, Optional

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
verification_table = dynamodb.Table(os.environ['VERIFICATION_TABLE_NAME'])
extraction_table = dynamodb.Table(os.environ['EXTRACTION_TABLE_NAME'])
report_table = dynamodb.Table(os.environ['REPORT_TABLE_NAME'])
eventbridge = boto3.client('events')

# Environment variables
report_bucket = os.environ['REPORT_BUCKET']
event_bus_name = os.environ['EVENT_BUS_NAME']

def lambda_handler(event, context):
    """
    Lambda function that generates verification reports based on verification results
    
    Parameters:
    - event: EventBridge event from verification aggregator
    - context: Lambda context
    
    Returns:
    - Report generation results including report URLs and metadata
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse event details
        event_detail = event['detail']
        session_id = event_detail.get('sessionId')
        overall_status = event_detail.get('overallStatus')
        
        if not session_id:
            logger.error("No session ID found in event")
            return {
                'statusCode': 400,
                'error': "No session ID found in event"
            }
            
        # Get verification data
        verification_data = get_verification_data(session_id)
        if not verification_data:
            logger.error(f"No verification data found for session {session_id}")
            return {
                'statusCode': 404,
                'error': f"No verification data found for session {session_id}"
            }
        
        # Get extracted document data
        document_data = get_extracted_document_data(session_id)
        if not document_data:
            logger.warning(f"No document data found for session {session_id}")
        
        # Generate report ID
        report_id = f"report-{session_id}-{int(datetime.now().timestamp())}"
        
        # Generate reports in different formats
        json_report = generate_json_report(session_id, verification_data, document_data, overall_status)
        pdf_report = generate_pdf_report(session_id, verification_data, document_data, overall_status)
        
        # Store reports
        json_location = store_report(report_id, "json", json_report, session_id)
        pdf_location = store_report(report_id, "pdf", pdf_report, session_id)
        
        # Store report metadata
        store_report_metadata(report_id, session_id, json_location, pdf_location, overall_status)
        
        # Emit report generated event
        emit_report_event(report_id, session_id, json_location, pdf_location, overall_status)
        
        return {
            'statusCode': 200,
            'reportId': report_id,
            'sessionId': session_id,
            'reportLocations': {
                'json': json_location,
                'pdf': pdf_location
            },
            'overallStatus': overall_status
        }
        
    except Exception as e:
        logger.error(f"Error generating report: {str(e)}")
        
        # Store error in DynamoDB for tracking
        if 'session_id' in locals():
            store_report_error(session_id, str(e))
        
        # Emit error event
        if 'session_id' in locals():
            emit_error_event(session_id, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_verification_data(session_id):
    """
    Retrieve verification data from DynamoDB
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Dictionary containing verification data
    """
    try:
        response = verification_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        if not response.get('Items'):
            logger.warning(f"No verification data found for session {session_id}")
            return None
            
        return response['Items']
        
    except Exception as e:
        logger.error(f"Error retrieving verification data: {str(e)}")
        raise

def get_extracted_document_data(session_id):
    """
    Retrieve extracted document data from DynamoDB
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - Dictionary containing document data
    """
    try:
        response = extraction_table.query(
            KeyConditionExpression='pk = :pk',
            ExpressionAttributeValues={
                ':pk': f"SESSION#{session_id}"
            }
        )
        
        if not response.get('Items'):
            logger.warning(f"No document data found for session {session_id}")
            return None
            
        return response['Items']
        
    except Exception as e:
        logger.error(f"Error retrieving document data: {str(e)}")
        raise

def generate_json_report(session_id, verification_data, document_data, overall_status):
    """
    Generate a JSON report from verification and document data
    
    Parameters:
    - session_id: Session identifier
    - verification_data: Verification results
    - document_data: Extracted document data
    - overall_status: Overall verification status
    
    Returns:
    - JSON report as a string
    """
    timestamp = datetime.now().isoformat()
    
    # Parse verification data by document type
    verification_by_type = {}
    facial_verifications = []
    
    for item in verification_data:
        if 'sk' not in item:
            continue
            
        sk = item['sk']
        
        if sk.startswith('VERIFICATION#'):
            doc_type = sk.split('#')[1]
            if doc_type not in verification_by_type:
                verification_by_type[doc_type] = item
                
        if sk.startswith('FACIAL_VERIFICATION#'):
            facial_verifications.append(item)
    
    # Parse document data by document type
    documents_by_type = {}
    
    if document_data:
        for item in document_data:
            if 'sk' not in item:
                continue
                
            sk = item['sk']
            
            if sk.startswith('EXTRACTION#'):
                doc_type = sk.split('#')[1]
                if doc_type not in documents_by_type:
                    documents_by_type[doc_type] = item
    
    # Build report structure
    report = {
        'reportHeader': {
            'reportId': f"report-{session_id}-{int(datetime.now().timestamp())}",
            'sessionId': session_id,
            'generatedAt': timestamp,
            'overallVerificationStatus': overall_status
        },
        'documentVerifications': [],
        'facialVerifications': [],
        'extractedData': {},
        'overallSummary': {
            'status': overall_status,
            'verifiedDocuments': list(verification_by_type.keys()),
            'totalDocumentsVerified': len(verification_by_type),
            'facialVerificationStatus': get_overall_facial_status(facial_verifications)
        }
    }
    
    # Add document verifications
    for doc_type, verification in verification_by_type.items():
        report['documentVerifications'].append({
            'documentType': doc_type,
            'verificationStatus': verification.get('verificationStatus', 'UNKNOWN'),
            'confidenceScore': verification.get('confidenceScore', 0),
            'validationDetails': verification.get('validationDetails', {}),
            'verifiedAt': verification.get('verificationTimestamp', '')
        })
    
    # Add facial verifications
    for facial_verification in facial_verifications:
        report['facialVerifications'].append({
            'documentType': facial_verification.get('documentType', ''),
            'verificationStatus': facial_verification.get('verificationStatus', 'UNKNOWN'),
            'similarityScore': facial_verification.get('similarityScore', 0),
            'confidenceLevel': facial_verification.get('confidenceLevel', ''),
            'estimatedFAR': facial_verification.get('estimatedFAR', 0),
            'estimatedFRR': facial_verification.get('estimatedFRR', 0),
            'verifiedAt': facial_verification.get('verificationTimestamp', '')
        })
    
    # Add extracted document data
    for doc_type, document in documents_by_type.items():
        # Clean extracted fields for report
        extracted_fields = document.get('extractedFields', {})
        clean_fields = {}
        
        for field_name, field_data in extracted_fields.items():
            # Remove any binary data or overly complex structures
            if isinstance(field_data, dict) and 'value' in field_data:
                clean_fields[field_name] = {
                    'value': field_data['value'],
                    'confidence': field_data.get('confidence', 0)
                }
            else:
                clean_fields[field_name] = field_data
        
        report['extractedData'][doc_type] = clean_fields
    
    return json.dumps(report, indent=2)

def generate_pdf_report(session_id, verification_data, document_data, overall_status):
    """
    Generate a PDF report from verification and document data
    
    Parameters:
    - session_id: Session identifier
    - verification_data: Verification results
    - document_data: Extracted document data
    - overall_status: Overall verification status
    
    Returns:
    - PDF report as bytes
    """
    # Create PDF object
    pdf = FPDF()
    pdf.add_page()
    
    # Set up fonts
    pdf.set_font('Arial', 'B', 16)
    
    # Header
    pdf.cell(0, 10, 'Document Verification Report', 0, 1, 'C')
    pdf.set_font('Arial', '', 10)
    pdf.cell(0, 10, f"Session ID: {session_id}", 0, 1, 'C')
    pdf.cell(0, 10, f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", 0, 1, 'C')
    pdf.ln(10)
    
    # Overall status
    pdf.set_font('Arial', 'B', 14)
    pdf.cell(0, 10, 'Verification Summary', 0, 1, 'L')
    pdf.set_font('Arial', '', 12)
    pdf.cell(0, 10, f"Overall Status: {overall_status}", 0, 1, 'L')
    pdf.ln(5)
    
    # Parse verification data by document type
    verification_by_type = {}
    facial_verifications = []
    
    for item in verification_data:
        if 'sk' not in item:
            continue
            
        sk = item['sk']
        
        if sk.startswith('VERIFICATION#'):
            doc_type = sk.split('#')[1]
            if doc_type not in verification_by_type:
                verification_by_type[doc_type] = item
                
        if sk.startswith('FACIAL_VERIFICATION#'):
            facial_verifications.append(item)
    
    # Document Verifications
    pdf.set_font('Arial', 'B', 14)
    pdf.cell(0, 10, 'Document Verifications', 0, 1, 'L')
    
    for doc_type, verification in verification_by_type.items():
        pdf.set_font('Arial', 'B', 12)
        pdf.cell(0, 10, format_document_type(doc_type), 0, 1, 'L')
        pdf.set_font('Arial', '', 10)
        pdf.cell(0, 6, f"Status: {verification.get('verificationStatus', 'UNKNOWN')}", 0, 1, 'L')
        pdf.cell(0, 6, f"Confidence: {verification.get('confidenceScore', 0)}", 0, 1, 'L')
        
        # Add validation details if present
        validation_details = verification.get('validationDetails', {})
        if validation_details:
            pdf.cell(0, 6, "Validation Details:", 0, 1, 'L')
            for key, value in validation_details.items():
                if isinstance(value, dict):
                    pdf.cell(0, 6, f"- {key}: {json.dumps(value)[:50]}", 0, 1, 'L')
                else:
                    pdf.cell(0, 6, f"- {key}: {value}", 0, 1, 'L')
        
        pdf.ln(5)
    
    # Facial Verifications
    if facial_verifications:
        pdf.set_font('Arial', 'B', 14)
        pdf.cell(0, 10, 'Facial Verifications', 0, 1, 'L')
        
        for facial_verification in facial_verifications:
            doc_type = facial_verification.get('documentType', '')
            pdf.set_font('Arial', 'B', 12)
            pdf.cell(0, 10, f"Facial Comparison: {format_document_type(doc_type)}", 0, 1, 'L')
            pdf.set_font('Arial', '', 10)
            pdf.cell(0, 6, f"Status: {facial_verification.get('verificationStatus', 'UNKNOWN')}", 0, 1, 'L')
            pdf.cell(0, 6, f"Similarity Score: {facial_verification.get('similarityScore', 0)}", 0, 1, 'L')
            pdf.cell(0, 6, f"Confidence Level: {facial_verification.get('confidenceLevel', '')}", 0, 1, 'L')
            pdf.ln(5)
    
    # Extracted Data
    if document_data:
        pdf.set_font('Arial', 'B', 14)
        pdf.cell(0, 10, 'Extracted Document Data', 0, 1, 'L')
        
        documents_by_type = {}
        
        for item in document_data:
            if 'sk' not in item:
                continue
                
            sk = item['sk']
            
            if sk.startswith('EXTRACTION#'):
                doc_type = sk.split('#')[1]
                if doc_type not in documents_by_type:
                    documents_by_type[doc_type] = item
        
        for doc_type, document in documents_by_type.items():
            pdf.set_font('Arial', 'B', 12)
            pdf.cell(0, 10, format_document_type(doc_type), 0, 1, 'L')
            pdf.set_font('Arial', '', 10)
            
            # Display extracted fields
            extracted_fields = document.get('extractedFields', {})
            
            for field_name, field_data in extracted_fields.items():
                if isinstance(field_data, dict) and 'value' in field_data:
                    value = field_data['value']
                    confidence = field_data.get('confidence', 0)
                    
                    # Format field name for display
                    formatted_field = format_field_name(field_name)
                    
                    # Truncate very long values
                    if isinstance(value, str) and len(value) > 50:
                        value = value[:50] + "..."
                    
                    pdf.cell(0, 6, f"{formatted_field}: {value} (Confidence: {confidence})", 0, 1, 'L')
                elif isinstance(field_data, str):
                    # Format field name for display
                    formatted_field = format_field_name(field_name)
                    
                    # Truncate very long values
                    if len(field_data) > 50:
                        field_data = field_data[:50] + "..."
                    
                    pdf.cell(0, 6, f"{formatted_field}: {field_data}", 0, 1, 'L')
            
            pdf.ln(5)
    
    # Disclaimer
    pdf.ln(10)
    pdf.set_font('Arial', 'I', 8)
    pdf.cell(0, 10, "This report is generated for internal use only. The verification results are based on automated processing.", 0, 1, 'C')
    pdf.cell(0, 10, f"Report ID: report-{session_id}-{int(datetime.now().timestamp())}", 0, 1, 'C')
    
    # Return PDF as bytes
    return pdf.output(dest='S').encode('latin1')

def get_overall_facial_status(facial_verifications):
    """Determine overall facial verification status"""
    if not facial_verifications:
        return "NO_DATA"
    
    statuses = [v.get('verificationStatus', 'UNKNOWN') for v in facial_verifications]
    
    if any(s == 'FAILED' for s in statuses):
        return "FAILED"
    elif any(s == 'MANUAL_REVIEW' for s in statuses):
        return "MANUAL_REVIEW"
    elif all(s == 'PASSED' for s in statuses):
        return "PASSED"
    else:
        return "INCONCLUSIVE"

def format_document_type(doc_type):
    """Format document type for display"""
    if doc_type == "PASSPORT":
        return "Passport"
    elif doc_type == "NATIONAL_ID":
        return "National ID Card"
    elif doc_type == "DRIVERS_LICENSE":
        return "Driver's License"
    elif doc_type == "VEHICLE_REGISTRATION":
        return "Vehicle Registration (Carte Grise)"
    else:
        return doc_type

def format_field_name(field_name):
    """Format field name for display"""
    # Convert camelCase or snake_case to Title Case With Spaces
    words = []
    current_word = ""
    
    for char in field_name:
        if char.isupper() and current_word:
            words.append(current_word)
            current_word = char
        elif char == '_':
            if current_word:
                words.append(current_word)
            current_word = ""
        else:
            current_word += char
    
    if current_word:
        words.append(current_word)
    
    return ' '.join(word.capitalize() for word in words)

def store_report(report_id, format_type, report_content, session_id):
    """
    Store report in S3
    
    Parameters:
    - report_id: Report identifier
    - format_type: Report format (json, pdf)
    - report_content: Report content
    - session_id: Session identifier
    
    Returns:
    - S3 location of the stored report
    """
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    key = f"reports/{session_id}/{report_id}.{format_type}"
    
    try:
        # Convert string to bytes for PDF, keep as is for JSON
        if format_type == 'pdf':
            content = report_content  # Already bytes
        else:
            content = report_content.encode('utf-8')
        
        # Set content type based on format
        content_type = 'application/pdf' if format_type == 'pdf' else 'application/json'
        
        # Upload to S3
        s3_client.put_object(
            Bucket=report_bucket,
            Key=key,
            Body=content,
            ContentType=content_type,
            Metadata={
                'session_id': session_id,
                'report_id': report_id,
                'format': format_type,
                'generated_at': timestamp
            }
        )
        
        # Return S3 location
        return f"s3://{report_bucket}/{key}"
        
    except Exception as e:
        logger.error(f"Error storing report: {str(e)}")
        raise

def store_report_metadata(report_id, session_id, json_location, pdf_location, overall_status):
    """Store report metadata in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        report_table.put_item(
            Item={
                'reportId': report_id,
                'sessionId': session_id,
                'createdAt': timestamp,
                'overallStatus': overall_status,
                'reportLocations': {
                    'json': json_location,
                    'pdf': pdf_location
                },
                'ttl': int((datetime.now().timestamp() + 31536000))  # 1 year retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing report metadata: {str(e)}")
        raise

def store_report_error(session_id, error_message):
    """Store report generation error in DynamoDB"""
    timestamp = datetime.now().isoformat()
    error_id = f"error-{session_id}-{int(datetime.now().timestamp())}"
    
    try:
        report_table.put_item(
            Item={
                'reportId': error_id,
                'sessionId': session_id,
                'createdAt': timestamp,
                'error': True,
                'errorMessage': error_message,
                'ttl': int((datetime.now().timestamp() + 2592000))  # 30 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing report error: {str(e)}")

def emit_report_event(report_id, session_id, json_location, pdf_location, overall_status):
    """Emit report generated event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.report-generator',
                    'DetailType': 'ReportGenerated',
                    'Detail': json.dumps({
                        'reportId': report_id,
                        'sessionId': session_id,
                        'overallStatus': overall_status,
                        'reportLocations': {
                            'json': json_location,
                            'pdf': pdf_location
                        },
                        'timestamp': datetime.now().isoformat()
                    }),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting report event: {str(e)}")

def emit_error_event(session_id, error_message):
    """Emit report error event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.report-generator',
                    'DetailType': 'ReportGenerationError',
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
```

### 3.2 AWS CDK Infrastructure

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class ReportGeneratorStack extends cdk.Stack {
  public readonly reportFunction: lambda.Function;
  public readonly reportTable: dynamodb.Table;
  public readonly reportBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket for reports
    this.reportBucket = new s3.Bucket(this, 'ReportBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'ReportRetention',
          expiration: cdk.Duration.days(365),  // 1 year retention
          enabled: true
        }
      ]
    });

    // Create DynamoDB table for report metadata
    this.reportTable = new dynamodb.Table(this, 'ReportTable', {
      partitionKey: { name: 'reportId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });
    
    // Create a GSI on sessionId for easier lookup
    this.reportTable.addGlobalSecondaryIndex({
      indexName: 'SessionIndex',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Create EventBridge event bus (or use existing one)
    const documentProcessingBus = events.EventBus.fromEventBusName(
      this, 
      'DocumentProcessingBus',
      'document-processing-bus'  // Must match the name in previous stacks
    );
    
    // Create Lambda function for report generation
    this.reportFunction = new lambda.Function(this, 'ReportFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/report-generator', {
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
        VERIFICATION_TABLE_NAME: 'verification-results-table', // Reference to existing table
        EXTRACTION_TABLE_NAME: 'extraction-results-table',     // Reference to existing table
        REPORT_TABLE_NAME: this.reportTable.tableName,
        REPORT_BUCKET: this.reportBucket.bucketName,
        EVENT_BUS_NAME: documentProcessingBus.eventBusName
      }
    });

    // Grant permissions to the report generator function
    this.reportTable.grantWriteData(this.reportFunction);
    this.reportBucket.grantWrite(this.reportFunction);
    
    // Grant access to read verification and extraction data
    this.reportFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/verification-results-table`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/extraction-results-table`
        ]
      })
    );
    
    // Grant EventBridge permissions
    this.reportFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );

    // Create EventBridge rule to trigger report generation when verification is completed
    const verificationCompletedRule = new events.Rule(this, 'VerificationCompletedRule', {
      eventPattern: {
        source: ['document-processing.verification-aggregator'],
        detailType: ['VerificationCompleted']
      },
      targets: [new targets.LambdaFunction(this.reportFunction)]
    });
    
    // Create EventBridge rule for report generation notification
    const reportGeneratedRule = new events.Rule(this, 'ReportGeneratedRule', {
      eventPattern: {
        source: ['document-processing.report-generator'],
        detailType: ['ReportGenerated']
      },
      targets: [
        // Add targets for handling report generation notification
        // This would typically trigger notification to relevant personnel
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'ReportTableName', {
      value: this.reportTable.tableName,
      description: 'The name of the DynamoDB table for report metadata',
    });
    
    new cdk.CfnOutput(this, 'ReportBucketName', {
      value: this.reportBucket.bucketName,
      description: 'The name of the S3 bucket for reports',
    });
    
    new cdk.CfnOutput(this, 'ReportFunctionArn', {
      value: this.reportFunction.functionArn,
      description: 'The ARN of the report generator Lambda function',
    });
  }
}
```

## 4. Report Structure and Formats

### 4.1 JSON Report Structure

The JSON report format includes the following sections:

1. **Report Header**
   - Report ID
   - Session ID
   - Generation timestamp
   - Overall verification status

2. **Document Verifications**
   - Document type
   - Verification status
   - Confidence score
   - Validation details

3. **Facial Verifications**
   - Document types compared
   - Verification status
   - Similarity scores
   - Confidence levels
   - FAR/FRR metrics

4. **Extracted Data**
   - Document-specific extracted fields
   - Field confidence scores

5. **Overall Summary**
   - Status
   - List of verified documents
   - Total documents verified
   - Facial verification status

### 4.2 PDF Report Structure

The PDF report follows a similar structure to the JSON report but is formatted for human readability:

1. **Header Section**
   - Company logo (optional)
   - Report title
   - Session ID
   - Generation date/time

2. **Summary Section**
   - Overall verification status
   - Document count
   - Pass/fail indicators

3. **Document Verification Section**
   - One subsection per document
   - Verification status
   - Key extracted fields
   - Validation issues (if any)

4. **Facial Verification Section**
   - Comparison results
   - Similarity scores
   - Confidence levels

5. **Footer Section**
   - Disclaimer text
   - Report ID
   - Page numbers

## 5. Report Storage Strategy

The Report Generator implements a secure, GDPR-compliant storage strategy:

### 5.1 S3 Storage Configuration

- **Encryption**: Server-side encryption for all reports
- **Access Control**: Strict IAM policies limiting access to authorized personnel
- **Lifecycle Management**: Automatic deletion after 1 year (configurable)
- **Versioning**: Optional versioning to track report changes

### 5.2 Metadata Management

- **DynamoDB Storage**: Report metadata stored in DynamoDB for quick retrieval
- **Query Capabilities**: Session ID and date range queries
- **Retention Policy**: Time-to-live (TTL) attribute for automatic deletion
- **Status Tracking**: Report generation status tracking

## 6. Integration with Overall Workflow

### 6.1 Triggering Mechanisms

The Report Generator is triggered by:

1. **EventBridge Events**: When verification aggregation is complete
2. **API Requests**: On-demand report generation through API
3. **Scheduled Reports**: Optional batch reporting (configurable)

### 6.2 Downstream Integration

Generated reports are:

1. **Stored in S3**: For long-term retention
2. **Indexed in DynamoDB**: For efficient retrieval
3. **Notified via EventBridge**: For alerting relevant personnel
4. **Available via API**: For retrieval by client applications

## 7. Testing and Validation

### 7.1 Testing Approach

The Report Generator is tested using:

1. **Unit Tests**
   - Report formatting logic
   - Data aggregation functions
   - Storage interaction

2. **Integration Tests**
   - End-to-end report generation flow
   - Event-based triggering
   - Storage and retrieval

3. **Output Validation**
   - JSON schema validation
   - PDF rendering validation
   - Content accuracy verification

### 7.2 Test Cases

The component includes test cases for:

1. **Report Generation Scenarios**
   - Complete verification data
   - Partial verification data
   - Missing document data
   - Various verification statuses

2. **Edge Cases**
   - Large reports with many documents
   - Special characters in extracted data
   - Multiple facial verification results

3. **Error Cases**
   - DynamoDB retrieval failures
   - S3 storage failures
   - PDF generation errors

## 8. Security Considerations

### 8.1 Data Security

1. **Access Control**
   - Principle of least privilege for Lambda function
   - S3 bucket policies restricting access
   - IAM roles limited to required actions

2. **Data Protection**
   - Server-side encryption for all reports
   - Secure transmission with HTTPS
   - No persistent storage of sensitive data

3. **Audit and Compliance**
   - All report generation actions logged
   - Report access tracking
   - GDPR compliance with retention limits

### 8.2 Privacy Considerations

1. **Data Minimization**
   - Only include necessary verification data in reports
   - Omit raw images and unnecessary PII
   - Apply redaction for highly sensitive fields when appropriate

2. **Retention Policies**
   - Reports deleted after 1 year (configurable)
   - Metadata time-to-live configuration
   - No indefinite storage of verification results

## 9. Performance Optimizations

1. **Lambda Optimization**
   - Memory allocation based on report complexity
   - Timeout configuration for large reports
   - PDF generation efficiency improvements

2. **Storage Efficiency**
   - Compression for large reports
   - Metadata indexing for quick retrieval
   - Caching for frequently accessed reports

3. **Scaling Considerations**
   - Concurrent report generation handling
   - S3 performance optimization
   - DynamoDB capacity planning

## 10. Implementation Requirements

### 10.1 Dependencies

- **Python Libraries**
  - `fpdf`: PDF generation
  - `boto3`: AWS SDK for Python
  - `json`: JSON handling
  - `datetime`: Date and time handling

### 10.2 Environment Setup

- Environment variables for configuration
- AWS permissions and roles
- S3 bucket creation and configuration
- DynamoDB table creation with appropriate indexes