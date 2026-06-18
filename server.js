/**
 * server.js - CAN-HMI API Demo  (Express + ws)
 * Real HTTP server + WebSocket streaming.
 * Mirrors the mock.js contract exactly so FE can swap wss://... into real URL.
 *
 * Routes:
 *   GET  /api/info
 *   GET  /api/profiles
 *   GET  /api/profile?name=X
 *   POST /api/profile
 *   PUT  /api/profile
 *   DELETE /api/profile/:name
 *   GET  /configs
 *   GET  /config
 *   PUT  /config
 *   GET  /signals
 *   GET  /signals/available
 *   PUT  /signals/:name
 *   POST /signals/batch_update
 *   WS   /ws/signals
 *   Static files served from repo root
 */

'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const { WebSocketServer } = require('ws');

const PORT   = process.env.PORT || 8000;
const ROOT   = __dirname;

// ── Load JSON data files ──────────────────────────────────────────────────────
function loadJSON(relPath) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8')); }
  catch (_) { return null; }
}

const INFO_JSON     = loadJSON('data/info.json');
const CONFIG_JSON   = loadJSON('data/config.json');
const SIGNAL_STD_JSON = loadJSON('data/signal_std_name.json') || {};
const PROFILES_JSON = loadJSON('data/profiles.json'); // optional seed

// Resolve CAN DB path from config (default: data/can0.json)
const CAN0_PATH = CONFIG_JSON?.can_db?.path || 'data/can0.json';
const CAN0_JSON = loadJSON(CAN0_PATH);
if (!CAN0_JSON) { console.error(`[boot] ERROR: CAN DB not found: ${CAN0_PATH}`); process.exit(1); }
console.log(`[boot] Loaded CAN DB: ${CAN0_PATH}`);

// ── Parse can0.json messages → flat signal list ───────────────────────────────
function parseCan0Signals(can0) {
  const signals = [];
  const seen    = new Set();
  for (const [, msg] of Object.entries(can0.messages || {})) {
    for (const [sigName, sig] of Object.entries(msg.signals || {})) {
      if (seen.has(sigName)) continue;
      seen.add(sigName);
      signals.push({
        name:        sigName,
        std_name:    SIGNAL_STD_JSON[sigName] || sigName,
        unit:        sig.unit        || '',
        min:         sig.minimum     ?? 0,
        max:         sig.maximum     ?? 0,
        writable:    !!sig.TX,
        description: sig.description || '',
        states:      Array.isArray(sig.states) ? sig.states : [],
      });
    }
  }
  return signals;
}

// ── In-memory store (seeded from can0.json, no persistence) ──────────────────
const SIGNALS_META = parseCan0Signals(CAN0_JSON);
const SIGNALS_BY_NAME = new Map(SIGNALS_META.map(s => [s.name, s]));
const SIGNALS_BY_STD_NAME = new Map(SIGNALS_META.map(s => [s.std_name || s.name, s.name]));

function resolveSignalName(ref) {
  if (!ref) return null;
  if (SIGNALS_BY_NAME.has(ref)) return ref;
  return SIGNALS_BY_STD_NAME.get(ref) || null;
}

function resolveSignalMeta(ref) {
  const name = resolveSignalName(ref);
  return name ? SIGNALS_BY_NAME.get(name) || null : null;
}

function signalPayload(name, value, timestamp) {
  const meta = SIGNALS_BY_NAME.get(name);
  if (!meta) return null;
  return {
    name: meta.name,
    std_name: meta.std_name || meta.name,
    value: value ?? signalValues[name]?.value ?? 0,
    timestamp: timestamp ?? signalValues[name]?.timestamp ?? null,
  };
}

function normalizeSignalList(signals) {
  if (signals === '*') return '*';
  if (!Array.isArray(signals)) return [];
  return [...new Set(signals.map(resolveSignalName).filter(Boolean))];
}

// Redact sensitive server fields from info
let INFO_DATA = null;
if (INFO_JSON) {
  INFO_DATA = {
    ...INFO_JSON,
    server: INFO_JSON.server
      ? { ...INFO_JSON.server, api_key: '[REDACTED]' }
      : undefined,
  };
}

// Deep-clone config so mutations don't touch the loaded object
let CONFIG_DATA = CONFIG_JSON ? JSON.parse(JSON.stringify(CONFIG_JSON)) : null;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function signalRule(s) {
  const baseMin = Number.isFinite(s?.min) ? s.min : 0;
  const baseMax = Number.isFinite(s?.max) ? s.max : 100;
  const unitRaw = String(s?.unit || '').toLowerCase();
  const unit = unitRaw.replace(/\s+/g, '');
  const name = String(s?.name || '').toLowerCase();
  const desc = String(s?.description || '').toLowerCase();

  const withRange = (rMin, rMax, stepMin, stepMax) => {
    const min = Math.max(baseMin, rMin);
    const max = Math.min(baseMax, rMax);
    return min <= max ? { min, max, stepMin, stepMax } : { min: baseMin, max: baseMax, stepMin: 1, stepMax: 3 };
  };

  const isTemp = unit === 'c' || unit === '°c' || unit === 'degc' || unitRaw.includes('celsius') || name.includes('temp') || desc.includes('temp');
  if (isTemp) return withRange(20, 60, 1, 1);

  const isDeg = unit === 'deg' || unitRaw.includes('degree');
  if (isDeg) return withRange(30, 40, 1, 1);

  const isMm = unit === 'mm';
  if (isMm) return withRange(10, 100, 1, 1);

  return { min: baseMin, max: baseMax, stepMin: 1, stepMax: 3 };
}

// Signal values - seeded with midpoint or random enum state
const signalValues = {};
SIGNALS_META.forEach(s => {
  let initVal;
  if (s.states.length) {
    initVal = s.states[Math.floor(Math.random() * s.states.length)].value;
  } else {
    const { min, max } = signalRule(s);
    initVal = randInt(Math.ceil(min), Math.floor(max));
  }
  signalValues[s.name] = { value: initVal, timestamp: Date.now() / 1000 };
});

// Profiles - seeded from info.json profiles section, or from profiles.json, or built-in defaults
let sectionId = INFO_JSON?.section_id ?? CONFIG_JSON?.section_id ?? 1;

function buildDefaultProfiles() {
  const allNames = SIGNALS_META.map(s => s.name);
  const flFr = allNames.filter(n => /_FL_|_FR_/.test(n));
  const rear  = allNames.filter(n => /_RL1_|_RL2_|_RR1_/.test(n));
  const writable = allNames.filter(n => SIGNALS_META.find(s => s.name === n)?.writable);
  return [
    { profile_name: 'U0', description: 'Front seat profile',        signals: flFr,     selected: true  },
    { profile_name: 'U1', description: 'Rear seat profile',         signals: rear,     selected: false },
    { profile_name: 'U2', description: 'Outside view (all seats)',  signals: allNames, selected: false },
    { profile_name: 'U3', description: 'Outside control',           signals: writable, selected: false },
  ];
}

let profiles;
if (INFO_JSON?.profiles && Array.isArray(INFO_JSON.profiles) && INFO_JSON.profiles.length) {
  profiles = JSON.parse(JSON.stringify(INFO_JSON.profiles));
  if (!profiles.some(p => p.selected)) profiles[0].selected = true;
} else {
  profiles = buildDefaultProfiles();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function activeProfile() {
  return profiles.find(p => p.selected) || profiles[0];
}

function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const k of Object.keys(src)) {
    if (src[k] !== null && typeof src[k] === 'object' && !Array.isArray(src[k])) {
      if (!target[k]) target[k] = {};
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
}

function err(res, code, id, msg, httpStatus) {
  res.status(httpStatus).json({ error: msg, code, id });
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS - allow any origin for demo use
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files: serve repo root
// Specific doc routes first so /docs → docs/index.html, /ws → docs/ws.html
app.get('/docs/errors', (req, res) => res.sendFile(path.join(ROOT, 'docs', 'errors.html')));
app.get('/docs',        (req, res) => res.sendFile(path.join(ROOT, 'docs', 'index.html')));
app.get('/ws',          (req, res) => res.sendFile(path.join(ROOT, 'docs', 'ws.html')));
app.get('/ws-docs',     (req, res) => res.sendFile(path.join(ROOT, 'docs', 'ws.html')));

// ── REST: System Info ─────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  if (!INFO_DATA) return err(res, 1000, 'SYS_UNKNOWN', 'Info not available', 503);
  res.json(INFO_DATA);
});

// ── REST: Profiles ────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  res.json({ section_id: sectionId, profiles });
});

app.get('/api/profile', (req, res) => {
  const name = req.query.name;
  const p = name ? profiles.find(x => x.profile_name === name) : activeProfile();
  if (!p) return err(res, 3004, 'VAL_NOT_FOUND', `Profile '${name}' not found`, 404);
  res.json({ section_id: sectionId, ...p });
});

app.post('/api/profile', (req, res) => {
  const { profile_name, signals: sigs = [], description = '' } = req.body || {};
  if (!profile_name) return err(res, 3002, 'VAL_MISSING_FIELD', 'profile_name is required', 400);
  if (profiles.find(p => p.profile_name === profile_name))
    return err(res, 3005, 'VAL_CONFLICT', `Profile '${profile_name}' already exists`, 409);
  const np = { profile_name, description, signals: sigs, selected: false };
  profiles.push(np);
  sectionId++;
  res.status(201).json(np);
});

app.put('/api/profile', (req, res) => {
  const payload = req.body || {};
  if (payload.section_id !== sectionId)
    return err(res, 3005, 'VAL_CONFLICT', `section_id mismatch: expected ${sectionId}, got ${payload.section_id}`, 409);
  // Handle "set active" shortcut
  if (payload.selected === true && payload.profile_name) {
    profiles.forEach(p => { p.selected = (p.profile_name === payload.profile_name); });
    sectionId++;
    return res.json({ ok: true, section_id: sectionId });
  }
  const idx = profiles.findIndex(p => p.profile_name === payload.profile_name);
  if (idx < 0) return err(res, 3004, 'VAL_NOT_FOUND', 'Profile not found', 404);
  profiles[idx] = { ...profiles[idx], ...payload };
  sectionId++;
  res.json(profiles[idx]);
});

app.delete('/api/profile/:name', (req, res) => {
  const idx = profiles.findIndex(p => p.profile_name === req.params.name);
  if (idx < 0) return err(res, 3004, 'VAL_NOT_FOUND', 'Profile not found', 404);
  const removed = profiles.splice(idx, 1)[0];
  sectionId++;
  res.json({ deleted: removed.profile_name, section_id: sectionId });
});

// ── REST: Configs ─────────────────────────────────────────────────────────────
app.get('/configs', (req, res) => {
  if (!INFO_DATA) return err(res, 1000, 'SYS_UNKNOWN', 'Info not available', 503);
  res.json({ ...INFO_DATA, profiles, section_id: sectionId });
});

app.get('/config', (req, res) => {
  if (!CONFIG_DATA) return err(res, 1000, 'SYS_UNKNOWN', 'Config not available', 503);
  res.json({ ...CONFIG_DATA, section_id: sectionId });
});

app.put('/config', (req, res) => {
  const payload = req.body || {};
  if (payload.section_id !== sectionId)
    return err(res, 3005, 'VAL_CONFLICT', `section_id mismatch: expected ${sectionId}, got ${payload.section_id}`, 409);
  if (!CONFIG_DATA) return err(res, 1000, 'SYS_UNKNOWN', 'Config not available', 503);
  const allowed = ['hardware', 'storage', 'safety'];
  for (const key of allowed) {
    if (payload[key] !== undefined) deepMerge(CONFIG_DATA[key], payload[key]);
  }
  sectionId++;
  res.status(202).json({ ...CONFIG_DATA, section_id: sectionId });
});

// ── REST: Signals ─────────────────────────────────────────────────────────────
app.get('/signals', (req, res) => {
  const sigs = Object.entries(signalValues).map(([name, sv]) => ({
    name,
    std_name: SIGNALS_BY_NAME.get(name)?.std_name || name,
    value: sv.value,
    timestamp: sv.timestamp,
  }));
  res.json({ timestamp: new Date().toISOString(), signals: sigs });
});

app.get('/signals/available', (req, res) => {
  const signals_info = SIGNALS_META.map(s => {
    const sv = signalValues[s.name];
    return { ...s, value: sv?.value ?? null, timestamp: sv?.timestamp ?? null };
  });
  res.json({ signals_info });
});

app.put('/signals/:name', (req, res) => {
  const { name } = req.params;
  const meta = resolveSignalMeta(name);
  if (!meta)          return err(res, 3004, 'VAL_NOT_FOUND',    `Signal '${name}' not found`, 404);
  if (!meta.writable) return err(res, 4002, 'SAFE_WRITE_DENIED', `Signal '${name}' is not writable`, 403);
  const value = req.body?.value;
  if (value === undefined || value === null)
    return err(res, 3002, 'VAL_MISSING_FIELD', 'value is required', 400);
  const v = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(v) || v < meta.min || v > meta.max)
    return err(res, 3003, 'VAL_OUT_OF_RANGE', `Value ${value} out of range [${meta.min}, ${meta.max}]`, 422);
  signalValues[meta.name] = { value: v, timestamp: Date.now() / 1000 };
  broadcastWrite([{ name: meta.name, value: v }]); // push to all subscribed WS clients
  res.status(202).json({ signal_name: meta.name, std_name: meta.std_name || meta.name, value: v, queued_at: Date.now() / 1000 });
});

app.post('/signals/batch_update', (req, res) => {
  const { signals: items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return err(res, 3002, 'VAL_MISSING_FIELD', 'signals array required', 400);
  const results = [];
  for (const item of items) {
    const ref = item?.name ?? item?.signal_name ?? item?.std_name;
    const value = item?.value;
    const meta = resolveSignalMeta(ref);
    if (!meta)          { results.push({ name: ref, std_name: ref, value, status: 'not_found' }); continue; }
    if (!meta.writable) { results.push({ name: meta.name, std_name: meta.std_name || meta.name, value, status: 'not_writable' }); continue; }
    const v = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(v) || v < meta.min || v > meta.max) { results.push({ name: meta.name, std_name: meta.std_name || meta.name, value, status: 'out_of_range' }); continue; }
    signalValues[meta.name] = { value: v, timestamp: Date.now() / 1000 };
    results.push({ name: meta.name, std_name: meta.std_name || meta.name, value: v, status: 'ok' });
  }
  // push all successful writes to subscribed WS clients
  broadcastWrite(results.filter(r => r.status === 'ok').map(r => ({ name: r.name, value: r.value })));
  res.status(202).json({ timestamp: new Date().toISOString(), results });
});

// ── REST: Restraints ──────────────────────────────────────────────────────────
const SEAT_TO_SUFFIX = {
  driver:      'FL',
  passenger:   'FR',
  rear_left_row1:   'RL1',
  rear_left_row2:  'RL2',
  rear_right_row1: 'RR1',
};
const VALID_SEAT_BELTS = ['CLL', 'SLL', 'MSLL'];
const VALID_CRASH_PULSES = ['OLC18', 'OLC30'];

app.get('/api/restraints/match', (req, res) => {
  const { seat, seat_belt, crash_pulse = 'OLC18' } = req.query;

  if (!seat)      return err(res, 3002, 'VAL_MISSING_FIELD', 'seat is required', 400);
  if (!seat_belt) return err(res, 3002, 'VAL_MISSING_FIELD', 'seat_belt is required', 400);

  const suffix = SEAT_TO_SUFFIX[seat];
  if (!suffix)
    return err(res, 3003, 'VAL_OUT_OF_RANGE',
      `Unknown seat '${seat}'. Valid: ${Object.keys(SEAT_TO_SUFFIX).join(', ')}`, 422);

  if (!VALID_SEAT_BELTS.includes(seat_belt))
    return err(res, 3003, 'VAL_OUT_OF_RANGE',
      `Unknown seat_belt '${seat_belt}'. Valid: ${VALID_SEAT_BELTS.join(', ')}`, 422);

  if (!VALID_CRASH_PULSES.includes(crash_pulse))
    return err(res, 3003, 'VAL_OUT_OF_RANGE',
      `Unknown crash_pulse '${crash_pulse}'. Valid: ${VALID_CRASH_PULSES.join(', ')}`, 422);

  // Read live signal values for this seat
  const weightSig  = signalValues[`OMS_${suffix}_OccupantWeightMean_kg`];
  const posXSig    = signalValues[`SPS_${suffix}_SeatDirectionX`];
  const injurySig  = signalValues[`ARS_${suffix}_InjuryRiskAdaptive`];

  const weight  = weightSig  ? Math.round(weightSig.value)  : 56;   // default 50th-pct
  const posX    = posXSig    ? posXSig.value                : 2047;  // default mid
  const injRisk = injurySig  ? injurySig.value              : 50;

  // Percentile classification from occupant weight (kg)
  const percentile    = weight <= 50 ? 5 : weight <= 80 ? 50 : 95;

  // Seat fore-aft position from SPS_SeatDirectionX (0–4095 mm range)
  const seat_position = posX < 1365 ? 'fwd' : posX < 2730 ? 'mid' : 'bwd';

  // Score 0.0–5.0 derived from ARS injury risk (0–100 → 0.0–5.0)
  const score = parseFloat((injRisk / 20).toFixed(1));

  const filename = `${percentile}p_${seat_position}_${weight}_${seat_belt}.mp4`;

  res.json({
    matched: true,
    video: {
      filename,
      percentile,
      seat_position,
      weight,
      seat_belt,
      url: `/api/restraints/video/${filename}`,
    },
    score,
  });
});

// Static: serve everything after API routes
app.use(express.static(ROOT));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws/signals' });

// Registry: Map<WebSocket, () => Set<string>|null>
// Allows REST routes to broadcast writes to subscribed WS clients.
const wsClients = new Map();

/**
 * Push a list of { name, value } updates to every connected WS client
 * that has subscribed to each signal. Called after REST writes so that
 * TabB receives a TX value written by TabA immediately.
 */
function broadcastWrite(updates) {
  if (!updates.length) return;
  const ts = new Date().toISOString();
  wss.clients.forEach(ws => {
    if (ws.readyState !== ws.OPEN) return;
    const getSubscribed = wsClients.get(ws);
    if (!getSubscribed) return;
    const sub = getSubscribed(); // null = all
    const filtered = updates.filter(u => sub === null || sub.has(u.name));
    if (filtered.length)
      ws.send(JSON.stringify({ timestamp: ts, signals: filtered.map(u => signalPayload(u.name)).filter(Boolean) }));
  });
}

// Per-client subscription state + streaming
// Protocol (client → server):
//   { type: "subscribe",   signals: ["Sig1","Sig2"] | "*" }
//   { type: "unsubscribe", signals: ["Sig1"] }
//   { type: "ping" }
// Protocol (server → client):
//   { type: "subscribed", signals: [...] | "*", count: N }  — ack + snapshot follows
//   { timestamp, signals: [{name,value},...] }               — periodic stream
//   { type: "pong" }
wss.on('connection', (ws, req) => {
  console.log('[ws] client connected from', req.socket.remoteAddress);

  // null = stream ALL non-writable signals; Set<string> = only named signals
  let subscribed = null;
  wsClients.set(ws, () => subscribed); // register for broadcastWrite

  // per-client drifting values
  const clientVals = Object.fromEntries(
    Object.entries(signalValues).map(([k, v]) => [k, { ...v }])
  );

  // ── helpers ──────────────────────────────────────────────────────────────
  function _ackSubscription() {
    const subList = subscribed ? [...subscribed] : '*';
    const count   = subscribed
      ? subscribed.size
      : SIGNALS_META.filter(s => !s.writable).length;
    ws.send(JSON.stringify({ type: 'subscribed', signals: subList, count }));
    // immediate value snapshot for subscribed set
    const snap = (subscribed
      ? SIGNALS_META.filter(s => subscribed.has(s.name))
      : SIGNALS_META.filter(s => !s.writable)
    ).map(s => signalPayload(s.name));
    if (snap.length)
      ws.send(JSON.stringify({ timestamp: new Date().toISOString(), signals: snap }));
  }

  // ── periodic stream ───────────────────────────────────────────────────────
  const intervalMs = 500;
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const updates = [];

    SIGNALS_META.forEach(s => {
      if (s.writable) return;
      if (subscribed !== null && !subscribed.has(s.name)) return; // not subscribed

      const cur = clientVals[s.name]?.value ?? (s.min + s.max) / 2;
      let nv;

      if (s.states.length > 0) {
        if (Math.random() >= 0.08) return;
        nv = s.states[Math.floor(Math.random() * s.states.length)].value;
      } else {
        const rule = signalRule(s);
        const min = rule.min;
        const max = rule.max;
        const curNorm = Number.isFinite(cur) ? Math.round(cur) : Math.round((min + max) / 2);
        const range = Math.max(0, Math.floor(max - min));
        const rawStep = randInt(rule.stepMin, rule.stepMax);
        const step = Math.min(rawStep, range);
        if (step === 0) return;

        let dir = Math.random() < 0.5 ? -1 : 1;
        if (curNorm <= min) dir = 1;
        if (curNorm >= max) dir = -1;

        nv = Math.max(min, Math.min(max, curNorm + dir * step));
      }

      clientVals[s.name] = { value: nv, timestamp: Date.now() / 1000 };
      // Note: intentionally NOT writing back to signalValues here.
      // Each WS client drifts its own copy independently.
      // signalValues is only mutated by REST PUT /signals/:name writes.
      updates.push({ name: s.name, value: nv, timestamp: Date.now() / 1000 });
    });

    if (updates.length)
      ws.send(JSON.stringify({ timestamp: new Date().toISOString(), signals: updates.map(u => signalPayload(u.name, u.value, u.timestamp)).filter(Boolean) }));
  }, intervalMs);

  // ── incoming messages ─────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'subscribe':
        if (!msg.signals || msg.signals === '*') {
          subscribed = null;
        } else if (Array.isArray(msg.signals)) {
          subscribed = new Set(normalizeSignalList(msg.signals));
        }
        _ackSubscription();
        console.log(`[ws] client subscribed to ${
          subscribed ? subscribed.size + ' signals' : 'ALL signals'
        }`);
        break;

      case 'unsubscribe':
        if (Array.isArray(msg.signals)) {
          if (subscribed === null) {
            // was "all" → convert to full set minus removed
            subscribed = new Set(SIGNALS_META.filter(s => !s.writable).map(s => s.name));
          }
          normalizeSignalList(msg.signals).forEach(n => subscribed.delete(n));
          _ackSubscription();
        }
        break;
    }
  });

  ws.on('close', () => { clearInterval(timer); wsClients.delete(ws); console.log('[ws] client disconnected'); });
  ws.on('error', (e) => { clearInterval(timer); wsClients.delete(ws); console.error('[ws] error:', e.message); });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] REST API : http://localhost:${PORT}/api/info`);
  console.log(`[server] Swagger  : http://localhost:${PORT}/docs`);
  console.log(`[server] WS stream: ws://localhost:${PORT}/ws/signals`);
  console.log(`[server] WS docs  : http://localhost:${PORT}/ws-docs`);
});
