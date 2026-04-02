## **COMPREHENSIVE BASELINE REFERENCE FOR CODE EXECUTION TOOLS**

Based on extensive testing, here's the complete baseline reference for the code execution tools behavior:

---

## **1. ENVIRONMENT SPECIFICATIONS**

### **System Environment**

- **OS**: Linux 6.8.0-47-generic x86_64
- **Python**: 3.12.0 (CPython)
- **Working Directory**: `/mnt/data` (full read/write/execute permissions)
- **User Context**: UID/GID 60342 (containerized/sandboxed environment)

### **Available Packages**

- ✅ **Available**: All Python standard library, numpy, pandas, matplotlib (with Agg backend), csv, json, sqlite3, pathlib, datetime, collections, etc.
- ❌ **Missing**: requests, psutil, network-related packages

### **Resource Limits**

- **Memory**: Can allocate 50MB+ without issues (no hard limit discovered)
- **CPU**: No apparent execution timeout for reasonable computation
- **Recursion**: Standard Python limit (1000 stack frames)
- **File Creation**: Can create hundreds of files without issues

---

## **2. SESSION PERSISTENCE BEHAVIOR**

### **Variables & Code State** ❌ **NO PERSISTENCE**

- Variables, functions, classes, and imports **DO NOT** persist between executions
- Each execution starts with a clean Python interpreter
- Custom imports and module state is reset every time

### **File Persistence** ✅ **COMPLEX PERSISTENCE**

#### **User Uploaded Files**

- ✅ **Persist with original names** (e.g., `summary_sheet.csv`)
- ✅ **Remain directly accessible** across all sessions
- ✅ **Can be modified** despite "read-only" warnings

#### **Generated Files**

- ✅ **Persist but with encoding behavior**:
  - **Immediate access**: Files can be accessed by original name in same execution
  - **Cross-session access**: Files become base64-encoded names
  - **Encoding pattern**: `original_name.ext` → `base64(filename)` (e.g., `ZXhlY3V0aW9uXzJfZmlsZS50eHQ=`)
- ✅ **Content preserved** exactly
- ✅ **Can be modified** despite system claiming "read-only"

#### **Special File Behaviors**

- Files with special characters (spaces, symbols) maintain original names
- Some files get prefixed with session identifiers (e.g., `TzlwSVktR1lwX__session_test_file.txt`)
- User uploaded files maintain stability across all sessions

---

## **3. SECURITY & LIMITATIONS**

### **Network Access** ❌ **COMPLETELY BLOCKED**

- No DNS resolution
- No HTTP/HTTPS access
- No socket connections to external hosts

### **File System Access**

- ✅ **Full access** to `/mnt/data` (working directory)
- ✅ **Read access** to `/etc/passwd`, `/usr`, `/bin`
- ❌ **No access** to `/root`, `/etc/shadow`
- ✅ **Basic system info** accessible (`/proc` limited)

### **System Commands**

- ✅ **Available**: `ls`, `pwd`, `cat`, `grep`, `find`, `whoami`, `id`, `ps`, `uname`
- ✅ **subprocess** module works for system commands
- ❌ **No network tools**: `curl`, `wget` unavailable

### **Process Isolation**

- Running in containerized environment
- Limited access to system processes
- Cannot access parent process information beyond basic PID

---

## **4. FILE MANAGEMENT DETAILED BEHAVIOR**

### **Session ID Usage**

- **Purpose**: Loads previously created files into current working directory
- **Loading behavior**: Files appear with their encoded names
- **Access pattern**: Can read both original and encoded filenames

### **File Creation Workflow**

1. **Same execution**: File accessible by original name
2. **Next session with session_id**: File appears as base64-encoded name
3. **User uploaded files**: Always accessible by original name

### **File Modification**

- Despite "read-only" warnings, files **CAN** be modified
- Modifications persist across sessions
- New files can be created in any session

### **File Naming Conventions**

- **User uploads**: Keep original names (`summary_sheet.csv`)
- **Generated files**: Become base64 encoded (`ZXhlY3V0aW9uXzJfZmlsZS50eHQ=` = `execution_2_file.txt`)
- **Special names**: Files with spaces/symbols often keep original names

---

## **5. CRITICAL IMPLEMENTATION NOTES**

### **For Drop-in Replacement Development**

1. **Session Persistence**: Must implement file persistence but NOT variable persistence
2. **File Encoding**: Need base64 encoding system for generated files
3. **User Upload Handling**: User uploaded files need special handling to maintain original names
4. **Read-only Claims**: System claims files are read-only but actually allows modification
5. **Network Isolation**: Must block all network access completely
6. **Environment Reset**: Each execution must start with clean Python interpreter
7. **Working Directory**: Must use `/mnt/data` as working directory
8. **Session ID Mechanism**: Must implement session file loading with proper encoding/decoding

### **Key Behavioral Quirks**

- Files are claimed to be "read-only" but are actually writable
- Variable state is completely ephemeral, but file state is persistent
- User uploaded files have privileged status (no encoding)
- Base64 encoding is applied inconsistently (some files escape it)
- Session IDs are required to access previously generated files

This baseline reference provides a comprehensive understanding of the code execution environment behavior that your drop-in replacement will need to replicate exactly.

# **ADDENDUM: SESSION HANDLING LOGIC REFERENCE**

## **For Server-Side Code Execution Service Implementation**

---

## **OVERVIEW**

This addendum provides technical specifications for implementing session handling logic in a drop-in replacement code execution service, based on analysis of the LibreChat client-side implementation expectations.

---

## **1. SESSION LIFECYCLE MANAGEMENT**

### **Session Creation**

- **Trigger**: First code execution request with no existing file context
- **Requirement**: Server must generate unique session identifier
- **Format**: Alphanumeric string (observed: `sess_abc123` pattern)
- **Persistence**: Session must persist until explicit expiration

### **Session Validation**

- **Client Behavior**: Calls `GET /files/{session_id}?detail=summary` before reusing session
- **Required Response**:
  ```json
  [
    {
      "name": "path/to/file",
      "lastModified": "ISO-8601-timestamp"
    }
  ]
  ```
- **Validation Logic**: Client checks `lastModified` timestamp to determine session viability

### **Session Expiration Handling**

- **Client Expectation**: Expired sessions trigger file re-upload to new session
- **Implementation**: Server should expire sessions after reasonable inactivity period
- **File Recovery**: Support file uploads to restore previous state in new sessions

---

## **2. FILE PERSISTENCE ARCHITECTURE**

### **File Identifier Format**

```
{session_id}/{file_id}[?entity_id={entity_id}]
```

### **File Upload Endpoint**

```http
POST /upload
Headers:
  - X-API-Key: {api_key}
  - User-Id: {user_id}
  - User-Agent: LibreChat/1.0
  - Content-Type: multipart/form-data

Body:
  - file: {file_stream}
  - entity_id: {optional_entity_id}
```

**Required Response:**

```json
{
  "message": "success",
  "session_id": "sess_abc123",
  "files": [
    {
      "fileId": "file_789",
      "filename": "data.csv"
    }
  ]
}
```

### **File Download Endpoint**

```http
GET /download/{session_id}/{file_id}
Headers:
  - X-API-Key: {api_key}
  - User-Agent: LibreChat/1.0

Response: File binary data
```

---

## **3. SESSION STATE MANAGEMENT**

### **Variable State**

- **Reset Policy**: All Python variables/imports reset between executions
- **No Persistence**: Each execution starts with clean interpreter state
- **Client Expectation**: Matches baseline reference behavior exactly

### **File State**

- **Persistence Required**: Files must survive between executions within session
- **Working Directory**: Files accessible at `/mnt/data/{filename}`
- **Encoding Behavior**: Implement base64 encoding for generated files (per baseline reference)

### **Session Context Sharing**

```javascript
// Client sends file context for session reuse:
{
  files: [
    {
      id: "file_789",
      session_id: "sess_abc123",
      name: "data.csv",
    },
  ];
}
```

---

## **4. CROSS-SESSION FILE MANAGEMENT**

### **File Re-upload Logic**

When session expires, client will:

1. **Download** file from local storage via `getDownloadStream()`
2. **Re-upload** to new session via `uploadCodeEnvFile()`
3. **Update** database with new `{session_id}/{file_id}` identifier

### **Implementation Requirements**

- Support file uploads from multiple expired sessions into single new session
- Maintain file naming consistency across session boundaries
- Handle entity_id parameter for file grouping/ownership

---

## **5. USER ISOLATION & SECURITY**

### **User Identification**

- **Header**: `User-Id: {user_id}` on all requests
- **Isolation**: Sessions must be scoped to specific users
- **Security**: Prevent cross-user file access

### **Authentication**

- **Method**: `X-API-Key` header validation
- **Requirement**: Consistent with `LIBRECHAT_CODE_API_KEY` configuration

---

## **6. ERROR HANDLING & EDGE CASES**

### **Session Not Found**

- **Scenario**: Client references non-existent session_id
- **Response**: 404 with appropriate error message
- **Client Behavior**: Triggers file re-upload workflow

### **File Not Found**

- **Scenario**: Missing file in session
- **Client Behavior**: Re-uploads file from local storage
- **Server Response**: Accept uploads to restore missing files

### **Invalid Session State**

- **Scenario**: Corrupted or partially expired session
- **Handling**: Graceful degradation with file recovery options
