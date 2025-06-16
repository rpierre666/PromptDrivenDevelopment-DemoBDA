# Document Pre-processor Implementation

This document provides the implementation for the Document Pre-processor component of the French Official Documents Processing System using AWS Bedrock Data Automation. The Document Pre-processor is a critical path component that ensures document quality before processing with Bedrock Data Automation.

## 1. Component Overview

The Document Pre-processor is responsible for:
- Enhancing image quality of uploaded documents
- Normalizing document orientation and perspective
- Detecting document boundaries
- Validating document quality for downstream processing
- Preparing images for optimal data extraction by Bedrock Data Automation

## 2. Architecture Design

### 2.1 Component Architecture

The Document Pre-processor is implemented as an AWS Lambda function that processes documents stored in S3. It leverages AWS Lambda's image processing capabilities and integrates with Amazon Rekognition for document analysis.

```
┌─────────────┐     ┌───────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│             │     │               │     │                     │     │                  │
│    S3       │────▶│ AWS Lambda    │────▶│ OpenCV Processing   │────▶│ Amazon           │
│ Raw Images  │     │ Function      │     │ Library             │     │ Rekognition      │
│             │     │               │     │                     │     │                  │
└─────────────┘     └───────────────┘     └─────────────────────┘     └──────────────────┘
                           │                                                   │
                           │                                                   │
                           ▼                                                   ▼
                    ┌─────────────┐                                    ┌──────────────────┐
                    │             │                                    │                  │
                    │    S3       │                                    │ Document Quality │
                    │ Processed   │                                    │ Validation       │
                    │ Images      │                                    │                  │
                    └─────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - S3 event trigger when a new document is uploaded
   - Document type metadata from the client application

2. **Output**:
   - Processed document stored in S3
   - Processing status and quality metrics stored in DynamoDB
   - Event notification for downstream processing

## 3. Implementation

### 3.1 AWS Lambda Function

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

# Initialize AWS clients
s3_client = boto3.client('s3')
rekognition_client = boto3.client('rekognition')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['METADATA_TABLE_NAME'])
eventbridge = boto3.client('events')

# Environment variables
output_bucket = os.environ['PROCESSED_DOCUMENTS_BUCKET']
quality_threshold = float(os.environ['QUALITY_THRESHOLD'])

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
        print(f"Error processing document: {str(e)}")
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
    # - Improve readability of registration fields
    # - Handle colored backgrounds
    
    return processed, metrics

def process_generic_document(img):
    """Generic document processing for unknown types"""
    # Basic image enhancement
    processed = enhance_document_image(img)
    
    # Calculate quality metrics
    metrics = calculate_quality_metrics(processed)
    
    return processed, metrics

def correct_perspective(img, corners):
    """Correct document perspective based on identified corners"""
    # Sort corners (top-left, top-right, bottom-right, bottom-left)
    rect = order_points(corners)
    
    # Calculate width and height of the corrected image
    (tl, tr, br, bl) = rect
    widthA = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
    widthB = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
    maxWidth = max(int(widthA), int(widthB))
    
    heightA = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
    heightB = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
    maxHeight = max(int(heightA), int(heightB))
    
    # Destination points for transform
    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]], dtype="float32")
    
    # Compute perspective transform and apply it
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(img, M, (maxWidth, maxHeight))
    
    return warped

def order_points(pts):
    """Order points in top-left, top-right, bottom-right, bottom-left order"""
    rect = np.zeros((4, 2), dtype="float32")
    
    # Top-left will have smallest sum, bottom-right largest sum
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    
    # Top-right will have smallest difference, bottom-left largest difference
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    
    return rect

def enhance_document_image(img):
    """Enhance document image for better OCR processing"""
    # Convert to grayscale if not already
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img
    
    # Apply adaptive histogram equalization for better contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    equalized = clahe.apply(gray)
    
    # Apply bilateral filter to enhance edges while removing noise
    filtered = cv2.bilateralFilter(equalized, 9, 75, 75)
    
    # Convert back to color if original was color
    if len(img.shape) == 3:
        enhanced = cv2.cvtColor(filtered, cv2.COLOR_GRAY2BGR)
    else:
        enhanced = filtered
    
    return enhanced

def calculate_quality_metrics(img):
    """Calculate document quality metrics"""
    # Convert to grayscale if not already
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img
    
    # Calculate blur score (lower is blurrier)
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    blur_score = min(1.0, laplacian_var / 500)  # Normalize between 0-1
    
    # Calculate brightness and contrast
    brightness = np.mean(gray) / 255  # Normalize between 0-1
    contrast = np.std(gray) / 128  # Normalize approximately between 0-1
    
    # Check image resolution (DPI proxy)
    height, width = img.shape[:2]
    resolution_score = min(1.0, (width * height) / (1000 * 1500))
    
    # Calculate overall quality score (weighted average)
    overall_score = (0.4 * blur_score + 0.2 * brightness + 0.2 * contrast + 0.2 * resolution_score)
    
    return {
        'blur_score': round(blur_score, 3),
        'brightness': round(brightness, 3),
        'contrast': round(contrast, 3),
        'resolution_score': round(resolution_score, 3),
        'overall_score': round(overall_score, 3)
    }

def store_processing_metadata(session_id, document_type, input_key, output_key, quality_metrics, quality_status):
    """Store document processing metadata in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    table.put_item(
        Item={
            'pk': f"SESSION#{session_id}",
            'sk': f"DOCUMENT#{document_type}",
            'sessionId': session_id,
            'documentType': document_type,
            'inputLocation': input_key,
            'outputLocation': output_key if quality_status == "ACCEPTED" else None,
            'qualityStatus': quality_status,
            'qualityMetrics': quality_metrics,
            'processingTimestamp': timestamp,
            'ttl': int((datetime.now().timestamp() + 7776000))  # 90 days retention
        }
    )

def store_processing_error(session_id, document_type, error_message):
    """Store document processing error in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    table.put_item(
        Item={
            'pk': f"SESSION#{session_id}",
            'sk': f"ERROR#{document_type}#{timestamp}",
            'sessionId': session_id,
            'documentType': document_type,
            'errorMessage': error_message,
            'errorTimestamp': timestamp,
            'ttl': int((datetime.now().timestamp() + 2592000))  # 30 days retention
        }
    )

def emit_processing_event(session_id, document_type, output_key, quality_status):
    """Emit document processing event to EventBridge"""
    eventbridge.put_events(
        Entries=[
            {
                'Source': 'document-processing.pre-processor',
                'DetailType': 'DocumentProcessed',
                'Detail': json.dumps({
                    'sessionId': session_id,
                    'documentType': document_type,
                    'outputLocation': output_key,
                    'qualityStatus': quality_status,
                    'timestamp': datetime.now().isoformat()
                }),
                'EventBusName': 'document-processing-bus'
            }
        ]
    )

def emit_error_event(session_id, error_message):
    """Emit document processing error event to EventBridge"""
    eventbridge.put_events(
        Entries=[
            {
                'Source': 'document-processing.pre-processor',
                'DetailType': 'DocumentProcessingError',
                'Detail': json.dumps({
                    'sessionId': session_id,
                    'errorMessage': error_message,
                    'timestamp': datetime.now().isoformat()
                }),
                'EventBusName': 'document-processing-bus'
            }
        ]
    )
```

### 3.2 AWS Infrastructure as Code (CDK)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

export class DocumentPreprocessorStack extends cdk.Stack {
  public readonly preprocessorFunction: lambda.Function;
  public readonly rawDocumentsBucket: s3.Bucket;
  public readonly processedDocumentsBucket: s3.Bucket;
  public readonly metadataTable: dynamodb.Table;
  public readonly documentProcessingBus: events.EventBus;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 buckets for document storage
    this.rawDocumentsBucket = new s3.Bucket(this, 'RawDocumentsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteAfter90Days',
          enabled: true,
          expiration: cdk.Duration.days(90), // GDPR compliance
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],  // Restrict in production
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    });

    this.processedDocumentsBucket = new s3.Bucket(this, 'ProcessedDocumentsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteAfter90Days',
          enabled: true,
          expiration: cdk.Duration.days(90), // GDPR compliance
        },
      ],
    });

    // Create DynamoDB table for metadata storage
    this.metadataTable = new dynamodb.Table(this, 'DocumentMetadataTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Create EventBridge bus for document processing events
    this.documentProcessingBus = new events.EventBus(this, 'DocumentProcessingBus', {
      eventBusName: 'document-processing-bus',
    });

    // Create layer for OpenCV and PIL dependencies
    const opencvLayer = new lambda.LayerVersion(this, 'OpenCVLayer', {
      code: lambda.Code.fromAsset('layers/opencv'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      description: 'OpenCV and PIL libraries for image processing',
    });

    // Create Lambda function for document pre-processing
    this.preprocessorFunction = new lambda.Function(this, 'DocumentPreprocessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/document-preprocessor'),
      handler: 'index.lambda_handler',
      memorySize: 2048,  // Higher memory for image processing
      timeout: cdk.Duration.seconds(60),
      environment: {
        PROCESSED_DOCUMENTS_BUCKET: this.processedDocumentsBucket.bucketName,
        METADATA_TABLE_NAME: this.metadataTable.tableName,
        QUALITY_THRESHOLD: '0.5',  // Minimum acceptable quality score
      },
      layers: [opencvLayer],
    });

    // Grant permissions
    this.rawDocumentsBucket.grantRead(this.preprocessorFunction);
    this.processedDocumentsBucket.grantWrite(this.preprocessorFunction);
    this.metadataTable.grantWriteData(this.preprocessorFunction);
    this.documentProcessingBus.grantPutEventsTo(this.preprocessorFunction);
    
    // Grant Rekognition permissions
    this.preprocessorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rekognition:DetectText', 'rekognition:AnalyzeDocument'],
      resources: ['*'],
    }));

    // Configure S3 event notification to trigger Lambda
    this.rawDocumentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED, 
      new s3n.LambdaDestination(this.preprocessorFunction),
      { prefix: 'uploads/' }
    );

    // Create EventBridge rule for quality validation failures
    new events.Rule(this, 'QualityValidationFailureRule', {
      eventBus: this.documentProcessingBus,
      eventPattern: {
        source: ['document-processing.pre-processor'],
        detailType: ['DocumentProcessed'],
        detail: {
          qualityStatus: ['REJECTED'],
        },
      },
      targets: [
        // Add target for handling rejected documents
        // This could be another Lambda function to notify users
      ],
    });

    // Create EventBridge rule for processing errors
    new events.Rule(this, 'ProcessingErrorRule', {
      eventBus: this.documentProcessingBus,
      eventPattern: {
        source: ['document-processing.pre-processor'],
        detailType: ['DocumentProcessingError'],
      },
      targets: [
        // Add target for handling errors
        // This could be an SQS queue for manual intervention
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'RawDocumentsBucketName', {
      value: this.rawDocumentsBucket.bucketName,
      description: 'The name of the S3 bucket for raw document uploads',
    });
    
    new cdk.CfnOutput(this, 'ProcessedDocumentsBucketName', {
      value: this.processedDocumentsBucket.bucketName,
      description: 'The name of the S3 bucket for processed documents',
    });
    
    new cdk.CfnOutput(this, 'DocumentMetadataTableName', {
      value: this.metadataTable.tableName,
      description: 'The name of the DynamoDB table for document metadata',
    });
  }
}
```

## 4. Technical Documentation

### 4.1 Image Processing Techniques

The Document Pre-processor uses the following image processing techniques to optimize documents for data extraction:

1. **Document Boundary Detection**
   - Uses Canny edge detection to identify document edges
   - Finds contours to identify the document boundaries
   - Approximates contours to identify document corners

2. **Perspective Correction**
   - Applies perspective transformation to obtain a top-down view
   - Corrects skewed or rotated documents
   - Normalizes document size and orientation

3. **Image Enhancement**
   - Applies adaptive histogram equalization for improved contrast
   - Uses bilateral filtering to reduce noise while preserving edges
   - Optimizes brightness and contrast for better text recognition

4. **Quality Assessment**
   - Evaluates blur using Laplacian variance
   - Assesses brightness and contrast
   - Checks image resolution adequacy
   - Calculates overall quality score

### 4.2 Document Type Specific Processing

Each document type requires specific processing techniques to optimize for data extraction:

1. **Identity Documents (Passport/National ID)**
   - Emphasis on MRZ (Machine Readable Zone) enhancement
   - Special handling for holographic elements
   - Enhanced contrast for facial images

2. **Driver's License**
   - Focus on license number and category fields
   - Enhanced contrast for security features
   - Special handling for photo area

3. **Vehicle Registration (Carte Grise)**
   - Handling of colored backgrounds
   - Enhanced contrast for registration numbers
   - Special processing for tabular data

### 4.3 Quality Metrics

The Document Pre-processor calculates the following quality metrics:

1. **Blur Score**: Measures image sharpness (0-1, higher is better)
   - Based on Laplacian variance
   - Critical for text extraction accuracy

2. **Brightness**: Measures overall image brightness (0-1)
   - Optimal range: 0.4-0.7
   - Too dark or too bright affects OCR accuracy

3. **Contrast**: Measures the distinction between light and dark areas (0-1)
   - Optimal range: 0.3-0.8
   - Higher values improve text detection

4. **Resolution Score**: Measures if image resolution is sufficient (0-1)
   - Based on total pixel count relative to minimum requirements
   - Critical for small text extraction

5. **Overall Score**: Weighted average of all metrics
   - Customizable weights based on document type
   - Used to determine if document quality is acceptable

## 5. Configuration Guide

### 5.1 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROCESSED_DOCUMENTS_BUCKET` | S3 bucket for processed documents | (Required) |
| `METADATA_TABLE_NAME` | DynamoDB table for document metadata | (Required) |
| `QUALITY_THRESHOLD` | Minimum acceptable quality score (0-1) | 0.5 |
| `ENABLE_REKOGNITION` | Whether to use Rekognition for validation | true |

### 5.2 Lambda Configuration

- **Memory**: 2048 MB (recommended for image processing)
- **Timeout**: 60 seconds
- **Runtime**: Python 3.9
- **Layer Dependencies**: OpenCV, PIL, NumPy

### 5.3 S3 Event Configuration

- **Event Type**: ObjectCreated
- **Prefix**: uploads/
- **Suffix**: .jpg, .jpeg, .png, .pdf

## 6. Testing Guide

### 6.1 Unit Testing

Unit tests for the Document Pre-processor are located in the `tests/unit` directory. Run tests using pytest:

```bash
python -m pytest tests/unit
```

Key test scenarios include:
- Document boundary detection accuracy
- Perspective correction effectiveness
- Image enhancement quality
- Quality metric calculation accuracy

### 6.2 Integration Testing

Integration tests verify the end-to-end flow from S3 upload to processed output:

```bash
python -m pytest tests/integration
```

Key test scenarios include:
- S3 event triggering
- DynamoDB metadata storage
- EventBridge event emission
- Handling of different document types

### 6.3 Test Data

The `test-data` directory contains sample documents for testing:
- Sample passport images
- Sample national ID card images
- Sample driver's license images
- Sample vehicle registration (Carte Grise) images

### 6.4 Performance Testing

Performance testing measures:
- Processing time for different document types and sizes
- Memory usage during image processing
- Throughput capabilities

## 7. Operating Procedures

### 7.1 Monitoring

Monitor the Document Pre-processor using:
- CloudWatch Metrics for Lambda execution
- CloudWatch Logs for processing details
- Custom metrics for quality scores and processing time

Key metrics to monitor:
- Rejection rate by document type
- Average processing time
- Error rate

### 7.2 Troubleshooting

Common issues and solutions:

1. **High Rejection Rate**
   - Check quality threshold configuration
   - Review sample rejected documents
   - Adjust image enhancement parameters

2. **Slow Processing Time**
   - Increase Lambda memory allocation
   - Optimize image resizing parameters
   - Consider splitting processing into multiple functions

3. **Incorrect Document Type Detection**
   - Review document type detection logic
   - Update detection patterns
   - Consider using metadata from client application

### 7.3 Updating the Component

When updating the Document Pre-processor:
1. Test changes in development environment
2. Deploy to staging for integration testing
3. Monitor performance after deployment
4. Be prepared to roll back if issues occur

## 8. Next Steps and Future Enhancements

1. **Machine Learning Enhancement**
   - Train custom models for document type recognition
   - Implement ML-based quality assessment

2. **Advanced Preprocessing**
   - Add support for multi-page documents
   - Implement glare and shadow removal
   - Add watermark detection and removal

3. **Performance Optimization**
   - Implement selective processing based on document quality
   - Add caching for frequently used preprocessing parameters
   - Optimize image sizing based on document type

4. **Integration Enhancements**
   - Add support for real-time feedback to client applications
   - Implement progressive processing for large documents
   - Develop document-specific preprocessing parameters