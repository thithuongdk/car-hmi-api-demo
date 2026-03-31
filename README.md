# CAN-HMI API Demo

Frontend-only demo
REST + WebSocket được mock bằng JavaScript + localStorage.

🔗 **[Live Demo](https://car-hmi-api-demo.vercel.app)** &nbsp;|&nbsp; 📖 **[API Docs](https://car-hmi-api-demo.vercel.app/docs)**

## Modes

| Mode | Dashboard | Profiles | Config | Signals Info |
|---|---|---|---|---|
| **User** | Signals theo active profile | ✅ CRUD | ❌ | ❌ |
| **Dev** | Tất cả signals | ✅ CRUD | ✅ | ✅ |

## Tabs

| Tab | Nội dung |
|---|---|
| 📊 Dashboard | Signal cards với live mock WS updates; write controls cho writable signals |
| 👤 Profiles | CRUD profiles, select active → Dashboard filter theo profile (User mode) |
| ⚙️ Config | (Dev mode only) Xem/sửa configs, sampling rate, RTSP/WebRTC URL, DBC files |
| ℹ️ Signals Info | Bảng metadata đầy đủ - `GET /signals/available` |
| 📋 API Log | Log tất cả API calls (method, URL, request/response body, status) |

## Signal Catalogue

| Signal | Unit | Min | Max | Writable | States |
|---|---|---|---|---|---|
| `EngineSpeed` | rpm | 0 | 8000 | No | - |
| `CoolantTemp` | °C | 0 | 120 | No | - |
| `HB_FL_ActivationLevel` | - | 0 | 7 | **Yes** | Level 1–8 (values 0–7) |
| `HB_FR_ActivationLevel` | - | 0 | 7 | **Yes** | Level 1–8 (values 0–7) |

## API endpoints được mock

```
# Profiles  (User mode)
GET    /api/profiles              - list all profiles
GET    /api/profile?name=X        - get one profile
POST   /api/profile               - create profile
PUT    /api/profile               - update profile (section_id required)
DELETE /api/profile/{name}        - delete profile → 204

# Config  (Dev mode)
GET    /configs                   - list all configs
GET    /config                    - get active config
PUT    /config                    - update config (section_id required)

# Signals  (User + Dev)
GET    /signals                   - snapshot current values
GET    /signals/available         - full metadata (unit, min, max, writable, states)
PUT    /signals/{signal_name}     - write single writable signal → 202
POST   /signals/batch_update      - batch write writable signals → 202

# Realtime
WS     ws://host/ws/signals       - real-time signal stream (interval = 1000/sampling_rate ms)
```

## section_id (Optimistic Locking)
- Mỗi `PUT /api/profile` và `PUT /config` phải gửi `section_id` khớp với giá trị hiện tại.
- BE sẽ tăng `section_id` sau mỗi write thành công.
- Nếu không khớp → **409 Conflict** (xem API Log để debug).

## Deploy lên Vercel

```bash
# 1. Tạo repo GitHub và push project
git init
git add .
git commit -m "initial: car-hmi-api-demo"
git remote add origin https://github.com/YOUR_ORG/car-hmi-api-demo.git
git push -u origin main

# 2. Import repo trên vercel.com → Deploy
# Hoặc dùng CLI:
npm i -g vercel
vercel --prod
```

## DBC → signal.json (cập nhật signal catalogue)

Script `candb/dbc2signal.js` đọc một file `.dbc` và sinh lại `candb/signal.json`.
File `signal.json` cũ được tự động backup trước khi ghi đè.

### Cách dùng

```bash
# Cú pháp
node candb/dbc2signal.js [input.dbc] [output.json]

# Mặc định (dùng p_dummy.dbc → signal.json)
node candb/dbc2signal.js

# Chỉ định file tùy ý
node candb/dbc2signal.js candb/my_project.dbc candb/signal.json
```

### Backup tự động

Mỗi lần chạy, file `signal.json` hiện tại được copy sang:

```
candb/signal.bk_001.json   ← lần chạy đầu tiên
candb/signal.bk_002.json   ← lần chạy thứ hai
…
```

Nếu chưa có `signal.json` (lần đầu), không tạo backup.

### Quy ước các trường được sinh tự động

| Trường | Nguồn |
|---|---|
| `name` | `SG_` signal name |
| `description` | `CM_ SG_` comment đầu tiên |
| `unit` | `SG_` unit field hoặc `CM_` "Signalvalues: mm/deg/..." |
| `min` / `max` | `SG_` range `[min\|max]` |
| `source` | Node gửi từ `BO_` sender |
| `destination` | Danh sách nhận từ `SG_` (bỏ `Vector__XXX`) |
| `states` | `VAL_` enum table (nếu có) |
| `RX` | `true` (mặc định - tất cả signal đều readable) |
| `TX` | `false` (mặc định - sửa thủ công cho writable signals) |
| `value` / `timestamp` | `0` (khởi tạo) |

### Ví dụ output

```json
{
  "name": "SPS_FL_SeatDirectionX",
  "value": 0,
  "source": ["PANTHER"],
  "destination": ["CAR_PC", "SIMI"],
  "timestamp": 0,
  "description": "FL Seat x-for Direction Actuator",
  "unit": "mm",
  "min": 0,
  "max": 4095,
  "RX": true,
  "TX": false,
  "states": []
}
```

---

## Chạy local

```bash
# Python
python -m http.server 8080
# → mở http://localhost:8080
```

## Cấu trúc

```
car-hmi-api-demo/
├── review.json       - review checklist
├── index.html        - SPA shell
├── vercel.json       - Vercel static config
├── render.yaml       - Render static site config
├── candb/
│   ├── p_dummy.dbc   - nguồn DBC mẫu
│   ├── signal.json   - signal catalogue (sinh bởi dbc2signal.js)
│   └── dbc2signal.js - converter script
├── css/
│   └── style.css     - Dark theme
├── docs/
│   ├── index.html    - Swagger UI (GET /docs)
│   └── ws.html       - WebSocket docs + live tester (GET /ws)
└── js/
    ├── mock.js       - Store + MockAPI + MockWebSocket + Logger
    └── app.js        - UI application logic
```

## Notes cho FE team

- **Dữ liệu lưu trong localStorage** - Reset bằng nút "↺ Reset" ở header.
- **Mode User**: Dashboard chỉ hiện signals theo active profile.
- **Mode Dev**: Tất cả signals + tab Config + Signals Info.
- **WS stream interval** phụ thuộc `sampling_rate` của active config.
- **Writable signals** (chip màu xanh) có write control trực tiếp trên card.
- API Log → click vào row để expand REQUEST/RESPONSE body.
