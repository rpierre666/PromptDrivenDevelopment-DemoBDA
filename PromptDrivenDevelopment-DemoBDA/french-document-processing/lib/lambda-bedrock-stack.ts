import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { Construct } from 'constructs';

export interface LambdaBedrockStackProps extends cdk.StackProps {
  // References to resources from the storage stack
  processedDocumentsBucket: s3.IBucket;
  documentMetadataTable: dynamodb.ITable;
  
  // Reference to IAM role from IAM roles stack
  bedrockIntegrationRole?: iam.IRole;
  
  // Reference to event bus
  eventBus: events.IEventBus;
}

export class LambdaBedrockStack extends cdk.Stack {
  // Public references for other stacks to use
  public readonly bedrockFunction: lambda.Function;
  public readonly extractionTable: dynamodb.Table;
  
  constructor(scope: Construct, id: string, props: LambdaBedrockStackProps) {
    super(scope, id, props);

    // Create log group with appropriate retention
    const logGroup = new logs.LogGroup(this, 'BedrockIntegrationLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create parameter for knowledge base ID
    const knowledgeBaseId = new ssm.StringParameter(this, 'BedrockKnowledgeBaseId', {
      parameterName: '/french-doc-processing/bedrock/knowledge-base-id',
      stringValue: 'placeholder-knowledge-base-id', // This should be updated after creating the knowledge base
      description: 'ID of the Bedrock knowledge base containing document templates',
      tier: ssm.ParameterTier.STANDARD
    });

    // Create DynamoDB table for extraction results
    this.extractionTable = new dynamodb.Table(this, 'ExtractionTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for document type queries
    this.extractionTable.addGlobalSecondaryIndex({
      indexName: 'DocumentTypeIndex',
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Create DynamoDB table for document templates
    const templateTable = new dynamodb.Table(this, 'TemplateTable', {
      partitionKey: { name: 'documentType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN // Retain template data
    });

    // Lambda layer for dependencies
    const bedrockLayer = new lambda.LayerVersion(this, 'BedrockLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-layer/bedrock-integration')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      description: 'Dependencies for the Bedrock Integration Lambda function'
    });

    // Create Lambda function
    this.bedrockFunction = new lambda.Function(this, 'BedrockIntegrationFunction', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/bedrock-integration')),
      layers: [bedrockLayer],
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      environment: {
        PROCESSED_DOCUMENTS_BUCKET: props.processedDocumentsBucket.bucketName,
        EXTRACTION_TABLE_NAME: this.extractionTable.tableName,
        TEMPLATE_TABLE_NAME: templateTable.tableName,
        KNOWLEDGE_BASE_ID: knowledgeBaseId.stringValue,
        CONFIDENCE_THRESHOLD: '0.7',
        EVENT_BUS_NAME: props.eventBus.eventBusName
      },
      role: props.bedrockIntegrationRole,
      logGroup: logGroup,
      description: 'Integrates with Bedrock Data Automation to extract data from French documents'
    });
    
    // If role is not provided, grant necessary permissions directly
    if (!props.bedrockIntegrationRole) {
      // Grant access to S3 buckets
      props.processedDocumentsBucket.grantRead(this.bedrockFunction);
      
      // Grant access to DynamoDB tables
      props.documentMetadataTable.grantReadWriteData(this.bedrockFunction);
      this.extractionTable.grantReadWriteData(this.bedrockFunction);
      templateTable.grantReadData(this.bedrockFunction);
      
      // Add permissions for Bedrock
      this.bedrockFunction.addToRolePolicy(
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
      
      // Grant permission to access Parameter Store parameters
      knowledgeBaseId.grantRead(this.bedrockFunction);
      
      // Grant permission to put events on the event bus
      props.eventBus.grantPutEventsTo(this.bedrockFunction);
    }

    // Create EventBridge rule to trigger Lambda when documents are preprocessed
    const preprocessingRule = new events.Rule(this, 'DocumentPreprocessedRule', {
      eventBus: props.eventBus,
      eventPattern: {
        source: ['document-processing-system'],
        detailType: ['DocumentPreprocessed'],
        detail: {
          qualityStatus: ['ACCEPTED'] // Only process documents that passed quality checks
        }
      },
      description: 'Triggers Bedrock integration when documents are preprocessed'
    });

    // Add the Lambda function as a target for the rule
    preprocessingRule.addTarget(new targets.LambdaFunction(this.bedrockFunction));
    
    // Define outputs
    new cdk.CfnOutput(this, 'BedrockFunctionName', {
      value: this.bedrockFunction.functionName,
      description: 'The name of the Bedrock integration Lambda function'
    });
    
    new cdk.CfnOutput(this, 'ExtractionTableName', {
      value: this.extractionTable.tableName,
      description: 'The name of the DynamoDB table for extraction results'
    });
    
    new cdk.CfnOutput(this, 'TemplateTableName', {
      value: templateTable.tableName,
      description: 'The name of the DynamoDB table for document templates'
    });
  }
}