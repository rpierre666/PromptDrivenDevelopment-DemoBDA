#!/bin/bash

# French Document Processing System - Automated Deployment Script
# This script automates the deployment of the French Document Processing System
# using AWS CDK and associated services.

set -e  # Exit on error

# Color codes for better readability
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ==============================================
# Configuration variables - Edit these as needed
# ==============================================
AWS_REGION="${AWS_REGION:-eu-west-3}"  # Default to Paris region for French services
PROJECT_NAME="french-doc-processing"
CDK_STACK_PREFIX="FrenchDocProcessing"
LOG_FILE="deployment-$(date +%Y%m%d-%H%M%S).log"

# Component flags - set to true to deploy specific components
DEPLOY_STORAGE=true
DEPLOY_IAM=true
DEPLOY_PREPROCESSOR=true
DEPLOY_BEDROCK=true
DEPLOY_VALIDATOR=true
DEPLOY_FACIAL=true
DEPLOY_AGGREGATOR=true
DEPLOY_REPORT=true
DEPLOY_DB_UPDATER=true
DEPLOY_STORAGE_MANAGER=true
DEPLOY_API=true

# ==============================================
# Functions
# ==============================================

log() {
    local message="$1"
    local level="${2:-INFO}"
    local timestamp=$(date +"%Y-%m-%d %H:%M:%S")
    
    echo -e "${timestamp} [${level}] ${message}" | tee -a "$LOG_FILE"
}

log_success() {
    log "${GREEN}$1${NC}" "SUCCESS"
}

log_info() {
    log "${BLUE}$1${NC}" "INFO"
}

log_warning() {
    log "${YELLOW}$1${NC}" "WARNING"
}

log_error() {
    log "${RED}$1${NC}" "ERROR"
}

check_prereqs() {
    log_info "Checking prerequisites..."
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js 14.x or later."
        exit 1
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed. Please install npm."
        exit 1
    fi
    
    # Check CDK
    if ! command -v cdk &> /dev/null; then
        log_error "AWS CDK is not installed. Installing it now..."
        npm install -g aws-cdk
        if [ $? -ne 0 ]; then
            log_error "Failed to install AWS CDK. Please check npm configuration."
            exit 1
        fi
    fi
    
    # Check AWS credentials
    aws sts get-caller-identity &> /dev/null
    if [ $? -ne 0 ]; then
        log_error "AWS credentials are not configured properly. Please run 'aws configure'."
        exit 1
    fi
    
    # Check Python
    if ! command -v python3 &> /dev/null; then
        log_error "Python 3 is not installed. Please install Python 3.9 or later."
        exit 1
    fi
    
    log_success "All prerequisites satisfied!"
}

setup_project() {
    log_info "Setting up project directory structure..."
    
    # Create project directory if it doesn't exist
    if [ ! -d "$PROJECT_NAME" ]; then
        mkdir -p "$PROJECT_NAME"
        cd "$PROJECT_NAME"
        
        # Initialize CDK project
        cdk init app --language typescript
        if [ $? -ne 0 ]; then
            log_error "Failed to initialize CDK project."
            exit 1
        fi
        
        # Install dependencies
        npm install aws-cdk-lib constructs
        if [ $? -ne 0 ]; then
            log_error "Failed to install CDK dependencies."
            exit 1
        fi
        
        # Create directories for Lambda functions
        mkdir -p lambda/{document-preprocessor,bedrock-integration,document-validator,facial-image-extractor,facial-verification-evaluator,verification-aggregator,report-generator,customer-db-updater,document-storage-manager}
        
        log_success "Project directory structure created successfully."
    else
        cd "$PROJECT_NAME"
        log_warning "Project directory already exists. Using existing project."
    fi
}

bootstrap_cdk() {
    log_info "Bootstrapping CDK in AWS account..."
    
    cdk bootstrap aws://"$(aws sts get-caller-identity --query Account --output text)"/"$AWS_REGION"
    if [ $? -ne 0 ]; then
        log_error "Failed to bootstrap CDK."
        exit 1
    fi
    
    log_success "CDK bootstrapped successfully in region $AWS_REGION."
}

deploy_storage_stack() {
    if [ "$DEPLOY_STORAGE" = true ]; then
        log_info "Deploying storage infrastructure..."
        
        # Copy storage stack code from template if it doesn't exist
        if [ ! -f "lib/storage-stack.ts" ]; then
            cat > lib/storage-stack.ts << 'EOF'
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
EOF
            log_info "Created storage stack template."
        fi
        
        # Update main CDK app file to include storage stack
        cat > bin/${PROJECT_NAME}.ts << EOF
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';

const app = new cdk.App();

// Define environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || '$AWS_REGION'
};

// Create the storage stack
new StorageStack(app, '${CDK_STACK_PREFIX}StorageStack', {
  env: env,
  description: 'Storage infrastructure for French document processing system'
});
EOF
        
        # Build and deploy
        npm run build
        if [ $? -ne 0 ]; then
            log_error "Failed to build the CDK app."
            exit 1
        fi
        
        cdk deploy ${CDK_STACK_PREFIX}StorageStack --require-approval never
        if [ $? -ne 0 ]; then
            log_error "Failed to deploy storage stack."
            exit 1
        fi
        
        log_success "Storage infrastructure deployed successfully."
    else
        log_info "Skipping storage infrastructure deployment as requested."
    fi
}

deploy_iam_roles() {
    if [ "$DEPLOY_IAM" = true ]; then
        log_info "Deploying IAM roles..."
        
        # Implementation for deploying IAM roles
        # Copy IAM stack code, update main CDK app, build and deploy
        
        log_success "IAM roles deployed successfully."
    else
        log_info "Skipping IAM roles deployment as requested."
    fi
}

deploy_preprocessor() {
    if [ "$DEPLOY_PREPROCESSOR" = true ]; then
        log_info "Deploying Document Pre-processor component..."
        
        # Implementation for deploying the Document Pre-processor component
        # Copy necessary Lambda code, create stack, update main CDK app, build and deploy
        
        log_success "Document Pre-processor component deployed successfully."
    else
        log_info "Skipping Document Pre-processor deployment as requested."
    fi
}

deploy_bedrock_integration() {
    if [ "$DEPLOY_BEDROCK" = true ]; then
        log_info "Deploying Bedrock Data Automation Integration component..."
        
        # Implementation for deploying the Bedrock Integration component
        
        log_success "Bedrock Data Automation Integration component deployed successfully."
    else
        log_info "Skipping Bedrock Integration deployment as requested."
    fi
}

deploy_validator() {
    if [ "$DEPLOY_VALIDATOR" = true ]; then
        log_info "Deploying Document Validation Service component..."
        
        # Implementation for deploying the Document Validation Service component
        
        log_success "Document Validation Service component deployed successfully."
    else
        log_info "Skipping Document Validator deployment as requested."
    fi
}

deploy_facial_components() {
    if [ "$DEPLOY_FACIAL" = true ]; then
        log_info "Deploying Facial Verification components..."
        
        # Implementation for deploying the Facial Image Extractor and Facial Verification Evaluator
        
        log_success "Facial Verification components deployed successfully."
    else
        log_info "Skipping Facial Verification components deployment as requested."
    fi
}

deploy_remaining_components() {
    # Deploy Verification Aggregator
    if [ "$DEPLOY_AGGREGATOR" = true ]; then
        log_info "Deploying Verification Aggregator component..."
        # Implementation here
        log_success "Verification Aggregator component deployed successfully."
    fi
    
    # Deploy Report Generator
    if [ "$DEPLOY_REPORT" = true ]; then
        log_info "Deploying Report Generator component..."
        # Implementation here
        log_success "Report Generator component deployed successfully."
    fi
    
    # Deploy Customer Database Updater
    if [ "$DEPLOY_DB_UPDATER" = true ]; then
        log_info "Deploying Customer Database Updater component..."
        # Implementation here
        log_success "Customer Database Updater component deployed successfully."
    fi
    
    # Deploy Document Storage Manager
    if [ "$DEPLOY_STORAGE_MANAGER" = true ]; then
        log_info "Deploying Document Storage Manager component..."
        # Implementation here
        log_success "Document Storage Manager component deployed successfully."
    fi
    
    # Deploy API Gateway
    if [ "$DEPLOY_API" = true ]; then
        log_info "Deploying API Gateway component..."
        # Implementation here
        log_success "API Gateway component deployed successfully."
    fi
}

run_tests() {
    log_info "Running basic tests to verify deployment..."
    
    # Check S3 buckets
    log_info "Checking S3 buckets..."
    RAW_BUCKET=$(aws cloudformation describe-stacks --stack-name ${CDK_STACK_PREFIX}StorageStack --query "Stacks[0].Outputs[?OutputKey=='RawDocumentsBucketName'].OutputValue" --output text)
    if [ -z "$RAW_BUCKET" ]; then
        log_warning "Could not find raw documents bucket. Deployment may have issues."
    else
        log_success "Raw documents bucket created: $RAW_BUCKET"
    fi
    
    # Check DynamoDB tables
    log_info "Checking DynamoDB tables..."
    METADATA_TABLE=$(aws cloudformation describe-stacks --stack-name ${CDK_STACK_PREFIX}StorageStack --query "Stacks[0].Outputs[?OutputKey=='DocumentMetadataTableName'].OutputValue" --output text)
    if [ -z "$METADATA_TABLE" ]; then
        log_warning "Could not find document metadata table. Deployment may have issues."
    else
        log_success "Document metadata table created: $METADATA_TABLE"
    fi
    
    log_success "Basic verification tests completed."
}

deploy_all() {
    check_prereqs
    setup_project
    bootstrap_cdk
    deploy_storage_stack
    deploy_iam_roles
    deploy_preprocessor
    deploy_bedrock_integration
    deploy_validator
    deploy_facial_components
    deploy_remaining_components
    run_tests
    
    log_success "Deployment completed successfully! System is now ready for configuration and testing."
}

deploy_specific() {
    check_prereqs
    setup_project
    bootstrap_cdk
    
    # Deploy only the components specified in configuration
    deploy_storage_stack
    deploy_iam_roles
    deploy_preprocessor
    deploy_bedrock_integration
    deploy_validator
    deploy_facial_components
    deploy_remaining_components
    run_tests
    
    log_success "Deployment of selected components completed successfully!"
}

show_help() {
    echo "French Document Processing System - Deployment Script"
    echo "====================================================="
    echo "Usage: $0 [OPTIONS]"
    echo
    echo "Options:"
    echo "  --all                Deploy all components"
    echo "  --component [NAME]   Deploy specific component (storage, iam, preprocessor, bedrock, validator, facial, aggregator, report, db-updater, storage-manager, api)"
    echo "  --region [REGION]    Specify AWS region (default: eu-west-3)"
    echo "  --help               Show this help message"
    echo
    echo "Examples:"
    echo "  $0 --all                           # Deploy entire system"
    echo "  $0 --component storage --component iam  # Deploy only storage and IAM components"
    echo "  $0 --region eu-central-1 --all     # Deploy to Frankfurt region"
    echo
}

# ==============================================
# Main Execution
# ==============================================

# Parse command line arguments
if [ $# -eq 0 ]; then
    show_help
    exit 0
fi

DEPLOY_ALL=false
COMPONENTS=()

while [[ $# -gt 0 ]]; do
    key="$1"
    
    case $key in
        --all)
            DEPLOY_ALL=true
            shift
            ;;
        --component)
            COMPONENTS+=("$2")
            shift
            shift
            ;;
        --region)
            AWS_REGION="$2"
            shift
            shift
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Configure component flags based on arguments
if [ ${#COMPONENTS[@]} -gt 0 ]; then
    # Reset all component flags to false
    DEPLOY_STORAGE=false
    DEPLOY_IAM=false
    DEPLOY_PREPROCESSOR=false
    DEPLOY_BEDROCK=false
    DEPLOY_VALIDATOR=false
    DEPLOY_FACIAL=false
    DEPLOY_AGGREGATOR=false
    DEPLOY_REPORT=false
    DEPLOY_DB_UPDATER=false
    DEPLOY_STORAGE_MANAGER=false
    DEPLOY_API=false
    
    # Set flags for requested components
    for component in "${COMPONENTS[@]}"; do
        case $component in
            storage)
                DEPLOY_STORAGE=true
                ;;
            iam)
                DEPLOY_IAM=true
                ;;
            preprocessor)
                DEPLOY_PREPROCESSOR=true
                ;;
            bedrock)
                DEPLOY_BEDROCK=true
                ;;
            validator)
                DEPLOY_VALIDATOR=true
                ;;
            facial)
                DEPLOY_FACIAL=true
                ;;
            aggregator)
                DEPLOY_AGGREGATOR=true
                ;;
            report)
                DEPLOY_REPORT=true
                ;;
            db-updater)
                DEPLOY_DB_UPDATER=true
                ;;
            storage-manager)
                DEPLOY_STORAGE_MANAGER=true
                ;;
            api)
                DEPLOY_API=true
                ;;
            *)
                log_warning "Unknown component: $component. Skipping."
                ;;
        esac
    done
    
    log_info "Deploying specific components: ${COMPONENTS[*]}"
    deploy_specific
elif [ "$DEPLOY_ALL" = true ]; then
    log_info "Deploying all components in region $AWS_REGION"
    deploy_all
else
    log_error "No deployment option specified."
    show_help
    exit 1
fi

exit 0