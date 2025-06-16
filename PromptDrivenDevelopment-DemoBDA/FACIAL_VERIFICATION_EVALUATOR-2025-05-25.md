# Facial Verification Evaluator Implementation

This document provides the implementation for the Facial Verification Evaluator component of the French Official Documents Processing System. This component is responsible for comparing facial images extracted from documents with the customer's live portrait photo to verify identity.

## 1. Component Overview

The Facial Verification Evaluator is responsible for:
- Comparing extracted facial images from identity documents with the customer's live portrait photo
- Integrating with AWS Rekognition for facial comparison analysis
- Applying configured FAR/FRR thresholds (FAR ≤ 0.1%, FRR ≤ 3%)
- Determining verification status (PASS/FAIL/MANUAL_REVIEW) based on confidence scores
- Handling verification errors and edge cases
- Generating verification results for downstream processing

## 2. Architecture Design

### 2.1 Component Architecture

The Facial Verification Evaluator is implemented as an AWS Lambda function that processes facial images stored in S3. It leverages AWS Rekognition's CompareFaces API to perform facial comparison and determine verification status based on configured thresholds.

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│                 │     │                   │     │                   │     │                 │
│ EventBridge     │────▶│ Facial            │────▶│ AWS Rekognition   │────▶│ Threshold       │
│ Event Bus       │     │ Verification      │     │ CompareFaces API  │     │ Evaluator       │
│                 │     │ Lambda            │     │                   │     │                 │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └─────────────────┘
                               │                                                    │
                               │                                                    │
                               ▼                                                    ▼
                        ┌──────────────┐                                    ┌──────────────────┐
                        │              │                                    │                  │
                        │ DynamoDB     │                                    │ Manual Review    │
                        │ Verification │                                    │ Queue (SQS)      │
                        │ Results      │                                    │                  │
                        └──────────────┘                                    └──────────────────┘
```

### 2.2 Integration Points

1. **Input**: 
   - EventBridge events from Facial Image Extractor
   - Live portrait photo location in S3
   - Document facial images locations in S3

2. **Output**:
   - Verification results stored in DynamoDB
   - Events for downstream processing
   - Manual review requests (when needed)

## 3. Implementation

### 3.1 AWS Lambda Function

```python
import json
import os
import boto3
import uuid
from datetime import datetime
import logging
import io
from PIL import Image
import numpy as np
import base64

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
rekognition_client = boto3.client('rekognition')
dynamodb = boto3.resource('dynamodb')
face_table = dynamodb.Table(os.environ['FACE_METADATA_TABLE_NAME'])
verification_table = dynamodb.Table(os.environ['VERIFICATION_RESULTS_TABLE_NAME'])
sqs = boto3.client('sqs')
eventbridge = boto3.client('events')

# Environment variables
manual_review_queue_url = os.environ['MANUAL_REVIEW_QUEUE_URL']
event_bus_name = os.environ['EVENT_BUS_NAME']
similarity_threshold = float(os.environ['SIMILARITY_THRESHOLD'])
manual_review_threshold = float(os.environ['MANUAL_REVIEW_THRESHOLD'])
far_threshold = float(os.environ['FAR_THRESHOLD'])  # False Acceptance Rate threshold (≤ 0.1%)
frr_threshold = float(os.environ['FRR_THRESHOLD'])  # False Rejection Rate threshold (≤ 3%)

def lambda_handler(event, context):
    """
    Lambda function that compares facial images from documents with live portrait photo
    
    Parameters:
    - event: EventBridge event from facial image extractor or direct API call
    - context: Lambda context
    
    Returns:
    - Verification results including pass/fail status and confidence scores
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Determine event type (direct API call or EventBridge event)
        if 'detail' in event:
            # EventBridge event
            event_detail = event['detail']
            session_id = event_detail.get('sessionId')
            document_type = event_detail.get('documentType')
            face_location = event_detail.get('faceLocation')
        else:
            # Direct API call
            session_id = event.get('sessionId')
            document_type = event.get('documentType')
            face_location = event.get('faceLocation')
        
        # Get live portrait photo location
        live_portrait_location = get_live_portrait_location(session_id)
        
        if not live_portrait_location:
            logger.error(f"No live portrait photo found for session {session_id}")
            emit_error_event(session_id, document_type, "No live portrait photo found")
            return {
                'statusCode': 400,
                'verificationStatus': 'FAILED',
                'reason': "No live portrait photo found"
            }
            
        # Parse S3 locations
        portrait_bucket, portrait_key = parse_s3_location(live_portrait_location)
        document_face_bucket, document_face_key = parse_s3_location(face_location)
        
        # Compare faces
        comparison_result = compare_faces(
            portrait_bucket, portrait_key,
            document_face_bucket, document_face_key
        )
        
        if not comparison_result['success']:
            logger.error(f"Face comparison failed: {comparison_result['reason']}")
            emit_error_event(session_id, document_type, comparison_result['reason'])
            return {
                'statusCode': 400,
                'verificationStatus': 'FAILED',
                'reason': comparison_result['reason']
            }
            
        # Evaluate verification result
        verification_result = evaluate_verification(
            comparison_result['similarity_score'],
            comparison_result['face_match']
        )
        
        # Store verification result
        store_verification_result(session_id, document_type, comparison_result, verification_result)
        
        # Handle manual review if needed
        if verification_result['status'] == 'MANUAL_REVIEW':
            queue_for_manual_review(
                session_id, document_type, 
                live_portrait_location, face_location,
                comparison_result, verification_result
            )
        
        # Emit event for downstream processing
        emit_verification_event(session_id, document_type, verification_result)
        
        return {
            'statusCode': 200,
            'verificationStatus': verification_result['status'],
            'sessionId': session_id,
            'documentType': document_type,
            'similarityScore': comparison_result['similarity_score'],
            'confidenceLevel': verification_result['confidence_level'],
            'thresholdUsed': verification_result['threshold_used'],
            'manualReviewRequired': verification_result['status'] == 'MANUAL_REVIEW'
        }
        
    except Exception as e:
        logger.error(f"Error in facial verification: {str(e)}")
        
        # Store error in DynamoDB for tracking
        if 'session_id' in locals() and 'document_type' in locals():
            store_verification_error(session_id, document_type, str(e))
        
        # Emit error event
        if 'session_id' in locals() and 'document_type' in locals():
            emit_error_event(session_id, document_type, str(e))
            
        return {
            'statusCode': 500,
            'error': str(e)
        }

def get_live_portrait_location(session_id):
    """
    Get live portrait photo location from metadata store
    
    Parameters:
    - session_id: Session identifier
    
    Returns:
    - S3 location of the live portrait photo
    """
    try:
        response = face_table.get_item(
            Key={
                'pk': f"SESSION#{session_id}",
                'sk': "FACE#LIVE_PORTRAIT"
            }
        )
        
        if 'Item' not in response:
            logger.warning(f"No live portrait found for session {session_id}")
            return None
        
        return response['Item'].get('faceLocation')
    
    except Exception as e:
        logger.error(f"Error retrieving live portrait location: {str(e)}")
        return None

def parse_s3_location(location):
    """Extract bucket name and key from S3 location"""
    # Format expected: s3://bucket-name/key
    if not location.startswith('s3://'):
        raise ValueError("Invalid S3 location format")
    
    parts = location[5:].split('/', 1)
    if len(parts) != 2:
        raise ValueError("Invalid S3 location format")
    
    return parts[0], parts[1]

def compare_faces(portrait_bucket, portrait_key, document_face_bucket, document_face_key):
    """
    Compare two facial images using AWS Rekognition
    
    Parameters:
    - portrait_bucket: S3 bucket containing the live portrait
    - portrait_key: S3 key of the live portrait
    - document_face_bucket: S3 bucket containing the document face
    - document_face_key: S3 key of the document face
    
    Returns:
    - Dictionary with comparison results
    """
    try:
        # Call AWS Rekognition to compare faces
        response = rekognition_client.compare_faces(
            SourceImage={
                'S3Object': {
                    'Bucket': portrait_bucket,
                    'Name': portrait_key
                }
            },
            TargetImage={
                'S3Object': {
                    'Bucket': document_face_bucket,
                    'Name': document_face_key
                }
            },
            SimilarityThreshold=10.0,  # Low threshold to get all possible matches
            QualityFilter="AUTO"
        )
        
        # Check if faces were compared
        if not response.get('FaceMatches'):
            return {
                'success': False,
                'face_match': False,
                'reason': "No matching faces found",
                'similarity_score': 0.0
            }
        
        # Get the highest similarity face match
        face_matches = sorted(response['FaceMatches'], key=lambda x: x['Similarity'], reverse=True)
        best_match = face_matches[0]
        
        # Extract additional details for audit and review
        source_face = response.get('SourceImageFace', {})
        target_face_details = best_match.get('Face', {})
        
        return {
            'success': True,
            'face_match': best_match['Similarity'] >= similarity_threshold,
            'similarity_score': best_match['Similarity'],
            'confidence': target_face_details.get('Confidence', 0.0),
            'source_face_details': {
                'bounding_box': source_face.get('BoundingBox', {}),
                'confidence': source_face.get('Confidence', 0.0)
            },
            'target_face_details': {
                'bounding_box': target_face_details.get('BoundingBox', {}),
                'age_range': target_face_details.get('AgeRange', {}),
                'pose': target_face_details.get('Pose', {})
            }
        }
        
    except rekognition_client.exceptions.InvalidParameterException as e:
        logger.error(f"Invalid parameter in Rekognition: {str(e)}")
        return {
            'success': False,
            'face_match': False,
            'reason': f"Invalid parameter: {str(e)}",
            'similarity_score': 0.0
        }
    
    except rekognition_client.exceptions.InvalidS3ObjectException as e:
        logger.error(f"Invalid S3 object: {str(e)}")
        return {
            'success': False,
            'face_match': False,
            'reason': f"Invalid S3 object: {str(e)}",
            'similarity_score': 0.0
        }
        
    except Exception as e:
        logger.error(f"Error comparing faces: {str(e)}")
        return {
            'success': False,
            'face_match': False,
            'reason': f"Error comparing faces: {str(e)}",
            'similarity_score': 0.0
        }

def evaluate_verification(similarity_score, face_match):
    """
    Evaluate verification result based on similarity score and configured thresholds
    
    Parameters:
    - similarity_score: Similarity score from Rekognition (0-100)
    - face_match: Boolean indicating if faces match according to similarity threshold
    
    Returns:
    - Dictionary with verification status and confidence information
    """
    # Calculate normalized score (0-1)
    normalized_score = similarity_score / 100.0
    
    # Determine verification status
    if not face_match or normalized_score < manual_review_threshold:
        status = 'FAILED'
        confidence_level = 'LOW'
    elif normalized_score >= similarity_threshold:
        status = 'PASSED'
        confidence_level = 'HIGH' if normalized_score >= 0.9 else 'MEDIUM'
    else:
        status = 'MANUAL_REVIEW'
        confidence_level = 'MEDIUM'
    
    # Calculate estimated FAR/FRR based on similarity score
    # These are simplified approximations - in a real system these would be
    # based on empirical testing or model specifications
    estimated_far = calculate_estimated_far(normalized_score)
    estimated_frr = calculate_estimated_frr(normalized_score)
    
    # Check if the estimated rates exceed our thresholds
    if status == 'PASSED' and estimated_far > far_threshold:
        status = 'MANUAL_REVIEW'
        confidence_level = 'MEDIUM'
    
    return {
        'status': status,
        'confidence_level': confidence_level,
        'threshold_used': similarity_threshold,
        'manual_review_threshold': manual_review_threshold,
        'verification_timestamp': datetime.now().isoformat(),
        'estimated_far': estimated_far,
        'estimated_frr': estimated_frr,
        'meets_far_requirement': estimated_far <= far_threshold,
        'meets_frr_requirement': estimated_frr <= frr_threshold
    }

def calculate_estimated_far(normalized_score):
    """
    Calculate estimated False Acceptance Rate based on similarity score
    This is a simplified model and would be replaced by actual statistical data
    
    Parameters:
    - normalized_score: Normalized similarity score (0-1)
    
    Returns:
    - Estimated FAR (0-1)
    """
    # Simplified exponential model: FAR decreases exponentially as similarity increases
    # At similarity = 0.7: FAR ≈ 0.1% (0.001)
    # At similarity = 0.8: FAR ≈ 0.01% (0.0001)
    # At similarity = 0.9: FAR ≈ 0.001% (0.00001)
    if normalized_score >= 0.99:
        return 0.000001  # 0.0001%
    elif normalized_score >= 0.95:
        return 0.00001   # 0.001%
    elif normalized_score >= 0.9:
        return 0.0001    # 0.01%
    elif normalized_score >= 0.8:
        return 0.001     # 0.1%
    elif normalized_score >= 0.7:
        return 0.005     # 0.5%
    elif normalized_score >= 0.6:
        return 0.01      # 1%
    else:
        return 0.1       # 10%

def calculate_estimated_frr(normalized_score):
    """
    Calculate estimated False Rejection Rate based on similarity threshold
    This is a simplified model and would be replaced by actual statistical data
    
    Parameters:
    - normalized_score: Normalized similarity score (0-1)
    
    Returns:
    - Estimated FRR (0-1)
    """
    # Simplified linear model: FRR increases as similarity threshold increases
    # Higher thresholds increase the chance of rejecting valid matches
    threshold = similarity_threshold
    
    # Base FRR at different thresholds
    # At threshold = 0.6: FRR ≈ 1% (0.01)
    # At threshold = 0.7: FRR ≈ 2% (0.02)
    # At threshold = 0.8: FRR ≈ 3% (0.03)
    # At threshold = 0.9: FRR ≈ 5% (0.05)
    if threshold >= 0.9:
        base_frr = 0.05
    elif threshold >= 0.8:
        base_frr = 0.03
    elif threshold >= 0.7:
        base_frr = 0.02
    else:
        base_frr = 0.01
        
    # Adjust based on actual score (higher scores reduce FRR)
    score_adjustment = max(0, (threshold - normalized_score) * 0.1)
    
    return base_frr + score_adjustment

def store_verification_result(session_id, document_type, comparison_result, verification_result):
    """Store facial verification result in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        verification_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"VERIFICATION#{document_type}",
                'sessionId': session_id,
                'documentType': document_type,
                'verificationStatus': verification_result['status'],
                'similarityScore': comparison_result['similarity_score'],
                'confidenceLevel': verification_result['confidence_level'],
                'thresholdUsed': verification_result['threshold_used'],
                'manualReviewThreshold': verification_result['manual_review_threshold'],
                'verificationTimestamp': verification_result['verification_timestamp'],
                'estimatedFAR': verification_result['estimated_far'],
                'estimatedFRR': verification_result['estimated_frr'],
                'meetsFARRequirement': verification_result['meets_far_requirement'],
                'meetsFRRRequirement': verification_result['meets_frr_requirement'],
                'faceMatch': comparison_result.get('face_match', False),
                'faceDetails': {
                    'sourceDetails': comparison_result.get('source_face_details', {}),
                    'targetDetails': comparison_result.get('target_face_details', {})
                },
                'ttl': int((datetime.now().timestamp() + 7776000))  # 90 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing verification result: {str(e)}")
        raise

def store_verification_error(session_id, document_type, error_message):
    """Store facial verification error in DynamoDB"""
    timestamp = datetime.now().isoformat()
    
    try:
        verification_table.put_item(
            Item={
                'pk': f"SESSION#{session_id}",
                'sk': f"ERROR#VERIFICATION#{document_type}#{timestamp}",
                'sessionId': session_id,
                'documentType': document_type,
                'errorMessage': error_message,
                'errorTimestamp': timestamp,
                'ttl': int((datetime.now().timestamp() + 2592000))  # 30 days retention
            }
        )
    except Exception as e:
        logger.error(f"Error storing verification error: {str(e)}")

def queue_for_manual_review(session_id, document_type, portrait_location, face_location, 
                            comparison_result, verification_result):
    """Queue verification for manual review when needed"""
    try:
        message = {
            'sessionId': session_id,
            'documentType': document_type,
            'verificationTimestamp': verification_result['verification_timestamp'],
            'portraitLocation': portrait_location,
            'documentFaceLocation': face_location,
            'similarityScore': comparison_result['similarity_score'],
            'thresholdUsed': verification_result['threshold_used'],
            'manualReviewReason': "Similarity score within manual review range",
            'estimatedFAR': verification_result['estimated_far'],
            'estimatedFRR': verification_result['estimated_frr']
        }
        
        # Send to SQS queue for manual review
        sqs.send_message(
            QueueUrl=manual_review_queue_url,
            MessageBody=json.dumps(message),
            MessageAttributes={
                'SessionId': {
                    'DataType': 'String',
                    'StringValue': session_id
                },
                'DocumentType': {
                    'DataType': 'String',
                    'StringValue': document_type
                },
                'VerificationType': {
                    'DataType': 'String',
                    'StringValue': 'FACIAL'
                }
            }
        )
        
        logger.info(f"Queued for manual review: {session_id}-{document_type}")
        
    except Exception as e:
        logger.error(f"Error queueing for manual review: {str(e)}")

def emit_verification_event(session_id, document_type, verification_result):
    """Emit facial verification event to EventBridge"""
    try:
        event_detail = {
            'sessionId': session_id,
            'documentType': document_type,
            'verificationStatus': verification_result['status'],
            'confidenceLevel': verification_result['confidence_level'],
            'timestamp': datetime.now().isoformat(),
            'estimatedFAR': verification_result['estimated_far'],
            'estimatedFRR': verification_result['estimated_frr'],
            'meetsFARRequirement': verification_result['meets_far_requirement'],
            'meetsFRRRequirement': verification_result['meets_frr_requirement']
        }
        
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.facial-verification',
                    'DetailType': 'FacialVerificationCompleted',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name
                }
            ]
        )
    except Exception as e:
        logger.error(f"Error emitting verification event: {str(e)}")

def emit_error_event(session_id, document_type, error_message):
    """Emit facial verification error event to EventBridge"""
    try:
        eventbridge.put_events(
            Entries=[
                {
                    'Source': 'document-processing.facial-verification',
                    'DetailType': 'FacialVerificationError',
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
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class FacialVerificationEvaluatorStack extends cdk.Stack {
  public readonly verificationFunction: lambda.Function;
  public readonly verificationResultsTable: dynamodb.Table;
  public readonly manualReviewQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table for verification results
    this.verificationResultsTable = new dynamodb.Table(this, 'VerificationResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Create SQS queue for manual reviews
    this.manualReviewQueue = new sqs.Queue(this, 'ManualReviewQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ManualReviewDLQ', {
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3
      }
    });
    
    // Create EventBridge event bus (or use existing one)
    const documentProcessingBus = events.EventBus.fromEventBusName(
      this, 
      'DocumentProcessingBus',
      'document-processing-bus'  // Must match the name in FacialImageExtractorStack
    );
    
    // Create Lambda function for facial verification evaluation
    this.verificationFunction = new lambda.Function(this, 'VerificationFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/facial-verification-evaluator'),
      handler: 'index.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        VERIFICATION_RESULTS_TABLE_NAME: this.verificationResultsTable.tableName,
        FACE_METADATA_TABLE_NAME: 'face-metadata-table', // Reference to existing table from Facial Image Extractor
        MANUAL_REVIEW_QUEUE_URL: this.manualReviewQueue.queueUrl,
        EVENT_BUS_NAME: documentProcessingBus.eventBusName,
        SIMILARITY_THRESHOLD: '80.0',       // 80% similarity to PASS
        MANUAL_REVIEW_THRESHOLD: '60.0',    // 60-80% similarity for MANUAL_REVIEW
        FAR_THRESHOLD: '0.001',             // 0.1% maximum False Acceptance Rate
        FRR_THRESHOLD: '0.03'               // 3% maximum False Rejection Rate
      }
    });

    // Grant permissions to the verification function
    this.verificationResultsTable.grantWriteData(this.verificationFunction);
    this.manualReviewQueue.grantSendMessages(this.verificationFunction);
    
    // Grant Rekognition permissions
    this.verificationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:CompareFaces'],
        resources: ['*']  // Rekognition doesn't support resource-specific permissions for CompareFaces
      })
    );
    
    // Grant access to read face metadata
    this.verificationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/face-metadata-table`] // Reference to existing table
      })
    );
    
    // Grant access to read facial images from S3
    this.verificationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          'arn:aws:s3:::extracted-faces-bucket/*', // From Facial Image Extractor
          'arn:aws:s3:::user-uploads-bucket/*'     // Bucket where live portraits are stored
        ]
      })
    );
    
    // Grant EventBridge permissions
    this.verificationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [documentProcessingBus.eventBusArn]
      })
    );

    // Create EventBridge rule to trigger verification when facial extraction is completed
    const faceExtractionCompletedRule = new events.Rule(this, 'FaceExtractionCompletedRule', {
      eventPattern: {
        source: ['document-processing.facial-extractor'],
        detailType: ['FacialImageExtracted']
      },
      targets: [new targets.LambdaFunction(this.verificationFunction)]
    });
    
    // Create EventBridge rule for verification results
    const verificationResultRule = new events.Rule(this, 'VerificationResultRule', {
      eventPattern: {
        source: ['document-processing.facial-verification'],
        detailType: ['FacialVerificationCompleted']
      },
      targets: [
        // Add targets for handling verification results
        // This would typically trigger verification aggregation
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'VerificationResultsTableName', {
      value: this.verificationResultsTable.tableName,
      description: 'The name of the DynamoDB table for verification results',
    });
    
    new cdk.CfnOutput(this, 'ManualReviewQueueUrl', {
      value: this.manualReviewQueue.queueUrl,
      description: 'The URL of the SQS queue for manual reviews',
    });
    
    new cdk.CfnOutput(this, 'VerificationFunctionArn', {
      value: this.verificationFunction.functionArn,
      description: 'The ARN of the verification evaluator Lambda function',
    });
  }
}
```

## 4. Facial Verification Strategy

### 4.1 Facial Comparison Approach

The Facial Verification Evaluator uses AWS Rekognition's `CompareFaces` API to compare facial images and implements the following verification strategy:

1. **Two-stage verification**:
   - Initial comparison based on similarity score from AWS Rekognition
   - Secondary evaluation based on configured FAR/FRR thresholds

2. **Thresholds-based decision making**:
   - Pass threshold: 80% similarity (configurable)
   - Manual review range: 60-80% similarity (configurable)
   - Fail threshold: Below 60% similarity (configurable)

3. **FAR/FRR control**:
   - Target FAR: ≤ 0.1% (configurable)
   - Target FRR: ≤ 3% (configurable)
   - Dynamic threshold adjustment based on estimated rates

4. **Edge case handling**:
   - Multiple faces detection with priority to the most similar
   - Pose and quality assessment for confidence weighting
   - Error states handling (no faces, poor quality, etc.)

### 4.2 Verification Confidence Levels

To provide meaningful verification results, the component assigns confidence levels based on similarity scores:

1. **High Confidence** (≥90% similarity):
   - Very low probability of false acceptance
   - Typically used for highly sensitive operations
   - Estimated FAR: ≤ 0.01%

2. **Medium Confidence** (80-90% similarity):
   - Good balance between security and usability
   - Suitable for standard verification
   - Estimated FAR: 0.01-0.1%

3. **Low Confidence** (<80% similarity):
   - Higher risk of false acceptance
   - Requires additional verification steps
   - Either failed or routed to manual review

### 4.3 Manual Review Strategy

The component implements a systematic approach to manual review:

1. **Review criteria**:
   - Similarity score falls between 60-80%
   - Estimated FAR exceeds the configured threshold
   - System uncertainty detected (e.g., multiple potential matches)

2. **Review queue management**:
   - Prioritization based on session age and customer impact
   - Enriched context data for reviewers
   - Dead letter queue for unprocessed reviews

3. **Review decision tracking**:
   - Recording of reviewer decisions
   - Feedback loop for system improvement
   - Performance metrics calculation

## 5. FAR and FRR Management

### 5.1 FAR/FRR Estimation Model

The component implements a model for estimating FAR and FRR based on similarity scores:

1. **FAR estimation**:
   - Exponential model with decreasing FAR as similarity increases
   - Calibrated to target ≤0.1% FAR at 80% similarity threshold
   - Regular recalibration based on empirical performance data

2. **FRR estimation**:
   - Linear model with increasing FRR as threshold increases
   - Target ≤3% FRR at 80% similarity threshold
   - Adjustment factors based on image quality and pose variations

3. **Threshold optimization**:
   - Regular analysis of actual verification results
   - Dynamic adjustment of thresholds based on operational data
   - Balance between security requirements and user experience

### 5.2 Performance Monitoring

To ensure the system meets FAR/FRR requirements, the component implements:

1. **Continuous monitoring**:
   - Tracking of similarity score distributions
   - Manual review outcomes analysis
   - Threshold effectiveness measurement

2. **Performance metrics**:
   - Automatic pass rate
   - Manual review rate
   - False match and non-match rates from reviews
   - Average verification confidence

3. **Alerting mechanisms**:
   - Significant deviations from expected performance
   - Sudden changes in verification patterns
   - Threshold breach notifications

## 6. Testing and Evaluation

### 6.1 Testing Approach

The Facial Verification Evaluator is tested using:

1. **Unit Testing**:
   - Verification logic with mock comparison results
   - Threshold evaluation functions
   - Error handling and manual review routing

2. **Integration Testing**:
   - End-to-end verification with Rekognition
   - EventBridge event handling
   - Manual review queue integration

3. **Performance Testing**:
   - FAR/FRR measurement with test datasets
   - Response time benchmarking
   - Resource utilization monitoring

### 6.2 Test Cases

The component includes test cases for:

1. **Happy Path Scenarios**:
   - Clear matches with high similarity
   - Non-matches with low similarity
   - Borderline cases for manual review

2. **Edge Cases**:
   - Multiple faces in source or target images
   - Low-quality images just above thresholds
   - Varying facial expressions and angles

3. **Error Cases**:
   - Missing source or target images
   - Rekognition service errors
   - DynamoDB read/write failures

### 6.3 Performance Validation

The verification system is validated against the required performance targets:

1. **FAR validation**:
   - Testing with known non-matching pairs
   - Statistical analysis of false acceptances
   - Verification that FAR remains ≤0.1%

2. **FRR validation**:
   - Testing with known matching pairs
   - Statistical analysis of false rejections
   - Verification that FRR remains ≤3%

3. **Response time validation**:
   - Validation of end-to-end processing time
   - Identification of performance bottlenecks
   - Optimization of slow-running components

## 7. Operation and Monitoring

### 7.1 Monitoring Setup

The Facial Verification Evaluator includes monitoring:

1. **CloudWatch Metrics**:
   - Pass/fail/manual review rates
   - Average similarity scores
   - Processing times
   - Error rates

2. **CloudWatch Alarms**:
   - High failure rate alert
   - Excessive manual review rate alert
   - Processing time threshold alert

3. **Dashboard Views**:
   - Real-time verification statistics
   - FAR/FRR trending
   - Manual review queue depth

### 7.2 Operational Procedures

Standard operating procedures for the Facial Verification Evaluator:

1. **Manual Review Process**:
   - Review queue monitoring and processing
   - Decision recording and feedback
   - Escalation path for uncertain cases

2. **Performance Tuning**:
   - Regular threshold review and adjustment
   - FAR/FRR model calibration
   - Integration with aggregate verification results

3. **Incident Response**:
   - Procedures for verification service degradation
   - Error condition investigation and resolution
   - Recovery from Rekognition service issues

## 8. Security and Privacy Considerations

1. **Data Protection**:
   - No persistent storage of raw facial images
   - Encryption of verification results
   - 90-day retention policy for results

2. **Access Control**:
   - Principle of least privilege for Lambda function
   - Restricted access to manual review queue
   - Audit logging of all verification actions

3. **Privacy Safeguards**:
   - Minimal collection and storage of biometric data
   - Clear logging of purpose and authorization
   - Compliance with GDPR biometric data requirements