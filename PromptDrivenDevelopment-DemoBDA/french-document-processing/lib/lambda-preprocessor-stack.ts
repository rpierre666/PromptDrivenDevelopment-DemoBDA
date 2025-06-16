import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface LambdaPreprocessorStackProps extends cdk.StackProps {
  // References to resources from the storage stack
  rawDocumentsBucket: s3.IBucket;
  processedDocumentsBucket: s3.IBucket;
  documentMetadataTable: dynamodb.ITable;
  
  // Reference to IAM role from IAM roles stack
  documentPreprocessorRole?: iam.IRole;
  
  // Optional event bus, will create new one if not provided
  eventBus?: events.IEventBus;
}

export class LambdaPreprocessorStack extends cdk.Stack {
  // Public references for other stacks to use
  public readonly preprocessorFunction: lambda.Function;
  public readonly eventBus: events.IEventBus;
  
  constructor(scope: Construct, id: string, props: LambdaPreprocessorStackProps) {
    super(scope, id, props);

    // Create or use provided event bus
    this.eventBus = props.eventBus || new events.EventBus(this, 'DocumentProcessingEventBus', {
      eventBusName: 'DocumentProcessingEventBus'
    });

    // Create log group with appropriate retention
    const logGroup = new logs.LogGroup(this, 'PreprocessorLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    
    // Lambda layer for dependencies (OpenCV, Pillow, NumPy)
    const preprocessorLayer = new lambda.LayerVersion(this, 'PreprocessorLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-layer/document-preprocessor')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      description: 'Dependencies for the Document Pre-processor Lambda function'
    });

    // Create Lambda function
    this.preprocessorFunction = new lambda.Function(this, 'DocumentPreprocessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/document-preprocessor')),
      layers: [preprocessorLayer],
      memorySize: 2048, // Higher memory for image processing
      timeout: cdk.Duration.seconds(60),
      environment: {
        PROCESSED_DOCUMENTS_BUCKET: props.processedDocumentsBucket.bucketName,
        METADATA_TABLE_NAME: props.documentMetadataTable.tableName,
        QUALITY_THRESHOLD: '0.7',
        EVENT_BUS_NAME: this.eventBus.eventBusName
      },
      role: props.documentPreprocessorRole,
      logGroup: logGroup,
      description: 'Processes uploaded documents by enhancing quality and normalizing for optimal extraction'
    });
    
    // If role is not provided, grant necessary permissions directly
    if (!props.documentPreprocessorRole) {
      // Grant access to S3 buckets
      props.rawDocumentsBucket.grantRead(this.preprocessorFunction);
      props.processedDocumentsBucket.grantWrite(this.preprocessorFunction);
      
      // Grant access to DynamoDB tables
      props.documentMetadataTable.grantReadWriteData(this.preprocessorFunction);
      
      // Add permissions for Rekognition (for document analysis)
      this.preprocessorFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'rekognition:DetectText',
            'rekognition:DetectLabels'
          ],
          resources: ['*']
        })
      );
      
      // Grant permission to put events on the event bus
      this.eventBus.grantPutEventsTo(this.preprocessorFunction);
    }
    
    // Create S3 notification to trigger Lambda when documents are uploaded
    props.rawDocumentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.preprocessorFunction)
    );
    
    // Define outputs
    new cdk.CfnOutput(this, 'PreprocessorFunctionName', {
      value: this.preprocessorFunction.functionName,
      description: 'The name of the document preprocessor Lambda function'
    });
    
    new cdk.CfnOutput(this, 'DocumentProcessingEventBusName', {
      value: this.eventBus.eventBusName,
      description: 'The name of the event bus used for document processing events'
    });
  }
}