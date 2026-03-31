# CAN-HMI API - Error Codes

All API errors return a consistent JSON structure:

```json
{
	"error": "Short human-readable description",
	"code": 3002,
	"id": "VAL_MISSING_FIELD"
}
```

## Overview

| Code | ID | HTTP | Group | Description |
|------|----|------|-------|-------------|
| `1000` | `SYS_UNKNOWN` | 500 | System | Unknown error |
| `1001` | `SYS_DB_LOCKED` | 503 | System | SQLite database locked |
| `1002` | `SYS_MAINTENANCE` | 503 | System | System under maintenance |
| `2001` | `HW_CAN_0_ERROR` | 503 | Hardware | CAN0 bus communication timeout |
| `2002` | `HW_CAN_1_ERROR` | 504 | Hardware | CAN1 bus communication timeout |
| `2003` | `HW_CAM_LOST` | 503 | Hardware | Camera signal lost |
| `3001` | `VAL_INVALID_JSON` | 400 | Validation | Invalid JSON format |
| `3002` | `VAL_MISSING_FIELD` | 400 | Validation | Missing required field |
| `3003` | `VAL_OUT_OF_RANGE` | 422 | Validation | Value outside allowed range |
| `3004` | `VAL_NOT_FOUND` | 404 | Validation | Resource not found |
| `3005` | `VAL_CONFLICT` | 409 | Validation | section_id mismatch or duplicate name |
| `4001` | `SEC_UNAUTHORIZED` | 401 | Security | Invalid API key |
| `4002` | `SAFE_WRITE_DENIED` | 403 | Safety | Signal is read-only (`TX: false`) |
| `4003` | `SAFE_WATCHDOG_TRIP` | 500 | Safety | Watchdog detected hang |
| `4004` | `SAFE_VEHICLE_MOVING` | 403 | Safety | Write denied while vehicle is moving |

## HTTP Status Mapping

| HTTP | App Codes | Meaning |
|------|-----------|---------|
| 200 | - | Success |
| 201 | - | Resource created |
| 202 | - | Write accepted |
| 204 | - | Delete successful |
| 400 | 3001, 3002 | Invalid JSON or missing field |
| 401 | 4001 | Unauthorized |
| 403 | 4002, 4004 | Forbidden by safety rules |
| 404 | 3004 | Resource not found |
| 409 | 3005 | Conflict / stale section_id |
| 422 | 3003 | Value out of range |
| 500 | 1000, 4003 | Internal error |
| 503 | 1001, 1002, 2001, 2003 | Service unavailable / hardware issue |
| 504 | 2002 | CAN1 timeout |

## Optimistic Locking

For `PUT /api/profile` and `PUT /config`, client must send the latest `section_id`.
If stale, server returns `409 VAL_CONFLICT` and client should GET latest data, then retry.
