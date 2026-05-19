# CAN-HMI API Demo

REST + WebSocket API demo cho Car HMI system dựa trên CAN DB (`data/can0.json`).
- **Mock mode** (Vercel / local file): toàn bộ backend được mock bằng JavaScript + `localStorage`, không cần server thật.
- **Live mode** (Render): Express server thật + WebSocket thật với per-client subscription.

🔗 **[Live Demo — Render](https://car-hmi-api-demo.onrender.com)** &nbsp;|&nbsp; **[Static Demo — Vercel](https://car-hmi-api-demo.vercel.app)** &nbsp;|&nbsp; 📖 **[API Docs](https://car-hmi-api-demo.onrender.com/docs)** &nbsp;|&nbsp; **[WS Docs](https://car-hmi-api-demo.onrender.com/ws)**

## Modes

| Mode | Dashboard | Profiles | Config | Signals Info |
|---|---|---|---|---|
| **User** | Signals theo active profile | ✅ CRUD | ❌ | ❌ |
| **Dev** | Tất cả 167 signals | ✅ CRUD | ✅ | ✅ |

## Tabs

| Tab | Nội dung |
|---|---|
| 📊 Dashboard | Signal cards với live WS updates; write controls cho writable signals (TX) |
| 👤 Profiles | CRUD profiles, select active → Dashboard filter theo profile (User mode) |
| ⚙️ Config | (Dev mode only) Xem/sửa hardware, storage, safety config |
| ℹ️ Signals Info | Bảng metadata đầy đủ 167 signals — `GET /signals/available` |
| 📋 API Log | Log tất cả API calls + WS events (method, URL, request/response body, status) |

## Signal Catalogue

167 signals từ `data/can0.json`. Một số đại diện:

| Signal | Unit | Min | Max | Writable | States |
|---|---|---|---|---|---|
| `ARS_FL_InjuryRiskAdaptive` | - | 0 | 100 | No | - |
| `ARS_FL_TimeToFireAirbag` | - | 0 | 65535 | No | - |
| `OMS_FL_HandsOnWheel` | - | 0 | 7 | No | 8 states |
| `OMS_FL_OccupantWeightMean_kg` | - | 0 | 255 | No | - |
| `OMS_FL_OccupantHeightMean_cm` | - | 0 | 255 | No | - |
| `SMA_VehicleStable` | - | 0 | 1 | No | - |
| `ABL_FL_RetractRequest` | - | 0 | 255 | **Yes** | - |
| `ACR_FL_RetractRequest` | - | 0 | 255 | **Yes** | Slack Removal, Retract L1–L4, Haptic 1–6, … |
| `ACR_FR_RetractRequest` | - | 0 | 255 | **Yes** | (same as FL) |
| `HMI_CrashSeverity` | - | 0 | 7 | **Yes** | - |
| `HMI_FL_OccupantAge_years` | - | 0 | 255 | **Yes** | - |
| `Generic_SeatFunctionEnable` | - | 0 | 1 | **Yes** | - |

> Full list: open **Signals Info** tab in dev mode, or call `GET /signals/available`.

## API Endpoints

```
# Profiles
GET    /api/profiles              — list all profiles
GET    /api/profile?name=X        — get one profile
POST   /api/profile               — create profile
PUT    /api/profile               — update profile (section_id required)
DELETE /api/profile/{name}        — delete profile → 204

# Config
GET    /configs                   — full system info (read-only)
GET    /config                    — editable config snapshot
PUT    /config                    — update config (section_id required)

# Signals
GET    /signals                   — snapshot current values
GET    /signals/available         — full metadata (unit, min, max, writable, states)
PUT    /signals/{signal_name}     — write single writable signal → 202 + WS broadcast
POST   /signals/batch_update      — batch write writable signals → 202 + WS broadcast

# Realtime
WS     /ws/signals                — real-time signal stream (500ms, per-client subscription)
```

## WebSocket Subscription Protocol

```js
// Subscribe to specific signals (after connect)
ws.send(JSON.stringify({ type: 'subscribe', signals: ['ARS_FL_InjuryRiskAdaptive', 'OMS_FL_HandsOnWheel'] }));
// ← { type: 'subscribed', signals: [...], count: 2 }  + immediate snapshot

// Subscribe to all signals
ws.send(JSON.stringify({ type: 'subscribe', signals: '*' }));

// Unsubscribe specific signals
ws.send(JSON.stringify({ type: 'unsubscribe', signals: ['OMS_FL_HandsOnWheel'] }));

// Keepalive
ws.send(JSON.stringify({ type: 'ping' }));
// ← { type: 'pong' }
```

**Cross-tab write broadcast**: khi TabA gọi `PUT /signals/ACR_FL_RetractRequest`, giá trị mới được push ngay tới tất cả WS clients đang subscribe signal đó.

**App tự động subscribe** theo context:
- Dev mode → subscribe `*` (all signals)
- User mode → subscribe chỉ signals của active profile
- Đổi profile → re-subscribe tự động

## section_id (Optimistic Locking)
- Mỗi `PUT /api/profile` và `PUT /config` phải gửi `section_id` khớp với giá trị hiện tại.
- BE sẽ tăng `section_id` sau mỗi write thành công.
- Nếu không khớp → **409 Conflict** (xem API Log để debug).

## Deploy

### Render (Real Server + WebSocket)

```bash
git init
git add .
git commit -m "initial: car-hmi-api-demo"
git remote add origin https://github.com/YOUR_ORG/car-hmi-api-demo.git
git push -u origin main
# Rồi connect repo ở render.com → auto deploy từ render.yaml
```

`render.yaml` đã có sẵn: `node server.js`, port `$PORT`, health check `/api/info`.

### Vercel (Static Mock Only)

```bash
npm i -g vercel
vercel --prod
```

Trên Vercel `server.js` không chạy — app tự detect và dùng `MockWebSocket` + `localStorage`.

## CAN DB

Nguồn dữ liệu: `data/can0.json` (CAN database với 167 unique signals).
Cấu trúc: `{ messages: { MsgName: { id, size, senders, signals: { SigName: { minimum, maximum, unit, description, states, TX, RX } } } } }`

## Tests

```bash
node _test_mock.js   # 39 tests — Store, Profiles CRUD, Config, Signals, WS subscription
```

---

## Chạy local

```bash
npm install
node server.js
# → mở http://localhost:8000
```

Hoặc không cần server (mock only):
```bash
# Python
python -m http.server 8080
# → mở http://localhost:8080  (chế độ mock)
```

## Cấu trúc

```
car-hmi-api-demo/
├── index.html        — SPA shell
├── server.js         — Express server + WebSocket (Render)
├── vercel.json       — Vercel static config (mock only)
├── render.yaml       — Render deployment config
├── _test_mock.js     — Integration tests (39 tests)
├── candb/
│   ├── p_dummy.dbc   — nguồn DBC mẫu
│   └── dbc2signal.js — DBC→JSON converter
├── data/
│   ├── can0.json     — CAN database (167 signals)
│   ├── config.json   — server config
│   └── info.json     — user profiles
├── css/
│   └── style.css     — Dark theme
├── docs/
│   ├── index.html    — Swagger UI (GET /docs)
│   ├── ws.html       — WebSocket docs + live tester (GET /ws)
│   └── errors.html   — Error codes reference
└── js/
    ├── mock.js       — Store + MockAPI + MockWebSocket + Logger
    └── app.js        — UI application logic
```

## Notes cho FE team

- **Dữ liệu lưu trong localStorage** - Reset bằng nút "↺ Reset" ở header.
- **Mode User**: Dashboard chỉ hiện signals theo active profile.
- **Mode Dev**: Tất cả signals + tab Config + Signals Info.
- **WS stream interval** phụ thuộc `sampling_rate` của active config.
- **Writable signals** (chip màu xanh) có write control trực tiếp trên card.
- API Log → click vào row để expand REQUEST/RESPONSE body.
