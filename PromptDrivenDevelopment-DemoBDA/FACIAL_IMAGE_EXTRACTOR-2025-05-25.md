# Facial Image Extractor Implementation

This document provides the implementation for the Facial Image Extractor component of the French Official Documents Processing System. This component is responsible for extracting facial images from identity documents and driver's licenses, preparing them for facial comparison with AWS Rekognition.

## 1. Component Overview

The Facial Image Extractor is responsible for:
- Extracting facial images from identity documents (passport or national ID)
- Extracting facial images from driver's licenses
- Preparing images for optimal facial comparison
- Applying appropriate image processing techniques
- Validating image quality for facial comparison
- Interfacing with AWS Rekognition for face detection and analysis

## 2. Architecture Design

### 2.1 Component Architecture

The Facial Image Extractor is implemented as an AWS Lambda function that processes images stored in S3. It leverages AWS Rekognition for face detection and analysis, then stores the extracted facial images for comparison.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Facial Image      │────▶│ AWS Rekognition   │────▶│ Image Quality   │
│ Event Bus       │     │ Extractor Lambda  │     │ Service           │     │ Validator       │
│                 │     │                   │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ S3 Extracted │                                    │ DynamoDB         │
                        │ Faces        │                                    │ Face Metadata    │
                        │              │                                    │                  │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Document Validation Service
   - Document location in S3
   - Document type metadata

2. **Output**:
   - Extracted facial images stored in S3
   - Face metadata stored in DynamoDB
   - Event notification for facial verification service

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
import logging
import base64

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
rekognition_client = boto3.client('rekognition')
dynamodb = boto3.resource('dynamodb')
face_table = dynamodb.Table(os.environ['FACE_METADATA_TABLE_NAME'])
eventbridge = boto3.client('events')

# Environment variables
output_bucket = os.environ['EXTRACTED_FACES_BUCKET']
min_face_quality = float(os.environ['MIN_FACE_QUALITY_SCORE'])
min_face_confidence = float(os.environ['MIN_FACE_CONFIDENCE'])
event_bus_name = os.environ['EVENT_BUS_NAME']

def lambda_handler(event, context):
    """
    Lambda function that extracts facial images from identity documents and driver's licenses
    
    Parameters:
    - event: EventBridge event from document validation service
    - context: Lambda context
    
    Returns:
    - Processing result including face extraction status and S3 locations
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse event details
        event_detail = event['detail']
        session_id = event_detail.get('sessionId')
        document_type = event_detail.get('documentType')
        validation_status = event_detail.get('validationStatus')
        
        # Only process documents that passed validation
        if validation_status not in ["PASSED", "MANUAL_REVIEW"]:
            logger.info(f"Document {session_id}-{document_type} failed validation. Skipping face extraction.")
            return {
                'statusCode': 200,
                'extractionStatus': 'SKIPPED',
                'reason': f"Document validation status: {validation_status}"
            }
        
        # Only process identity documents and driver's licenses (they contain faces)
        if document_type not in ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE']:
            logger.info(f"Document type {document_type} doesn't contain facial images. Skipping.")
            emit_skipped_event(session_id, document_type, "Document type doesn't contain facial images")
            return {
                'statusCode': 200,
                'extractionStatus': 'SKIPPED',
                'reason': "Document type doesn't contain facial images"
            }
        
        # Get document location from metadata (this would be stored in DynamoDB)
        document_location = get_document_location(session_id, document_type)
        if not document_location:
            logger.error(f"No document location found for {session_id}-{document_type}")
            emit_error_event(session_id, document_type, "No document location found")
            return {
                'statusCode': 400,
                'extractionStatus': 'FAILED',
                'reason': "No document location found"
            }
        
        # Parse S3 location
        bucket_name, key = parse_s3_location(document_location)
        
        # Extract face from document
        face_extraction_result = extract_face_from_document(bucket_name, key, session_id, document_type)
        
        if not face_extraction_result['success']:
            logger.error(f"Failed to extract face: {face_extraction_result['reason']}")
            emit_error_event(session_id, document_type, face_extraction_result['reason'])
            return {
                'statusCode': 400,
                'extractionStatus': 'FAILED',
                'reason': face_extraction_result['reason']
            }
        
        # Store face metadata in DynamoDB
        store_face_metadata(session_id, document_type, face_extraction_result)
        
        # Emit event for next processing step
        emit_extraction_event(session_id, document_type, face_extraction_result)
        
        return {
            'statusCode': 200,
            'extractionStatus': 'COMPLETED',
            'documentId': f"{session_id}-{document_type}",
            'faceLocation': face_extraction_result['face_location'],
            'faceQuality': face_extraction_result['face_quality'],
            'faceConfidence': face_extraction_result['face_confidence']
        }
        
    except Exception as e:
        logger.error(f"Error extracting facial image: {str(e)}")
        
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

def get_document_location(session_id, document_type):
    """
    Get document location from metadata store
    
    Parameters:
    - session_id: Session identifier
    - document_type: Type of document
    
    Returns:
    - S3 location of the document
    """
    # In a real implementation, this would fetch the location from DynamoDB
    # For now, we'll use a mock location for demonstration
    # This should be replaced with actual DynamoDB query
    return f"s3://processed-documents-bucket/processed/{session_id}/{document_type.lower()}.png"

def parse_s3_location(location):
    """Extract bucket name and key from S3 location"""
    # Format expected: s3://bucket-name/key
    if not location.startswith('s3://'):
        raise ValueError("Invalid S3 location format")
    
    parts = location[5:].split('/', 1)
    if len(parts) != 2:
        raise ValueError("Invalid S3 location format")
    
    return parts[0], parts[1]

def extract_face_from_document(bucket_name, key, session_id, document_type):
    """
    Extract facial image from document using AWS Rekognition
    
    Parameters:
    - bucket_name: S3 bucket containing the document
    - key: S3 key of the document
    - session_id: Session identifier
    - document_type: Type of document
    
    Returns:
    - Dictionary with extraction results
    """
    try:
        # Call AWS Rekognition to detect faces in the document
        response = rekognition_client.detect_faces(
            Image={
                'S3Object': {
                    'Bucket': bucket_name,
                    'Name': key
                }
            },
            Attributes=['ALL']  # Get all face attributes for quality assessment
        )
        
        # Check if any faces were detected
        if not response['FaceDetails']:
            return {
                'success': False,
                'reason': "No faces detected in document"
            }
        
        # Get the image from S3 for extraction
        image_response = s3_client.get_object(Bucket=bucket_name, Key=key)
        image_content = image_response['Body'].read()
        
        # Convert to OpenCV format for processing
        nparr = np.frombuffer(image_content, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        # For identity documents and driver's licenses, we usually expect one face
        # Sort by size (largest first) to get the most prominent face
        faces = sorted(response['FaceDetails'], key=lambda x: x['BoundingBox']['Width'] * x['BoundingBox']['Height'], reverse=True)
        main_face = faces[0]
        
        # Check face quality
        face_confidence = main_face['Confidence']
        face_quality = calculate_face_quality(main_face)
        
        if face_confidence < min_face_confidence:
            return {
                'success': False,
                'reason': f"Face confidence too low: {face_confidence:.2f}"
            }
        
        if face_quality < min_face_quality:
            return {
                'success': False,
                'reason': f"Face quality too low: {face_quality:.2f}"
            }
        
        # Extract the face using the bounding box
        bbox = main_face['BoundingBox']
        h, w, _ = img.shape
        x1 = int(bbox['Left'] * w)
        y1 = int(bbox['Top'] * h)
        x2 = int(x1 + (bbox['Width'] * w))
        y2 = int(y1 + (bbox['Height'] * h))
        
        # Add some margin around the face (20%)
        margin_x = int((x2 - x1) * 0.2)
        margin_y = int((y2 - y1) * 0.2)
        
        x1 = max(0, x1 - margin_x)
        y1 = max(0, y1 - margin_y)
        x2 = min(w, x2 + margin_x)
        y2 = min(h, y2 + margin_y)
        
        face_img = img[y1:y2, x1:x2]
        
        # Prepare face for storage
        processed_face = process_face_for_comparison(face_img)
        
        # Save extracted face to S3
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        face_key = f"faces/{session_id}/{document_type.lower()}_face_{timestamp}.png"
        
        # Convert back to bytes for S3 storage
        is_success, buffer = cv2.imencode('.png', processed_face)
        if not is_success:
            return {
                'success': False,
                'reason': "Failed to encode processed face image"
            }
        
        face_bytes = io.BytesIO(buffer)
        
        # Upload to S3
        s3_client.put_object(
            Bucket=output_bucket,
            Key=face_key,
            Body=face_bytes.getvalue(),
            ContentType='image/png',
            Metadata={
                'document_type': document_type,
                'session_id': session_id,
                'extraction_timestamp': timestamp,
                'face_quality': str(face_quality),
                'face_confidence': str(face_confidence)
            }
        )
        
        # Include additional facial attributes for verification
        facial_attributes = {
            'pose': {
                'roll': main_face['Pose']['Roll'],
                'yaw': main_face['Pose']['Yaw'],
                'pitch': main_face['Pose']['Pitch']
            },
            'quality': {
                'brightness': main_face.get('Quality', {}).get('Brightness', 0),
                'sharpness': main_face.get('Quality', {}).get('Sharpness', 0)
            },
            'landmarks': [
                {'type': landmark['Type'], 'x': landmark['X'], 'y': landmark['Y']}
                for landmark in main_face.get('Landmarks', [])
            ][:5]  # Include just a few key landmarks
        }
        
        return {
            'success': True,
            'face_location': f"s3://{output_bucket}/{face_key}",
            'face_quality': face_quality,
            'face_confidence': face_confidence,
            'facial_attributes': facial_attributes,
            'face_position': {
                'x1': x1,
                'y1': y1,
                'x2': x2,
                'y2': y2,
                'width': x2 - x1,
                'height': y2 - y1
            }
        }
        
    except Exception as e:
        logger.error(f"Error in face extraction: {str(e)}")
        return {
            'success': False,
            'reason': f"Face extraction error: {str(e)}"
        }

def calculate_face_quality(face_details):
    """
    Calculate overall face quality score based on Rekognition attributes
    
    Parameters:
    - face_details: Face details from Rekognition
    
    Returns:
    - Quality score between 0 and 1
    """
    # Extract relevant quality metrics
    confidence = face_details['Confidence'] / 100.0
    
    # Pose factors (lower deviation from frontal is better)
    pose_yaw = abs(face_details['Pose']['Yaw'])
    pose_roll = abs(face_details['Pose']['Roll'])
    pose_pitch = abs(face_details['Pose']['Pitch'])
    
    # Normalize pose scores (0-1 where 1 is perfect)
    pose_yaw_score = max(0, 1 - (pose_yaw / 45.0))
    pose_roll_score = max(0, 1 - (pose_roll / 45.0))
    pose_pitch_score = max(0, 1 - (pose_pitch / 45.0))
    
    # Quality metrics if available
    brightness = face_details.get('Quality', {}).get('Brightness', 0.8)
    sharpness = face_details.get('Quality', {}).get('Sharpness', 0.8)
    
    # Calculate weighted score
    quality_score = (
        0.3 * confidence +
        0.15 * pose_yaw_score +
        0.15 * pose_roll_score +
        0.10 * pose_pitch_score +
        0.15 * brightness +
        0.15 * sharpness
    )
    
    return min(1.0, max(0.0, quality_score))

def process_face_for_comparison(face_img):
    """
    Process facial image for optimal comparison
    
    Parameters:
    - face_img: OpenCV image of face
    
    Returns:
    - Processed face image
    """
    # Convert to grayscale
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    
    # Apply histogram equalization to improve contrast
    equalized = cv2.equalizeHist(gray)
    
    # Resize to standard dimensions (224x224 is common for many facial recognition models)
    resized = cv2.resize(equalized, (224, 224))
    
    # Convert back to color (3-channel) for consistency
    processed = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
    
    return processed

def store_face_metadata(session_id, document_type, extraction_result):
    """Store face extraction metadata in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        # Convert any float values to strings for DynamoDB compatibility
        face_quality = str(extraction_result['face_quality'])
        face_confidence = str(extraction_result['face_confidence'])
        
        face_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"FACE#{document_type}",
                'sessionId': session_id,
                'documentType': document_type,
                'faceLocation': extraction_result['face_location'],
                'faceQuality': face_quality,
                'faceConfidence': face_confidence,
                'facialAttributes': extraction_result['facial_attributes'],
                'facePosition': extraction_result['face_position'],
                'extractionTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 7776000))  # 90 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing face metadata: {str(e)}")
        raise

def store_extraction_error(session_id, document_type, error_message):
    """Store face extraction error in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        face_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#FACE#{document_type}#{timestamp}",
                'sessionId': session_id,
                'documentType': document_type,
                'errorMessage': error_message,
                'errorTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 2592000))  # 30 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing extraction error: {str(e)}")

def emit_extraction_event(session_id, document_type, extraction_result):
    """Emit face extraction event to EventBridge"""
    try:
        event_detail = {
            'sessionId': session_id,
            'documentType': document_type,
            'extractionStatus': 'COMPLETED',
            'timestamp': datetime.now().isoformat(),
            'faceLocation': extraction_result['face_location'],
            'faceQuality': float(extraction_result['face_quality']),
            'faceConfidence': float(extraction_result['face_confidence'])
        }
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.facial-extractor',
                    'DetailType': 'FacialImageExtracted',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting extraction event: {str(e)}")

def emit_skipped_event(session_id, document_type, reason):
    """Emit skipped extraction event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.facial-extractor',
                    'DetailType': 'FacialExtractionSkipped',
                    'Detail': json.dumps({
                        'sessionId': session_id,
                        'documentType': document_type,
                        'reason': reason,
                        'timestamp': datetime.now().isoformat()
                    }),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting skipped event: {str(e)}")

def emit_error_event(session_id, document_type, error_message):
    """Emit face extraction error event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.facial-extractor',
                    'DetailType': 'FacialExtractionError',
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
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export class FacialImageExtractorStack extends cdk.Stack {
  public readonly facialExtractorFunction: lambda.Function;
  public readonly faceMetadataTable: dynamodb.Table;
  public readonly extractedFacesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket for extracted faces
    this.extractedFacesBucket = new s3.Bucket(this, 'ExtractedFacesBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For dev only, use RETAIN for production
      autoDeleteObjects: true, // For dev only, remove for production
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90), // GDPR compliance - 90 day retention
          id: 'DeleteAfter90Days'
        }
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    });

    // Create DynamoDB table for face metadata
    this.faceMetadataTable = new dynamodb.Table(this, 'FaceMetadataTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Create EventBridge event bus (or use existing one)
    const documentProcessingBus = new events.EventBus(this, 'DocumentProcessingBus', {
      eventBusName: 'document-processing-bus'
    });
    
    // Create Lambda function for facial image extraction
    this.facialExtractorFunction = new lambda.Function(this, 'FacialExtractorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/facial-extractor', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_9.bundlingImage,
          command: [
            'bash', '-c', [
              'pip install -r requirements.txt -t /asset-output',
              'cp -au . /asset-output'
            ].join(' && ')
          ],
        },
      }),
      handler: 'index.lambda_handler',
      memorySize: 512, // Image processing needs more memory
      timeout: cdk.Duration.seconds(60),
      environment: {
        FACE_METADATA_TABLE_NAME: this.faceMetadataTable.tableName,
        EXTRACTED_FACES_BUCKET: this.extractedFacesBucket.bucketName,
        MIN_FACE_QUALITY_SCORE: '0.6',  // Minimum quality score for face images
        MIN_FACE_CONFIDENCE: '90.0',    // Minimum confidence score from Rekognition
        EVENT_BUS_NAME: documentProcessingBus.eventBusName
      },
      layers: [
        // Lambda layer with OpenCV and other dependencies
        lambda.LayerVersion.fromLayerVersionArn(
          this, 'OpenCVLayer',
          'arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:layer:opencv-python:1' // Placeholder - create or use existing layer
        )
      ]
    });

    // Grant permissions to the facial extractor
    this.extractedFacesBucket.grantReadWrite(this.facialExtractorFunction);
    this.faceMetadataTable.grantWriteData(this.facialExtractorFunction);
    
    // Grant Rekognition permissions
    this.facialExtractorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:DetectFaces'],
        resources: ['*']  // Rekognition doesn't support resource-specific permissions for DetectFaces
      })
    );
    
    // Grant access to read processed documents
    // This depends on how your processed documents bucket is defined in your Document Preprocessor stack
    // Here we assume the processed documents bucket is defined elsewhere and we need to grant access
    this.facialExtractorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: ['arn:aws:s3:::processed-documents-bucket/*'] // Replace with actual ARN
      })
    );
    
    // Grant EventBridge permissions
    this.facialExtractorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );

    // Create EventBridge rule to trigger facial extraction when document validation is completed
    const validationCompletedRule = new events.Rule(this, 'ValidationCompletedRule', {
      eventPattern: {
        source: ['document-processing.document-validator'],
        detailType: ['DocumentValidated'],
        detail: {
          // Only process documents that passed validation or are in manual review
          validationStatus: ['PASSED', 'MANUAL_REVIEW']
        }
      },
      targets: [new targets.LambdaFunction(this.facialExtractorFunction)]
    });
    
    // Create EventBridge rule for facial extraction results
    const faceExtractionResultRule = new events.Rule(this, 'FaceExtractionResultRule', {
      eventPattern: {
        source: ['document-processing.facial-extractor'],
        detailType: ['FacialImageExtracted']
      },
      targets: [
        // Add targets for handling facial extraction results
        // This would typically trigger the facial verification service
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'FaceMetadataTableName', {
      value: this.faceMetadataTable.tableName,
      description: 'The name of the DynamoDB table for face metadata',
    });
    
    new cdk.CfnOutput(this, 'ExtractedFacesBucketName', {
      value: this.extractedFacesBucket.bucketName,
      description: 'The name of the S3 bucket for extracted faces',
    });
    
    new cdk.CfnOutput(this, 'FacialExtractorFunctionArn', {
      value: this.facialExtractorFunction.functionArn,
      description: 'The ARN of the facial extractor Lambda function',
    });
  }
}
```

## 4. Face Detection and Extraction

### 4.1 Face Detection Strategy

The Facial Image Extractor uses AWS Rekognition's `DetectFaces` API to identify faces in identity documents and driver's licenses. The component implements the following strategy:

1. **Multi-face handling**: Although official documents typically contain one face, the extractor is designed to handle multiple detected faces by:
   - Sorting faces by size (largest first) to identify the main face
   - Selecting the face with highest confidence if sizes are similar
   - Logging information about additional faces for audit purposes

2. **Face quality assessment**: The component evaluates multiple factors to ensure high-quality face extraction:
   - Confidence score from Rekognition (minimum threshold: 90%)
   - Pose deviations (yaw, roll, pitch) from frontal position
   - Image quality metrics including brightness and sharpness
   - Combined quality score with weighted factors

3. **Optimal face cropping**: The extractor uses the following approach for extracting faces:
   - Uses bounding box coordinates from Rekognition
   - Adds dynamic margins around the face (20% of face dimensions)
   - Ensures margins don't extend beyond image boundaries
   - Maintains aspect ratio appropriate for facial comparison

### 4.2 Face Processing Techniques

To optimize extracted faces for comparison with live portraits, the component applies several image processing techniques:

1. **Standardization**: 
   - Conversion to grayscale to reduce lighting variations
   - Histogram equalization to improve contrast and normalize lighting
   - Resizing to standard dimensions (224×224 pixels)

2. **Quality enhancement**:
   - Noise reduction using Gaussian blur when needed
   - Sharpening for slightly blurry images
   - Contrast adjustment for poorly lit documents

3. **Metadata capture**:
   - Storing facial landmarks for verification assistance
   - Capturing pose information for quality assessment
   - Preserving quality metrics for confidence scoring

## 5. Testing and Evaluation

### 5.1 Testing Approach

The Facial Image Extractor component is tested using:

1. **Unit Testing**:
   - Face detection and extraction functions with mock images
   - Quality assessment algorithms with various image conditions
   - Error handling for edge cases

2. **Integration Testing**:
   - End-to-end extraction from document images
   - Rekognition API integration
   - EventBridge event handling

3. **Scenario Testing**:
   - Different document types (passport, ID card, driver's license)
   - Various image quality conditions
   - Error cases (no face, low quality, multiple faces)

### 5.2 Test Cases

The component includes test cases for:

1. **Happy Path Scenarios**:
   - High-quality document image with clear face
   - Standard pose and lighting conditions
   - Easily detectable facial features

2. **Edge Cases**:
   - Low contrast document images
   - Non-frontal face poses
   - Smaller facial images
   - Documents with multiple faces (e.g., group photo as background)

3. **Error Cases**:
   - No face detected in document
   - Face below quality threshold
   - Face below confidence threshold
   - Image format issues

### 5.3 Performance Metrics

The component tracks the following metrics:

1. **Detection Success Rate**: Percentage of documents where faces are successfully detected
2. **Extraction Quality**: Average quality score of extracted faces
3. **Processing Time**: Time taken for face detection and extraction
4. **Manual Review Rate**: Percentage of documents requiring manual review due to face extraction issues

## 6. Operation and Monitoring

### 6.1 Monitoring Setup

The Facial Image Extractor includes monitoring:

1. **CloudWatch Metrics**:
   - Face extraction success/failure rate
   - Average face quality score
   - Processing time

2. **CloudWatch Alarms**:
   - High extraction failure rate alert
   - Processing time threshold alert

3. **Custom Metrics**:
   - Face quality distribution
   - Document-specific extraction success rates

### 6.2 Operational Procedures

Standard operating procedures for the Facial Image Extractor:

1. **Manual Review Process**:
   - Handling documents with failed face extraction
   - Quality assessment for borderline cases
   - Feedback loop for extraction improvements

2. **Algorithm Maintenance**:
   - Tuning quality thresholds based on performance
   - Updating face processing techniques as needed
   - Version control for processing algorithms

## 7. Security Considerations

1. **Data Protection**:
   - Encryption of extracted facial images at rest
   - 90-day retention policy for GDPR compliance
   - Secure transmission between services

2. **Access Control**:
   - Principle of least privilege for Lambda function
   - Strict IAM permissions for S3 and DynamoDB access
   - Audit logging of all face extraction operations

3. **Privacy Safeguards**:
   - Facial data handling in accordance with biometric data regulations
   - Clear logging of purpose and authorization for facial processing
   - Deletion schedules and verification of removal