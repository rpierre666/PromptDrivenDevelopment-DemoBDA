# French Document Processing System

## Project Overview

This repository contains a comprehensive solution for processing and validating French official documents using AWS services, particularly AWS Bedrock Data Automation. The system is designed to help financial institutions, vehicle registration agencies, and identity verification service providers verify French customers' identities and vehicle ownership during onboarding.

## Key Features

- **Document Processing**: Automated extraction and validation of data from French official documents:
  - Passport/National ID
  - Driver's License
  - Vehicle Registration (Carte Grise)
  
- **Facial Verification**: Comparison between live photos and document photos with high accuracy targets:
  - False Acceptance Rate (FAR) ≤ 0.1%
  - False Rejection Rate (FRR) ≤ 3%
  
- **Compliance**: Built with GDPR compliance in mind, including specific document retention periods
  
- **Reporting**: Generation of verification reports and customer database updates

## Repository Structure

- **Application Documentation**: Contains detailed documentation for all system components:
  - Requirements specification
  - High-level design
  - Component diagrams
  - Sequence diagrams
  - API specifications
  - Implementation plans
  - Detailed component documentation
  
- **french-document-processing**: The main implementation directory containing:
  - AWS CDK infrastructure code (TypeScript)
  - Lambda functions for document processing
  - Integration with AWS Bedrock
  - Deployment scripts
  - Testing framework

## Architecture

The system follows a serverless, event-driven architecture using AWS services:

1. Document capture and preprocessing
2. Bedrock Data Automation for document analysis
3. Document validation and data extraction
4. Facial image extraction and verification
5. Verification aggregation and report generation
6. Customer database updates
7. Secure document storage

## Getting Started

### Prerequisites

- AWS Account with appropriate permissions
- Node.js and npm installed
- AWS CDK installed
- AWS CLI configured

### Installation

1. Clone this repository
2. Navigate to the `french-document-processing` directory
3. Install dependencies:
   ```
   npm install
   ```
4. Build the project:
   ```
   npm run build
   ```

### Deployment

Use the provided deployment script to deploy the solution to your AWS account:

```bash
./deployment_script.sh
```

For troubleshooting deployment issues:

```bash
./troubleshoot.sh
```

## Testing

Run the test suite:

```bash
npm run test
```

## Development

- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch for changes and compile
- `npx cdk diff` - Compare deployed stack with current state
- `npx cdk synth` - Emit the synthesized CloudFormation template

## License

[Specify your license information here]

## Contributors

[List of contributors]

