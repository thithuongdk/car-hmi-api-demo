# CAN-HMI — API reference (tiếng Việt)

Đối chiếu trực tiếp route, OpenAPI và implementation hiện tại ngày 2026-09-17. Có **53 thao tác HTTP nghiệp vụ (47 + 6 alias hệ thống), 3 endpoint WebSocket**. Không thực hiện request thay đổi CAN/cấu hình/profile/reboot để tạo tài liệu.

## Cách sử dụng chung

Base URL ví dụ: `http://localhost:8000`. Dùng HTTPS/WSS nếu proxy triển khai TLS. REST body JSON dùng `Content-Type: application/json`; timestamp REST là Unix giây, signal frame WS là ISO8601 UTC. Tất cả response bên dưới là **ví dụ minh họa format**, không phải kết quả production đã xác minh.

```bash
BASE="http://localhost:8000"
API_KEY="YOUR_CONFIGURED_API_KEY"
PROFILE="admin"
CLIENT_ID="web-demo-01"
```

| Header | Ý nghĩa |
|---|---|
| `X-API-Key` | API key thực; các router signals/config/devmode/profile yêu cầu khi authentication bật. |
| `X-Profile-Name` | Chọn phạm vi profile. Bỏ qua thì resolve theo client/global. Ví dụ admin phải tồn tại. |
| `X-Client-Id` | Định danh client nhất quán; bắt buộc với heartbeat/offline và khóa Dev Mode. |
| `X-Dev-Mode: true` | Bypass kiểm tra profile ở các route có hỗ trợ; bắt buộc riêng cho điều khiển hệ thống. Không bypass API key. |

App hiện coi key placeholder `change-me-in-production`, `changeme`, `default` là auth disabled. Hai route retry/reboot vẫn yêu cầu key thực đã cấu hình; không thể dùng placeholder. API public: system GET, adaptive restraint, camera, video/restraints. Không có route nghiệp vụ GET `/health` hoặc `/ready` ở root: dùng `/system/health`, `/system/ready` hoặc alias `/api/health`, `/api/ready`.

Ví dụ mutation chỉ là hướng dẫn; chọn giá trị theo writable/states của DBC và quyền profile. Không cần X-Dev-Mode cho đọc/ghi signal thông thường khi profile có quyền.

## Danh sách đầy đủ HTTP

| Method | API | Chức năng (theo code) |
|---|---|---|
| GET | `/signals` | List latest signal values |
| GET | `/signals/available` | List all available signals with metadata |
| GET | `/signals/{signal_name}` | Get latest value for one signal |
| PUT | `/signals/{signal_name}` | Write value to signal (CAN write) |
| GET | `/signals/{signal_name}/history` | Query signal history from DB |
| POST | `/signals/batch_update` | Write multiple writable signals simultaneously (batch) |
| GET | `/config` | List all signal configurations |
| GET | `/config/signal/{signal_name}` | Get config for one signal |
| PATCH | `/config/signal/{signal_name}` | Update signal config |
| GET | `/config/processor` | Get processor config |
| POST | `/config/processor` | Update processor config |
| GET | `/config/system` | Get system config and field update policy |
| PATCH | `/config/system` | Patch system config without dropping unrelated fields |
| GET | `/config/system/backups` | List fixed-path system config backups |
| POST | `/config/system/backups` | Back up system config |
| POST | `/config/system/backups/{backup_id}/restore` | Restore a system config backup |
| POST | `/config/system/reset` | Reset system config from the fixed project template |
| POST | `/config/system/reload` | Re-apply live fields from the system config file |
| GET | `/config/general` | Get full application config |
| PATCH | `/config/general` | Patch application config (partial) |
| POST | `/config/general/reset` | Reset application config to defaults |
| GET | `/adaptive_restraint/available` | Get all available options for adaptive restraint filters |
| GET | `/adaptive_restraint/chart_info` | Get statistic and chart information for adaptive restraint systems |
| GET | `/system/info` | Get project & system information |
| GET | `/system/health` | Health check |
| GET | `/system/ready` | Readiness probe (for container/systemd) |
| GET | `/system/metrics` | CarPC resource information (CPU, RAM, disk, queue, heap…) |
| POST | `/system/can/retry` | Retry CAN connections |
| POST | `/system/reboot` | Reboot Car-HMI service |
| GET | `/api/restraints/match` | Find best-matching restraint video for crash conditions |
| GET | `/api/restraints/video/{filename}` | Stream a video file from the media directory |
| GET | `/api/camera/stream` | Proxy live MJPEG stream from the vehicle camera |
| GET | `/api/camera/status` | Camera stream proxy status |
| GET | `/api/devmode/catalog` | Dev Mode signal families and selectable states |
| GET | `/api/devmode/status` | Current Dev Mode seat locks |
| POST | `/api/devmode/seats/select` | Select seats for Dev Mode (locks other sections out) |
| POST | `/api/devmode/exit` | Leave Dev Mode and release all seat locks of this section |
| POST | `/api/devmode/signals` | Apply one signal family to several seats at once |
| GET | `/api/info` | Get project & system information |
| GET | `/api/health` | Health check |
| GET | `/api/ready` | Readiness probe (for container/systemd) |
| GET | `/api/metrics` | CarPC resource information (CPU, RAM, disk, queue, heap…) |
| POST | `/api/can/retry` | Retry CAN connections |
| POST | `/api/reboot` | Reboot Car-HMI service |
| GET | `/api/profiles` | List all profiles |
| GET | `/api/profile/sessions` | List client active-profile sessions |
| POST | `/api/profile/heartbeat` | Heartbeat for client profile session |
| POST | `/api/profile/offline` | Mark client profile session offline |
| GET | `/api/profile` | Get profile by name (or active profile) |
| POST | `/api/profile` | Create new profile |
| PUT | `/api/profile` | Update profile (optimistic lock) |
| PUT | `/api/profile/active` | Set active profile |
| DELETE | `/api/profile/{name}` | Delete profile |

## Format và ví dụ cho từng HTTP API

### `GET /signals`

List latest signal values

Auth: API key khi authentication bật. Profile cần read cho GET, write cho PUT/POST; full bao gồm read/write. X-Dev-Mode có thể bypass kiểm tra profile.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/signals" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `SignalListResponse`.

```json
{
  "items": [
    {
      "signal_name": "COM_Status_ElkCan",
      "std_name": "COM_Status_ElkCan",
      "value": 1.0,
      "unit": null,
      "timestamp": 1789600000.0
    }
  ],
  "total": 1,
  "warnings": []
}
```

### `GET /signals/available`

List all available signals with metadata

Auth: API key khi authentication bật. Profile cần read cho GET, write cho PUT/POST; full bao gồm read/write. X-Dev-Mode có thể bypass kiểm tra profile.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/signals/available" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `SignalMetadataListResponse`.

```json
{
  "signals_info": [
    {
      "signal_name": "COM_Status_ElkCan",
      "std_name": "COM_Status_ElkCan",
      "tag": null,
      "unit": null,
      "min_value": 0.0,
      "max_value": 0.0,
      "writable": false,
      "states": null,
      "group_name": "example",
      "widget_type": "example",
      "value": 1.0,
      "timestamp": 1789600000.0
    }
  ],
  "total": 1,
  "warnings": []
}
```

Lưu ý: Đọc writable, min_value, max_value, states ở đây trước khi chọn giá trị ghi. Metadata có thể vẫn được trả với value=null khi profile không có quyền đọc signal đó.

### `GET /signals/{signal_name}`

Get latest value for one signal

Auth: API key khi authentication bật. Profile cần read cho GET, write cho PUT/POST; full bao gồm read/write. X-Dev-Mode có thể bypass kiểm tra profile.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `signal_name` | path | string | Có |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/signals/COM_Status_ElkCan" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `SignalValueResponse`.

```json
{
  "signal_name": "COM_Status_ElkCan",
  "std_name": "COM_Status_ElkCan",
  "value": 1.0,
  "unit": null,
  "timestamp": 1789600000.0
}
```

### `PUT /signals/{signal_name}`

Write value to signal (CAN write)

Auth: API key khi authentication bật. Profile cần read cho GET, write cho PUT/POST; full bao gồm read/write. X-Dev-Mode có thể bypass kiểm tra profile.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `signal_name` | path | string | Có |  |

Body schema: `WriteSignalRequest` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "value": 0
}
```

Ví dụ:

```bash
curl -sS \
  -X PUT \
  "$BASE/signals/ABL_FL_RetractRequest" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"value":0}'
```

Response thành công: HTTP 202.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "signal_name": "ABL_FL_RetractRequest",
  "value": 0,
  "queued_at": 1789600000.0
}
```

### `GET /signals/{signal_name}/history`

Query signal history from DB

Auth: API key khi authentication bật. Profile cần read cho GET, write cho PUT/POST; full bao gồm read/write. X-Dev-Mode có thể bypass kiểm tra profile.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `signal_name` | path | string | Có |  |
| `start` | query | number / null | Không |  |
| `end` | query | number / null | Không |  |
| `limit` | query | integer | Không | default=100; minimum=1; maximum=10000 |
| `offset` | query | integer | Không | default=0; minimum=0 |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/signals/COM_Status_ElkCan/history?start=1789600000&end=1789603600&limit=100&offset=0" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `SignalListResponse`.

```json
{
  "items": [
    {
      "signal_name": "COM_Status_ElkCan",
      "std_name": "COM_Status_ElkCan",
      "value": 1.0,
      "unit": null,
      "timestamp": 1789600000.0
    }
  ],
  "total": 1,
  "warnings": []
}
```

### `POST /signals/batch_update`

Write multiple writable signals simultaneously (batch)

Auth: API key khi authentication bật. Profile cần read cho GET, write cho PUT/POST; full bao gồm read/write. X-Dev-Mode có thể bypass kiểm tra profile.

Query/path: không có tham số.

Body schema: `BatchSignalWrite` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "signals": [
    {
      "signal_name": "ABL_FL_RetractRequest",
      "value": 0
    },
    {
      "signal_name": "ABL_FR_RetractRequest",
      "value": 0
    }
  ]
}
```

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/signals/batch_update" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"signals":[{"signal_name":"ABL_FL_RetractRequest","value":0},{"signal_name":"ABL_FR_RetractRequest","value":0}]}'
```

Response thành công: HTTP 202.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "queued": [
    {
      "signal_name": "ABL_FL_RetractRequest",
      "value": 0
    },
    {
      "signal_name": "ABL_FR_RetractRequest",
      "value": 0
    }
  ],
  "count": 2,
  "queued_at": 1789600000.0,
  "errors": [],
  "warnings": []
}
```

Lưu ý: Có thể trả HTTP 202 dù gửi thành công một phần; kiểm tra cả errors và warnings. Nếu không signal nào gửi được: transport → 503; not_tx → 403; các lỗi còn lại → 404.

### `GET /config`

List all signal configurations

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/config" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `array<SignalConfigResponse>`.

```json
[
  {
    "signal_name": "COM_Status_ElkCan",
    "unit": null,
    "min_value": 0.0,
    "max_value": 0.0,
    "group_name": "example",
    "widget_type": "example",
    "writable": false
  }
]
```

Lưu ý: Hiện implementation lấy snapshot từ SignalStore; không phải danh sách bản ghi cấu hình đã lưu trong SQLite.

### `GET /config/signal/{signal_name}`

Get config for one signal

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `signal_name` | path | string | Có |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/config/signal/COM_Status_ElkCan" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `SignalConfigResponse`.

```json
{
  "signal_name": "COM_Status_ElkCan",
  "unit": null,
  "min_value": 0.0,
  "max_value": 0.0,
  "group_name": "example",
  "widget_type": "example",
  "writable": false
}
```

Lưu ý: PATCH lưu display metadata vào repository. GET hiện chỉ đọc tên/unit từ SignalStore và trả mặc định cho các field khác; chưa đọc lại toàn bộ bản ghi đã PATCH. writable ở đây là metadata, quyền TX thực tế vẫn do DBC quyết định.

### `PATCH /config/signal/{signal_name}`

Update signal config

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `signal_name` | path | string | Có |  |

Body schema: `UpdateSignalConfigRequest` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "unit": "",
  "min_value": 0,
  "max_value": 12,
  "widget_type": "slider",
  "writable": true
}
```

Ví dụ:

```bash
curl -sS \
  -X PATCH \
  "$BASE/config/signal/ABL_FL_RetractRequest" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"unit":"","min_value":0,"max_value":12,"widget_type":"slider","writable":true}'
```

Response thành công: HTTP 200.

Response schema: `SignalConfigResponse`.

```json
{
  "signal_name": "COM_Status_ElkCan",
  "unit": null,
  "min_value": 0.0,
  "max_value": 0.0,
  "group_name": "example",
  "widget_type": "example",
  "writable": false
}
```

Lưu ý: PATCH lưu display metadata vào repository. GET hiện chỉ đọc tên/unit từ SignalStore và trả mặc định cho các field khác; chưa đọc lại toàn bộ bản ghi đã PATCH. writable ở đây là metadata, quyền TX thực tế vẫn do DBC quyết định.

### `GET /config/processor`

Get processor config

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/config/processor" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `ProcessorConfigResponse`.

```json
{
  "max_queue_size": 10000,
  "queue_policy": "drop_oldest"
}
```

### `POST /config/processor`

Update processor config

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body schema: `UpdateProcessorConfigRequest` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "max_queue_size": 10000,
  "queue_policy": "drop_oldest"
}
```

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/config/processor" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"max_queue_size":10000,"queue_policy":"drop_oldest"}'
```

Response thành công: HTTP 200.

Response schema: `ProcessorConfigResponse`.

```json
{
  "max_queue_size": 10000,
  "queue_policy": "drop_oldest"
}
```

### `GET /config/system`

Get system config and field update policy

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/config/system" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "config": {
    "api": {
      "api_key": "********"
    },
    "reader": {
      "stale_threshold_sec": 30
    }
  },
  "fields_schema_version": 1,
  "reload_levels": {
    "live": "Applied immediately to runtime references.",
    "reboot": "Saved to disk; reboot Car-HMI to apply fully.",
    "immutable": "Cannot be changed through the API."
  },
  "fields": [],
  "paths": {
    "config": "config/system.json",
    "reset_template": "config/system_bk.json",
    "field_definitions": "config/system.fields.json",
    "backup_directory": "config/backups"
  },
  "pending_reboot_paths": [],
  "reboot_required": false
}
```

Lưu ý: Response chứa toàn bộ config và policy; ví dụ rút gọn dữ liệu bên trong config/fields. PATCH object merge đệ quy; array được thay toàn bộ. Muốn sửa can[0], gửi đầy đủ danh sách can cần giữ. can_db_file, channel_tracking_signals và camera/supervisor yêu cầu reboot; xem fields từ GET thay vì suy luận.

### `PATCH /config/system`

Patch system config without dropping unrelated fields

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body schema: `object` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "reader": {
    "stale_threshold_sec": 30
  }
}
```

Ví dụ:

```bash
curl -sS \
  -X PATCH \
  "$BASE/config/system" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"reader":{"stale_threshold_sec":30}}'
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "ok": true,
  "config": {
    "reader": {
      "stale_threshold_sec": 30
    }
  },
  "changed_paths": [
    "reader.stale_threshold_sec"
  ],
  "reload": {
    "live": [
      "reader.stale_threshold_sec"
    ],
    "reboot": [],
    "immutable": []
  },
  "runtime": {
    "applied": [
      "reader.stale_threshold_sec"
    ],
    "unavailable": []
  },
  "pending_reboot_paths": [],
  "reboot_required": false,
  "backup": {
    "id": "BACKUP_ID",
    "created_at": "2026-09-17T00:00:00+00:00",
    "size_bytes": 5000
  }
}
```

Lưu ý: Response chứa toàn bộ config và policy; ví dụ rút gọn dữ liệu bên trong config/fields. PATCH object merge đệ quy; array được thay toàn bộ. Muốn sửa can[0], gửi đầy đủ danh sách can cần giữ. can_db_file, channel_tracking_signals và camera/supervisor yêu cầu reboot; xem fields từ GET thay vì suy luận.

### `GET /config/system/backups`

List fixed-path system config backups

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/config/system/backups" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "backups": [
    {
      "id": "BACKUP_ID",
      "created_at": "2026-09-17T00:00:00+00:00",
      "size_bytes": 5000
    }
  ]
}
```

### `POST /config/system/backups`

Back up system config

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/config/system/backups" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 201.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "ok": true,
  "backup": {
    "id": "BACKUP_ID",
    "created_at": "2026-09-17T00:00:00+00:00",
    "size_bytes": 5000
  }
}
```

### `POST /config/system/backups/{backup_id}/restore`

Restore a system config backup

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `backup_id` | path | string | Có |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/config/system/backups/BACKUP_ID/restore" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "ok": true,
  "config": {
    "reader": {
      "stale_threshold_sec": 30
    }
  },
  "changed_paths": [
    "reader.stale_threshold_sec"
  ],
  "reload": {
    "live": [
      "reader.stale_threshold_sec"
    ],
    "reboot": [],
    "immutable": []
  },
  "runtime": {
    "applied": [
      "reader.stale_threshold_sec"
    ],
    "unavailable": []
  },
  "pending_reboot_paths": [],
  "reboot_required": false,
  "backup": {
    "id": "BACKUP_ID",
    "created_at": "2026-09-17T00:00:00+00:00",
    "size_bytes": 5000
  }
}
```

Lưu ý: Thay BACKUP_ID bằng id từ GET /config/system/backups. Response ví dụ dùng wrapper chung; diff và backup thực tế thay đổi theo bản phục hồi.

### `POST /config/system/reset`

Reset system config from the fixed project template

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/config/system/reset" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "ok": true,
  "config": {
    "reader": {
      "stale_threshold_sec": 30
    }
  },
  "changed_paths": [
    "reader.stale_threshold_sec"
  ],
  "reload": {
    "live": [
      "reader.stale_threshold_sec"
    ],
    "reboot": [],
    "immutable": []
  },
  "runtime": {
    "applied": [
      "reader.stale_threshold_sec"
    ],
    "unavailable": []
  },
  "pending_reboot_paths": [],
  "reboot_required": false,
  "backup": {
    "id": "BACKUP_ID",
    "created_at": "2026-09-17T00:00:00+00:00",
    "size_bytes": 5000
  }
}
```

Lưu ý: Reset từ config/system_bk.json; response ví dụ dùng wrapper chung, changed_paths và reload thực tế phụ thuộc diff.

### `POST /config/system/reload`

Re-apply live fields from the system config file

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/config/system/reload" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "ok": true,
  "config": {
    "reader": {
      "stale_threshold_sec": 30
    }
  },
  "changed_paths": [
    "reader.stale_threshold_sec"
  ],
  "reload": {
    "live": [
      "reader.stale_threshold_sec"
    ],
    "reboot": [],
    "immutable": []
  },
  "runtime": {
    "applied": [
      "reader.stale_threshold_sec"
    ],
    "unavailable": []
  },
  "pending_reboot_paths": [],
  "reboot_required": false,
  "backup": {
    "id": "BACKUP_ID",
    "created_at": "2026-09-17T00:00:00+00:00",
    "size_bytes": 5000
  }
}
```

Lưu ý: Áp dụng lại cấu hình live; không thay thế yêu cầu reboot cho các field reboot. backup là field tùy chọn; reload thường không có backup.

### `GET /config/general`

Get full application config

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/config/general" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "api": {
    "api_key": "********"
  },
  "reader": {
    "stale_threshold_sec": 30
  }
}
```

Lưu ý: Alias cũ: GET/PATCH trả trực tiếp config, không có wrapper ok/reload/runtime. Config ví dụ được rút gọn.

### `PATCH /config/general`

Patch application config (partial)

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body schema: `object` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "reader": {
    "stale_threshold_sec": 30
  }
}
```

Ví dụ:

```bash
curl -sS \
  -X PATCH \
  "$BASE/config/general" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"reader":{"stale_threshold_sec":30}}'
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "api": {
    "api_key": "********"
  },
  "reader": {
    "stale_threshold_sec": 30
  }
}
```

Lưu ý: Alias cũ: GET/PATCH trả trực tiếp config, không có wrapper ok/reload/runtime. Config ví dụ được rút gọn.

### `POST /config/general/reset`

Reset application config to defaults

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/config/general/reset" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "ok": true,
  "default": {
    "reader": {
      "stale_threshold_sec": 30
    }
  }
}
```

Lưu ý: Alias cũ: trả ok và default, không có wrapper reload/runtime. default ví dụ được rút gọn.

### `GET /adaptive_restraint/available`

Get all available options for adaptive restraint filters

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/adaptive_restraint/available"
```

Response thành công: HTTP 200.

Response schema: `map<string, array<any>>`.

```json
{
  "System": [
    "fusion",
    "camera",
    "non_adapt"
  ],
  "Age": [
    "35y",
    "65y"
  ],
  "Seatbelt": [],
  "Velocity": [],
  "Weight": [],
  "Height": [],
  "Distance": []
}
```

Lưu ý: System/Age cố định như ví dụ; các danh sách còn lại lấy từ dữ liệu thật. Danh sách rỗng trong ví dụ chỉ là minh họa, không phải kết quả đã gọi live.

### `GET /adaptive_restraint/chart_info`

Get statistic and chart information for adaptive restraint systems

Auth: Không có dependency API key trên route này.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `System` | query | array<string> | Không |  |
| `Age` | query | array<string> | Không |  |
| `Seatbelt` | query | array<string> | Không |  |
| `Velocity` | query | array<number> | Không |  |
| `Weight` | query | array<number> | Không |  |
| `Height` | query | array<number> | Không |  |
| `Distance` | query | array<number> | Không |  |
| `RawData` | query | boolean | Không | default=true |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/adaptive_restraint/chart_info?System=fusion&System=camera&Age=35y&RawData=false"
```

Response thành công: HTTP 200.

Response schema: `object`.

```json
{
  "controls": {
    "System": [
      "fusion",
      "camera"
    ],
    "Age": [
      "35y"
    ],
    "Seatbelt": [],
    "Velocity": [],
    "Weight": [],
    "Height": [],
    "Distance": [],
    "RawData": false
  },
  "datas": [
    {
      "injury_risk_fusion_35y": {
        "values": [],
        "max": 0,
        "min": 0,
        "upper fence": 0,
        "q3": 0,
        "median": 0,
        "q1": 0,
        "lower fence": 0
      }
    }
  ],
  "available_options": {
    "Velocity": [],
    "Weight": [],
    "Height": [],
    "Distance": [],
    "Seatbelt": []
  }
}
```

Lưu ý: Tên query phân biệt hoa/thường. Danh sách truyền bằng lặp query: System=fusion&System=camera. Bỏ một filter hoặc list rỗng → dùng tất cả lựa chọn của filter đó. RawData mặc định true; true thêm raw_rows tối đa 100 hàng, false bỏ raw_rows. Route không thực sự đọc JSON body GET dù docstring cũ đề cập. available_options là danh sách filter khả dụng; ví dụ rút gọn.

### `GET /system/info`

Get project & system information

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/system/info"
```

Response thành công: HTTP 200.

Response schema: `SystemInfoResponse`.

```json
{
  "name": "CAN-HMI Signal API",
  "version": "1.0.0",
  "description": "Real-time CAN bus signal monitoring and control API",
  "uptime_seconds": 0.0,
  "bus_connected": true,
  "db_connected": true,
  "signal_count": 0
}
```

### `GET /system/health`

Health check

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/system/health"
```

Response thành công: HTTP 200.

Response schema: `HealthResponse`.

```json
{
  "status": "degraded",
  "uptime_seconds": 0.0,
  "bus_connected": false,
  "db_connected": true
}
```

### `GET /system/ready`

Readiness probe (for container/systemd)

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/system/ready"
```

Response thành công: HTTP 200.

Response schema: `ReadinessResponse`.

```json
{
  "ready": false,
  "details": {
    "bus": false,
    "db": true,
    "readers_thread_alive": false,
    "readers_recent_frames": false,
    "readers_no_fatal_error": true
  }
}
```

### `GET /system/metrics`

CarPC resource information (CPU, RAM, disk, queue, heap…)

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/system/metrics"
```

Response thành công: HTTP 200.

Response schema: `SystemMetricsResponse`.

```json
{
  "timestamp": 1789600000.0,
  "cpu_percent": 0.0,
  "cpu_percent_per_core": [
    0.0
  ],
  "cpu_count_logical": 0,
  "cpu_count_physical": 0,
  "cpu_freq_current_mhz": 0.0,
  "cpu_freq_max_mhz": 0.0,
  "process_cpu_percent": 0.0,
  "process_memory_rss_mb": 0.0,
  "process_memory_vms_mb": 0.0,
  "process_memory_percent": 0.0,
  "process_threads": 0,
  "process_open_files": 0,
  "process_pid": 0,
  "ram_total_mb": 0.0,
  "ram_available_mb": 0.0,
  "ram_used_mb": 0.0,
  "ram_percent": 0.0,
  "swap_total_mb": 0.0,
  "swap_used_mb": 0.0,
  "swap_percent": 0.0,
  "disk_total_gb": 0.0,
  "disk_used_gb": 0.0,
  "disk_free_gb": 0.0,
  "disk_percent": 0.0,
  "net_bytes_sent": 0,
  "net_bytes_recv": 0,
  "net_packets_sent": 0,
  "net_packets_recv": 0,
  "queue_size": 0,
  "queue_maxsize": 0,
  "queue_usage_percent": 0.0,
  "heap_allocated_mb": 0.0,
  "gc_objects": 0,
  "asyncio_tasks": 0,
  "uptime_seconds": 0.0,
  "python_version": "3.x",
  "platform": "Linux"
}
```

### `POST /system/can/retry`

Retry CAN connections

Auth: API key thực + `X-Dev-Mode: true`.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/system/can/retry" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Dev-Mode: true"
```

Response thành công: HTTP 200.

Response schema: `object`.

```json
{
  "scheduled": [
    true
  ],
  "count": 1
}
```

### `POST /system/reboot`

Reboot Car-HMI service

Auth: API key thực + `X-Dev-Mode: true`.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/system/reboot" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Dev-Mode: true"
```

Response thành công: HTTP 202.

Response schema: `object`.

```json
{
  "status": "reboot_scheduled"
}
```

### `GET /api/restraints/match`

Find best-matching restraint video for crash conditions

Auth: Không có dependency API key trên route này.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `weight` | query | number | Có |  |
| `height` | query | number | Có |  |
| `crash_severity` | query | integer | Có |  |
| `seatbelt_system` | query | string | Có |  |
| `seat` | query | string | Không | default="fl" |
| `seat_x_mm` | query | number / null | Không |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/restraints/match?weight=75&height=175&crash_severity=40&seatbelt_system=SLL&seat=fl&seat_x_mm=100"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "matched": false,
  "video": null,
  "score": 0,
  "context": {
    "weight_kg": 75,
    "height_cm": 175,
    "derived_percentile": 50,
    "effective_percentile": 50,
    "can_percentile": null,
    "target_velocity_kmh": 40,
    "seatbelt_system": "SLL",
    "seat": "fl",
    "seat_x_mm": 100,
    "seat_x_source": "hmi_param",
    "seat_position_zone": "mid",
    "out_of_position": false,
    "candidates_found": 0
  }
}
```

Lưu ý: crash_severity ∈ 35/40/50/56; seatbelt_system SLL/CLL/MSLL; seat fl/fr. seat_x_mm tùy chọn, ưu tiên query > live CAN > fallback. Occupant classification live CAN ưu tiên hơn percentile suy ra từ weight. Khi matched=true, video có filename, percentile, seat_position, velocity_kmh, seatbelt, url.

### `GET /api/restraints/video/{filename}`

Stream a video file from the media directory

Auth: Không có dependency API key trên route này.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `filename` | path | string | Có |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/restraints/video/VIDEO.mp4" \
  --output video.mp4
```

Response thành công: HTTP 200.

Format: binary video, media_type video/mp4; không phải JSON.

Lưu ý: Trả FileResponse với media_type video/mp4, không phải JSON dù OpenAPI hiện ghi application/json. Thay VIDEO.mp4 bằng filename/url từ API match.

### `GET /api/camera/stream`

Proxy live MJPEG stream from the vehicle camera

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/camera/stream" \
  --output camera.mjpeg
```

Response thành công: HTTP 200.

Format: MJPEG binary multipart/x-mixed-replace, không phải JSON.

Lưu ý: Trả MJPEG multipart/x-mixed-replace với boundary lấy từ upstream, không phải JSON dù OpenAPI hiện ghi application/json. Chỉ kết nối upstream khi có người xem; không polling request theo frame.

### `GET /api/camera/status`

Camera stream proxy status

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/camera/status"
```

Response thành công: HTTP 200.

Response schema: `CameraStatusResponse`.

```json
{
  "enabled": true,
  "stream_url": "http://192.168.2.119:8080/stream",
  "connected": true,
  "viewer_count": 0,
  "last_error": "example"
}
```

### `GET /api/devmode/catalog`

Dev Mode signal families and selectable states

Auth: API key khi authentication bật. Route không bắt buộc X-Dev-Mode hoặc kiểm tra profile; các thao tác khóa/status cần X-Client-Id.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/devmode/catalog" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "seats": [
    "fl",
    "fr",
    "rl1",
    "rl2",
    "rr1"
  ],
  "families": [
    {
      "signal_name": "ABL_RetractRequest",
      "kind": "state",
      "states": [
        {
          "value": 0,
          "description": "Off"
        }
      ],
      "signals": [
        "ABL_FL_RetractRequest"
      ]
    }
  ],
  "block_timeout_sec": 60,
  "status_stale_timeout_sec": 30
}
```

Lưu ý: Ví dụ rút gọn danh sách families/signals/states. Families hiện có ACR_RetractRequest, ABL_RetractRequest, ISB_Color, HB_Request; lấy catalog để hiển thị states.

### `GET /api/devmode/status`

Current Dev Mode seat locks

Auth: API key khi authentication bật. Route không bắt buộc X-Dev-Mode hoặc kiểm tra profile; các thao tác khóa/status cần X-Client-Id.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/devmode/status" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "seats": {
    "fl": {
      "selected": false,
      "owned": false,
      "connected": false,
      "expires_at": null,
      "remaining_sec": 0.0
    }
  },
  "expires_at": null
}
```

Lưu ý: seats thực tế chứa đầy đủ fl, fr, rl1, rl2, rr1; ví dụ chỉ hiển thị fl.

### `POST /api/devmode/seats/select`

Select seats for Dev Mode (locks other sections out)

Auth: API key khi authentication bật. Route không bắt buộc X-Dev-Mode hoặc kiểm tra profile; các thao tác khóa/status cần X-Client-Id.

Query/path: không có tham số.

Body schema: `DevModeSeatSelectRequest` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "seats": {
    "fl": true,
    "fr": false
  },
  "block_timeout_sec": 60
}
```

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/devmode/seats/select" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"seats":{"fl":true,"fr":false},"block_timeout_sec":60}'
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "applied": {
    "fl": {
      "selected": true,
      "applied_at": "2026-09-17T00:00:00Z"
    },
    "fr": {
      "selected": false,
      "applied_at": "2026-09-17T00:00:00Z"
    }
  },
  "expires_at": "2026-09-17T00:01:00Z"
}
```

Lưu ý: seats là map seat→boolean. block_timeout_sec tùy chọn, 1–3600 giây, mặc định từ devmode.block_timeout_sec. Khóa thuộc X-Client-Id; ECU offline hoặc khóa của client khác có thể làm thao tác thất bại.

### `POST /api/devmode/exit`

Leave Dev Mode and release all seat locks of this section

Auth: API key khi authentication bật. Route không bắt buộc X-Dev-Mode hoặc kiểm tra profile; các thao tác khóa/status cần X-Client-Id.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/devmode/exit" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "released": [
    "fl"
  ],
  "released_at": "2026-09-17T00:00:00Z"
}
```

### `POST /api/devmode/signals`

Apply one signal family to several seats at once

Auth: API key khi authentication bật. Route không bắt buộc X-Dev-Mode hoặc kiểm tra profile; các thao tác khóa/status cần X-Client-Id.

Query/path: không có tham số.

Body schema: `DevModeSignalRequest` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "signal_name": "ABL_RetractRequest",
  "value": 0,
  "seats": {
    "fl": true
  },
  "block_timeout_sec": 60
}
```

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/devmode/signals" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"signal_name":"ABL_RetractRequest","value":0,"seats":{"fl":true},"block_timeout_sec":60}'
```

Response thành công: HTTP 200.

Response format bổ sung từ implementation (OpenAPI chưa khai báo chi tiết).

```json
{
  "applied": {
    "fl": {
      "signal_name": "ABL_RetractRequest",
      "value": 0,
      "signals": {
        "ABL_FL_RetractRequest": 0
      },
      "applied_at": "2026-09-17T00:00:00Z"
    }
  },
  "expires_at": "2026-09-17T00:01:00Z"
}
```

Lưu ý: seats: fl/fr/rl1/rl2/rr1. block_timeout_sec tùy chọn, 1–3600 giây. ISB_Color dùng số RGB 0x000000–0xFFFFFF (gửi số thập phân trong JSON). Implementation hiện chỉ validate range riêng cho màu; các states hiển thị trong catalog không phải tất cả đều được kiểm tra range ở route.

### `GET /api/info`

Get project & system information

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/info"
```

Response thành công: HTTP 200.

Response schema: `SystemInfoResponse`.

```json
{
  "name": "CAN-HMI Signal API",
  "version": "1.0.0",
  "description": "Real-time CAN bus signal monitoring and control API",
  "uptime_seconds": 0.0,
  "bus_connected": true,
  "db_connected": true,
  "signal_count": 0
}
```

### `GET /api/health`

Health check

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/health"
```

Response thành công: HTTP 200.

Response schema: `HealthResponse`.

```json
{
  "status": "degraded",
  "uptime_seconds": 0.0,
  "bus_connected": false,
  "db_connected": true
}
```

### `GET /api/ready`

Readiness probe (for container/systemd)

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/ready"
```

Response thành công: HTTP 200.

Response schema: `ReadinessResponse`.

```json
{
  "ready": false,
  "details": {
    "bus": false,
    "db": true,
    "readers_thread_alive": false,
    "readers_recent_frames": false,
    "readers_no_fatal_error": true
  }
}
```

### `GET /api/metrics`

CarPC resource information (CPU, RAM, disk, queue, heap…)

Auth: Không có dependency API key trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/metrics"
```

Response thành công: HTTP 200.

Response schema: `SystemMetricsResponse`.

```json
{
  "timestamp": 1789600000.0,
  "cpu_percent": 0.0,
  "cpu_percent_per_core": [
    0.0
  ],
  "cpu_count_logical": 0,
  "cpu_count_physical": 0,
  "cpu_freq_current_mhz": 0.0,
  "cpu_freq_max_mhz": 0.0,
  "process_cpu_percent": 0.0,
  "process_memory_rss_mb": 0.0,
  "process_memory_vms_mb": 0.0,
  "process_memory_percent": 0.0,
  "process_threads": 0,
  "process_open_files": 0,
  "process_pid": 0,
  "ram_total_mb": 0.0,
  "ram_available_mb": 0.0,
  "ram_used_mb": 0.0,
  "ram_percent": 0.0,
  "swap_total_mb": 0.0,
  "swap_used_mb": 0.0,
  "swap_percent": 0.0,
  "disk_total_gb": 0.0,
  "disk_used_gb": 0.0,
  "disk_free_gb": 0.0,
  "disk_percent": 0.0,
  "net_bytes_sent": 0,
  "net_bytes_recv": 0,
  "net_packets_sent": 0,
  "net_packets_recv": 0,
  "queue_size": 0,
  "queue_maxsize": 0,
  "queue_usage_percent": 0.0,
  "heap_allocated_mb": 0.0,
  "gc_objects": 0,
  "asyncio_tasks": 0,
  "uptime_seconds": 0.0,
  "python_version": "3.x",
  "platform": "Linux"
}
```

### `POST /api/can/retry`

Retry CAN connections

Auth: API key thực + `X-Dev-Mode: true`.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/can/retry" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Dev-Mode: true"
```

Response thành công: HTTP 200.

Response schema: `object`.

```json
{
  "scheduled": [
    true
  ],
  "count": 1
}
```

### `POST /api/reboot`

Reboot Car-HMI service

Auth: API key thực + `X-Dev-Mode: true`.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/reboot" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Dev-Mode: true"
```

Response thành công: HTTP 202.

Response schema: `object`.

```json
{
  "status": "reboot_scheduled"
}
```

### `GET /api/profiles`

List all profiles

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/profiles" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `ProfilesResponse`.

```json
{
  "profiles": [
    {
      "name": "demo",
      "signals": [
        {
          "name": "demo",
          "permission": [
            "read"
          ]
        }
      ],
      "exinfo": {},
      "description": "example",
      "section_id": "012345abcdef"
    }
  ],
  "total": 1,
  "active": "demo",
  "global_active": "demo",
  "client_id": "web-demo-01"
}
```

### `GET /api/profile/sessions`

List client active-profile sessions

Auth: API key khi authentication bật. Profile cần read hoặc X-Dev-Mode.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/profile/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `ProfileSessionsResponse`.

```json
{
  "sessions": [
    {
      "client_id": "web-demo-01",
      "active": "demo",
      "updated_at": 0.0,
      "last_seen": 0.0,
      "status": "ok"
    }
  ],
  "total": 1,
  "online_total": 0,
  "offline_total": 0,
  "by_profile": [
    {
      "profile_name": "example",
      "total": 1,
      "online": 0,
      "offline": 0
    }
  ],
  "global_active": "demo",
  "ttl_seconds": 600,
  "server_time": 0.0
}
```

### `POST /api/profile/heartbeat`

Heartbeat for client profile session

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/profile/heartbeat" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `ProfileHeartbeatResponse`.

```json
{
  "client_id": "web-demo-01",
  "active": "demo",
  "last_seen": 0.0,
  "ttl_seconds": 600
}
```

### `POST /api/profile/offline`

Mark client profile session offline

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

Query/path: không có tham số.

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/profile/offline" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `ProfileHeartbeatResponse`.

```json
{
  "client_id": "web-demo-01",
  "active": "demo",
  "last_seen": 0.0,
  "ttl_seconds": 600
}
```

Lưu ý: Đánh dấu offline và giải phóng khóa Dev Mode của X-Client-Id.

### `GET /api/profile`

Get profile by name (or active profile)

Auth: API key khi authentication bật. Không có kiểm tra quyền profile bổ sung trên route này.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `name` | query | string / null | Không |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  "$BASE/api/profile?name=demo" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 200.

Response schema: `ProfileResponse`.

```json
{
  "name": "demo",
  "signals": [
    {
      "name": "demo",
      "permission": [
        "read"
      ]
    }
  ],
  "exinfo": {},
  "description": "example",
  "section_id": "012345abcdef"
}
```

Lưu ý: POST: signals/exinfo có thể bỏ qua. PUT: name, signals, section_id bắt buộc; section_id phải lấy từ GET mới nhất và có 12 ký tự. 012345abcdef chỉ minh họa, không dùng như token thật. signals được thay toàn bộ. Bỏ exinfo để giữ hiện tại; description bỏ qua/null hiện được gán null bởi implementation.

### `POST /api/profile`

Create new profile

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode; tạo profile đầu tiên cho phép bootstrap khi chưa có profile.

Query/path: không có tham số.

Body schema: `ProfileCreate` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "name": "demo",
  "signals": [
    {
      "name": "COM_Status_ElkCan",
      "permission": [
        "read"
      ]
    },
    {
      "name": "ABL_FL_RetractRequest",
      "permission": [
        "read",
        "write"
      ]
    }
  ],
  "exinfo": {
    "label": "Demo"
  },
  "description": "Demo profile"
}
```

Ví dụ:

```bash
curl -sS \
  -X POST \
  "$BASE/api/profile?name=demo" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"name":"demo","signals":[{"name":"COM_Status_ElkCan","permission":["read"]},{"name":"ABL_FL_RetractRequest","permission":["read","write"]}],"exinfo":{"label":"Demo"},"description":"Demo profile"}'
```

Response thành công: HTTP 201.

Response schema: `ProfileResponse`.

```json
{
  "name": "demo",
  "signals": [
    {
      "name": "demo",
      "permission": [
        "read"
      ]
    }
  ],
  "exinfo": {},
  "description": "example",
  "section_id": "012345abcdef"
}
```

Lưu ý: POST: signals/exinfo có thể bỏ qua. PUT: name, signals, section_id bắt buộc; section_id phải lấy từ GET mới nhất và có 12 ký tự. 012345abcdef chỉ minh họa, không dùng như token thật. signals được thay toàn bộ. Bỏ exinfo để giữ hiện tại; description bỏ qua/null hiện được gán null bởi implementation.

### `PUT /api/profile`

Update profile (optimistic lock)

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode; tạo profile đầu tiên cho phép bootstrap khi chưa có profile.

Query/path: không có tham số.

Body schema: `ProfileUpdate` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "name": "demo",
  "signals": [
    {
      "name": "COM_Status_ElkCan",
      "permission": [
        "read"
      ]
    }
  ],
  "section_id": "012345abcdef",
  "exinfo": {},
  "description": "Demo profile"
}
```

Ví dụ:

```bash
curl -sS \
  -X PUT \
  "$BASE/api/profile?name=demo" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"name":"demo","signals":[{"name":"COM_Status_ElkCan","permission":["read"]}],"section_id":"012345abcdef","exinfo":{},"description":"Demo profile"}'
```

Response thành công: HTTP 200.

Response schema: `ProfileResponse`.

```json
{
  "name": "demo",
  "signals": [
    {
      "name": "demo",
      "permission": [
        "read"
      ]
    }
  ],
  "exinfo": {},
  "description": "example",
  "section_id": "012345abcdef"
}
```

Lưu ý: POST: signals/exinfo có thể bỏ qua. PUT: name, signals, section_id bắt buộc; section_id phải lấy từ GET mới nhất và có 12 ký tự. 012345abcdef chỉ minh họa, không dùng như token thật. signals được thay toàn bộ. Bỏ exinfo để giữ hiện tại; description bỏ qua/null hiện được gán null bởi implementation.

### `PUT /api/profile/active`

Set active profile

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode; tạo profile đầu tiên cho phép bootstrap khi chưa có profile.

Query/path: không có tham số.

Body schema: `ProfileSetActiveRequest` (bảng field đầy đủ ở cuối tài liệu).

```json
{
  "name": "demo"
}
```

Ví dụ:

```bash
curl -sS \
  -X PUT \
  "$BASE/api/profile/active" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"name":"demo"}'
```

Response thành công: HTTP 200.

Response schema: `ActiveProfileResponse`.

```json
{
  "active": "demo",
  "global_active": "demo",
  "client_id": "web-demo-01",
  "warnings": []
}
```

Lưu ý: Có X-Client-Id: đổi profile của client đó. Không có: đổi active global. Tên demo phải tồn tại trước khi gọi.

### `DELETE /api/profile/{name}`

Delete profile

Auth: API key khi authentication bật. Profile cần full hoặc X-Dev-Mode; tạo profile đầu tiên cho phép bootstrap khi chưa có profile.

| Tham số | Vị trí | Kiểu | Bắt buộc | Default/giới hạn |
|---|---|---|---|---|
| `name` | path | string | Có |  |

Body: không có.

Ví dụ:

```bash
curl -sS \
  -X DELETE \
  "$BASE/api/profile/demo" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Profile-Name: $PROFILE" \
  -H "X-Client-Id: $CLIENT_ID"
```

Response thành công: HTTP 204.

Không có body (204).

## WebSocket — 3 endpoint

| URL | Format |
|---|---|
| `/ws/signals?api_key=...&profile_name=admin` | Subscribe/unsubscribe/ping. Endpoint chính. |
| `/ws/subscribe?api_key=...&profile_name=admin` | Alias của /ws/signals. |
| `/ws/all?api_key=...` | Legacy tự nhận signal frames; không xử lý lệnh subscribe/ping như hai endpoint trên. |

API key truyền trong query và được kiểm tra trước accept; sai key gọi close code 4401 (client có thể chỉ nhận handshake failure). profile_name tùy chọn, nếu bỏ qua dùng resolve profile/global. Các endpoint WS không nhận X-Client-Id từ browser WebSocket như REST.

```javascript
const apiKey = "YOUR_CONFIGURED_API_KEY";
const profile = "admin";
const socket = new WebSocket(
  `ws://localhost:8000/ws/signals?api_key=${encodeURIComponent(apiKey)}&profile_name=${encodeURIComponent(profile)}`
);
socket.onopen = () => socket.send(JSON.stringify({
  type: "subscribe",
  signals: ["COM_Status_ElkCan", "metrics"],
  rate_ms: 200,
  mode: "continuous"
}));
socket.onmessage = event => console.log(JSON.parse(event.data));
// Sau khi kết nối: socket.send(JSON.stringify({type:"ping"}));
// socket.send(JSON.stringify({type:"unsubscribe",signals:["COM_Status_ElkCan"]}));
```

| Field client→server | Kiểu / format |
|---|---|
| `type` | subscribe / unsubscribe / ping |
| `signals` | array tên signal, `"*"`, hoặc `"metrics"`; implementation cũng chấp nhận string `"*"` |
| `mode` | continuous (mặc định) / once; once không tự trả snapshot ngay, chờ broadcast phù hợp rồi dừng signal/channel đó |
| `rate_ms` | số ms >= 0, khoảng gửi tối thiểu cho connection; field này được xử lý trong code dù chưa có trong model SubscribeRequest |
| Legacy | `{ "action": "subscribe", "channels": ["COM_Status_ElkCan"], "mode": "continuous" }` |

ACK thực tế (không phải type=subscribed như docstring cũ):

```json
{
  "type": "subscribe_ack",
  "action": "subscribe",
  "channels": [
    "COM_Status_ElkCan",
    "metrics"
  ],
  "count": 2,
  "warnings": []
}
```

Unsubscribe ACK:

```json
{
  "type": "unsubscribe_ack",
  "action": "unsubscribe",
  "channels": [
    "COM_Status_ElkCan"
  ],
  "count": 1,
  "warnings": []
}
```

Signal frame:

```json
{
  "timestamp": "2026-09-17T00:00:00.123Z",
  "signals": [
    {
      "name": "COM_Status_ElkCan",
      "std_name": "COM_Status_ElkCan",
      "value": 1.0
    }
  ]
}
```

Metrics: `{ "type": "metrics", ... }` với fields của SystemMetricsResponse. Ping trả `{ "type": "pong" }`. JSON sai trả `{ "type": "error", "message": "Invalid JSON" }`. ACK có thể chứa warnings về quyền/phạm vi profile. Signal frames chỉ gồm tín hiệu được subscription chấp nhận.

## Lỗi chung

HTTP error thường có `{ "detail": "message" }`, hoặc `{ "detail": { "code": "...", "message": "...", "signals": [] } }`. Validation request dùng HTTP 422 với detail là array chứa loc/msg/type. warnings/errors trong HTTP 200/202 không đồng nghĩa thành công toàn bộ; cần kiểm tra count/queued/applied. /health và /ready hiện vẫn HTTP 200 khi degraded/ready=false; kiểm tra JSON body.

## Schema đầy đủ của request/response models

Bảng này lấy từ OpenAPI sinh bởi app. Nullable ghi `null`; dấu bắt buộc nghĩa là field required trong JSON schema. Các object như config/system và một số response custom chưa có typed schema được mô tả tại từng API ở trên.

### AccessWarning

Access/profile warning information for a profile-scoped operation.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `code` | string | Có |  | Warning or access error code |
| `message` | string | Có |  | Short description for the frontend |
| `profile_name` | string / null | Không |  | Profile name currently in effect |
| `required_permission` | string / null | Không |  | Permission required for the operation |
| `signal_name` | string / null | Không |  | Affected signal name if this is a single-signal warning |
| `signals` | array<string> | Không |  | List of signals skipped in the batch |

### ActiveProfileResponse

Active profile change result.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `active` | string | Có |  | Active profile name after the update |
| `global_active` | string / null | Không |  | Globally active profile name |
| `client_id` | string / null | Không |  | Client ID if updated for a client session |
| `warnings` | array<AccessWarning> | Không |  | Warnings if the state did not change |

### BatchSignalWrite

Request to write multiple CAN signals at once — POST /signals/batch_update.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signals` | array<BatchSignalWriteItem> | Có |  | List of signals to be written |

### BatchSignalWriteItem

One signal in a batch write request.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signal_name` | string | Có |  | Signal name |
| `value` | number | Có |  | Value to write |

### CameraStatusResponse

Status of the MJPEG camera stream proxy.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `enabled` | boolean | Có |  | Whether the camera stream is enabled in config |
| `stream_url` | string | Có |  | MJPEG source URL proxied by CarPC |
| `connected` | boolean | Có |  | Whether CarPC is currently able to connect to the camera |
| `viewer_count` | integer | Có |  | Number of clients currently viewing the stream through CarPC |
| `last_error` | string / null | Không |  | Most recent upstream error, if any |

### ClientProfileSession

Current profile session for a client.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `client_id` | string | Có |  | Client ID from the X-Client-Id header |
| `active` | string | Có |  | Active profile name for this client |
| `updated_at` | number | Có |  | Unix timestamp of the latest update |
| `last_seen` | number | Có |  | Unix timestamp of the latest heartbeat |
| `status` | enum ["online", "offline"] | Có | enum=["online", "offline"] | Online/offline status based on TTL |

### DevModeSeatSelectRequest

Select/deselect seats in Dev Mode — POST /api/devmode/seats/select.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `seats` | map<string, boolean> | Có |  | Map seat_id → selected (fl, fr, rl1, rl2, rr1) |
| `block_timeout_sec` | number / null | Không | minimum=1.0; maximum=3600.0 | How long other sections stay blocked from writing the seat (seconds); defaults to 60 |

### DevModeSignalRequest

Apply one signal family to several seats at once — POST /api/devmode/signals.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signal_name` | string | Có |  | Signal family: ACR_RetractRequest \| ABL_RetractRequest \| ISB_Color \| HB_Request |
| `value` | number | Có |  | Value applied to every selected seat |
| `seats` | map<string, boolean> | Có |  | Map seat_id → whether the value is applied |
| `block_timeout_sec` | number / null | Không | minimum=1.0; maximum=3600.0 | Seat lock renewal duration (seconds); defaults to 60 |

### HTTPValidationError



| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `detail` | array<ValidationError> | Không |  |  |

### HealthResponse

Overall system health status.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `status` | string | Có |  | Overall status: 'ok', 'degraded', or 'error' |
| `uptime_seconds` | number | Có |  | Number of seconds the system has been running continuously |
| `bus_connected` | boolean | Có |  | True if the CAN bus connection is active |
| `db_connected` | boolean | Có |  | True if the database connection is active |

### ProcessorConfigResponse

Current processor pipeline configuration.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `max_queue_size` | integer | Có |  | Maximum signal queue size |
| `queue_policy` | string | Có |  | Policy when the queue is full: 'drop_oldest' or 'reject' |

### ProfileCreate

Request to create a new profile — POST /api/profile.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `name` | string | Có |  | Profile name (unique) |
| `signals` | array<ProfileSignal> | Không |  | List of signals and per-signal permissions |
| `exinfo` | object | Không |  | Arbitrary data for the frontend |
| `description` | string / null | Không |  | Short profile description |

### ProfileHeartbeatResponse

Client session heartbeat update result.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `client_id` | string | Có |  | Client ID whose heartbeat was updated |
| `active` | string / null | Không |  | Active profile for the client, or the global fallback |
| `last_seen` | number | Có |  | Unix timestamp of the latest heartbeat |
| `ttl_seconds` | integer | Có |  | Current session TTL |

### ProfileResponse

Profile information.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `name` | string | Có |  | Profile name |
| `signals` | array<ProfileSignal> | Có |  | List of signals and per-signal permissions |
| `exinfo` | object | Không |  | Arbitrary data for the frontend |
| `description` | string / null | Không |  | Description |
| `section_id` | string | Có |  | Hash used for optimistic locking |

### ProfileSessionProfileStat

Session counts by active profile.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `profile_name` | string | Có |  | Profile name currently active for the session |
| `total` | integer | Có |  | Total sessions currently using this active profile |
| `online` | integer | Có |  | Number of online sessions for this profile |
| `offline` | integer | Có |  | Number of offline sessions for this profile |

### ProfileSessionsResponse

List of active-profile sessions by client.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `sessions` | array<ClientProfileSession> | Không |  | List mapping client -> active profile |
| `total` | integer | Có |  | Total client sessions |
| `online_total` | integer | Không | default=0 | Total online sessions |
| `offline_total` | integer | Không | default=0 | Total offline sessions |
| `by_profile` | array<ProfileSessionProfileStat> | Không |  | Statistics for active sessions by profile |
| `global_active` | string / null | Không |  | Default active profile at the global level |
| `ttl_seconds` | integer | Có |  | TTL used to determine online/offline status |
| `server_time` | number | Có |  | Current Unix timestamp on the server |

### ProfileSetActiveRequest

Request to change the active profile on the server.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `name` | string | Có |  | Profile name to become active |

### ProfileSignal

Signal scope in a profile with signal-specific permissions.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `name` | string | Có |  | Signal name |
| `permission` | array<enum ["read", "write", "full"]> | Không |  | Permissions for the signal: read, write, full |

### ProfileUpdate

Request to update a profile (optimistic lock) — PUT /api/profile.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `name` | string | Có |  | Profile name to update |
| `signals` | array<ProfileSignal> | Có |  | List of signals and per-signal permissions |
| `exinfo` | object / null | Không |  | Arbitrary data for the frontend (leave empty to keep unchanged) |
| `description` | string / null | Không |  | Short description |
| `section_id` | string | Có |  | Current section_id (from GET /api/profile). Used to prevent concurrent overwrites — 409 on mismatch. |

### ProfilesResponse

List of all profiles.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `profiles` | array<ProfileResponse> | Có |  |  |
| `total` | integer | Có |  |  |
| `active` | string / null | Không |  | Currently active profile name |
| `global_active` | string / null | Không |  | Globally active profile name |
| `client_id` | string / null | Không |  | Client ID if the request includes X-Client-Id |

### ReadinessResponse

Readiness status for processing incoming requests.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `ready` | boolean | Có |  | True if the application is ready to accept requests |
| `details` | map<string, boolean> | Có |  | Status of each component (key: component name, value: ready or not) |

### SignalConfigResponse

Display configuration and metadata for a signal.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signal_name` | string | Có |  | Signal identifier |
| `unit` | string / null | Không |  | Measurement unit |
| `min_value` | number / null | Không |  | Minimum valid value |
| `max_value` | number / null | Không |  | Maximum valid value |
| `group_name` | string / null | Không |  | Functional grouping |
| `widget_type` | string / null | Không |  | Frontend widget type |
| `writable` | boolean | Không | default=false | Whether the signal is writable |

### SignalListResponse

List of signal values returned by the API.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `items` | array<SignalValueResponse> | Có |  | List of signals |
| `total` | integer | Có |  | Total number of signals in the list |
| `warnings` | array<AccessWarning> | Không |  | Access warnings, if any |

### SignalMetadata

Full metadata for one signal — returned by GET /signals/available.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signal_name` | string | Có |  | Unique signal identifier |
| `std_name` | string / null | Không |  | Standard signal name; currently identical to signal_name |
| `tag` | array<string> / null | Không |  | Tags inferred from the signal name or DBC configuration |
| `unit` | string / null | Không |  | Measurement unit |
| `min_value` | number / null | Không |  | Minimum valid value |
| `max_value` | number / null | Không |  | Maximum valid value |
| `writable` | boolean | Không | default=false | Whether the signal can be written via the API |
| `states` | array<object> / null | Không |  | List of enum states [{value, description}], or None for continuous numeric signals |
| `group_name` | string / null | Không |  | Functional group (for example: engine, body) |
| `widget_type` | string / null | Không |  | Frontend widget type |
| `value` | number / null | Không |  | Current value (snapshot, optional) |
| `timestamp` | number / null | Không |  | Unix timestamp of the latest read |

### SignalMetadataListResponse

List of signal metadata.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signals_info` | array<SignalMetadata> | Có |  | List of signal metadata |
| `total` | integer | Có |  | Total number of signals |
| `warnings` | array<AccessWarning> | Không |  | Access warnings, if any |

### SignalValueResponse

Current value of a CAN signal.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `signal_name` | string | Có |  | Unique signal identifier |
| `std_name` | string / null | Không |  | Standard signal name; currently identical to signal_name |
| `value` | number | Có |  | Decoded real value |
| `unit` | string / null | Không |  | Measurement unit (for example: km/h, °C) |
| `timestamp` | number | Có |  | Unix timestamp (seconds) when the value was read |

### SystemInfoResponse

Project overview and system status — GET /api/info.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `name` | string | Có |  | Application name |
| `version` | string | Có |  | API version |
| `description` | string | Có |  | Description |
| `uptime_seconds` | number | Có |  | Uptime (seconds) |
| `bus_connected` | boolean | Có |  | Whether the CAN bus is connected |
| `db_connected` | boolean | Có |  | Whether the database is connected |
| `signal_count` | integer | Có |  | Number of signals currently in the store |

### SystemMetricsResponse

System resource and application process information (CarPC metrics).

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `timestamp` | number | Có |  | Unix timestamp when metrics were collected |
| `cpu_percent` | number | Có |  | Overall CPU usage (%) |
| `cpu_percent_per_core` | array<number> | Có |  | Per-core CPU usage (%) |
| `cpu_count_logical` | integer | Có |  | Logical CPU core count |
| `cpu_count_physical` | integer | Có |  | Physical CPU core count |
| `cpu_freq_current_mhz` | number | Có |  | Current CPU frequency (MHz) |
| `cpu_freq_max_mhz` | number | Có |  | Maximum CPU frequency (MHz) |
| `process_cpu_percent` | number | Có |  | Application process CPU usage (%) |
| `process_memory_rss_mb` | number | Có |  | Process RSS memory (MB) |
| `process_memory_vms_mb` | number | Có |  | Process virtual memory (VMS) (MB) |
| `process_memory_percent` | number | Có |  | Percentage of system RAM used by the process |
| `process_threads` | integer | Có |  | Process thread count |
| `process_open_files` | integer | Có |  | Number of open file descriptors |
| `process_pid` | integer | Có |  | Application process PID |
| `ram_total_mb` | number | Có |  | Total physical RAM (MB) |
| `ram_available_mb` | number | Có |  | Available RAM (MB) |
| `ram_used_mb` | number | Có |  | RAM currently in use (MB) |
| `ram_percent` | number | Có |  | RAM usage (%) |
| `swap_total_mb` | number | Có |  | Total swap capacity (MB) |
| `swap_used_mb` | number | Có |  | Swap currently in use (MB) |
| `swap_percent` | number | Có |  | Swap usage (%) |
| `disk_total_gb` | number | Có |  | Total disk capacity (GB) |
| `disk_used_gb` | number | Có |  | Used disk space (GB) |
| `disk_free_gb` | number | Có |  | Free disk space (GB) |
| `disk_percent` | number | Có |  | Disk usage (%) |
| `net_bytes_sent` | integer | Có |  | Total bytes sent over the network |
| `net_bytes_recv` | integer | Có |  | Total bytes received over the network |
| `net_packets_sent` | integer | Có |  | Total packets sent |
| `net_packets_recv` | integer | Có |  | Total packets received |
| `queue_size` | integer | Có |  | Current number of items in the signal processing queue |
| `queue_maxsize` | integer | Có |  | Maximum queue size |
| `queue_usage_percent` | number | Có |  | Queue usage (%) |
| `heap_allocated_mb` | number | Có |  | Allocated Python heap memory (MB) |
| `gc_objects` | integer | Có |  | Number of Python objects tracked by the Garbage Collector |
| `asyncio_tasks` | integer | Có |  | Number of running asyncio tasks |
| `uptime_seconds` | number | Có |  | Application uptime (seconds) |
| `python_version` | string | Có |  | Python version in use |
| `platform` | string | Có |  | Operating system / platform information |

### UpdateProcessorConfigRequest

Request to update the processor configuration (PATCH).

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `max_queue_size` | integer / null | Không |  | New queue size |
| `queue_policy` | enum ["drop_oldest", "reject"] / null | Không | enum=["drop_oldest", "reject"] | Handling policy when the queue is full |

### UpdateSignalConfigRequest

Request to update a partial signal configuration (PATCH).

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `unit` | string / null | Không |  | New measurement unit |
| `min_value` | number / null | Không |  | New minimum value |
| `max_value` | number / null | Không |  | New maximum value |
| `widget_type` | string / null | Không |  | New widget type |
| `writable` | boolean / null | Không |  | Allow writes or not |

### ValidationError



| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `loc` | array<string / integer> | Có |  |  |
| `msg` | string | Có |  |  |
| `type` | string | Có |  |  |
| `input` | any | Không |  |  |
| `ctx` | object | Không |  |  |

### WriteSignalRequest

Request to write a value onto the CAN bus.

| Field | Kiểu | Bắt buộc | Default/giới hạn | Mô tả |
|---|---|---|---|---|
| `value` | number | Có |  | Value to write to the CAN bus |

## Endpoint tài liệu và frontend

| Method | URL | Kết quả |
|---|---|---|
| GET | /docs | Swagger UI; thử API với key thật qua Authorize. |
| GET | /redoc | ReDoc. |
| GET | /openapi.json | OpenAPI JSON runtime. |
| GET | /docs/oauth2-redirect | Helper redirect của Swagger UI; không phải API nghiệp vụ. |
| GET | / và static assets | Frontend StaticFiles mount nếu thư mục frontend tồn tại. |

Snapshot OpenAPI trong repo: [api.openapi.json](api.openapi.json). OpenAPI không chứa WebSocket và hiện chưa mô tả đúng media type binary của camera/video; phần mô tả thủ công phía trên theo implementation thực tế.
