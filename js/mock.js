/**
 * mock.js - Simulates full CAN-HMI backend: REST + WebSocket + Logger
 * Based on BE-FE-Review.json contract.
 * No real server needed - all data is stored in localStorage.
 */

// ── Default data ──────────────────────────────────────────────────────────────
// Populated asynchronously by Store.init() from data/can0.json (path in config.json)
let _SIGNALS_META = [];
let _INFO_DATA = null;    // populated from data/info.json
let _CONFIG_DATA = null;  // populated from data/config.json

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
    const res = { section_id: d.section_id, profiles: d.profiles };
    Log.api("GET", "/api/profiles", null, res);
    return res;
  },

  /** GET /api/profile?name=X  (or active if no name) */
  async getProfile(name) {
    await delay();
    const d = Store.get();
    const p = name ? d.profiles.find(p => p.profile_name === name) : d.profiles.find(p => p.selected);
    if (!p) { Log.api("GET", `/api/profile?name=${name}`, null, { error: "Not found" }, 404); throw new Error("Profile not found"); }
    Log.api("GET", `/api/profile?name=${name || "(active)"}`, null, { section_id: d.section_id, ...p });
    return { section_id: d.section_id, ...p };
  },

  /** POST /api/profile */
  async createProfile(payload) {
    await delay();
    const d = Store.get();
    if (d.profiles.find(p => p.profile_name === payload.profile_name)) {
      Log.api("POST", "/api/profile", payload, { error: "Profile name already exists" }, 409);
      throw new Error("Profile '" + payload.profile_name + "' already exists");
    }
    const np = { profile_name: payload.profile_name, signals: payload.signals || [], selected: false };
    d.profiles.push(np);
    d.section_id++;
    Store.save();
    Log.api("POST", "/api/profile", payload, np, 201);
    return np;
  },

  /** PUT /api/profile  (section_id must match) */
  async updateProfile(payload) {
    await delay();
    const d = Store.get();
    if (payload.section_id !== d.section_id) {
      const err = { error: `section_id mismatch: expected ${d.section_id}, got ${payload.section_id}` };
      Log.api("PUT", "/api/profile", payload, err, 409);
      throw new Error(err.error);
    }
    const idx = d.profiles.findIndex(p => p.profile_name === payload.profile_name);
    if (idx < 0) throw new Error("Profile not found");
    d.profiles[idx] = { ...d.profiles[idx], ...payload };
    d.section_id++;
    Store.save();
    Log.api("PUT", "/api/profile", payload, d.profiles[idx]);
    return d.profiles[idx];
  },

  /** DELETE /api/profile/:name */
  async deleteProfile(name) {
    await delay();
    const d = Store.get();
    const idx = d.profiles.findIndex(p => p.profile_name === name);
    if (idx < 0) { Log.api("DELETE", `/api/profile/${name}`, null, { error: "Not found" }, 404); throw new Error("Not found"); }
    const removed = d.profiles.splice(idx, 1)[0];
    d.section_id++;
    Store.save();
    Log.api("DELETE", `/api/profile/${name}`, null, { deleted: name, section_id: d.section_id });
    return removed;
  },

  /** Mark one profile as selected (active) */
  async selectProfile(name) {
    await delay(40);
    const d = Store.get();
    d.profiles.forEach(p => { p.selected = (p.profile_name === name); });
    Store.save();
    Log.api("PUT", "/api/profile", { profile_name: name, selected: true, section_id: d.section_id }, { ok: true });
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
    const signals = Object.entries(d.signal_values).map(([name, sv]) => ({ name, value: sv.value, timestamp: sv.timestamp }));
    const res = { timestamp: new Date().toISOString(), signals };
    Log.api("GET", "/signals", null, res);
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
    const meta = d.signals_meta.find(s => s.name === name);
    if (!meta)          { Log.api("PUT", `/signals/${name}`, { value }, { error: "Not found" }, 404);       throw new Error(`Signal '${name}' not found`); }
    if (!meta.writable) { Log.api("PUT", `/signals/${name}`, { value }, { error: "Not writable" }, 403);   throw new Error(`Signal '${name}' is not writable`); }
    const v = typeof value === "number" ? value : parseFloat(value);
    d.signal_values[name] = { value: v, timestamp: Date.now() / 1000 };
    Store.save();
    const res = { signal_name: name, value: v, queued_at: Date.now() / 1000 };
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
    const results = [];
    for (const { name, value } of signals) {
      const meta = d.signals_meta.find(s => s.name === name);
      if (meta && meta.writable) {
        const v = typeof value === "number" ? value : parseFloat(value);
        d.signal_values[name] = { value: v, timestamp: Date.now() / 1000 };
        results.push({ name, value: v, status: "ok" });
      } else {
        results.push({ name, value, status: meta ? "not_writable" : "not_found" });
      }
    }
    Store.save();
    const req = { timestamp: new Date().toISOString(), signals };
    const res = { timestamp: new Date().toISOString(), results };
    Log.api("POST", "/signals/batch_update", req, res, 202);
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
        updates.push({ name: s.name, value: nv });
      });
      Store.save();

      if (updates.length && this.onmessage) {
        const msg = JSON.stringify({ timestamp: new Date().toISOString(), signals: updates });
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
    ).map(s => ({ name: s.name, value: d.signal_values[s.name]?.value ?? 0 }));
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
        const d = Store.get();
        if (!msg.signals || msg.signals === '*') {
          this._subscription = null;
        } else if (Array.isArray(msg.signals)) {
          const valid = new Set(d.signals_meta.map(s => s.name));
          this._subscription = new Set(msg.signals.filter(n => valid.has(n)));
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
          msg.signals.forEach(n => this._subscription.delete(n));
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
