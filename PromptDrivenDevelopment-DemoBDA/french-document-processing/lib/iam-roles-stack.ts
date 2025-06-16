import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface IamRolesStackProps extends cdk.StackProps {
  // References to resources from the storage stack
  rawDocumentsBucket: s3.IBucket;
  processedDocumentsBucket: s3.IBucket;
  extractedFacesBucket: s3.IBucket;
  reportsBucket: s3.IBucket;
  
  documentMetadataTable: dynamodb.ITable;
  verificationResultsTable: dynamodb.ITable;
  faceMetadataTable: dynamodb.ITable;
  sessionTable: dynamodb.ITable;
}

export class IamRolesStack extends cdk.Stack {
  // Public references to roles for other stacks to use
  public readonly documentPreprocessorRole: iam.Role;
  public readonly bedrockIntegrationRole: iam.Role;
  public readonly documentValidatorRole: iam.Role;
  public readonly facialImageExtractorRole: iam.Role;
  public readonly facialVerificationEvaluatorRole: iam.Role;
  public readonly verificationAggregatorRole: iam.Role;
  public readonly reportGeneratorRole: iam.Role;
  public readonly customerDbUpdaterRole: iam.Role;
  public readonly documentStorageManagerRole: iam.Role;
  
  constructor(scope: Construct, id: string, props: IamRolesStackProps) {
    super(scope, id, props);

    // Document Preprocessor Role
    this.documentPreprocessorRole = new iam.Role(this, 'DocumentPreprocessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Document Preprocessor Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to S3 buckets
    props.rawDocumentsBucket.grantRead(this.documentPreprocessorRole);
    props.processedDocumentsBucket.grantWrite(this.documentPreprocessorRole);
    
    // Grant access to DynamoDB tables
    props.documentMetadataTable.grantReadWriteData(this.documentPreprocessorRole);
    props.sessionTable.grantReadData(this.documentPreprocessorRole);
    
    // Add permissions for Rekognition (for document analysis)
    this.documentPreprocessorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'rekognition:DetectText',
          'rekognition:DetectLabels'
        ],
        resources: ['*']
      })
    );
    
    // Add permissions for EventBridge to emit events
    this.documentPreprocessorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Bedrock Integration Role
    this.bedrockIntegrationRole = new iam.Role(this, 'BedrockIntegrationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Bedrock Data Automation Integration Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to S3 buckets
    props.processedDocumentsBucket.grantRead(this.bedrockIntegrationRole);
    
    // Grant access to DynamoDB tables
    props.documentMetadataTable.grantReadWriteData(this.bedrockIntegrationRole);
    
    // Add permissions for Bedrock
    this.bedrockIntegrationRole.addToPolicy(
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
    
    // Add permissions for EventBridge to emit events
    this.bedrockIntegrationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Document Validator Role
    this.documentValidatorRole = new iam.Role(this, 'DocumentValidatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Document Validator Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to DynamoDB tables
    props.documentMetadataTable.grantReadData(this.documentValidatorRole);
    props.verificationResultsTable.grantReadWriteData(this.documentValidatorRole);
    
    // Add permissions for SQS (for manual review queue)
    this.documentValidatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: ['*']  // Should be restricted to specific queue ARN in production
      })
    );
    
    // Add permissions for EventBridge to emit events
    this.documentValidatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Facial Image Extractor Role
    this.facialImageExtractorRole = new iam.Role(this, 'FacialImageExtractorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Facial Image Extractor Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to S3 buckets
    props.processedDocumentsBucket.grantRead(this.facialImageExtractorRole);
    props.extractedFacesBucket.grantWrite(this.facialImageExtractorRole);
    
    // Grant access to DynamoDB tables
    props.documentMetadataTable.grantReadData(this.facialImageExtractorRole);
    props.faceMetadataTable.grantReadWriteData(this.facialImageExtractorRole);
    
    // Add permissions for Rekognition (for face detection)
    this.facialImageExtractorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'rekognition:DetectFaces',
          'rekognition:IndexFaces'
        ],
        resources: ['*']
      })
    );
    
    // Add permissions for EventBridge to emit events
    this.facialImageExtractorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Facial Verification Evaluator Role
    this.facialVerificationEvaluatorRole = new iam.Role(this, 'FacialVerificationEvaluatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Facial Verification Evaluator Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to S3 buckets
    props.extractedFacesBucket.grantRead(this.facialVerificationEvaluatorRole);
    
    // Grant access to DynamoDB tables
    props.faceMetadataTable.grantReadData(this.facialVerificationEvaluatorRole);
    props.verificationResultsTable.grantReadWriteData(this.facialVerificationEvaluatorRole);
    
    // Add permissions for Rekognition (for face comparison)
    this.facialVerificationEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'rekognition:CompareFaces'
        ],
        resources: ['*']
      })
    );
    
    // Add permissions for SQS (for manual review queue)
    this.facialVerificationEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: ['*']  // Should be restricted to specific queue ARN in production
      })
    );
    
    // Add permissions for EventBridge to emit events
    this.facialVerificationEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Verification Aggregator Role
    this.verificationAggregatorRole = new iam.Role(this, 'VerificationAggregatorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Verification Aggregator Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to DynamoDB tables
    props.verificationResultsTable.grantReadData(this.verificationAggregatorRole);
    props.sessionTable.grantReadWriteData(this.verificationAggregatorRole);
    
    // Add permissions for EventBridge to emit events
    this.verificationAggregatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Report Generator Role
    this.reportGeneratorRole = new iam.Role(this, 'ReportGeneratorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Report Generator Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to S3 buckets
    props.reportsBucket.grantWrite(this.reportGeneratorRole);
    
    // Grant access to DynamoDB tables
    props.verificationResultsTable.grantReadData(this.reportGeneratorRole);
    props.documentMetadataTable.grantReadData(this.reportGeneratorRole);
    
    // Add permissions for EventBridge to emit events
    this.reportGeneratorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Customer DB Updater Role
    this.customerDbUpdaterRole = new iam.Role(this, 'CustomerDbUpdaterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Customer Database Updater Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to DynamoDB tables
    props.verificationResultsTable.grantReadData(this.customerDbUpdaterRole);
    
    // Add permissions for SQS (for retry queue)
    this.customerDbUpdaterRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'],
        resources: ['*']  // Should be restricted to specific queue ARN in production
      })
    );
    
    // Add permissions for EventBridge to emit events
    this.customerDbUpdaterRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );
    
    // Add permissions for SSM Parameter Store (for database credentials)
    this.customerDbUpdaterRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: ['*']  // Should be restricted to specific parameters in production
      })
    );

    // Document Storage Manager Role
    this.documentStorageManagerRole = new iam.Role(this, 'DocumentStorageManagerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Document Storage Manager Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });
    
    // Grant access to S3 buckets
    props.rawDocumentsBucket.grantRead(this.documentStorageManagerRole);
    props.processedDocumentsBucket.grantRead(this.documentStorageManagerRole);
    props.extractedFacesBucket.grantReadWrite(this.documentStorageManagerRole);
    
    // Grant access to DynamoDB tables
    props.documentMetadataTable.grantReadWriteData(this.documentStorageManagerRole);
    
    // Add permissions for S3 bucket lifecycle management
    this.documentStorageManagerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:PutLifecycleConfiguration',
          's3:GetLifecycleConfiguration'
        ],
        resources: [
          props.rawDocumentsBucket.bucketArn,
          props.processedDocumentsBucket.bucketArn,
          props.extractedFacesBucket.bucketArn
        ]
      })
    );
    
    // Add permissions for EventBridge to emit events
    this.documentStorageManagerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: ['*']  // Should be restricted to specific event bus ARN in production
      })
    );

    // Stack outputs
    new cdk.CfnOutput(this, 'DocumentPreprocessorRoleName', {
      value: this.documentPreprocessorRole.roleName,
      description: 'The name of the IAM role for the Document Preprocessor Lambda function'
    });
    
    new cdk.CfnOutput(this, 'BedrockIntegrationRoleName', {
      value: this.bedrockIntegrationRole.roleName,
      description: 'The name of the IAM role for the Bedrock Integration Lambda function'
    });
    
    new cdk.CfnOutput(this, 'DocumentValidatorRoleName', {
      value: this.documentValidatorRole.roleName,
      description: 'The name of the IAM role for the Document Validator Lambda function'
    });
    
    // Additional outputs for other roles...
  }
}