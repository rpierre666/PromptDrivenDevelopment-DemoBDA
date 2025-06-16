#!/bin/bash

# French Document Processing System - Deployment Troubleshooter
# This script diagnoses and fixes common deployment issues

set -e  # Exit on error

# Color codes for better readability
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log file
LOG_FILE="troubleshooting-$(date +%Y%m%d-%H%M%S).log"

# Configuration variables - Edit these to match your deployment
AWS_REGION="${AWS_REGION:-eu-west-3}"  # Default to Paris region for French services
STACK_NAME="FrenchDocProcessingStorageStack"

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

check_aws_auth() {
    log_info "Checking AWS authentication..."
    
    # Try to get caller identity
    aws sts get-caller-identity &> /dev/null
    if [ $? -ne 0 ]; then
        log_error "AWS authentication failed. Please check your credentials."
        return 1
    else
        local account_id=$(aws sts get-caller-identity --query Account --output text)
        log_success "AWS authentication successful. Using account: $account_id"
        return 0
    fi
}

check_stack_status() {
    log_info "Checking CloudFormation stack status..."
    
    # Check if stack exists
    aws cloudformation describe-stacks --stack-name $STACK_NAME &> /dev/null
    if [ $? -ne 0 ]; then
        log_error "Stack '$STACK_NAME' not found."
        return 1
    fi
    
    # Get stack status
    local status=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus' --output text)
    log_info "Stack status: $status"
    
    if [[ $status == *FAILED* ]]; then
        log_error "Stack deployment failed."
        
        # Get stack events to identify failure reason
        log_info "Last few stack events:"
        aws cloudformation describe-stack-events --stack-name $STACK_NAME --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' --output table
        
        return 1
    elif [[ $status == *PROGRESS* ]]; then
        log_warning "Stack deployment is still in progress. Please wait for it to complete."
        return 2
    elif [[ $status == *COMPLETE* ]]; then
        log_success "Stack status is $status"
        return 0
    else
        log_warning "Unknown stack status: $status"
        return 3
    fi
}

check_stack_outputs() {
    log_info "Checking CloudFormation stack outputs..."
    
    # Get stack outputs
    local outputs=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs' --output json)
    
    if [[ $outputs == "null" ]] || [[ $outputs == "[]" ]]; then
        log_error "Stack has no outputs. This indicates a deployment problem."
        return 1
    else
        log_success "Stack has outputs:"
        echo "$outputs" | jq -r '.[] | "\(.OutputKey): \(.OutputValue)"' || echo "$outputs"
        return 0
    fi
}

check_resources() {
    log_info "Checking CloudFormation stack resources..."
    
    # Get stack resources
    local resources=$(aws cloudformation describe-stack-resources --stack-name $STACK_NAME --query 'StackResources[*].[LogicalResourceId,ResourceType,ResourceStatus]' --output table)
    
    echo "$resources"
    
    # Count resources by type
    local s3_count=$(echo "$resources" | grep -c "AWS::S3::Bucket")
    local dynamo_count=$(echo "$resources" | grep -c "AWS::DynamoDB::Table")
    
    log_info "Found $s3_count S3 buckets and $dynamo_count DynamoDB tables"
    
    if [[ $s3_count -eq 0 ]]; then
        log_error "No S3 buckets found in the stack."
        return 1
    fi
    
    if [[ $dynamo_count -eq 0 ]]; then
        log_warning "No DynamoDB tables found in the stack."
    fi
    
    return 0
}

list_s3_buckets() {
    log_info "Listing all S3 buckets in account..."
    
    aws s3 ls
    
    log_info "Checking for buckets containing 'document' or 'french'..."
    aws s3 ls | grep -i "document\|french"
}

diagnose_issues() {
    log_info "Running deployment diagnostics..."
    
    # Check AWS credentials
    check_aws_auth
    if [ $? -ne 0 ]; then
        log_error "Authentication issue detected. Fix AWS credentials before proceeding."
        return 1
    fi
    
    # Check stack status
    check_stack_status
    local status_result=$?
    
    if [ $status_result -eq 1 ]; then
        log_error "Stack deployment failed. See above for failure reasons."
        log_info "OPTIONS:"
        log_info "1. Fix the identified issues"
        log_info "2. Delete and redeploy the stack using 'cdk destroy $STACK_NAME' followed by 'cdk deploy $STACK_NAME'"
        return 1
    elif [ $status_result -eq 2 ]; then
        log_warning "Stack deployment is still in progress. Please wait and try again later."
        return 2
    fi
    
    # Check stack outputs
    check_stack_outputs
    if [ $? -ne 0 ]; then
        log_error "Stack has no outputs, which suggests deployment issues."
    fi
    
    # Check stack resources
    check_resources
    if [ $? -ne 0 ]; then
        log_error "Stack is missing expected resources."
        log_info "OPTIONS:"
        log_info "1. Check CloudFormation logs for errors"
        log_info "2. Verify your CDK code is correctly defining the resources"
        log_info "3. Redeploy the stack with 'cdk destroy $STACK_NAME' followed by 'cdk deploy $STACK_NAME'"
    fi
    
    # List S3 buckets
    list_s3_buckets
    
    log_info "Diagnostics complete."
    log_info "If you need to delete and redeploy the stack, use:"
    log_info "  cdk destroy $STACK_NAME"
    log_info "  cdk deploy $STACK_NAME --require-approval never"
    log_info "For more detailed logs, check CloudFormation in the AWS Console."
}

# Main execution
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}French Document Processing - Troubleshooter${NC}"
echo -e "${BLUE}========================================${NC}"

diagnose_issues

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Troubleshooting Complete${NC}"
echo -e "${BLUE}========================================${NC}"