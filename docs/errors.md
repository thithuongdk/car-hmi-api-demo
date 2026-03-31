# CAN-HMI API � B? M� L?i (Error Codes)

T?t c? l?i API tr? v? JSON c�ng c?u tr�c:

```json
{
  "error": "M� t? l?i ng?n g?n",
  "code": 3002,
  "id":   "VAL_MISSING_FIELD"
}
```

> **Ghi ch�:** `code` v� `id` l� application-level error codes, d?c l?p v?i HTTP status code.  
> `code` d�ng d? switch-case ph�a FE; `id` d�ng d? log/trace d? d?c.

---

## T?ng Quan M� L?i

| Code | ID | HTTP | Nh�m | M� t? |
|------|----|------|------|-------|
| `1000` | `SYS_UNKNOWN` | 500 | System | L?i kh�ng x�c d?nh |
| `1001` | `SYS_DB_LOCKED` | 503 | System | Database SQLite b? kh�a |
| `1002` | `SYS_MAINTENANCE` | 503 | System | H? th?ng dang b?o tr� |
| `2001` | `HW_CAN_ERROR` | 503 | Hardware | L?i k?t n?i SocketCAN |
| `2002` | `HW_XCP_TIMEOUT` | 504 | Hardware | ECU kh�ng ph?n h?i (XCP) |
| `2003` | `HW_CAM_LOST` | 503 | Hardware | M?t t�n hi?u Camera |
| `2004` | `HW_GPS_NO_FIX` | 200 | Hardware | Chua c� t�n hi?u GPS |
| `3001` | `VAL_INVALID_JSON` | 400 | Validation | JSON kh�ng h?p l? |
| `3002` | `VAL_MISSING_FIELD` | 400 | Validation | Thi?u tru?ng b?t bu?c |
| `3003` | `VAL_OUT_OF_RANGE` | 422 | Validation | Gi� tr? ngo�i ngu?ng min/max |
| `3004` | `VAL_NOT_FOUND` | 404 | Validation | Resource kh�ng t?n t?i |
| `3005` | `VAL_CONFLICT` | 409 | Validation | section_id mismatch / t�n tr�ng |
| `4001` | `SEC_UNAUTHORIZED` | 401 | Security | API Key kh�ng h?p l? |
| `4002` | `SAFE_WRITE_DENIED` | 403 | Safety | Signal read-only, kh�ng ghi du?c |
| `4003` | `SAFE_WATCHDOG_TRIP` | 500 | Safety | Watchdog ph�t hi?n l?i treo |
| `4004` | `SAFE_VEHICLE_MOVING` | 403 | Safety | Kh�ng ghi du?c khi xe dang ch?y |

---

## ?? Nh�m 10xx � L?i H? Th?ng (System Errors)

| Code | ID | HTTP | M� t? | H�nh d?ng g?i � |
|------|----|------|-------|----------------|
| `1000` | `SYS_UNKNOWN` | 500 | L?i kh�ng x�c d?nh, chua du?c ph�n lo?i | Ki?m tra server log. Retry sau v�i gi�y |
| `1001` | `SYS_DB_LOCKED` | 503 | Database SQLite b? kh�a (write contention) | Retry sau 1�3 gi�y v?i exponential backoff |
| `1002` | `SYS_MAINTENANCE` | 503 | H? th?ng dang b?o tr�, kh�ng nh?n request | Hi?n th? th�ng b�o ch? cho user |

**V� d? response:**
```json
{ "error": "Database is locked, please retry", "code": 1001, "id": "SYS_DB_LOCKED" }
```

---

## ?? Nh�m 20xx � L?i Ph?n C?ng (Hardware & Drivers)

| Code | ID | HTTP | M� t? | H�nh d?ng g?i � |
|------|----|------|-------|----------------|
| `2001` | `HW_CAN_ERROR` | 503 | L?i k?t n?i SocketCAN (bus-off ho?c ng?t c�p) | Ki?m tra driver CAN, c�p D-Sub9 |
| `2002` | `HW_XCP_TIMEOUT` | 504 | ECU kh�ng ph?n h?i qua XCP trong timeout | Ki?m tra ngu?n ECU, k?t n?i XCP-on-CAN |
| `2003` | `HW_CAM_LOST` | 503 | M?t t�n hi?u Camera (stream ng?t) | Kh?i d?ng l?i camera stream, ki?m tra ngu?n |
| `2004` | `HW_GPS_NO_FIX` | 200 | Chua c� t�n hi?u v? tinh (satellite fix) | Ch? xe ra khu v?c tho�ng. Kh�ng ph?i l?i nghi�m tr?ng � GPS value l� `null` |

> `HW_GPS_NO_FIX` tr? HTTP **200** v� l� tr?ng th�i b�nh thu?ng l�c kh?i d?ng.

**V� d? response `2001`:**
```json
{ "error": "SocketCAN interface vcan0 is down", "code": 2001, "id": "HW_CAN_ERROR" }
```

---

## ?? Nh�m 30xx � L?i D? Li?u & Validate (Data & Validation)

| Code | ID | HTTP | M� t? | H�nh d?ng g?i � |
|------|----|------|-------|----------------|
| `3001` | `VAL_INVALID_JSON` | 400 | Request body kh�ng ph?i JSON h?p l? | Ki?m tra c� ph�p JSON, header `Content-Type: application/json` |
| `3002` | `VAL_MISSING_FIELD` | 400 | Thi?u tru?ng d? li?u b?t bu?c | B? sung key c�n thi?u theo API schema |
| `3003` | `VAL_OUT_OF_RANGE` | 422 | Gi� tr? t�n hi?u vu?t ngu?ng `min`/`max` | G?i `GET /signals/available` d? l?y gi?i h?n h?p l? |
| `3004` | `VAL_NOT_FOUND` | 404 | Profile name / Signal name kh�ng t?n t?i | `GET /api/profiles` ho?c `GET /signals/available` d? l?y danh s�ch d�ng |
| `3005` | `VAL_CONFLICT` | 409 | T�n profile tr�ng, ho?c `section_id` kh�ng kh?p | Xem m?c **Optimistic Locking** b�n du?i |

**V� d? response `3003`:**
```json
{ "error": "Value 10 is out of range [0, 7] for HB_FL_ActivationLevel", "code": 3003, "id": "VAL_OUT_OF_RANGE" }
```

---

## ?? Nh�m 40xx � L?i An To�n & B?o M?t (Safety & Security)

| Code | ID | HTTP | M� t? | H�nh d?ng g?i � |
|------|----|------|-------|----------------|
| `4001` | `SEC_UNAUTHORIZED` | 401 | API Key kh�ng h?p l? ho?c thi?u header `X-API-Key` | Ki?m tra c?u h�nh header. Li�n h? admin l?y key m?i |
| `4002` | `SAFE_WRITE_DENIED` | 403 | Signal c� `TX: false` � sensor only, HMI kh�ng du?c ghi | Kh�ng g?i l?nh ghi. Ki?m tra `writable` t? `GET /signals/available` |
| `4003` | `SAFE_WATCHDOG_TRIP` | 500 | Watchdog ph�t hi?n process treo, t? reset | Ch? server kh?i d?ng l?i (< 5s). Alert n?u t�i di?n |
| `4004` | `SAFE_VEHICLE_MOVING` | 403 | L?nh ghi b? t? ch?i v� xe dang di chuy?n (speed > 0) | D?ng xe ho�n to�n tru?c khi th?c hi?n l?nh c?u h�nh |

**V� d? response `4002`:**
```json
{ "error": "Signal BSW_FL_BuckleStatus is read-only (TX: false)", "code": 4002, "id": "SAFE_WRITE_DENIED" }
```

**V� d? response `4004`:**
```json
{ "error": "Write denied: vehicle speed is 35 km/h", "code": 4004, "id": "SAFE_VEHICLE_MOVING" }
```

---

## HTTP Status Codes � Mapping

| HTTP | App Codes | Khi n�o |
|------|-----------|---------|
| `200 OK` | � / `2004` | GET th�nh c�ng; GPS no-fix (data v?n tr? v?) |
| `201 Created` | � | `POST /api/profile` t?o m?i th�nh c�ng |
| `202 Accepted` | � | Signal write queued th�nh c�ng |
| `204 No Content` | � | `DELETE /api/profile/{name}` x�a th�nh c�ng |
| `400 Bad Request` | `3001`, `3002` | JSON sai / thi?u field |
| `401 Unauthorized` | `4001` | API Key l?i |
| `403 Forbidden` | `4002`, `4004` | Signal read-only / xe dang ch?y |
| `404 Not Found` | `3004` | Resource kh�ng t?n t?i |
| `409 Conflict` | `3005` | T�n tr�ng / section_id mismatch |
| `422 Unprocessable` | `3003` | Value out of range |
| `500 Server Error` | `1000`, `4003` | L?i n?i b? / watchdog |
| `503 Unavailable` | `1001`, `1002`, `2001`, `2003` | DB locked / maintenance / hardware |
| `504 Gateway Timeout` | `2002` | ECU XCP timeout |

---

## Optimistic Locking � `section_id` (3005 / 409)

`section_id` l� s? nguy�n tang d?n, d�ng d? tr�nh race condition khi nhi?u client c�ng ghi.

```
1. Client  GET /api/profile          ?  { section_id: 5, ... }
2. Client  PUT /api/profile          ?  g?i k�m { section_id: 5, ... }
3a. OK     section_id = 5 tr�n server ?  200 OK, section_id tang th�nh 6
3b. FAIL   Client kh�c d� PUT tru?c  ?  409 { code: 3005, id: "VAL_CONFLICT",
                                             "error": "section_id mismatch: expected 6, got 5" }
4. X? l� 409: GET l?i d? l?y section_id m?i, r?i retry PUT
```

C�c endpoint c?n `section_id`: `PUT /api/profile`, `PUT /config`

---

## WebSocket Close Codes (`wss://�/ws/signals`)

| WS Code | T�n | Nguy�n nh�n |
|---------|-----|-------------|
| `1000` | Normal Closure | Server / client d�ng ch? d?ng (b�nh thu?ng) |
| `1001` | Going Away | Server dang restart / deploy |
| `1006` | Abnormal Closure | M?t m?ng d?t ng?t (kh�ng c� CLOSE frame) |
| `1008` | Policy Violation | X�c th?c th?t b?i (reserved) |
| `1011` | Internal Error | Server l?i trong khi stream (`1000` / `4003`) |

**Chi?n lu?c reconnect (exponential backoff):**

```js
let retryDelay = 1000;
function connect() {
  const ws = new WebSocket("wss://car-hmi-api-demo.onrender.com/ws/signals");
  ws.addEventListener("open",  () => { retryDelay = 1000; });
  ws.addEventListener("close", (e) => {
    if (e.code !== 1000) {
      setTimeout(() => { retryDelay = Math.min(retryDelay * 2, 30000); connect(); }, retryDelay);
    }
  });
}
```

---

## Signal Write � Lu?ng Debug

```
PUT /signals/SomeName  ?  404 / 3004  ?  Signal kh�ng c� trong signal.json
PUT /signals/SomeName  ?  403 / 4002  ?  TX: false (sensor, kh�ng ghi du?c)
PUT /signals/SomeName  ?  403 / 4004  ?  Xe dang ch?y, l?nh b? block
PUT /signals/SomeName  ?  422 / 3003  ?  Value ngo�i [min, max]
PUT /signals/SomeName  ?  202         ?  OK, d� queue g?i CAN

POST /signals/batch_update  ?  202  ?  K?t qu? t?ng signal trong "results":
    { name, value, status: "ok" | "not_writable" | "not_found" | "out_of_range" }
```

---

## V� D? Response �?y �?

### 201 � T?o profile th�nh c�ng
```json
{ "profile_name": "Driver_A", "signals": ["HB_FL_ActivationLevel", "BSW_FL_BuckleStatus"], "selected": false }
```

### 202 � Signal write accepted
```json
{ "signal_name": "HB_FL_ActivationLevel", "value": 3, "queued_at": 1717243200.123 }
```

### 202 � Batch write accepted
```json
{
  "status": "queued",
  "count": 3,
  "results": [
    { "name": "HB_FL_ActivationLevel", "value": 3, "status": "ok" },
    { "name": "BSW_FL_BuckleStatus",   "value": 1, "status": "not_writable" },
    { "name": "UnknownSignal",         "value": 0, "status": "not_found" }
  ]
}
```

### 400 � Thi?u tru?ng b?t bu?c
```json
{ "error": "Missing required field: profile_name", "code": 3002, "id": "VAL_MISSING_FIELD" }
```

### 403 � Signal read-only
```json
{ "error": "Signal BSW_FL_BuckleStatus is read-only (TX: false)", "code": 4002, "id": "SAFE_WRITE_DENIED" }
```

### 404 � Kh�ng t�m th?y
```json
{ "error": "Signal 'UnknownSignal' not found", "code": 3004, "id": "VAL_NOT_FOUND" }
```

### 409 � section_id mismatch
```json
{ "error": "section_id mismatch: expected 7, got 5", "code": 3005, "id": "VAL_CONFLICT" }
```

### 422 � Value out of range
```json
{ "error": "Value 10 is out of range [0, 7] for HB_FL_ActivationLevel", "code": 3003, "id": "VAL_OUT_OF_RANGE" }
```

### 503 � Hardware down
```json
{ "error": "SocketCAN interface vcan0 is down", "code": 2001, "id": "HW_CAN_ERROR" }
```
