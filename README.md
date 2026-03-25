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
| ℹ️ Signals Info | Bảng metadata đầy đủ — `GET /signals/available` |
| 📋 API Log | Log tất cả API calls (method, URL, request/response body, status) |

## Signal Catalogue

| Signal | Unit | Min | Max | Writable | States |
|---|---|---|---|---|---|
| `EngineSpeed` | rpm | 0 | 8000 | No | — |
| `CoolantTemp` | °C | 0 | 120 | No | — |
| `HB_FL_ActivationLevel` | — | 0 | 7 | **Yes** | Level 1–8 (values 0–7) |
| `HB_FR_ActivationLevel` | — | 0 | 7 | **Yes** | Level 1–8 (values 0–7) |

## API endpoints được mock

```
# Profiles  (User mode)
GET    /api/profiles              — list all profiles
GET    /api/profile?name=X        — get one profile
POST   /api/profile               — create profile
PUT    /api/profile               — update profile (section_id required)
DELETE /api/profile/{name}        — delete profile → 204

# Config  (Dev mode)
GET    /configs                   — list all configs
GET    /config                    — get active config
PUT    /config                    — update config (section_id required)

# Signals  (User + Dev)
GET    /signals                   — snapshot current values
GET    /signals/available         — full metadata (unit, min, max, writable, states)
PUT    /signals/{signal_name}     — write single writable signal → 202
POST   /signals/batch_update      — batch write writable signals → 202

# Realtime
WS     ws://host/ws/signals       — real-time signal stream (interval = 1000/sampling_rate ms)
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

## Chạy local

```bash
# Python
python -m http.server 8080
# → mở http://localhost:8080
```

## Cấu trúc

```
car-hmi-api-demo/
├── review.json       — review checklist
├── index.html        — SPA shell
├── vercel.json       — Vercel static config
├── css/
│   └── style.css     — Dark theme
├── docs/
│   └── index.html    — API documentation (static)
└── js/
    ├── mock.js       — Store + MockAPI + MockWebSocket + Logger
    └── app.js        — UI application logic
```

## Notes cho FE team

- **Dữ liệu lưu trong localStorage** — Reset bằng nút "↺ Reset" ở header.
- **Mode User**: Dashboard chỉ hiện signals theo active profile.
- **Mode Dev**: Tất cả signals + tab Config + Signals Info.
- **WS stream interval** phụ thuộc `sampling_rate` của active config.
- **Writable signals** (chip màu xanh) có write control trực tiếp trên card.
- API Log → click vào row để expand REQUEST/RESPONSE body.
