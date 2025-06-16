#!/bin/bash

# Exit on error
set -e

echo "Starting deployment process for French Document Processing application..."

# Step 1: Install dependencies if needed
echo "Checking for dependencies..."
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Step 2: Compile TypeScript
echo "Compiling TypeScript..."
npm run build

# Step 3: Show what changes will be deployed
echo "Checking for changes to be deployed..."
cdk diff FrenchDocumentProcessingStack

# Step 4: Deploy the stack
echo "Deploying the stack..."
cdk deploy FrenchDocumentProcessingStack --require-approval never

echo "Deployment completed successfully!"
