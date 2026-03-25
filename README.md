# CAN-HMI API Demo

Frontend-only demo cho team test và review API contract từ `BE-FE-Review.json`.
**Không cần backend** — toàn bộ REST + WebSocket được mock bằng JavaScript + localStorage.

## Tính năng

| Tab | Nội dung |
|---|---|
| 📊 Dashboard | Signal cards với live mock WS updates; write controls cho writable signals |
| 👤 Profiles | CRUD profiles, select active → Dashboard filter theo profile (User mode) |
| ⚙️ Config | (Dev mode only) Xem/sửa configs, sampling rate, RTSP URL |
| ℹ️ Signals Info | Bảng metadata đầy đủ — `GET /signals/available` |
| 📋 API Log | Log tất cả API calls (method, URL, request/response body, status) |

## API endpoints được mock

```
GET    /api/profiles              — list all profiles
GET    /api/profile?name=X        — get one profile
POST   /api/profile               — create profile
PUT    /api/profile               — update profile (section_id required)
DELETE /api/profile/:name         — delete profile

GET    /configs                   — list all configs
GET    /config                    — get active config
PUT    /config                    — update config (section_id required)

GET    /signals                   — snapshot current values
GET    /signals/available         — full metadata (unit, min, max, writable, states)
PUT    /signals/:name             — write single signal (writable only) → 202
POST   /signals/batch_update      — batch write writable signals → 202

WS     ws://host/ws/signals       — real-time signal stream
```

## section_id (Optimistic Locking)
- Mỗi PUT profile/config phải gửi `section_id` khớp với giá trị hiện tại.
- BE sẽ tăng `section_id` sau mỗi write thành công.
- Nếu không khớp → **409 Conflict** (xem API Log để debug).

## Deploy lên Vercel (1 phút)

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
# Python (không cần cài gì)
python -m http.server 8080
# → mở http://localhost:8080
```

## Cấu trúc

```
car-hmi-api-demo/
├── index.html        — SPA shell
├── vercel.json       — Vercel static config
├── css/
│   └── style.css     — Dark theme
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
