import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class StorageStack extends cdk.Stack {
  // Public references to resources for other stacks to use
  public readonly rawDocumentsBucket: s3.Bucket;
  public readonly processedDocumentsBucket: s3.Bucket;
  public readonly extractedFacesBucket: s3.Bucket;
  public readonly reportsBucket: s3.Bucket;
  
  public readonly documentMetadataTable: dynamodb.Table;
  public readonly verificationResultsTable: dynamodb.Table;
  public readonly faceMetadataTable: dynamodb.Table;
  public readonly sessionTable: dynamodb.Table;
  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket for raw document uploads
    this.rawDocumentsBucket = new s3.Bucket(this, 'RawDocumentsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
          allowedOrigins: ['*'],  // Restrict to specific domains in production
          allowedHeaders: ['*'],
          maxAge: 3600
        }
      ]
    });
    
    // S3 Bucket for processed documents with GDPR-compliant lifecycle rules
    this.processedDocumentsBucket = new s3.Bucket(this, 'ProcessedDocumentsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          id: 'GdprRetention',
          enabled: true,
          expiration: cdk.Duration.days(90),  // 90-day retention per GDPR requirement
          tagFilters: { 'retention': 'gdpr-90days' }
        }
      ]
    });
    
    // S3 Bucket for extracted facial images 
    this.extractedFacesBucket = new s3.Bucket(this, 'ExtractedFacesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'FaceRetention',
          enabled: true,
          expiration: cdk.Duration.days(7),  // Short retention for facial data
        }
      ]
    });
    
    // S3 Bucket for verification reports 
    this.reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    });

    // DynamoDB table for document metadata 
    this.documentMetadataTable = new dynamodb.Table(this, 'DocumentMetadataTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true
    });
    
    // Add Global Secondary Index for document type queries
    this.documentMetadataTable.addGlobalSecondaryIndex({
      indexName: 'DocumentTypeIndex',
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // DynamoDB table for verification results
    this.verificationResultsTable = new dynamodb.Table(this, 'VerificationResultsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true
    });
    
    // Add Global Secondary Index for status queries
    this.verificationResultsTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // DynamoDB table for facial metadata
    this.faceMetadataTable = new dynamodb.Table(this, 'FaceMetadataTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true
    });
    
    // DynamoDB table for session tracking
    this.sessionTable = new dynamodb.Table(this, 'SessionTable', {
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true
    });
    
    // Add Global Secondary Index for customer reference queries
    this.sessionTable.addGlobalSecondaryIndex({
      indexName: 'CustomerReferenceIndex',
      partitionKey: { name: 'customerReference', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Stack outputs for reference in other stacks and for documentation
    new cdk.CfnOutput(this, 'RawDocumentsBucketName', {
      value: this.rawDocumentsBucket.bucketName,
      description: 'The name of the S3 bucket for raw document uploads',
      exportName: 'RawDocumentsBucketName'
    });
    
    new cdk.CfnOutput(this, 'ProcessedDocumentsBucketName', {
      value: this.processedDocumentsBucket.bucketName,
      description: 'The name of the S3 bucket for processed documents',
      exportName: 'ProcessedDocumentsBucketName'
    });
    
    new cdk.CfnOutput(this, 'ExtractedFacesBucketName', {
      value: this.extractedFacesBucket.bucketName,
      description: 'The name of the S3 bucket for extracted facial images',
      exportName: 'ExtractedFacesBucketName'
    });
    
    new cdk.CfnOutput(this, 'ReportsBucketName', {
      value: this.reportsBucket.bucketName,
      description: 'The name of the S3 bucket for verification reports',
      exportName: 'ReportsBucketName'
    });
    
    new cdk.CfnOutput(this, 'DocumentMetadataTableName', {
      value: this.documentMetadataTable.tableName,
      description: 'The name of the DynamoDB table for document metadata',
      exportName: 'DocumentMetadataTableName'
    });
    
    new cdk.CfnOutput(this, 'VerificationResultsTableName', {
      value: this.verificationResultsTable.tableName,
      description: 'The name of the DynamoDB table for verification results',
      exportName: 'VerificationResultsTableName'
    });
  }
}
