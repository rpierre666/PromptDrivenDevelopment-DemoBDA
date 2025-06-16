#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStack } from '../lib/storage-stack';

const app = new cdk.App();

// Define environment - using default account and region or specified ones
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'eu-west-3'  // Default to Paris region for French documents
};

// Create the storage stack
new StorageStack(app, 'FrenchDocProcessingStorageStack', {
  env: env,
  description: 'Storage infrastructure for French document processing system'
});