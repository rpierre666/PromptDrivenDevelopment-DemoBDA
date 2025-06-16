# API Specification: French Document Processing System

This API specification defines the interfaces for the French Document Processing System that uses Bedrock Data Automation with pre-built templates. It covers the endpoints exposed through API Gateway that client applications will use to interact with the system.

## API Overview

The API follows REST principles and uses JSON for request and response payloads. All endpoints require authentication using JWT tokens and support HTTPS only to ensure secure communication.

## Base URL

```
https://api.document-processing-system.com/v1
```

## Authentication

All API requests require a valid JWT token in the Authorization header:

```
Authorization: Bearer {token}
```

## Common Response Codes

- `200 OK`: Request successful
- `201 Created`: Resource created successfully
- `400 Bad Request`: Invalid request parameters
- `401 Unauthorized`: Missing or invalid authentication
- `403 Forbidden`: Insufficient permissions
- `404 Not Found`: Resource not found
- `422 Unprocessable Entity`: Request validation failed
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server-side error

## Common Response Headers

- `Content-Type`: Always set to `application/json`
- `X-Request-ID`: Unique identifier for the request (for debugging)
- `X-Rate-Limit-Remaining`: Number of requests remaining in the current time window

## Endpoints

### 1. Document Processing

#### 1.1 Start Verification Session

```
POST /verification-sessions
```

Creates a new verification session for document processing and facial verification.

**Request Body:**
```json
{
  "customer_reference": "string",  // Optional customer reference ID
  "session_type": "ONBOARDING",    // ONBOARDING or VERIFICATION
  "callback_url": "string"         // Optional URL for session completion notification
}
```

**Response Body:**
```json
{
  "session_id": "string",          // Unique session identifier
  "expires_at": "string",          // ISO 8601 timestamp when session expires
  "upload_urls": {                 // Pre-signed URLs for document uploads
    "identity_document": "string",
    "drivers_license": "string",
    "vehicle_registration": "string",
    "facial_image": "string"
  },
  "status": "CREATED"              // CREATED, IN_PROGRESS, COMPLETED, FAILED
}
```

#### 1.2 Check Session Status

```
GET /verification-sessions/{session_id}
```

Retrieves the current status of a verification session.

**Path Parameters:**
- `session_id`: ID of the verification session

**Response Body:**
```json
{
  "session_id": "string",
  "status": "string",              // CREATED, IN_PROGRESS, COMPLETED, FAILED
  "created_at": "string",          // ISO 8601 timestamp
  "updated_at": "string",          // ISO 8601 timestamp
  "document_status": {
    "identity_document": "PENDING", // PENDING, UPLOADED, PROCESSING, PROCESSED, FAILED
    "drivers_license": "PENDING",
    "vehicle_registration": "PENDING",
    "facial_image": "PENDING"
  },
  "verification_status": {
    "identity_verification": "PENDING", // PENDING, PASSED, FAILED, MANUAL_REVIEW
    "facial_verification": "PENDING"
  }
}
```

#### 1.3 Upload Document Notification

```
POST /verification-sessions/{session_id}/documents/{document_type}/uploaded
```

Notifies the system that a document has been uploaded using the pre-signed URL.

**Path Parameters:**
- `session_id`: ID of the verification session
- `document_type`: Type of document (identity_document, drivers_license, vehicle_registration, facial_image)

**Response Body:**
```json
{
  "success": true,
  "document_status": "UPLOADED"
}
```

#### 1.4 Get Verification Results

```
GET /verification-sessions/{session_id}/results
```

Retrieves the verification results for a completed session.

**Path Parameters:**
- `session_id`: ID of the verification session

**Response Body:**
```json
{
  "session_id": "string",
  "status": "COMPLETED",
  "verification_result": "PASSED",  // PASSED, FAILED, MANUAL_REVIEW
  "report_id": "string",            // ID of the verification report
  "extracted_data": {
    "identity_document": {
      "document_type": "PASSPORT",  // PASSPORT or NATIONAL_ID
      "full_name": "string",
      "date_of_birth": "string",    // ISO 8601 date
      "document_number": "string",
      "expiration_date": "string",  // ISO 8601 date
      "issuer_name": "string",
      "city_of_issuance": "string"
    },
    "drivers_license": {
      "full_name": "string",
      "license_number": "string",
      "categories": ["string"],
      "issue_date": "string",       // ISO 8601 date
      "expiration_date": "string",  // ISO 8601 date
      "issuer_name": "string",
      "city_of_issuance": "string"
    },
    "vehicle_registration": {
      "registration_number": "string",
      "first_registration_date": "string",  // ISO 8601 date
      "owner_name": "string",
      "address": "string",
      "is_owner": true,
      "co_holders": ["string"],
      "vehicle_make": "string",
      "vehicle_type": "string",
      "cnit": "string",             // National Type Identification Code
      "commercial_name": "string"
    }
  },
  "verification_details": {
    "facial_verification": {
      "result": "PASSED",           // PASSED, FAILED, MANUAL_REVIEW
      "confidence_score": 0.95,     // 0-1 value
      "threshold_used": 0.8         // 0-1 value
    },
    "document_verification": {
      "identity_document": "PASSED", // PASSED, FAILED, MANUAL_REVIEW
      "drivers_license": "PASSED",
      "vehicle_registration": "PASSED"
    }
  },
  "error_details": []               // Any error messages if applicable
}
```

### 2. Report Management

#### 2.1 Get Verification Report

```
GET /reports/{report_id}
```

Retrieves a verification report.

**Path Parameters:**
- `report_id`: ID of the verification report

**Query Parameters:**
- `format`: Optional format (json, pdf), defaults to json

**Response Body (JSON format):**
```json
{
  "report_id": "string",
  "session_id": "string",
  "created_at": "string",          // ISO 8601 timestamp
  "verification_result": "PASSED",  // PASSED, FAILED, MANUAL_REVIEW
  "customer_reference": "string",
  "document_summaries": [
    {
      "document_type": "PASSPORT",
      "verification_status": "PASSED",
      "key_fields": {
        "full_name": "string",
        "document_number": "string"
      }
    }
    // Additional documents
  ],
  "facial_verification_summary": {
    "result": "PASSED",
    "confidence_score": 0.95
  }
}
```

### 3. Document Retrieval

#### 3.1 Get Document Metadata

```
GET /documents/{document_id}/metadata
```

Retrieves metadata for a processed document.

**Path Parameters:**
- `document_id`: ID of the document

**Response Body:**
```json
{
  "document_id": "string",
  "document_type": "PASSPORT",
  "session_id": "string",
  "upload_date": "string",        // ISO 8601 timestamp
  "process_date": "string",       // ISO 8601 timestamp
  "status": "PROCESSED",          // UPLOADED, PROCESSING, PROCESSED, FAILED, DELETED
  "retention_expiry": "string",   // ISO 8601 timestamp when document will be deleted
  "extraction_confidence": 0.95   // 0-1 value indicating overall extraction confidence
}
```

#### 3.2 Search Documents

```
GET /documents
```

Searches for documents based on metadata.

**Query Parameters:**
- `session_id`: Optional verification session ID
- `document_type`: Optional document type (PASSPORT, NATIONAL_ID, DRIVERS_LICENSE, VEHICLE_REGISTRATION)
- `status`: Optional document status
- `customer_reference`: Optional customer reference
- `uploaded_after`: Optional ISO 8601 timestamp
- `uploaded_before`: Optional ISO 8601 timestamp
- `page`: Optional page number (default: 1)
- `limit`: Optional items per page (default: 20, max: 100)

**Response Body:**
```json
{
  "total_count": 42,
  "page": 1,
  "limit": 20,
  "documents": [
    {
      "document_id": "string",
      "document_type": "PASSPORT",
      "session_id": "string",
      "upload_date": "string",     // ISO 8601 timestamp
      "status": "PROCESSED",
      "customer_reference": "string"
    }
    // Additional documents
  ]
}
```

### 4. System Operations

#### 4.1 Get System Health

```
GET /health
```

Checks the health status of the document processing system.

**Response Body:**
```json
{
  "status": "HEALTHY",            // HEALTHY, DEGRADED, UNAVAILABLE
  "components": {
    "bedrock_data_automation": "HEALTHY",
    "facial_verification": "HEALTHY",
    "document_storage": "HEALTHY",
    "database": "HEALTHY"
  },
  "uptime": 1234567,              // seconds
  "version": "1.0.0"
}
```

#### 4.2 Get Processing Statistics

```
GET /statistics
```

Retrieves system processing statistics.

**Query Parameters:**
- `from`: Required ISO 8601 timestamp for start of reporting period
- `to`: Required ISO 8601 timestamp for end of reporting period

**Response Body:**
```json
{
  "period": {
    "from": "string",             // ISO 8601 timestamp
    "to": "string"                // ISO 8601 timestamp
  },
  "sessions": {
    "created": 42,
    "completed": 38,
    "failed": 4
  },
  "documents_processed": {
    "identity_documents": 38,
    "drivers_licenses": 38,
    "vehicle_registrations": 38
  },
  "verification_results": {
    "passed": 35,
    "failed": 2,
    "manual_review": 1
  },
  "average_processing_time": 12.3  // seconds
}
```

## Webhooks

The system can send webhook notifications to a specified callback URL when certain events occur.

### Webhook Event Types

- `session.created`: A new verification session has been created
- `document.uploaded`: A document has been uploaded
- `document.processed`: A document has been processed by Bedrock Data Automation
- `verification.completed`: The entire verification process has completed
- `verification.failed`: The verification process has failed

### Webhook Payload

```json
{
  "event_type": "verification.completed",
  "timestamp": "string",          // ISO 8601 timestamp
  "session_id": "string",
  "data": {
    // Event-specific data
  }
}
```

## Error Responses

When an error occurs, the API returns a standard error response:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid document type provided",
    "details": [
      {
        "field": "document_type",
        "message": "Must be one of: PASSPORT, NATIONAL_ID, DRIVERS_LICENSE, VEHICLE_REGISTRATION"
      }
    ],
    "request_id": "string"       // Unique identifier for the failed request
  }
}
```

## Rate Limiting

The API enforces rate limits to prevent abuse. Current limits are:

- 100 requests per minute per API key for most endpoints
- 20 session creations per minute per API key
- 5 document uploads per minute per session

When rate limits are exceeded, the API returns a 429 status code with a Retry-After header indicating when the client can retry.

## API Versioning

The API version is included in the URL path (e.g., `/v1/verification-sessions`). When breaking changes are introduced, a new API version will be released and the previous version will be supported for at least 6 months.