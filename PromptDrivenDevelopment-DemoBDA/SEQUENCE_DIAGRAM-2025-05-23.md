# Sequence Diagram: French Document Processing System

This sequence diagram illustrates the step-by-step interaction flow in the French document processing system using Bedrock Data Automation with pre-built templates. It shows the interactions between components during document capture, processing, facial verification, and final verification processes.

## Document Submission and Processing Flow

```mermaid
sequenceDiagram
    participant User
    participant ClientApp as Web/Mobile Application
    participant APIGateway
    participant Orchestrator as Workflow Orchestrator
    participant PreProcessor as Document Pre-processor
    participant Bedrock as Bedrock Data Automation
    participant Validator as Document Validator
    participant FacialExtractor as Facial Image Extractor
    participant Rekognition as AWS Rekognition
    participant Evaluator as Facial Verification Evaluator
    participant Aggregator as Verification Aggregator
    participant Reporter as Report Generator
    participant DBUpdater as Customer DB Updater
    participant StorageManager as Document Storage Manager
    participant S3
    participant DynamoDB
    participant CustomerDB

    User->>ClientApp: Submit identity document
    User->>ClientApp: Submit driver's license
    User->>ClientApp: Submit vehicle registration
    ClientApp->>APIGateway: Upload documents
    APIGateway->>Orchestrator: Start document processing workflow
    
    %% Document Pre-processing
    Orchestrator->>PreProcessor: Process identity document
    PreProcessor->>PreProcessor: Enhance image quality
    PreProcessor->>PreProcessor: Normalize document
    PreProcessor->>Bedrock: Send processed identity document
    
    Orchestrator->>PreProcessor: Process driver's license
    PreProcessor->>Bedrock: Send processed driver's license
    
    Orchestrator->>PreProcessor: Process vehicle registration
    PreProcessor->>Bedrock: Send processed vehicle registration
    
    %% Data extraction
    Bedrock->>Bedrock: Apply pre-built template for identity document
    Bedrock->>Validator: Return extracted identity fields
    Validator->>Validator: Validate extracted fields
    Validator->>Orchestrator: Return validated identity data
    
    Bedrock->>Bedrock: Apply pre-built template for driver's license
    Bedrock->>Validator: Return extracted license fields
    Validator->>Validator: Validate extracted fields
    Validator->>Orchestrator: Return validated license data
    
    Bedrock->>Bedrock: Apply pre-built template for vehicle registration
    Bedrock->>Validator: Return extracted registration fields
    Validator->>Validator: Validate extracted fields
    Validator->>Orchestrator: Return validated registration data
    
    %% Facial capture and verification
    Orchestrator->>ClientApp: Request facial capture
    ClientApp->>User: Prompt for live portrait photo
    User->>ClientApp: Capture live portrait
    ClientApp->>APIGateway: Upload portrait photo
    APIGateway->>Orchestrator: Process facial verification
    
    Orchestrator->>FacialExtractor: Extract faces from documents
    FacialExtractor->>FacialExtractor: Extract face from identity document
    FacialExtractor->>FacialExtractor: Extract face from driver's license
    FacialExtractor->>Rekognition: Send live portrait and document faces
    
    Rekognition->>Rekognition: Compare portrait with ID document face
    Rekognition->>Rekognition: Compare portrait with driver's license face
    Rekognition->>Evaluator: Return comparison results
    
    Evaluator->>Evaluator: Apply FAR/FRR thresholds
    Evaluator->>Orchestrator: Return verification result
    
    %% Verification aggregation and reporting
    Orchestrator->>Aggregator: Aggregate document and facial verification results
    Aggregator->>Aggregator: Compile verification data
    Aggregator->>Reporter: Send verification data for report
    Aggregator->>DBUpdater: Send verified customer data
    Aggregator->>StorageManager: Send documents and metadata
    
    Reporter->>Reporter: Generate verification report
    Reporter->>DynamoDB: Store verification report
    Reporter->>Orchestrator: Return report ID
    
    DBUpdater->>CustomerDB: Update customer information
    DBUpdater->>Orchestrator: Confirm database update
    
    StorageManager->>S3: Store original documents
    StorageManager->>DynamoDB: Store document metadata
    StorageManager->>Orchestrator: Confirm storage complete
    
    Orchestrator->>APIGateway: Return verification status and report ID
    APIGateway->>ClientApp: Return verification results
    ClientApp->>User: Display verification confirmation
```

## Error Handling Flow

```mermaid
sequenceDiagram
    participant User
    participant ClientApp as Web/Mobile Application
    participant APIGateway
    participant Orchestrator as Workflow Orchestrator
    participant Validator as Document Validator
    participant Evaluator as Facial Verification Evaluator
    participant Manual as Manual Verification Queue
    participant Agent as Verification Agent
    
    %% Document validation error
    Validator->>Validator: Detect invalid or missing fields
    Validator->>Orchestrator: Return validation error
    Orchestrator->>APIGateway: Request additional document capture
    APIGateway->>ClientApp: Prompt for document recapture
    ClientApp->>User: Request document recapture
    
    %% Facial verification error
    Evaluator->>Evaluator: Detect facial match below threshold
    Evaluator->>Orchestrator: Return verification failure
    Orchestrator->>Manual: Queue for manual verification
    Manual->>Agent: Assign to verification agent
    Agent->>Manual: Approve or reject verification
    Manual->>Orchestrator: Return manual verification result
    
    %% Communication to user
    Orchestrator->>APIGateway: Return final verification status
    APIGateway->>ClientApp: Return verification results
    ClientApp->>User: Display verification status
```

## Lifecycle Management Flow

```mermaid
sequenceDiagram
    participant S3
    participant DynamoDB
    participant LifecycleManager as GDPR Lifecycle Manager
    participant AuditLogger as Audit Logging Service
    
    %% Regular lifecycle check (scheduled event)
    LifecycleManager->>S3: Query documents older than 90 days
    S3->>LifecycleManager: Return list of documents
    LifecycleManager->>S3: Apply deletion policy
    S3->>LifecycleManager: Confirm document deletion
    
    LifecycleManager->>DynamoDB: Update document status to "deleted"
    LifecycleManager->>AuditLogger: Record document lifecycle event
    AuditLogger->>AuditLogger: Store audit logs (1 year retention)
```

## Summary of Key Interactions

1. **Document Processing Flow**:
   - User submits three document types through client application
   - Documents are pre-processed for quality enhancement
   - Bedrock Data Automation extracts data using pre-built templates
   - Extracted data is validated against business rules

2. **Facial Verification Flow**:
   - User provides live portrait photo
   - System extracts facial images from identity documents
   - AWS Rekognition performs facial comparison
   - Evaluator determines if verification passes based on thresholds

3. **Post-Processing Flow**:
   - Results are aggregated from document processing and facial verification
   - Verification report is generated and stored
   - Customer database is updated with verified information
   - Documents are stored with appropriate metadata
   - User receives verification confirmation

4. **Error Handling**:
   - Document validation errors trigger recapture requests
   - Failed facial verification routes to manual review
   - Final status is communicated to the user

5. **Lifecycle Management**:
   - Documents older than 90 days are automatically deleted
   - Metadata is updated to reflect deletion status
   - Audit logs are maintained for 1 year