# Document Pre-processor Lambda CDK Implementation

This document provides the AWS CDK implementation for the Document Pre-processor Lambda function, which is the first critical component in the French Document Processing System. This implementation includes the necessary Lambda function, IAM roles, EventBridge rules, and integration with the storage resources.

## Overview

The Document Pre-processor Lambda function is responsible for:
- Processing uploaded document images
- Enhancing image quality
- Normalizing document orientation and boundaries
- Validating document quality
- Preparing images for Bedrock Data Automation

## Implementation Steps

### 1. Create Lambda Stack

Create a new file named `lib/lambda-preprocessor-stack.ts` with the following content:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdaPreprocessorStackProps extends cdk.StackProps {
  // References to resources from the storage stack
  rawDocumentsBucket: s3.IBucket;
  processedDocumentsBucket: s3.IBucket;
  documentMetadataTable: dynamodb.ITable;
  eventBus?: events.IEventBus; // Optional, will create a new one if not provided
}

export class LambdaPreprocessorStack extends cdk.Stack {
  public readonly preprocessorFunction: lambda.Function;
  public readonly eventBus: events.IEventBus;
  
  constructor(scope: Construct, id: string, props: LambdaPreprocessorStackProps) {
    super(scope, id, props);

    // Use provided event bus or create a new one
    this.eventBus = props.eventBus || new events.EventBus(this, 'DocumentProcessingEventBus', {
      eventBusName: 'DocumentProcessingEventBus'
    });

    // Create log group with appropriate retention
    const logGroup = new logs.LogGroup(this, 'PreprocessorLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create Lambda function
    this.preprocessorFunction = new lambda.Function(this, 'DocumentPreprocessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/document-preprocessor')),
      memorySize: 2048, // Higher memory for image processing
      timeout: cdk.Duration.seconds(30),
      environment: {
        PROCESSED_DOCUMENTS_BUCKET: props.processedDocumentsBucket.bucketName,
        METADATA_TABLE_NAME: props.documentMetadataTable.tableName,
        QUALITY_THRESHOLD: '0.7',
        EVENT_BUS_NAME: this.eventBus.eventBusName
      },
      logGroup: logGroup,
      description: 'Processes uploaded documents by enhancing quality and normalizing for optimal extraction'
    });

    // Grant necessary permissions
    props.rawDocumentsBucket.grantRead(this.preprocessorFunction);
    props.processedDocumentsBucket.grantWrite(this.preprocessorFunction);
    props.documentMetadataTable.grantReadWriteData(this.preprocessorFunction);
    
    // Add permissions for Rekognition
    this.preprocessorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rekognition:DetectText',
          'rekognition:DetectLabels',
          'rekognition:AnalyzeDocument'
        ],
        resources: ['*']
      })
    );
    
    // Grant permission to put events on the event bus
    this.eventBus.grantPutEventsTo(this.preprocessorFunction);
    
    // Create S3 notification to trigger Lambda when documents are uploaded
    props.rawDocumentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.preprocessorFunction)
    );
    
    // Create an EventBridge rule for error handling
    const errorRule = new events.Rule(this, 'PreprocessorErrorRule', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['document-processing-system'],
        detailType: ['DocumentProcessingError']
      },
      description: 'Captures document preprocessing errors'
    });
    
    // Define outputs
    new cdk.CfnOutput(this, 'PreprocessorFunctionName', {
      value: this.preprocessorFunction.functionName,
      description: 'The name of the document preprocessor Lambda function'
    });
    
    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'The name of the event bus used for document processing events'
    });
  }
}
```

### 2. Update Main CDK App

Update the `bin/french-document-processing-system.ts` file to include the preprocessor stack:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';
import { LambdaPreprocessorStack } from '../lib/lambda-preprocessor-stack';

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

// Define stack dependency
lambdaPreprocessorStack.addDependency(storageStack);
```

### 3. Create the Lambda Function Implementation

Create the directory structure for the Lambda function:

```bash
mkdir -p lambda/document-preprocessor
```

Create a file `lambda/document-preprocessor/index.py` with the implementation from our Document Pre-processor component:

```python
import json
import os
import boto3
import numpy as np
import cv2
from PIL import Image
import io
import uuid
from datetime import datetime
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
rekognition_client = boto3.client('rekognition')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['METADATA_TABLE_NAME'])
eventbridge = boto3.client('events')

# Environment variables
output_bucket = os.environ['PROCESSED_DOCUMENTS_BUCKET']
quality_threshold = float(os.environ['QUALITY_THRESHOLD'])
event_bus_name = os.environ['EVENT_BUS_NAME']

def lambda_handler(event, context):
    """
    Lambda function that processes document images for optimal OCR performance
    
    Parameters:
    - event: S3 event notification
    - context: Lambda context
    
    Returns:
    - Processing result including document quality metrics and S3 location
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Get the object from the event and show its content type
        bucket = event['Records'][0]['s3']['bucket']['name']
        key = event['Records'][0]['s3']['object']['key']
        
        # Extract metadata from object key or S3 metadata
        document_type = get_document_type(key)
        session_id = get_session_id(key)
        
        # Get the image from S3
        response = s3_client.get_object(Bucket=bucket, Key=key)
        image_content = response['Body'].read()
        
        # Process the image based on document type
        processed_image, quality_metrics = process_document(image_content, document_type)
        
        # Check if quality meets threshold
        quality_status = "ACCEPTED" if quality_metrics['overall_score'] >= quality_threshold else "REJECTED"
        
        # Generate output key
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        output_key = f"processed/{session_id}/{document_type.lower()}_{timestamp}.png"
        
        # Save processed image back to S3
        if quality_status == "ACCEPTED":
            output = io.BytesIO()
            processed_image.save(output, format='PNG')
            output.seek(0)
            s3_client.put_object(
                Bucket=output_bucket,
                Key=output_key,
                Body=output,
                ContentType='image/png',
                Metadata={
                    'document_type': document_type,
                    'session_id': session_id,
                    'processing_timestamp': timestamp,
                    'quality_score': str(quality_metrics['overall_score'])
                }
            )
        
        # Store processing results in DynamoDB
        store_processing_metadata(session_id, document_type, key, output_key, quality_metrics, quality_status)
        
        # Emit event for next processing step
        emit_processing_event(session_id, document_type, output_key, quality_status)
        
        return {
            'statusCode': 200,
            'documentId': f"{session_id}-{document_type}",
            'qualityStatus': quality_status,
            'outputLocation': f"s3://{output_bucket}/{output_key}" if quality_status == "ACCEPTED" else None,
            'qualityMetrics': quality_metrics
        }
        
    except Exception as e:
        logger.error(f"Error processing document: {str(e)}")
        # Store error in DynamoDB for tracking
        if 'session_id' in locals() and 'document_type' in locals():
            store_processing_error(session_id, document_type, str(e))
        
        # Emit error event
        if 'session_id' in locals():
            emit_error_event(session_id, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_document_type(key):
    """Extract document type from the S3 key or return default"""
    if 'passport' in key.lower():
        return 'PASSPORT'
    elif 'national_id' in key.lower() or 'id_card' in key.lower():
        return 'NATIONAL_ID'
    elif 'driver' in key.lower() or 'license' in key.lower():
        return 'DRIVERS_LICENSE'
    elif 'vehicle' in key.lower() or 'carte_grise' in key.lower():
        return 'VEHICLE_REGISTRATION'
    else:
        return 'UNKNOWN'

def get_session_id(key):
    """Extract session ID from the S3 key or generate a new one"""
    parts = key.split('/')
    if len(parts) >= 2:
        # Assuming key format: sessions/{session_id}/documents/{document_type}
        return parts[1]
    else:
        return str(uuid.uuid4())

def process_document(image_content, document_type):
    """
    Process document image based on document type
    
    Parameters:
    - image_content: Binary image content
    - document_type: Type of document (PASSPORT, NATIONAL_ID, etc.)
    
    Returns:
    - processed_image: PIL Image object of processed document
    - quality_metrics: Dictionary of quality metrics
    """
    # Convert image to OpenCV format
    nparr = np.frombuffer(image_content, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    # Apply document-specific processing
    if document_type in ['PASSPORT', 'NATIONAL_ID']:
        processed_img, metrics = process_identity_document(img)
    elif document_type == 'DRIVERS_LICENSE':
        processed_img, metrics = process_drivers_license(img)
    elif document_type == 'VEHICLE_REGISTRATION':
        processed_img, metrics = process_vehicle_registration(img)
    else:
        processed_img, metrics = process_generic_document(img)
    
    # Convert back to PIL format for saving
    processed_pil = Image.fromarray(cv2.cvtColor(processed_img, cv2.COLOR_BGR2RGB))
    
    return processed_pil, metrics

def process_identity_document(img):
    """Process passport or national ID"""
    # Document detection and perspective correction
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 75, 200)
    
    # Find contours and identify the document boundary
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img, calculate_quality_metrics(img)
    
    # Get the largest contour (assumed to be the document)
    largest_contour = max(contours, key=cv2.contourArea)
    
    # Approximate the contour to get corners
    epsilon = 0.02 * cv2.arcLength(largest_contour, True)
    approx = cv2.approxPolyDP(largest_contour, epsilon, True)
    
    # If we have a quadrilateral, correct perspective
    if len(approx) == 4:
        processed = correct_perspective(img, approx.reshape(4, 2))
    else:
        processed = img
    
    # Enhance image
    processed = enhance_document_image(processed)
    
    # Calculate quality metrics
    metrics = calculate_quality_metrics(processed)
    
    return processed, metrics

def process_drivers_license(img):
    """Process driver's license document"""
    # Similar to identity document but with different parameters
    processed, metrics = process_identity_document(img)
    
    # Additional processing specific to driver's license
    # - Enhance text areas for license number
    # - Improve contrast for category fields
    
    return processed, metrics

def process_vehicle_registration(img):
    """Process vehicle registration (Carte Grise)"""
    # Carte Grise often has different color and format
    processed, metrics = process_generic_document(img)
    
    # Additional processing specific to vehicle registration
    # - Handle specific color scheme of Carte Grise
    # - Enhance vehicle details area
    
    return processed, metrics

def process_generic_document(img):
    """Process generic document when specific type is unknown"""
    # Basic image enhancement without specialized processing
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    enhanced = cv2.equalizeHist(gray)
    enhanced = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
    
    # Calculate quality metrics
    metrics = calculate_quality_metrics(enhanced)
    
    return enhanced, metrics

def correct_perspective(img, corners):
    """
    Applies perspective correction to document image
    
    Parameters:
    - img: Original image
    - corners: Four corners of the document
    
    Returns:
    - Perspective-corrected image
    """
    # Sort corners (top-left, top-right, bottom-right, bottom-left)
    rect = order_points(corners)
    (tl, tr, br, bl) = rect
    
    # Compute width of new image
    width_a = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    width_b = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    max_width = max(int(width_a), int(width_b))
    
    # Compute height of new image
    height_a = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    height_b = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    max_height = max(int(height_a), int(height_b))
    
    # Define destination points for perspective transform
    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1]
    ], dtype="float32")
    
    # Compute perspective transform matrix
    transform_matrix = cv2.getPerspectiveTransform(rect, dst)
    
    # Apply perspective transformation
    warped = cv2.warpPerspective(img, transform_matrix, (max_width, max_height))
    
    return warped

def order_points(pts):
    """
    Order points in [top-left, top-right, bottom-right, bottom-left] order
    
    Parameters:
    - pts: Four corner points
    
    Returns:
    - Ordered points
    """
    rect = np.zeros((4, 2), dtype="float32")
    
    # Top-left has smallest sum, bottom-right has largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    
    # Top-right has smallest difference, bottom-left has largest difference
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    
    return rect

def enhance_document_image(img):
    """
    Enhances document image for better text recognition
    
    Parameters:
    - img: Original image
    
    Returns:
    - Enhanced image
    """
    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Apply adaptive histogram equalization
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    
    # Apply bilateral filter to enhance text while reducing noise
    enhanced = cv2.bilateralFilter(enhanced, 9, 75, 75)
    
    # Convert back to BGR for consistency
    enhanced = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
    
    return enhanced

def calculate_quality_metrics(img):
    """
    Calculate quality metrics for the document image
    
    Parameters:
    - img: Document image
    
    Returns:
    - Dictionary of quality metrics
    """
    # Convert to grayscale for calculations
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Calculate sharpness (variance of Laplacian)
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    sharpness = laplacian.var()
    
    # Calculate brightness (mean pixel value)
    brightness = gray.mean() / 255.0  # Normalize to 0-1
    
    # Calculate contrast (standard deviation of pixel values)
    contrast = gray.std() / 255.0  # Normalize to 0-1
    
    # Calculate noise level (approximation using median filter)
    median_filtered = cv2.medianBlur(gray, 3)
    noise = np.mean(np.abs(gray.astype(np.float32) - median_filtered.astype(np.float32))) / 255.0
    
    # Calculate overall quality score (weighted average)
    sharpness_norm = min(1.0, sharpness / 2000)  # Normalize sharpness
    overall_score = (0.4 * sharpness_norm + 0.2 * brightness + 0.3 * contrast - 0.1 * noise)
    
    # Ensure overall score is between 0 and 1
    overall_score = max(0.0, min(1.0, overall_score))
    
    return {
        "sharpness": sharpness_norm,
        "brightness": brightness,
        "contrast": contrast,
        "noise_level": noise,
        "overall_score": overall_score
    }

def store_processing_metadata(session_id, document_type, source_key, output_key, quality_metrics, quality_status):
    """
    Store document processing metadata in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - source_key: Original S3 key
    - output_key: Processed document S3 key
    - quality_metrics: Dictionary of quality metrics
    - quality_status: ACCEPTED or REJECTED
    """
    timestamp = datetime.now().isoformat()
    
    try:
        table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"DOCUMENT#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'sourceKey': source_key,
                'outputKey': output_key if quality_status == "ACCEPTED" else None,
                'processingTimestamp': timestamp,
                'qualityStatus': quality_status,
                'qualityMetrics': quality_metrics,
                'stage': 'PREPROCESSED',
                'ttl': int((datetime.now().timestamp() + 90 * 24 * 60 * 60))  # 90 days expiry
            }
        )
    except Exception as e:
        logger.error(f"Error storing metadata: {str(e)}")
        raise

def store_processing_error(session_id, document_type, error_message):
    """
    Store error information in DynamoDB
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - error_message: Error message
    """
    timestamp = datetime.now().isoformat()
    
    try:
        table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#PREPROCESSOR#{document_type}",
                'documentType': document_type,
                'sessionId': session_id,
                'errorTimestamp': timestamp,
                'errorMessage': error_message,
                'stage': 'PREPROCESSOR',
                'ttl': int((datetime.now().timestamp() + 30 * 24 * 60 * 60))  # 30 days expiry
            }
        )
    except Exception as e:
        logger.error(f"Error storing error information: {str(e)}")

def emit_processing_event(session_id, document_type, output_key, quality_status):
    """
    Emit event for document processing pipeline
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    - output_key: Processed document S3 key
    - quality_status: ACCEPTED or REJECTED
    """
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing-system',
                    'DetailType': 'DocumentPreprocessed',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'documentType': document_type,
                        'outputLocation': f"s3://{output_bucket}/{output_key}" if quality_status == "ACCEPTED" else None,
                        'qualityStatus': quality_status,
                        'timestamp': datetime.now().isoformat()
                    }),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting processing event: {str(e)}")

def emit_error_event(session_id, error_message):
    """
    Emit error event
    
    Parameters:
    - session_id: Session identifier
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
                        'errorMessage': error_message,
                        'component': 'DocumentPreprocessor',
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

Create a file `lambda/document-preprocessor/requirements.txt` with the library dependencies:

```
numpy==1.23.5
opencv-python-headless==4.7.0.72
Pillow==9.4.0
```

### 5. Build and Deploy

```bash
# Install dependencies for Lambda layer
cd lambda/document-preprocessor
pip install -r requirements.txt -t ./python

# Return to project root
cd ../..

# Build and deploy the CDK stacks
npm run build
cdk deploy FrenchDocProcessingStorageStack FrenchDocProcessingPreprocessorStack --require-approval never
```

## Key Technical Considerations

1. **Lambda Configuration**:
   - Memory size set to 2048MB to handle image processing efficiently
   - Timeout set to 30 seconds to allow for complex processing
   - Python 3.9 runtime for compatibility with OpenCV

2. **Dependencies**:
   - OpenCV for image processing and document boundary detection
   - Pillow for image manipulation and format conversion
   - NumPy for numerical operations

3. **Event-Driven Architecture**:
   - S3 event notifications trigger the Lambda function when documents are uploaded
   - EventBridge events notify downstream services when preprocessing is complete
   - Error handling events for system monitoring

4. **Security Considerations**:
   - IAM roles follow principle of least privilege
   - S3 access limited to specific buckets and operations
   - DynamoDB access limited to specific tables and operations

5. **Monitoring and Logging**:
   - CloudWatch Log Group with one-month retention
   - Error reporting through EventBridge
   - Function outputs for CloudFormation stack outputs