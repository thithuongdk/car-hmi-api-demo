/**
 * mock.js - Simulates full CAN-HMI backend: REST + WebSocket + Logger
 * Based on BE-FE-Review.json contract.
 * No real server needed - all data is stored in localStorage.
 */

// ── Default data ──────────────────────────────────────────────────────────────
// Populated asynchronously by Store.init() from data/can0.json (path in config.json)
let _SIGNALS_META = [];
let _SIGNAL_STD_MAP = {};
let _INFO_DATA = null;    // populated from data/info.json
let _CONFIG_DATA = null;  // populated from data/config.json
let _SIGNALS_BY_NAME = new Map();
let _SIGNALS_BY_STD_NAME = new Map();
const _CLIENT_ID_KEY = 'car_hmi_client_id';

function _getClientId() {
  let id = localStorage.getItem(_CLIENT_ID_KEY);
  if (!id) {
    id = `client-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(_CLIENT_ID_KEY, id);
  }
  return id;
}

function _rebuildSignalLookups() {
  _SIGNALS_BY_NAME = new Map(_SIGNALS_META.map(s => [s.name, s]));
  _SIGNALS_BY_STD_NAME = new Map(_SIGNALS_META.map(s => [s.std_name || s.name, s.name]));
}

function _resolveSignalName(ref) {
  if (!ref) return null;
  if (_SIGNALS_BY_NAME.has(ref)) return ref;
  return _SIGNALS_BY_STD_NAME.get(ref) || null;
}

function _resolveSignalMeta(ref) {
  const name = _resolveSignalName(ref);
  return name ? _SIGNALS_BY_NAME.get(name) || null : null;
}

function _signalPayload(name, value, timestamp) {
  const meta = _SIGNALS_BY_NAME.get(name);
  if (!meta) return null;
  const sv = Store.get().signal_values[name];
  return {
    name: meta.name,
    std_name: meta.std_name || meta.name,
    value: value ?? sv?.value ?? 0,
    timestamp: timestamp ?? sv?.timestamp ?? null,
  };
}

function _normalizeSignalList(signals) {
  if (signals === '*') return '*';
  if (!Array.isArray(signals)) return [];
  return [...new Set(signals.map(_resolveSignalName).filter(Boolean))];
}

/**
 * Flatten can0.json messages → array of signal meta objects.
 * Matches the internal signal meta shape used by Store and MockAPI.
 */
function _parseCan0Signals(can0) {
  const signals = [];
  const seen    = new Set();
  for (const [, msg] of Object.entries(can0.messages || {})) {
    for (const [sigName, sig] of Object.entries(msg.signals || {})) {
      if (seen.has(sigName)) continue;
      seen.add(sigName);
      signals.push({
        name:        sigName,
        std_name:    _SIGNAL_STD_MAP[sigName] || sigName,
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

function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _signalRule(s) {
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

// Fallback used only if can0.json cannot be fetched (e.g. bare file:// open)
const _FALLBACK_SIGNALS_META = [
  { name: "EngineSpeed",  unit: "rpm", min: 0, max: 8000, writable: false, description: "Engine speed", states: [] },
  { name: "CoolantTemp",  unit: "°C",  min: 0, max: 120,  writable: false, description: "Coolant temperature", states: [] },
  { name: "BrakePressure",unit: "bar", min: 0, max: 200,  writable: false, description: "Brake pressure", states: [] },
  { name: "HB_FL_ActivationLevel", unit: "", min: 0, max: 7, writable: true,
    description: "HB Front-Left Activation Level",
    states: Array.from({ length: 8 }, (_, i) => ({ value: i, description: `Level ${i+1}` })) },
];

// Built lazily inside _defaults() so it can use the populated _SIGNALS_META
function _defaultProfiles() {
  const allNames = _SIGNALS_META.map(s => s.name);
  // Pick a small representative subset for demo profiles
  const subset = allNames.filter(n =>
    ["HB_FL_ActivationLevel","HB_FR_ActivationLevel","WMS_FL_WebbingMovement","SPS_FL_SeatPositionX"].includes(n)
  ).slice(0, 4);
  return [
    { profile_name: "Dev", signals: allNames,  selected: true  },
    { profile_name: "U0",  signals: subset.length ? subset : allNames.slice(0, 4), selected: false },
    { profile_name: "U1",  signals: allNames.slice(0, 2),  selected: false },
    { profile_name: "U2",  signals: allNames.slice(0, 8),  selected: false },
  ];
}

const _DEFAULT_CONFIGS = [
  { config_name: "high_load", sampling_rate: 100, RTSP_url: "rtsp://example.com/stream", WebRTC_url: "", selected: true  },
  { config_name: "low_load",  sampling_rate: 10,  RTSP_url: "", WebRTC_url: "", selected: false },
];

// ── Store (localStorage-backed) ───────────────────────────────────────────────
const Store = (() => {
  const SK = "car-hmi-demo-v1";

  function _defaults() {
    const vals = {};
    _SIGNALS_META.forEach(s => {
      let initVal;
      if (s.states.length) {
        // enum: pick a random valid state value
        initVal = s.states[Math.floor(Math.random() * s.states.length)].value;
      } else {
        const { min, max } = _signalRule(s);
        initVal = _randInt(Math.ceil(min), Math.floor(max));
      }
      vals[s.name] = { value: initVal, timestamp: Date.now() / 1000 };
    });

    // Seed profiles from info.json if available, else use generated defaults
    const base = _INFO_DATA?.profiles
      ? JSON.parse(JSON.stringify(_INFO_DATA.profiles))
      : JSON.parse(JSON.stringify(_defaultProfiles()));
    if (!base.some(p => p.selected)) base[0].selected = true;
    return {
      section_id: 1,
      profiles:     base,
      profile_sessions: {},
      configs:      JSON.parse(JSON.stringify(_DEFAULT_CONFIGS)),
      signals_meta: JSON.parse(JSON.stringify(_SIGNALS_META)),
      signal_values: vals,
    };
  }

  let _data = null;
  function _load() { try { const r = localStorage.getItem(SK); if (r) return JSON.parse(r); } catch (_) {} return null; }
  function _save()  { try { localStorage.setItem(SK, JSON.stringify(_data)); } catch (_) {} }
  function get()    { if (!_data) _data = _load() || _defaults(); return _data; }
  function save()   { _save(); }
  function reset()  { localStorage.removeItem(SK); _data = null; }

  /** Fetch can0.json (path from config.json) and populate _SIGNALS_META. Must be awaited before first get(). */
  async function init() {
    // Load std-name aliases first so signal metadata can include std_name.
    try {
      const sr = await fetch('data/signal_std_name.json');
      if (sr.ok) _SIGNAL_STD_MAP = await sr.json();
    } catch (_) { /* silent */ }

    // Load config first to resolve the CAN DB path
    let can0Path = 'data/can0.json';
    try {
      const cr = await fetch('data/config.json');
      if (cr.ok) {
        _CONFIG_DATA = await cr.json();
        can0Path = _CONFIG_DATA?.can_db?.path || can0Path;
      }
    } catch (_) { /* silent */ }

    // Load CAN DB signals
    try {
      const resp = await fetch(can0Path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      _SIGNALS_META = _parseCan0Signals(json);
    } catch (e) {
      console.warn('[Store.init] Could not load CAN DB from', can0Path, '- using fallback signals.', e);
      _SIGNALS_META = JSON.parse(JSON.stringify(_FALLBACK_SIGNALS_META));
    }
    _rebuildSignalLookups();
    // Fetch project info (non-critical - app works fine without it)
    try {
      const ir = await fetch('data/info.json');
      if (ir.ok) {
        const raw = await ir.json();
        // Redact sensitive fields before caching
        _INFO_DATA = { ...raw, server: raw.server ? { ...raw.server, api_key: '[REDACTED]' } : raw.server };
      }
    } catch (_) { /* silent - info is optional */ }

    // If localStorage has stale data (different signal count), reset it
    const saved = _load();
    if (saved && saved.signals_meta && saved.signals_meta.length !== _SIGNALS_META.length) {
      localStorage.removeItem(SK);
    }
    _data = null; // force re-init with fresh meta
  }

  return { get, save, reset, init };
})();

// ── Logger ────────────────────────────────────────────────────────────────────
const Log = (() => {
  const entries = [];
  let count = 0;
  let _listener = null;

  function api(method, url, req, res, status = 200) {
    count++;
    const e = { id: count, type: "api", ts: new Date().toLocaleTimeString("en-GB"), method, url, request: req, response: res, status };
    entries.unshift(e);
    if (entries.length > 300) entries.pop();
    _listener?.(e);
    _badge();
  }

  function ws(event, detail) {
    count++;
    const e = { id: count, type: "ws", ts: new Date().toLocaleTimeString("en-GB"), event, detail };
    entries.unshift(e);
    if (entries.length > 300) entries.pop();
    _listener?.(e);
  }

  function _badge() {
    const el = document.getElementById("api-count");
    if (el) el.textContent = `${count} calls`;
  }

  function all()       { return entries; }
  function clear()     { entries.length = 0; count = 0; _badge(); }
  function onNew(fn)   { _listener = fn; }

  return { api, ws, all, clear, onNew };
})();

// ── Latency helper ────────────────────────────────────────────────────────────
const delay = (ms = 80) => new Promise(r => setTimeout(r, 50 + Math.random() * ms));

// ── MockAPI ───────────────────────────────────────────────────────────────────
const MockAPI = {

  // ── Profiles ──────────────────────────────────────────────────────────────

  /** GET /api/profiles */
  async getProfiles() {
    await delay();
    const d = Store.get();
    const active = d.profiles.find(p => p.selected)?.profile_name || d.profiles[0]?.profile_name || null;
    const res = {
      profiles: d.profiles.map(p => ({
        name: p.profile_name,
        signals: p.signals || [],
        permission: Array.isArray(p.permission) && p.permission.length ? p.permission : ['read'],
        description: p.description || '',
        section_id: String(d.section_id).padStart(12, '0').slice(-12),
      })),
      active,
      global_active: active,
      total: d.profiles.length,
      client_id: _getClientId(),
    };
    Log.api("GET", "/api/profiles", null, res);
    return res;
  },

  /** GET /api/profile?name=X  (or active if no name) */
  async getProfile(name) {
    await delay();
    const d = Store.get();
    const p = name ? d.profiles.find(p => p.profile_name === name || p.name === name) : d.profiles.find(p => p.selected);
    if (!p) { Log.api("GET", `/api/profile?name=${name}`, null, { error: "Not found" }, 404); throw new Error("Profile not found"); }
    const out = {
      name: p.profile_name,
      signals: p.signals || [],
      permission: Array.isArray(p.permission) && p.permission.length ? p.permission : ['read'],
      description: p.description || '',
      section_id: String(d.section_id).padStart(12, '0').slice(-12),
    };
    Log.api("GET", `/api/profile?name=${name || "(active)"}`, null, out);
    return out;
  },

  /** POST /api/profile */
  async createProfile(payload) {
    await delay();
    const d = Store.get();
    const profileName = (payload?.name || payload?.profile_name || '').trim();
    if (!profileName) {
      Log.api("POST", "/api/profile", payload, { error: "name is required" }, 400);
      throw new Error("name is required");
    }
    if (d.profiles.find(p => p.profile_name === profileName)) {
      Log.api("POST", "/api/profile", payload, { error: "Profile name already exists" }, 409);
      throw new Error("Profile '" + profileName + "' already exists");
    }
    const permission = Array.isArray(payload?.permission) && payload.permission.length ? payload.permission : ['read'];
    const np = {
      profile_name: profileName,
      name: profileName,
      signals: payload.signals || [],
      permission: permission.includes('full') ? ['full'] : permission,
      description: payload?.description || '',
      selected: false,
    };
    d.profiles.push(np);
    if (!d.profiles.some(p => p.selected)) np.selected = true;
    d.section_id++;
    Store.save();
    const out = { ...np, section_id: String(d.section_id).padStart(12, '0').slice(-12) };
    Log.api("POST", "/api/profile", payload, out, 201);
    return out;
  },

  /** PUT /api/profile  (section_id must match) */
  async updateProfile(payload) {
    await delay();
    const d = Store.get();
    const expected = String(d.section_id).padStart(12, '0').slice(-12);
    const given = String(payload.section_id || '');
    if (given && given !== expected) {
      const err = { error: `section_id mismatch: expected ${expected}, got ${given}` };
      Log.api("PUT", "/api/profile", payload, err, 409);
      throw new Error(err.error);
    }
    const profileName = (payload?.name || payload?.profile_name || '').trim();
    const idx = d.profiles.findIndex(p => p.profile_name === profileName);
    if (idx < 0) throw new Error("Profile not found");
    d.profiles[idx] = {
      ...d.profiles[idx],
      signals: Array.isArray(payload.signals) ? payload.signals : d.profiles[idx].signals,
      description: payload.description !== undefined ? payload.description : d.profiles[idx].description,
      permission: Array.isArray(payload.permission) && payload.permission.length
        ? (payload.permission.includes('full') ? ['full'] : payload.permission)
        : d.profiles[idx].permission,
    };
    d.section_id++;
    Store.save();
    const out = { ...d.profiles[idx], section_id: String(d.section_id).padStart(12, '0').slice(-12) };
    Log.api("PUT", "/api/profile", payload, out);
    return out;
  },

  /** DELETE /api/profile/:name */
  async deleteProfile(name) {
    await delay();
    const d = Store.get();
    const idx = d.profiles.findIndex(p => p.profile_name === name);
    if (idx < 0) { Log.api("DELETE", `/api/profile/${name}`, null, { error: "Not found" }, 404); throw new Error("Not found"); }
    d.profiles.splice(idx, 1);
    d.section_id++;
    if (!d.profiles.some(p => p.selected) && d.profiles[0]) d.profiles[0].selected = true;
    Store.save();
    Log.api("DELETE", `/api/profile/${name}`, null, null, 204);
    return null;
  },

  /** Mark one profile as selected (active) */
  async selectProfile(name) {
    await delay(40);
    const d = Store.get();
    const found = d.profiles.find(p => p.profile_name === name || p.name === name);
    if (!found) {
      Log.api("PUT", "/api/profile/active", { name }, { error: 'Profile not found' }, 404);
      throw new Error('Profile not found');
    }
    d.profiles.forEach(p => { p.selected = (p.profile_name === name); });
    Store.save();
    localStorage.setItem('car_hmi_profile_name', name);
    const out = { active: name, global_active: name, client_id: _getClientId(), warnings: [] };
    Log.api("PUT", "/api/profile/active", { name }, out, 200);
    return out;
  },

  async getProfileSessions() {
    await delay();
    const d = Store.get();
    const now = Date.now() / 1000;
    const sessionsMap = d.profile_sessions || {};
    const sessions = Object.entries(sessionsMap).map(([client_id, st]) => {
      const lastSeen = Number(st.last_seen || st.updated_at || 0);
      const online = (now - lastSeen) <= 600;
      return {
        client_id,
        active: st.active,
        updated_at: Number(st.updated_at || 0),
        last_seen: lastSeen,
        status: online ? 'online' : 'offline',
      };
    });
    const online_total = sessions.filter(s => s.status === 'online').length;
    const offline_total = sessions.length - online_total;
    const by_profile_map = {};
    sessions.forEach(s => {
      if (!by_profile_map[s.active]) by_profile_map[s.active] = { profile_name: s.active, total: 0, online: 0, offline: 0 };
      by_profile_map[s.active].total += 1;
      by_profile_map[s.active][s.status] += 1;
    });
    const out = {
      sessions,
      total: sessions.length,
      online_total,
      offline_total,
      by_profile: Object.values(by_profile_map),
      global_active: d.profiles.find(p => p.selected)?.profile_name || null,
      ttl_seconds: 600,
      server_time: now,
    };
    Log.api('GET', '/api/profile/sessions', null, out, 200);
    return out;
  },

  async heartbeatProfile() {
    await delay(20);
    const d = Store.get();
    if (!d.profile_sessions) d.profile_sessions = {};
    const cid = _getClientId();
    const now = Date.now() / 1000;
    const active = localStorage.getItem('car_hmi_profile_name') || d.profiles.find(p => p.selected)?.profile_name || null;
    d.profile_sessions[cid] = { active, updated_at: now, last_seen: now };
    Store.save();
    const out = { client_id: cid, active, last_seen: now, ttl_seconds: 600 };
    Log.api('POST', '/api/profile/heartbeat', {}, out, 200);
    return out;
  },

  async setProfileOffline() {
    await delay(20);
    const d = Store.get();
    if (!d.profile_sessions) d.profile_sessions = {};
    const cid = _getClientId();
    const now = Date.now() / 1000;
    const cur = d.profile_sessions[cid] || {};
    d.profile_sessions[cid] = {
      ...cur,
      active: cur.active || localStorage.getItem('car_hmi_profile_name') || d.profiles.find(p => p.selected)?.profile_name || null,
      updated_at: now,
      last_seen: now - 601,
    };
    Store.save();
    const out = { client_id: cid, active: d.profile_sessions[cid].active, last_seen: d.profile_sessions[cid].last_seen, ttl_seconds: 600 };
    Log.api('POST', '/api/profile/offline', {}, out, 200);
    return out;
  },

  // ── Configs ────────────────────────────────────────────────────────────────

  /** GET /configs - full system info (project, hardware, server, storage, safety, video, profiles) */
  async getConfigs() {
    await delay();
    if (!_INFO_DATA) {
      Log.api("GET", "/configs", null, { error: "Info not available", code: 1000, id: "SYS_UNKNOWN" }, 503);
      throw new Error("System info not available");
    }
    const d = Store.get();
    const res = { ..._INFO_DATA, profiles: d.profiles, section_id: d.section_id };
    Log.api("GET", "/configs", null, res);
    return res;
  },

  /** GET /config - editable system config (hardware.can_bus, storage, safety) from config.json */
  async getConfig() {
    await delay();
    const d = Store.get();
    if (!_CONFIG_DATA) {
      const err = { error: "Config not available", code: 1000, id: "SYS_UNKNOWN" };
      Log.api("GET", "/config", null, err, 503);
      throw new Error(err.error);
    }
    const res = { ..._CONFIG_DATA, section_id: d.section_id };
    Log.api("GET", "/config", null, res);
    return res;
  },

  /** PUT /config - deep-merge editable fields into config ({ section_id, hardware?, storage?, safety? }) */
  async updateConfig(payload) {
    await delay();
    const d = Store.get();
    if (payload.section_id !== d.section_id) {
      const err = { error: `section_id mismatch: expected ${d.section_id}, got ${payload.section_id}`, code: 3005, id: "VAL_CONFLICT" };
      Log.api("PUT", "/config", payload, err, 409);
      throw new Error(err.error);
    }
    if (!_CONFIG_DATA) {
      const err = { error: "Config not available", code: 1000, id: "SYS_UNKNOWN" };
      Log.api("PUT", "/config", payload, err, 503);
      throw new Error(err.error);
    }
    // Deep-merge only the allowed top-level sections
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
    const allowed = ['hardware', 'storage', 'safety'];
    for (const key of allowed) {
      if (payload[key] !== undefined) deepMerge(_CONFIG_DATA[key], payload[key]);
    }
    d.section_id++;
    Store.save();
    const res = { ..._CONFIG_DATA, section_id: d.section_id };
    Log.api("PUT", "/config", payload, res, 202);
    return res;
  },

  /** Mark one config as selected */
  async selectConfig(name) {
    await delay(40);
    const d = Store.get();
    d.configs.forEach(c => { c.selected = (c.config_name === name); });
    Store.save();
    Log.api("PUT", "/config", { config_name: name, selected: true }, { ok: true });
  },

  // ── Signals ────────────────────────────────────────────────────────────────

  /** GET /signals - current snapshot */
  async getSignals() {
    await delay();
    const d = Store.get();
    const items = Object.entries(d.signal_values).map(([name, sv]) => ({
      signal_name: name,
      std_name: _SIGNALS_BY_NAME.get(name)?.std_name || name,
      value: sv.value,
      unit: _SIGNALS_BY_NAME.get(name)?.unit || null,
      timestamp: sv.timestamp,
    }));
    const res = { items, total: items.length, warnings: [] };
    Log.api("GET", "/signals", null, res);
    return res;
  },

  /** GET /signals/:name — single signal current value + metadata */
  async getSignal(name) {
    await delay();
    const d = Store.get();
    const meta = _resolveSignalMeta(name);
    if (!meta) {
      Log.api("GET", `/signals/${name}`, null, { error: `Signal '${name}' not found` }, 404);
      throw new Error(`Signal '${name}' not found`);
    }
    const sv = d.signal_values[meta.name];
    const res = {
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
    };
    Log.api("GET", `/signals/${name}`, null, res);
    return res;
  },

  /** GET /signals/available - full metadata + current value */
  async getSignalsAvailable() {
    await delay();
    const d = Store.get();
    const signals_info = d.signals_meta.map(s => {
      const sv = d.signal_values[s.name];
      return { ...s, value: sv ? sv.value : null, timestamp: sv ? sv.timestamp : null };
    });
    const res = { signals_info };
    Log.api("GET", "/signals/available", null, res);
    return res;
  },

  /** PUT /signals/:name - single signal write */
  async updateSignal(name, value) {
    await delay();
    const d = Store.get();
    const meta = _resolveSignalMeta(name);
    if (!meta)          { Log.api("PUT", `/signals/${name}`, { value }, { error: "Not found" }, 404);       throw new Error(`Signal '${name}' not found`); }
    if (!meta.writable) { Log.api("PUT", `/signals/${name}`, { value }, { error: "Not writable" }, 403);   throw new Error(`Signal '${name}' is not writable`); }
    const v = typeof value === "number" ? value : parseFloat(value);
    d.signal_values[meta.name] = { value: v, timestamp: Date.now() / 1000 };
    Store.save();
    const res = { signal_name: meta.name, std_name: meta.std_name || meta.name, value: v, queued_at: Date.now() / 1000 };
    Log.api("PUT", `/signals/${name}`, { value }, res, 202);
    return res;
  },

  // ── Info ──────────────────────────────────────────────────────────────────

  /** GET /api/info - project & hardware metadata (read-only) */
  async getInfo() {
    await delay(30);
    if (!_INFO_DATA) {
      Log.api("GET", "/api/info", null, { error: "Info not available", code: 1000, id: "SYS_UNKNOWN" }, 503);
      throw new Error("System info not available");
    }
    Log.api("GET", "/api/info", null, _INFO_DATA);
    return _INFO_DATA;
  },

  /** POST /signals/batch_update - sync multiple writable signals */
  async batchUpdateSignals(signals) {
    await delay();
    const d = Store.get();
    const queued = [];
    const errors = [];
    for (const item of signals) {
      const ref = item?.name ?? item?.signal_name ?? item?.std_name;
      const value = item?.value;
      const meta = _resolveSignalMeta(ref);
      if (meta && meta.writable) {
        const v = typeof value === "number" ? value : parseFloat(value);
        if (!isNaN(v) && v >= meta.min && v <= meta.max) {
          d.signal_values[meta.name] = { value: v, timestamp: Date.now() / 1000 };
          queued.push({ signal_name: meta.name, value: v });
        } else {
          errors.push({ signal_name: meta.name, value, error: "out_of_range" });
        }
      } else {
        errors.push({ signal_name: meta ? meta.name : ref, value, error: meta ? "not_writable" : "not_found" });
      }
    }
    Store.save();
    const req = { signals };
    const res = { queued, count: queued.length, queued_at: Date.now() / 1000, errors };
    Log.api("POST", "/signals/batch_update", req, res, 202);
    return res;
  },

  // ── Restraints ─────────────────────────────────────────────────────────────

  /** GET /api/restraints/match?weight=&height=&crash_severity=&seatbelt_system=&seat=&seat_x_mm= */
  async matchRestraints({ weight, height, crash_severity, seatbelt_system, seat = 'fl', seat_x_mm } = {}) {
    await delay(30);

    const _VALID_BELTS = ['SLL', 'CLL', 'MSLL'];
    const _VALID_VELOCITIES = [35, 40, 50, 56];
    const _OLC = { OLC16: 35, OLC18: 40, OLC26: 50, OLC33: 56 };
    const _SEAT_TO_SIGNALS = {
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

    const reqLog = { weight, height, crash_severity, seatbelt_system, seat, seat_x_mm };
    if (weight === undefined || height === undefined || crash_severity === undefined || seatbelt_system === undefined) {
      const err = { error: 'weight, height, crash_severity, seatbelt_system are required', code: 3002, id: 'VAL_MISSING_FIELD' };
      Log.api('GET', '/api/restraints/match', reqLog, err, 400);
      throw Object.assign(new Error(err.error), err);
    }

    const weightKg = Number(weight);
    const heightCm = Number(height);
    if (!Number.isFinite(weightKg) || weightKg <= 0 || !Number.isFinite(heightCm) || heightCm <= 0) {
      const err = { error: 'weight and height must be positive numbers', code: 3003, id: 'VAL_OUT_OF_RANGE' };
      Log.api('GET', '/api/restraints/match', reqLog, err, 422);
      throw Object.assign(new Error(err.error), err);
    }

    const seatKey = String(seat || 'fl').toLowerCase();
    if (!_SEAT_TO_SIGNALS[seatKey]) {
      const err = { error: `Unknown seat '${seat}'`, code: 3003, id: 'VAL_OUT_OF_RANGE' };
      Log.api('GET', '/api/restraints/match', reqLog, err, 422);
      throw Object.assign(new Error(err.error), err);
    }

    const belt = String(seatbelt_system || '').toUpperCase();
    if (!_VALID_BELTS.includes(belt)) {
      const err = { error: `Unknown seatbelt_system '${seatbelt_system}'`, code: 3003, id: 'VAL_OUT_OF_RANGE' };
      Log.api('GET', '/api/restraints/match', reqLog, err, 422);
      throw Object.assign(new Error(err.error), err);
    }

    const crashKey = String(crash_severity || '').toUpperCase();
    const targetVelocity = Object.prototype.hasOwnProperty.call(_OLC, crashKey)
      ? _OLC[crashKey]
      : Number(crashKey);
    if (!_VALID_VELOCITIES.includes(targetVelocity)) {
      const err = { error: `Unknown crash_severity '${crash_severity}'`, code: 3003, id: 'VAL_OUT_OF_RANGE' };
      Log.api('GET', '/api/restraints/match', reqLog, err, 422);
      throw Object.assign(new Error(err.error), err);
    }

    const d = Store.get();
    const sv = d.signal_values;
    const sig = _SEAT_TO_SIGNALS[seatKey];

    const canOccRaw = sv[sig.occClass]?.value;
    const canSeatXRaw = sv[sig.seatX]?.value;
    const canOopRaw = sv[sig.oop]?.value;
    const seatXParam = seat_x_mm === undefined || seat_x_mm === null || seat_x_mm === '' ? null : Number(seat_x_mm);
    if (seatXParam !== null && !Number.isFinite(seatXParam)) {
      const err = { error: 'seat_x_mm must be a number', code: 3003, id: 'VAL_OUT_OF_RANGE' };
      Log.api('GET', '/api/restraints/match', reqLog, err, 422);
      throw Object.assign(new Error(err.error), err);
    }

    const derivedPercentile = weightKg < 65 ? 5 : weightKg <= 90 ? 50 : 95;
    const canPercentile = Number(canOccRaw) === 1 ? 5 : Number(canOccRaw) === 2 ? 50 : Number(canOccRaw) === 3 ? 95 : null;
    const effectivePercentile = canPercentile ?? derivedPercentile;

    let seatXmm = null;
    let seatXSource = 'default';
    if (seatXParam !== null) {
      seatXmm = seatXParam;
      seatXSource = 'hmi_param';
    } else if (Number.isFinite(canSeatXRaw)) {
      seatXmm = Number(canSeatXRaw);
      seatXSource = 'can_signal';
    }

    const seatPositionZone = !Number.isFinite(seatXmm)
      ? 'mid'
      : (seatXmm < 56.75 ? 'front' : seatXmm < 170.25 ? 'mid' : 'rear');

    const candidates = [];
    [5, 50, 95].forEach(p => {
      ['front', 'mid', 'rear'].forEach(z => {
        _VALID_VELOCITIES.forEach(v => {
          _VALID_BELTS.forEach(b => {
            candidates.push({
              filename: `${p}p_${z}_${v}_${b}.mp4`,
              percentile: p,
              seat_position: z,
              velocity_kmh: v,
              seatbelt: b,
            });
          });
        });
      });
    });

    const scored = candidates.map(c => {
      let score = 0;
      if (c.seatbelt === belt) score += 3;
      if (c.percentile === effectivePercentile) score += 2;
      if (c.seat_position === seatPositionZone) score += 1;
      score += Math.max(0, 1 - (Math.abs(c.velocity_kmh - targetVelocity) / 21));
      return { ...c, score: Number(score.toFixed(3)) };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const res = {
      matched: !!best,
      score: best ? best.score : 0,
      video: best ? {
        filename: best.filename,
        percentile: best.percentile,
        seat_position: best.seat_position,
        velocity_kmh: best.velocity_kmh,
        seatbelt: best.seatbelt,
        url: `/api/restraints/video/${best.filename}`,
      } : null,
      context: {
        weight_kg: Number(weightKg.toFixed(3)),
        height_cm: Number(heightCm.toFixed(3)),
        derived_percentile: derivedPercentile,
        effective_percentile: effectivePercentile,
        can_percentile: canPercentile,
        target_velocity_kmh: targetVelocity,
        seatbelt_system: belt,
        seat: seatKey,
        seat_x_mm: seatXmm,
        seat_x_source: seatXSource,
        seat_position_zone: seatPositionZone,
        out_of_position: Number(canOopRaw || 0) !== 0,
        candidates_found: candidates.length,
      }
    };
    Log.api('GET', '/api/restraints/match', reqLog, res);
    return res;
  },
};

// ── MockWebSocket ─────────────────────────────────────────────────────────────
/**
 * Drop-in replacement for the real WebSocket(ws://host/ws/signals).
 * Drifts all analog signals realistically every ~500ms.
 * Writable/enum signals are NOT auto-drifted (controlled by user).
 */
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._intervalId = null;
    // null = stream ALL non-writable signals; Set<string> = specific signals only
    this._subscription = null;
    this.onopen    = null;
    this.onmessage = null;
    this.onclose   = null;
    this.onerror   = null;

    setTimeout(() => {
      this.readyState = 1; // OPEN
      Log.ws("CONNECTED", url);
      this.onopen?.({ type: "open" });
      this._startStreaming();
    }, 350 + Math.random() * 200);
  }

  _startStreaming() {
    const d = Store.get();
    const cfg = d.configs.find(c => c.selected) || d.configs[0];
    // Stream interval: clamp between 200ms and 2000ms for demo visibility
    const intervalMs = Math.max(200, Math.min(2000, Math.round(1000 / (cfg.sampling_rate / 10))));

    this._intervalId = setInterval(() => {
      if (this.readyState !== 1) return;
      const d2 = Store.get();
      const updates = [];

      d2.signals_meta.forEach(s => {
        // TX=true signals are HMI-controlled - no auto-drift
        if (s.writable) return;
        // subscription filter
        if (this._subscription !== null && !this._subscription.has(s.name)) return;

        const cur = d2.signal_values[s.name]?.value ?? (s.min + s.max) / 2;
        let nv;
        if (s.states.length > 0) {
          // enum: 8% chance per tick to switch to a random valid state
          if (Math.random() >= 0.08) return;
          nv = s.states[Math.floor(Math.random() * s.states.length)].value;
        } else {
          // analog: unit-aware random walk
          const rule = _signalRule(s);
          const min = rule.min;
          const max = rule.max;
          const curNorm = Number.isFinite(cur) ? Math.round(cur) : Math.round((min + max) / 2);
          const range = Math.max(0, Math.floor(max - min));
          const rawStep = _randInt(rule.stepMin, rule.stepMax);
          const step = Math.min(rawStep, range);
          if (step === 0) return;

          let dir = Math.random() < 0.5 ? -1 : 1;
          if (curNorm <= min) dir = 1;
          if (curNorm >= max) dir = -1;

          nv = Math.max(min, Math.min(max, curNorm + dir * step));
        }
        d2.signal_values[s.name] = { value: nv, timestamp: Date.now() / 1000 };
        updates.push({ name: s.name, value: nv, timestamp: Date.now() / 1000 });
      });
      Store.save();

      if (updates.length && this.onmessage) {
        const msg = JSON.stringify({ timestamp: new Date().toISOString(), signals: updates.map(u => _signalPayload(u.name, u.value, u.timestamp)).filter(Boolean) });
        this.onmessage({ data: msg });
      }
    }, intervalMs);
  }

  // ── subscription helpers ─────────────────────────────────────────────────
  _ackSubscription() {
    const d = Store.get();
    const subList = this._subscription ? [...this._subscription] : '*';
    const count   = this._subscription
      ? this._subscription.size
      : d.signals_meta.filter(s => !s.writable).length;
    this.onmessage?.({ data: JSON.stringify({ type: 'subscribed', signals: subList, count }) });
    // immediate value snapshot
    const snap = (this._subscription
      ? d.signals_meta.filter(s => this._subscription.has(s.name))
      : d.signals_meta.filter(s => !s.writable)
    ).map(s => _signalPayload(s.name));
    if (snap.length)
      this.onmessage?.({ data: JSON.stringify({ timestamp: new Date().toISOString(), signals: snap }) });
  }

  send(data) {
    let msg;
    try { msg = typeof data === 'string' ? JSON.parse(data) : data; } catch (_) { return; }
    Log.ws("SEND →", JSON.stringify(msg));

    switch (msg.type) {
      case 'ping':
        this.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
        break;

      case 'subscribe': {
        if (!msg.signals || msg.signals === '*') {
          this._subscription = null;
        } else if (Array.isArray(msg.signals)) {
          this._subscription = new Set(_normalizeSignalList(msg.signals));
        }
        this._ackSubscription();
        break;
      }

      case 'unsubscribe': {
        if (Array.isArray(msg.signals)) {
          const d = Store.get();
          if (this._subscription === null) {
            // was "all" → convert to full set then remove
            this._subscription = new Set(d.signals_meta.filter(s => !s.writable).map(s => s.name));
          }
          _normalizeSignalList(msg.signals).forEach(n => this._subscription.delete(n));
          this._ackSubscription();
        }
        break;
      }
    }
  }

  close() {
    clearInterval(this._intervalId);
    this.readyState = 3; // CLOSED
    Log.ws("DISCONNECTED", this.url);
    this.onclose?.({ type: "close" });
  }
}
