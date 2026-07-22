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
 *   GET  /signals/:name
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
const { URL }    = require('url');
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

const AUTH_DISABLED_VALUES = new Set(['', 'change-me-in-production', 'changeme', 'default']);
const CONFIGURED_API_KEY = String(process.env.API_KEY || INFO_JSON?.server?.api_key || '').trim();
const API_KEY_ENABLED = !AUTH_DISABLED_VALUES.has(CONFIGURED_API_KEY.toLowerCase());

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

// New profile model compatible with car-hmi API
const PROFILE_HEADER = 'x-profile-name';
const CLIENT_ID_HEADER = 'x-client-id';
const DEV_MODE_HEADER = 'x-dev-mode';
const SESSION_TTL_SECONDS = 600;

const profilesState = {
  active: null,
  profiles: {},
  client_sessions: {},
};

function toPermissionList(raw) {
  const inArr = Array.isArray(raw) ? raw.map(x => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
  const normalized = [];
  if (inArr.includes('full')) return ['full'];
  if (inArr.includes('read')) normalized.push('read');
  if (inArr.includes('write')) normalized.push('write');
  return normalized.length ? normalized : ['read'];
}

function bootstrapProfilesState() {
  if (PROFILES_JSON?.profiles && typeof PROFILES_JSON.profiles === 'object' && !Array.isArray(PROFILES_JSON.profiles)) {
    const loaded = PROFILES_JSON.profiles;
    Object.entries(loaded).forEach(([name, p]) => {
      profilesState.profiles[name] = {
        signals: Array.isArray(p?.signals) ? [...new Set(p.signals.map(String))] : [],
        permission: toPermissionList(p?.permission),
        description: p?.description || null,
        created_at: Number(p?.created_at || Date.now() / 1000),
      };
    });
    profilesState.active = typeof PROFILES_JSON.active === 'string' ? PROFILES_JSON.active : Object.keys(profilesState.profiles)[0] || null;
    return;
  }

  for (const p of profiles) {
    const name = p.profile_name || p.name;
    if (!name) continue;
    profilesState.profiles[name] = {
      signals: Array.isArray(p.signals) ? [...new Set(p.signals.map(String))] : [],
      permission: ['full'],
      description: p.description || null,
      created_at: Date.now() / 1000,
    };
    if (p.selected && !profilesState.active) profilesState.active = name;
  }
  if (!profilesState.active) profilesState.active = Object.keys(profilesState.profiles)[0] || null;
}

bootstrapProfilesState();

function isDevMode(req) {
  const v = String(req.headers[DEV_MODE_HEADER] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function buildAccessWarning(code, message, extra = {}) {
  return {
    code,
    message,
    signals: [],
    ...extra,
  };
}

function apiErr(res, httpStatus, code, message, extra = {}) {
  return res.status(httpStatus).json({ detail: buildAccessWarning(code, message, extra) });
}

function authMiddleware(req, res, next) {
  const p = req.path || '/';
  const needsAuth = (
    p === '/api/profiles'
    || p.startsWith('/api/profile')
    || p.startsWith('/signals')
    || p.startsWith('/alarms')
    || p.startsWith('/config')
  );
  if (!needsAuth) return next();
  if (!API_KEY_ENABLED) return next();
  const key = String(req.headers['x-api-key'] || '');
  if (key && key === CONFIGURED_API_KEY) return next();
  return res.status(401).json({ detail: 'Unauthorized' });
}

function resolveClientId(req) {
  const raw = req.headers[CLIENT_ID_HEADER];
  if (!raw) return null;
  const val = String(raw).trim();
  return val ? val.slice(0, 128) : null;
}

function resolveProfileName(req) {
  const explicit = String(req.headers[PROFILE_HEADER] || '').trim();
  if (explicit) return explicit;
  const clientId = resolveClientId(req);
  if (clientId && profilesState.client_sessions[clientId]?.active) {
    return profilesState.client_sessions[clientId].active;
  }
  return profilesState.active;
}

function profileAllowsSignal(profile, signalName) {
  if (!profile) return false;
  const allowed = new Set(profile.signals || []);
  const stdName = SIGNALS_BY_NAME.get(signalName)?.std_name;
  return allowed.has(signalName) || (stdName ? allowed.has(stdName) : false);
}

function profileHasPermission(profile, required) {
  if (!profile) return false;
  const p = new Set(profile.permission || ['read']);
  if (p.has('full')) return true;
  return p.has(required);
}

function requireProfilePermission(req, res, required, opts = {}) {
  if (isDevMode(req)) return { ok: true, profileName: null, profile: null };

  const profileName = resolveProfileName(req);
  if (!profileName) {
    apiErr(res, 403, 'profile_not_selected', 'No profile selected for this operation');
    return { ok: false };
  }

  const profile = profilesState.profiles[profileName];
  if (!profile) {
    apiErr(res, 404, 'profile_not_found', `Profile '${profileName}' khong tim thay`, { profile_name: profileName });
    return { ok: false };
  }

  if (!profileHasPermission(profile, required)) {
    apiErr(res, 403, 'profile_permission_denied', `Profile '${profileName}' lacks '${required}' permission`, {
      profile_name: profileName,
      required_permission: required,
      signal_name: opts.signalName || null,
    });
    return { ok: false };
  }

  if (opts.signalName && !profileAllowsSignal(profile, opts.signalName)) {
    apiErr(res, 403, 'profile_signal_denied', `Signal '${opts.signalName}' is outside profile '${profileName}' scope`, {
      profile_name: profileName,
      required_permission: required,
      signal_name: opts.signalName,
    });
    return { ok: false };
  }

  return { ok: true, profileName, profile };
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Profile-Name, X-Client-Id, X-Dev-Mode');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(authMiddleware);

// Static files: serve repo root
// Specific doc routes first so /docs → docs/index.html, /ws → docs/ws.html
app.get('/docs/errors', (req, res) => res.sendFile(path.join(ROOT, 'docs', 'errors.html')));
app.get('/docs',        (req, res) => res.sendFile(path.join(ROOT, 'docs', 'index.html')));
app.get('/ws',          (req, res) => res.sendFile(path.join(ROOT, 'docs', 'ws.html')));
app.get('/ws-docs',     (req, res) => res.sendFile(path.join(ROOT, 'docs', 'ws.html')));

// ── REST: System Info ─────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  const uptime = Number(((Date.now() / 1000) - bootTs).toFixed(1));
  res.json({
    name: 'CAN-HMI Signal API',
    version: '1.0.0',
    description: 'Real-time CAN bus signal monitoring and control API',
    uptime_seconds: uptime,
    bus_connected: true,
    db_connected: true,
    signal_count: SIGNALS_META.length,
  });
});

// ── REST: Profiles (car-hmi compatible) ──────────────────────────────────────
function profileResponse(name, profile) {
  return {
    name,
    profile_name: name,
    signals: profile.signals || [],
    permission: toPermissionList(profile.permission),
    description: profile.description || null,
    section_id: String(sectionId).padStart(12, '0').slice(-12),
  };
}

app.get('/api/profiles', (req, res) => {
  const clientId = resolveClientId(req);
  const active = resolveProfileName(req);
  const out = Object.entries(profilesState.profiles).map(([name, p]) => profileResponse(name, p));
  res.json({
    profiles: out,
    total: out.length,
    active,
    global_active: profilesState.active,
    client_id: clientId,
    section_id: sectionId,
  });
});

app.get('/api/profile', (req, res) => {
  const name = String(req.query.name || '').trim() || resolveProfileName(req);
  if (!name) return apiErr(res, 404, 'profile_not_selected', 'Khong co active profile');
  const p = profilesState.profiles[name];
  if (!p) return apiErr(res, 404, 'profile_not_found', `Profile '${name}' khong tim thay`, { profile_name: name });
  res.json(profileResponse(name, p));
});

app.post('/api/profile', (req, res) => {
  const hasAnyProfile = Object.keys(profilesState.profiles).length > 0;
  if (hasAnyProfile && !isDevMode(req)) {
    const gate = requireProfilePermission(req, res, 'full');
    if (!gate.ok) return;
  }

  const body = req.body || {};
  const name = String(body.name || body.profile_name || '').trim();
  if (!name) return apiErr(res, 400, 'profile_name_required', 'name is required');
  if (profilesState.profiles[name]) return apiErr(res, 409, 'profile_already_exists', `Profile '${name}' da ton tai`, { profile_name: name });

  profilesState.profiles[name] = {
    signals: Array.isArray(body.signals) ? [...new Set(body.signals.map(String))] : [],
    permission: toPermissionList(body.permission),
    description: body.description || null,
    created_at: Date.now() / 1000,
  };
  if (!profilesState.active) profilesState.active = name;
  sectionId += 1;
  res.status(201).json(profileResponse(name, profilesState.profiles[name]));
});

app.put('/api/profile', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;

  const body = req.body || {};
  const name = String(body.name || body.profile_name || '').trim();
  if (!name) return apiErr(res, 400, 'profile_name_required', 'name is required');

  const p = profilesState.profiles[name];
  if (!p) return apiErr(res, 404, 'profile_not_found', `Profile '${name}' khong tim thay`, { profile_name: name });

  const expected = String(sectionId).padStart(12, '0').slice(-12);
  if (body.section_id && String(body.section_id) !== expected) {
    return apiErr(res, 409, 'profile_section_mismatch', 'section_id khong khop - vui long GET lai profile va thu lai', { profile_name: name });
  }

  p.signals = Array.isArray(body.signals) ? [...new Set(body.signals.map(String))] : p.signals;
  if (body.permission !== undefined) p.permission = toPermissionList(body.permission);
  p.description = body.description === undefined ? p.description : body.description;
  sectionId += 1;
  res.json(profileResponse(name, p));
});

app.put('/api/profile/active', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;

  const target = String(req.body?.name || '').trim();
  if (!target) return apiErr(res, 400, 'profile_name_required', 'name is required');
  if (!profilesState.profiles[target]) return apiErr(res, 404, 'profile_not_found', `Profile '${target}' khong tim thay`, { profile_name: target });

  const clientId = resolveClientId(req);
  if (clientId) {
    profilesState.client_sessions[clientId] = {
      active: target,
      updated_at: Date.now() / 1000,
      last_seen: Date.now() / 1000,
    };
  } else {
    profilesState.active = target;
  }

  res.json({ active: target, global_active: profilesState.active, client_id: clientId, warnings: [] });
});

app.delete('/api/profile/:name', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;

  const name = String(req.params.name || '').trim();
  if (!profilesState.profiles[name]) return apiErr(res, 404, 'profile_not_found', `Profile '${name}' khong tim thay`, { profile_name: name });

  delete profilesState.profiles[name];
  if (profilesState.active === name) {
    profilesState.active = Object.keys(profilesState.profiles)[0] || null;
  }
  for (const [cid, s] of Object.entries(profilesState.client_sessions)) {
    if (s?.active === name) delete profilesState.client_sessions[cid];
  }
  sectionId += 1;
  res.status(204).send();
});

app.get('/api/profile/sessions', (req, res) => {
  const gate = requireProfilePermission(req, res, 'read');
  if (!gate.ok) return;

  const now = Date.now() / 1000;
  const sessions = [];
  const byProfileMap = new Map();
  let onlineTotal = 0;
  let offlineTotal = 0;

  for (const [clientId, st] of Object.entries(profilesState.client_sessions)) {
    const active = st?.active;
    if (!active) continue;
    const lastSeen = Number(st.last_seen || st.updated_at || 0);
    const online = (now - lastSeen) <= SESSION_TTL_SECONDS;
    const status = online ? 'online' : 'offline';
    if (online) onlineTotal += 1; else offlineTotal += 1;
    sessions.push({
      client_id: clientId,
      active,
      updated_at: Number(st.updated_at || 0),
      last_seen: lastSeen,
      status,
    });
    const stat = byProfileMap.get(active) || { total: 0, online: 0, offline: 0 };
    stat.total += 1;
    if (online) stat.online += 1; else stat.offline += 1;
    byProfileMap.set(active, stat);
  }

  sessions.sort((a, b) => b.updated_at - a.updated_at);
  const byProfile = [...byProfileMap.entries()].map(([profile_name, stat]) => ({ profile_name, ...stat }));

  res.json({
    sessions,
    total: sessions.length,
    online_total: onlineTotal,
    offline_total: offlineTotal,
    by_profile: byProfile,
    global_active: profilesState.active,
    ttl_seconds: SESSION_TTL_SECONDS,
    server_time: now,
  });
});

app.post('/api/profile/heartbeat', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return apiErr(res, 400, 'client_id_required', `Header 'X-Client-Id' is required for heartbeat`);
  const now = Date.now() / 1000;
  const active = resolveProfileName(req);
  profilesState.client_sessions[clientId] = {
    ...(profilesState.client_sessions[clientId] || {}),
    active,
    updated_at: now,
    last_seen: now,
  };
  res.json({ client_id: clientId, active, last_seen: now, ttl_seconds: SESSION_TTL_SECONDS });
});

app.post('/api/profile/offline', (req, res) => {
  const clientId = resolveClientId(req);
  if (!clientId) return apiErr(res, 400, 'client_id_required', `Header 'X-Client-Id' is required for offline update`);
  const now = Date.now() / 1000;
  const active = resolveProfileName(req);
  profilesState.client_sessions[clientId] = {
    ...(profilesState.client_sessions[clientId] || {}),
    active,
    updated_at: now,
    last_seen: now - SESSION_TTL_SECONDS - 1,
  };
  res.json({ client_id: clientId, active, last_seen: profilesState.client_sessions[clientId].last_seen, ttl_seconds: SESSION_TTL_SECONDS });
});

// ── REST: Configs ─────────────────────────────────────────────────────────────
app.get('/configs', (req, res) => {
  if (!INFO_DATA) return err(res, 1000, 'SYS_UNKNOWN', 'Info not available', 503);
  const active = profilesState.active;
  const compatProfiles = Object.entries(profilesState.profiles).map(([name, p]) => ({
    profile_name: name,
    description: p.description || '',
    signals: p.signals || [],
    selected: name === active,
  }));
  res.json({ ...INFO_DATA, profiles: compatProfiles, section_id: sectionId });
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

const DEFAULT_CONFIG_SNAPSHOT = CONFIG_JSON ? JSON.parse(JSON.stringify(CONFIG_JSON)) : {};
let alarmsConfig = { alarms: {} };
let processorConfig = {
  max_queue_size: Number(CONFIG_DATA?.processor?.max_queue_size || 10000),
  queue_policy: String(CONFIG_DATA?.processor?.queue_policy || 'drop_oldest'),
};
const signalConfigOverrides = {};

function buildSignalConfigPayload(name) {
  const meta = SIGNALS_BY_NAME.get(name);
  const o = signalConfigOverrides[name] || {};
  return {
    signal_name: name,
    unit: o.unit ?? meta?.unit ?? null,
    min_value: o.min_value ?? meta?.min ?? null,
    max_value: o.max_value ?? meta?.max ?? null,
    group_name: o.group_name ?? null,
    widget_type: o.widget_type ?? null,
    writable: o.writable ?? !!meta?.writable,
  };
}

// car-hmi compatible config routes
app.get('/config/signal/:signal_name', (req, res) => {
  const name = resolveSignalName(req.params.signal_name);
  if (!name) return apiErr(res, 404, 'signal_config_not_found', `Signal '${req.params.signal_name}' not found`, { signal_name: req.params.signal_name });
  res.json(buildSignalConfigPayload(name));
});

app.patch('/config/signal/:signal_name', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;
  const name = resolveSignalName(req.params.signal_name);
  if (!name) return apiErr(res, 404, 'signal_config_not_found', `Signal '${req.params.signal_name}' not found`, { signal_name: req.params.signal_name });
  const base = signalConfigOverrides[name] || {};
  const body = req.body || {};
  signalConfigOverrides[name] = {
    ...base,
    ...(body.unit !== undefined ? { unit: body.unit } : {}),
    ...(body.min_value !== undefined ? { min_value: body.min_value } : {}),
    ...(body.max_value !== undefined ? { max_value: body.max_value } : {}),
    ...(body.widget_type !== undefined ? { widget_type: body.widget_type } : {}),
    ...(body.writable !== undefined ? { writable: !!body.writable } : {}),
  };
  return res.json(buildSignalConfigPayload(name));
});

app.get('/config/general', (req, res) => {
  if (!CONFIG_DATA) return apiErr(res, 503, 'general_config_unavailable', 'Config not available');
  res.json(CONFIG_DATA);
});

app.patch('/config/general', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;
  if (!CONFIG_DATA) return apiErr(res, 503, 'general_config_unavailable', 'Config not available');
  const body = req.body || {};
  deepMerge(CONFIG_DATA, body);
  res.json(CONFIG_DATA);
});

app.post('/config/general/reset', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;
  CONFIG_DATA = JSON.parse(JSON.stringify(DEFAULT_CONFIG_SNAPSHOT));
  res.json({ ok: true, default: CONFIG_DATA });
});

app.get('/config/processor', (req, res) => {
  res.json(processorConfig);
});

app.post('/config/processor', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;
  const body = req.body || {};
  if (body.max_queue_size !== undefined) processorConfig.max_queue_size = Number(body.max_queue_size);
  if (body.queue_policy !== undefined) processorConfig.queue_policy = String(body.queue_policy);
  if (CONFIG_DATA?.processor) {
    CONFIG_DATA.processor.max_queue_size = processorConfig.max_queue_size;
    CONFIG_DATA.processor.queue_policy = processorConfig.queue_policy;
  }
  res.json(processorConfig);
});

app.get('/config/alarms', (req, res) => {
  res.json(alarmsConfig);
});

app.post('/config/alarms', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;
  alarmsConfig = req.body && typeof req.body === 'object' ? req.body : { alarms: {} };
  res.json({ ok: true });
});

app.post('/config/alarms/reset', (req, res) => {
  const gate = requireProfilePermission(req, res, 'full');
  if (!gate.ok) return;
  alarmsConfig = { alarms: {} };
  res.json({ ok: true, written: alarmsConfig });
});

// ── REST: Alarms ─────────────────────────────────────────────────────────────
let alarmSeq = 1;
const alarmHistory = [];

function broadcastAlarm(alarm) {
  const payload = JSON.stringify({ type: 'alarm', ...alarm });
  wsAlarms.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  });
  wsAll.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  });
  for (const [ws, state] of wsSubState.entries()) {
    if (state.alarms && ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcastMetrics(metrics) {
  const payload = JSON.stringify({ type: 'metrics', ...metrics });
  for (const [ws, state] of wsSubState.entries()) {
    if (state.metrics && ws.readyState === ws.OPEN) ws.send(payload);
  }
  wsAll.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  });
}

if (alarmHistory.length === 0) {
  alarmHistory.push({
    id: alarmSeq++,
    signal_name: 'EngineRPM',
    level: 'warning',
    value: 3000,
    threshold: 3200,
    description: 'Seed warning alarm for demo',
    triggered_at: Date.now() / 1000,
    acknowledged: false,
    resolved_at: null,
  });
}

app.get('/alarms', (req, res) => {
  const { signal_name, level, acknowledged, limit = 50, offset = 0 } = req.query;
  let items = [...alarmHistory];
  if (signal_name) items = items.filter(a => a.signal_name === signal_name);
  if (level) items = items.filter(a => a.level === level);
  if (acknowledged !== undefined) {
    const ack = String(acknowledged).toLowerCase() === 'true';
    items = items.filter(a => !!a.acknowledged === ack);
  }
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 50);
  const sliced = items.slice(off, off + lim);
  res.json({ items: sliced, total: sliced.length });
});

app.get('/alarms/:alarm_id', (req, res) => {
  const id = Number(req.params.alarm_id);
  const found = alarmHistory.find(a => a.id === id);
  if (!found) return apiErr(res, 404, 'alarm_not_found', `Alarm ${id} not found`, { alarm_id: id });
  res.json(found);
});

function alarmStateChange(req, res, alarmId, kind) {
  const gate = requireProfilePermission(req, res, 'write');
  if (!gate.ok) return;
  const found = alarmHistory.find(a => a.id === alarmId);
  if (!found) return apiErr(res, 409, `alarm_${kind}_conflict`, `Already ${kind}d or not found`, { alarm_id: alarmId });
  if (kind === 'acknowledge') {
    if (found.acknowledged) return apiErr(res, 409, 'alarm_acknowledge_conflict', 'Already acknowledged or not found', { alarm_id: alarmId });
    found.acknowledged = true;
    broadcastAlarm(found);
    return res.json({ alarm_id: alarmId, acknowledged: true });
  }
  if (found.resolved_at) return apiErr(res, 409, 'alarm_resolve_conflict', 'Already resolved or not found', { alarm_id: alarmId });
  found.resolved_at = Date.now() / 1000;
  broadcastAlarm(found);
  return res.json({ alarm_id: alarmId, resolved: true });
}

app.post('/alarms/:alarm_id/acknowledge', (req, res) => alarmStateChange(req, res, Number(req.params.alarm_id), 'acknowledge'));
app.post('/alarms/:alarm_id/resolve', (req, res) => alarmStateChange(req, res, Number(req.params.alarm_id), 'resolve'));

// ── REST: System ─────────────────────────────────────────────────────────────
const bootTs = Date.now() / 1000;

function systemInfoPayload() {
  return {
    name: 'CAN-HMI Signal API',
    version: '1.0.0',
    description: 'Real-time CAN bus signal monitoring and control API',
    uptime_seconds: Number(((Date.now() / 1000) - bootTs).toFixed(1)),
    bus_connected: true,
    db_connected: true,
    signal_count: SIGNALS_META.length,
  };
}

app.get('/system/info', (req, res) => res.json(systemInfoPayload()));
app.get('/system/health', (req, res) => {
  const info = systemInfoPayload();
  res.json({ status: 'ok', uptime_seconds: info.uptime_seconds, bus_connected: info.bus_connected, db_connected: info.db_connected });
});
app.get('/system/ready', (req, res) => res.json({ ready: true, details: { bus: true, db: true, readers_thread_alive: true, readers_recent_frames: true, readers_no_fatal_error: true } }));
app.get('/system/metrics', (req, res) => {
  const now = Date.now() / 1000;
  const metrics = {
    timestamp: now,
    cpu_percent: 12.5,
    cpu_percent_per_core: [12.5, 11.2, 9.9, 13.7],
    cpu_count_logical: 4,
    cpu_count_physical: 4,
    cpu_freq_current_mhz: 2100,
    cpu_freq_max_mhz: 3200,
    process_cpu_percent: 2.1,
    process_memory_rss_mb: 128,
    process_memory_vms_mb: 256,
    process_memory_percent: 1.8,
    process_threads: 8,
    process_open_files: 32,
    process_pid: process.pid,
    ram_total_mb: 8192,
    ram_available_mb: 4096,
    ram_used_mb: 4096,
    ram_percent: 50,
    swap_total_mb: 1024,
    swap_used_mb: 0,
    swap_percent: 0,
    disk_total_gb: 256,
    disk_used_gb: 64,
    disk_free_gb: 192,
    disk_percent: 25,
    net_bytes_sent: 1000000,
    net_bytes_recv: 2000000,
    net_packets_sent: 10000,
    net_packets_recv: 15000,
    queue_size: 0,
    queue_maxsize: processorConfig.max_queue_size,
    queue_usage_percent: 0,
    heap_allocated_mb: 64,
    gc_objects: 10000,
    asyncio_tasks: 0,
    uptime_seconds: Number((now - bootTs).toFixed(1)),
    python_version: 'n/a-node-demo',
    platform: process.platform,
  };
  broadcastMetrics(metrics);
  res.json(metrics);
});

// aliases mounted under /api in car-hmi
app.get('/api/health', (req, res) => res.redirect(307, '/system/health'));
app.get('/api/ready', (req, res) => res.redirect(307, '/system/ready'));
app.get('/api/metrics', (req, res) => res.redirect(307, '/system/metrics'));

// ── REST: Signals ─────────────────────────────────────────────────────────────
app.get('/signals', (req, res) => {
  const resolvedName = resolveProfileName(req);
  const profile = resolvedName ? profilesState.profiles[resolvedName] : null;
  if (!profile) {
    return res.json({
      items: [],
      total: 0,
      warnings: [buildAccessWarning('profile_not_selected', 'No profile selected for this operation')],
    });
  }
  if (!profileHasPermission(profile, 'read')) {
    return res.json({
      items: [],
      total: 0,
      warnings: [buildAccessWarning('profile_permission_denied', `Profile '${resolvedName}' lacks 'read' permission`, {
        profile_name: resolvedName,
        required_permission: 'read',
      })],
    });
  }

  const warnings = [];
  const skipped = [];
  const items = [];
  const legacySignals = [];
  for (const [name, sv] of Object.entries(signalValues)) {
    const canRead = profileAllowsSignal(profile, name);
    if (!canRead) {
      skipped.push(name);
      continue;
    }
    const item = {
      signal_name: name,
      std_name: SIGNALS_BY_NAME.get(name)?.std_name || name,
      value: sv.value,
      unit: SIGNALS_BY_NAME.get(name)?.unit || null,
      timestamp: sv.timestamp,
    };
    items.push(item);
    legacySignals.push({ name: item.signal_name, std_name: item.std_name, value: item.value, timestamp: item.timestamp });
  }
  if (skipped.length) {
    warnings.push(buildAccessWarning('profile_signal_filtered', `Skipped ${skipped.length} signal(s) outside profile '${resolvedName}' scope`, {
      profile_name: resolvedName,
      required_permission: 'read',
      signals: skipped.sort(),
    }));
  }
  res.json({ items, total: items.length, warnings, timestamp: new Date().toISOString(), signals: legacySignals });
});

app.get('/signals/available', (req, res) => {
  const resolvedName = resolveProfileName(req);
  const profile = resolvedName ? profilesState.profiles[resolvedName] : null;
  if (!profile) {
    return res.json({
      signals_info: [],
      total: 0,
      warnings: [buildAccessWarning('profile_not_selected', 'No profile selected for this operation')],
    });
  }
  if (!profileHasPermission(profile, 'read')) {
    return res.json({
      signals_info: [],
      total: 0,
      warnings: [buildAccessWarning('profile_permission_denied', `Profile '${resolvedName}' lacks 'read' permission`, {
        profile_name: resolvedName,
        required_permission: 'read',
      })],
    });
  }

  const skipped = [];
  const signals_info = SIGNALS_META.map(s => {
    const sv = signalValues[s.name];
    const canRead = profileAllowsSignal(profile, s.name);
    if (!canRead) skipped.push(s.name);
    return {
      signal_name: s.name,
      std_name: s.std_name || s.name,
      tag: null,
      unit: s.unit || null,
      min_value: s.min,
      max_value: s.max,
      writable: s.writable,
      states: s.states,
      group_name: null,
      widget_type: null,
      alarm_warning_high: null,
      alarm_warning_low: null,
      alarm_critical_high: null,
      alarm_critical_low: null,
      value: canRead ? (sv?.value ?? null) : null,
      status: canRead ? 'ok' : null,
      timestamp: canRead ? (sv?.timestamp ?? null) : null,
    };
  });
  const warnings = [];
  if (skipped.length) {
    warnings.push(buildAccessWarning('profile_signal_filtered', `Skipped ${skipped.length} signal(s) outside profile '${resolvedName}' scope`, {
      profile_name: resolvedName,
      required_permission: 'read',
      signals: skipped.sort(),
    }));
  }
  res.json({ signals_info, total: signals_info.length, warnings });
});

/** GET /signals/:name — single signal current value + metadata */
app.get('/signals/:name', (req, res) => {
  const ref = req.params.name;
  const meta = resolveSignalMeta(ref);
  const gate = requireProfilePermission(req, res, 'read', { signalName: meta?.name || ref });
  if (!gate.ok) return;
  if (!meta) return err(res, 3004, 'VAL_NOT_FOUND', `Signal '${ref}' not found`, 404);
  const sv = signalValues[meta.name];
  res.json({
    signal_name: meta.name,
    name: meta.name,
    std_name: meta.std_name || meta.name,
    value: sv?.value ?? 0,
    timestamp: sv?.timestamp ?? null,
    unit: meta.unit,
    min: meta.min,
    max: meta.max,
    writable: meta.writable,
    description: meta.description,
    states: meta.states,
  });
});

app.get('/signals/:name/history', (req, res) => {
  const ref = req.params.name;
  const meta = resolveSignalMeta(ref);
  const gate = requireProfilePermission(req, res, 'read', { signalName: meta?.name || ref });
  if (!gate.ok) return;
  if (!meta) return err(res, 3004, 'VAL_NOT_FOUND', `Signal '${ref}' not found`, 404);
  const sv = signalValues[meta.name];
  const item = {
    signal_name: meta.name,
    value: sv?.value ?? 0,
    unit: meta.unit || null,
    timestamp: sv?.timestamp ?? Date.now() / 1000,
  };
  res.json({ items: [item], total: 1, warnings: [] });
});

app.put('/signals/:name', (req, res) => {
  const { name } = req.params;
  const meta = resolveSignalMeta(name);
  const gate = requireProfilePermission(req, res, 'write', { signalName: meta?.name || name });
  if (!gate.ok) return;
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
  const gate = requireProfilePermission(req, res, 'write');
  if (!gate.ok) return;
  const { signals: items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return err(res, 3002, 'VAL_MISSING_FIELD', 'signals array required', 400);
  const queued = [];
  const errors = [];
  const warnings = [];
  const skippedByScope = [];
  for (const item of items) {
    const ref = item?.name ?? item?.signal_name ?? item?.std_name;
    const value = item?.value;
    const meta = resolveSignalMeta(ref);
    if (!meta) {
      errors.push({ signal_name: ref, value, error: 'not_found' });
      continue;
    }
    if (gate.profile && !profileAllowsSignal(gate.profile, meta.name)) {
      skippedByScope.push(meta.name);
      continue;
    }
    if (!meta.writable) {
      errors.push({ signal_name: meta.name, value, error: 'not_writable' });
      continue;
    }
    const v = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(v) || v < meta.min || v > meta.max) {
      errors.push({ signal_name: meta.name, value, error: 'out_of_range' });
      continue;
    }
    signalValues[meta.name] = { value: v, timestamp: Date.now() / 1000 };
    queued.push({ signal_name: meta.name, value: v });
  }
  if (skippedByScope.length) {
    warnings.push(buildAccessWarning('profile_signal_filtered', `Skipped ${skippedByScope.length} signal(s) outside profile '${gate.profileName}' scope`, {
      profile_name: gate.profileName,
      required_permission: 'write',
      signals: [...new Set(skippedByScope)].sort(),
    }));
  }
  // push all successful writes to subscribed WS clients
  broadcastWrite(queued.map(r => ({ name: r.signal_name, value: r.value })));
  res.status(202).json({ queued, count: queued.length, queued_at: Date.now() / 1000, errors, warnings });
});

// ── REST: Restraints ──────────────────────────────────────────────────────────
const RESTRAINTS_MEDIA_DIR = path.join(ROOT, 'media');
const VALID_SEATBELT_SYSTEMS = ['SLL', 'CLL', 'MSLL'];
const VALID_VELOCITIES = [35, 40, 50, 56];
const OLC_TO_VELOCITY = { OLC16: 35, OLC18: 40, OLC26: 50, OLC33: 56 };
const SEAT_SIGNAL_MAP = {
  fl: {
    occClass: 'OMS_FL_OccupantClassification',
    oop: 'OMS_FL_OutOfPosition',
    seatX: 'SPS_FL_SeatDirectionX',
  },
  fr: {
    occClass: 'OMS_FR_OccupantClassification',
    oop: 'OMS_FR_OutOfPosition',
    seatX: 'SPS_FR_SeatDirectionX',
  },
};

function derivePercentileFromWeight(weightKg) {
  if (weightKg < 65) return 5;
  if (weightKg <= 90) return 50;
  return 95;
}

function resolveVelocityFromCrashSeverity(crashSeverity) {
  const text = String(crashSeverity || '').trim().toUpperCase();
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(OLC_TO_VELOCITY, text)) return OLC_TO_VELOCITY[text];
  const num = Number(text);
  if (Number.isFinite(num) && VALID_VELOCITIES.includes(num)) return num;
  return null;
}

function resolveSeatPositionZone(seatXmm) {
  if (!Number.isFinite(seatXmm)) return 'mid';
  if (seatXmm < 56.75) return 'front';
  if (seatXmm < 170.25) return 'mid';
  return 'rear';
}

function resolvePercentileFromCan(rawValue) {
  const value = Number(rawValue);
  if (value === 1) return 5;
  if (value === 2) return 50;
  if (value === 3) return 95;
  return null;
}

function parseMediaFilename(filename) {
  const m = String(filename || '').match(/^(5|50|95)p_(front|mid|rear)_(35|40|50|56)_(SLL|CLL|MSLL)\.[A-Za-z0-9]+$/);
  if (!m) return null;
  return {
    filename,
    percentile: Number(m[1]),
    seat_position: m[2],
    velocity_kmh: Number(m[3]),
    seatbelt: m[4],
  };
}

function listRestraintsCandidates() {
  if (!fs.existsSync(RESTRAINTS_MEDIA_DIR)) return [];
  const files = fs.readdirSync(RESTRAINTS_MEDIA_DIR, { withFileTypes: true });
  const out = [];
  for (const item of files) {
    if (!item.isFile()) continue;
    const parsed = parseMediaFilename(item.name);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
}

function scoreCandidate(candidate, expected) {
  let score = 0;
  if (candidate.seatbelt === expected.seatbelt) score += 3.0;
  if (candidate.percentile === expected.percentile) score += 2.0;
  if (candidate.seat_position === expected.seatPosition) score += 1.0;
  
  if (candidate.velocity_kmh === expected.velocityKmh) {
    score += 4;
  }

  return Number(score.toFixed(3));
}

app.get('/api/restraints/match', (req, res) => {
  const {
    weight,
    height,
    crash_severity,
    seatbelt_system,
    seat = 'fl',
    seat_x_mm,
  } = req.query;

  if (weight === undefined) return err(res, 3002, 'VAL_MISSING_FIELD', 'weight is required', 400);
  if (height === undefined) return err(res, 3002, 'VAL_MISSING_FIELD', 'height is required', 400);
  if (crash_severity === undefined) return err(res, 3002, 'VAL_MISSING_FIELD', 'crash_severity is required', 400);
  if (seatbelt_system === undefined) return err(res, 3002, 'VAL_MISSING_FIELD', 'seatbelt_system is required', 400);

  const weightKg = Number(weight);
  const heightCm = Number(height);
  if (!Number.isFinite(weightKg) || weightKg <= 0)
    return err(res, 3003, 'VAL_OUT_OF_RANGE', 'weight must be a positive number', 422);
  if (!Number.isFinite(heightCm) || heightCm <= 0)
    return err(res, 3003, 'VAL_OUT_OF_RANGE', 'height must be a positive number', 422);

  const seatKey = String(seat || 'fl').toLowerCase();
  if (!SEAT_SIGNAL_MAP[seatKey])
    return err(res, 3003, 'VAL_OUT_OF_RANGE', `Unknown seat '${seat}'. Valid: fl, fr`, 422);

  const seatbelt = String(seatbelt_system || '').trim().toUpperCase();
  if (!VALID_SEATBELT_SYSTEMS.includes(seatbelt))
    return err(res, 3003, 'VAL_OUT_OF_RANGE', `Unknown seatbelt_system '${seatbelt_system}'. Valid: ${VALID_SEATBELT_SYSTEMS.join(', ')}`, 422);

  const velocityKmh = resolveVelocityFromCrashSeverity(crash_severity);
  if (!velocityKmh)
    return err(res, 3003, 'VAL_OUT_OF_RANGE', `Unknown crash_severity '${crash_severity}'. Valid: ${VALID_VELOCITIES.join(', ')} or ${Object.keys(OLC_TO_VELOCITY).join(', ')}`, 422);

  const seatSignals = SEAT_SIGNAL_MAP[seatKey];
  const canOccRaw = signalValues[seatSignals.occClass]?.value;
  const canOopRaw = signalValues[seatSignals.oop]?.value;
  const canSeatXRaw = signalValues[seatSignals.seatX]?.value;

  const seatXParam = seat_x_mm === undefined ? null : Number(seat_x_mm);
  if (seat_x_mm !== undefined && !Number.isFinite(seatXParam))
    return err(res, 3003, 'VAL_OUT_OF_RANGE', 'seat_x_mm must be a number', 422);

  let seatXmm = null;
  let seatXSource = 'default';
  if (seatXParam !== null) {
    seatXmm = seatXParam;
    seatXSource = 'hmi_param';
  } else if (Number.isFinite(canSeatXRaw)) {
    seatXmm = Number(canSeatXRaw);
    seatXSource = 'can_signal';
  }

  const derivedPercentile = derivePercentileFromWeight(weightKg);
  const canPercentile = resolvePercentileFromCan(canOccRaw);
  // const effectivePercentile = canPercentile ?? derivedPercentile;
  const effectivePercentile = derivedPercentile;
  const seatPositionZone = resolveSeatPositionZone(seatXmm);

  const expected = {
    seatbelt,
    percentile: effectivePercentile,
    seatPosition: seatPositionZone,
    velocityKmh,
  };

  const candidates = listRestraintsCandidates();
  const scored = candidates
    .map(c => ({ ...c, score: scoreCandidate(c, expected) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0] || null;

  const context = {
    weight_kg: Number(weightKg.toFixed(3)),
    height_cm: Number(heightCm.toFixed(3)),
    derived_percentile: derivedPercentile,
    effective_percentile: effectivePercentile,
    can_percentile: canPercentile,
    target_velocity_kmh: velocityKmh,
    seatbelt_system: seatbelt,
    seat: seatKey,
    seat_x_mm: seatXmm,
    seat_x_source: seatXSource,
    seat_position_zone: seatPositionZone,
    out_of_position: Number(canOopRaw || 0) !== 0,
    candidates_found: candidates.length,
  };

  if (!best) {
    return res.json({
      matched: false,
      video: null,
      score: 0,
      context,
    });
  }

  return res.json({
    matched: true,
    score: best.score,
    video: {
      filename: best.filename,
      percentile: best.percentile,
      seat_position: best.seat_position,
      velocity_kmh: best.velocity_kmh,
      seatbelt: best.seatbelt,
      url: `/api/restraints/video/${encodeURIComponent(best.filename)}`,
    },
    context,
  });
});

// Map file extension → MIME type for video streaming
function getMimeType(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const mimes = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    flv: 'video/x-flv',
  };
  return mimes[ext] || 'application/octet-stream';
}

app.get('/api/restraints/video/:filename', (req, res) => {
  const filename = String(req.params.filename || '');
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return err(res, 3003, 'VAL_OUT_OF_RANGE', 'invalid filename', 400);
  }

  const mediaPath = path.resolve(RESTRAINTS_MEDIA_DIR);
  const targetPath = path.resolve(path.join(mediaPath, filename));
  if (!targetPath.startsWith(mediaPath + path.sep)) {
    return err(res, 3003, 'VAL_OUT_OF_RANGE', 'invalid filename', 400);
  }
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return err(res, 3004, 'VAL_NOT_FOUND', 'video file not found', 404);
  }

  const stat = fs.statSync(targetPath);
  const fileSize = stat.size;
  const mimeType = getMimeType(filename);
  const range = req.headers.range;

  // ── Handle HTTP Range requests (for video streaming) ────────────────────────
  if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      const validStart = isNaN(start) ? 0 : start;
      const validEnd = isNaN(end) ? fileSize - 1 : end;

      if (validStart >= fileSize || validEnd >= fileSize || validStart > validEnd) {
          return res.status(416).set({
              'Content-Range': `bytes */${fileSize}`,
          }).end();
      }

      const chunkSize = (validEnd - validStart) + 1;

      res.status(206).set({
          'Content-Range': `bytes ${validStart}-${validEnd}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
      });

      // ✅ CRITICAL FIX
      return fs.createReadStream(targetPath, { start: validStart, end: validEnd }).pipe(res);
  }

  // ── No Range header: send full file ────────────────────────────────────────
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Length': fileSize,
    'Content-Type': mimeType,
    'Cache-Control': 'public, max-age=3600',
  });
  return fs.createReadStream(targetPath).pipe(res);
});

// ── REST: Camera (simulation) ────────────────────────────────────────────────
app.get('/api/camera/status', (req, res) => {
  res.json({
    enabled: false,
    stream_url: null,
    connected: false,
    viewer_count: 0,
    last_error: 'Camera stream not configured in demo server',
  });
});

app.get('/api/camera/stream', (req, res) => {
  res.status(503).json({ detail: 'Camera stream unavailable in demo environment' });
});

// ── REST: Adaptive Restraint (simulation) ───────────────────────────────────
app.get('/adaptive_restraint/available', (req, res) => {
  res.json({
    System: ['fusion', 'camera', 'non_adapt'],
    Age: ['35y', '65y'],
    Seatbelt: ['3-point'],
    Velocity: [40, 50, 56],
    Weight: [49.0, 58.67, 70.0],
    Height: [155.0, 159.67, 170.0],
    Distance: [1440, 1534, 1620],
  });
});

app.get('/adaptive_restraint/chart_info', (req, res) => {
  const controls = {
    System: req.query.System ? [].concat(req.query.System) : ['fusion'],
    Age: req.query.Age ? [].concat(req.query.Age) : ['35y'],
    Seatbelt: req.query.Seatbelt ? [].concat(req.query.Seatbelt) : ['3-point'],
    Velocity: req.query.Velocity ? [].concat(req.query.Velocity).map(Number) : [40],
    Weight: req.query.Weight ? [].concat(req.query.Weight).map(Number) : [49.0],
    Height: req.query.Height ? [].concat(req.query.Height).map(Number) : [159.67],
    Distance: req.query.Distance ? [].concat(req.query.Distance).map(Number) : [1440],
    RawData: String(req.query.RawData || 'true').toLowerCase() !== 'false',
  };
  const datas = [{
    injury_risk_fusion_35y: {
      values: [0.0031, 0.0045, 0.0052],
      min: 0.0031,
      max: 0.0052,
      'lower fence': 0.0031,
      q1: 0.0038,
      median: 0.0045,
      q3: 0.0049,
      'upper fence': 0.0052,
    },
  }];
  const payload = {
    controls,
    datas,
    available_options: {
      Velocity: [40, 50, 56],
      Weight: [49.0, 58.67, 70.0],
      Height: [155.0, 159.67, 170.0],
      Distance: [1440, 1534, 1620],
      Seatbelt: ['3-point'],
    },
  };
  if (controls.RawData) {
    payload.raw_rows = [{
      weight: 49.0,
      seat_position: 1440,
      height: 159.67,
      'velocity [km/h]': 40,
      'Seatbelt Component': '3-point',
      injury_risk_fusion_35y: 0.0031,
    }];
  }
  res.json(payload);
});

// Static: serve everything after API routes
app.use(express.static(ROOT));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wsSignals = new WebSocketServer({ server, path: '/ws/signals' });
const wsSubscribe = new WebSocketServer({ server, path: '/ws/subscribe' });
const wsAlarms = new WebSocketServer({ server, path: '/ws/alarms' });
const wsAll = new WebSocketServer({ server, path: '/ws/all' });

const wsSubState = new Map(); // ws -> {signals:Set|'*', alarms:boolean, metrics:boolean, profileName:string|null}

function wsAuthorized(req) {
  if (!API_KEY_ENABLED) return true;
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('api_key') === CONFIGURED_API_KEY;
  } catch (_) {
    return false;
  }
}

function wsProfileFromReq(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('profile_name');
  } catch (_) {
    return null;
  }
}

function getOrCreateWsState(ws, profileName = null) {
  let st = wsSubState.get(ws);
  if (!st) {
    st = { signals: '*', alarms: false, metrics: false, profileName };
    wsSubState.set(ws, st);
  }
  return st;
}

function pickSignalsByState(state, inputSignals) {
  const out = [];
  const warnings = [];
  const profile = state.profileName ? profilesState.profiles[state.profileName] : null;
  const canRead = !profile || profileHasPermission(profile, 'read');
  if (!canRead) {
    warnings.push(buildAccessWarning('profile_permission_denied', `Profile '${state.profileName}' lacks 'read' permission`, {
      profile_name: state.profileName,
      required_permission: 'read',
    }));
    return { channels: [], warnings };
  }

  const rawList = inputSignals === '*' ? ['*'] : (Array.isArray(inputSignals) ? inputSignals : []);
  for (const ch of rawList) {
    const low = String(ch).toLowerCase();
    if (ch === '*') {
      if (!profile) {
        out.push('*');
      } else {
        const allowed = (profile.signals || []).map(s => resolveSignalName(s)).filter(Boolean);
        out.push(...allowed);
        warnings.push(buildAccessWarning('profile_signal_filtered', `Wildcard subscription limited to profile '${state.profileName}' signals`, {
          profile_name: state.profileName,
          required_permission: 'read',
          signals: [...new Set(allowed)].sort(),
        }));
      }
      continue;
    }
    if (low === 'alarms' || low === 'metrics') {
      out.push(low);
      continue;
    }
    const canonical = resolveSignalName(ch);
    if (!canonical) continue;
    if (profile && !profileAllowsSignal(profile, canonical)) {
      warnings.push(buildAccessWarning('profile_signal_denied', `Signal '${canonical}' is outside profile '${state.profileName}' scope`, {
        profile_name: state.profileName,
        required_permission: 'read',
        signal_name: canonical,
      }));
      continue;
    }
    out.push(canonical);
  }
  return { channels: [...new Set(out)], warnings };
}

function sendSignalFrame(ws, names) {
  const entries = [];
  for (const n of names) {
    const p = signalPayload(n);
    if (p) entries.push(p);
  }
  if (!entries.length) return;
  ws.send(JSON.stringify({ timestamp: new Date().toISOString(), signals: entries }));
}

function broadcastWrite(updates) {
  if (!updates.length) return;
  const names = updates.map(u => u.name).filter(Boolean);
  const payload = {
    timestamp: new Date().toISOString(),
    signals: names.map(n => signalPayload(n)).filter(Boolean),
  };

  for (const [ws, state] of wsSubState.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    if (state.signals === '*') {
      ws.send(JSON.stringify(payload));
      continue;
    }
    const filtered = names.filter(n => state.signals.has(n));
    if (!filtered.length) continue;
    sendSignalFrame(ws, filtered);
  }

  wsAll.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  });
}

function attachSignalSocket(ws, req) {
  if (!wsAuthorized(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  const profileName = wsProfileFromReq(req);
  const state = getOrCreateWsState(ws, profileName);
  const clientVals = Object.fromEntries(Object.entries(signalValues).map(([k, v]) => [k, { ...v }]));

  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const updates = [];
    const stateSignals = state.signals;
    SIGNALS_META.forEach(s => {
      if (s.writable) return;
      if (stateSignals !== '*' && !stateSignals.has(s.name)) return;
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
      updates.push({ name: s.name, value: nv, timestamp: Date.now() / 1000 });
    });
    if (updates.length) {
      ws.send(JSON.stringify({ timestamp: new Date().toISOString(), signals: updates.map(u => signalPayload(u.name, u.value, u.timestamp)).filter(Boolean) }));
    }
  }, 500);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    const action = (msg.type === 'subscribe' || msg.type === 'unsubscribe')
      ? msg.type
      : (msg.action || 'subscribe');
    const requested = msg.signals !== undefined ? msg.signals : msg.channels;
    const rawChannels = requested === '*' ? '*' : (Array.isArray(requested) ? requested : []);
    const mapped = pickSignalsByState(state, rawChannels);

    if (action === 'subscribe') {
      for (const ch of mapped.channels) {
        if (ch === 'alarms') state.alarms = true;
        else if (ch === 'metrics') state.metrics = true;
      }
      if (mapped.channels.includes('*')) {
        state.signals = '*';
      } else {
        if (state.signals === '*') state.signals = new Set();
        mapped.channels.forEach(ch => {
          if (ch !== 'alarms' && ch !== 'metrics') state.signals.add(ch);
        });
      }
    } else if (action === 'unsubscribe') {
      const chs = rawChannels === '*' ? ['*'] : rawChannels;
      for (const c of chs) {
        const low = String(c).toLowerCase();
        if (low === 'alarms') state.alarms = false;
        else if (low === 'metrics') state.metrics = false;
        else if (c === '*') state.signals = new Set();
        else if (state.signals !== '*') {
          const n = resolveSignalName(c);
          if (n) state.signals.delete(n);
        }
      }
    }

    const ackChannels = action === 'subscribe' ? mapped.channels : (rawChannels === '*' ? ['*'] : rawChannels);
    ws.send(JSON.stringify({
      type: `${action}_ack`,
      action,
      channels: ackChannels,
      count: ackChannels.length,
      warnings: mapped.warnings,
    }));
    // legacy ack for existing demo clients
    ws.send(JSON.stringify({ type: 'subscribed', signals: state.signals === '*' ? '*' : [...state.signals], count: state.signals === '*' ? SIGNALS_META.length : state.signals.size }));

    if (action === 'subscribe') {
      if (state.signals === '*') {
        sendSignalFrame(ws, SIGNALS_META.filter(s => !s.writable).map(s => s.name));
      } else {
        sendSignalFrame(ws, [...state.signals]);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(timer);
    wsSubState.delete(ws);
  });
  ws.on('error', () => {
    clearInterval(timer);
    wsSubState.delete(ws);
  });
}

wsSignals.on('connection', (ws, req) => attachSignalSocket(ws, req));
wsSubscribe.on('connection', (ws, req) => attachSignalSocket(ws, req));

wsAlarms.on('connection', (ws, req) => {
  if (!wsAuthorized(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch (_) {}
  });
});

wsAll.on('connection', (ws, req) => {
  if (!wsAuthorized(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch (_) {}
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] REST API : http://localhost:${PORT}/api/info`);
  console.log(`[server] Swagger  : http://localhost:${PORT}/docs`);
  console.log(`[server] WS stream: ws://localhost:${PORT}/ws/signals`);
  console.log(`[server] WS docs  : http://localhost:${PORT}/ws-docs`);
});
