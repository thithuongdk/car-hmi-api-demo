/**
 * mock.js — Simulates full CAN-HMI backend: REST + WebSocket + Logger
 * Based on BE-FE-Review.json contract.
 * No real server needed — all data is stored in localStorage.
 */

// ── Default data ──────────────────────────────────────────────────────────────
const _SIGNALS_META = [
  { name: "EngineSpeed",           unit: "rpm", min: 0,   max: 8000, writable: false, description: "Engine speed in revolutions per minute",
    states: [] },
  { name: "CoolantTemp",           unit: "°C",  min: 0,   max: 120,  writable: false, description: "Coolant temperature in degree Celsius",
    states: [] },
  { name: "HB_FL_ActivationLevel", unit: "",    min: 0,   max: 7,    writable: true,  description: "HB Front-Left Activation Level",
    states: Array.from({ length: 8 }, (_, i) => ({ value: i, description: `Level ${i + 1}` })) },
  { name: "HB_FR_ActivationLevel", unit: "",    min: 0,   max: 7,    writable: true,  description: "HB Front-Right Activation Level",
    states: Array.from({ length: 8 }, (_, i) => ({ value: i, description: `Level ${i + 1}` })) },
  { name: "BrakePressure",         unit: "bar", min: 0,   max: 200,  writable: false, description: "Brake line pressure",
    states: [] },
  { name: "BatteryVoltage",        unit: "V",   min: 9,   max: 16,   writable: false, description: "12V battery voltage",
    states: [] },
  { name: "FuelLevel",             unit: "%",   min: 0,   max: 100,  writable: false, description: "Fuel level percentage",
    states: [] },
];

const _DEFAULT_PROFILES = [
  { profile_name: "Dev", signals: _SIGNALS_META.map(s => s.name), selected: true  },
  { profile_name: "U0",  signals: ["EngineSpeed","CoolantTemp","HB_FL_ActivationLevel","HB_FR_ActivationLevel"], selected: false },
  { profile_name: "U1",  signals: ["EngineSpeed","CoolantTemp"], selected: false },
  { profile_name: "U2",  signals: ["HB_FL_ActivationLevel","HB_FR_ActivationLevel"], selected: false },
];

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
      const mid = (s.min + s.max) / 2;
      // enum signals start at 0
      const initVal = s.states.length ? 0 : +(mid + (Math.random() - 0.5) * mid * 0.4).toFixed(2);
      vals[s.name] = { value: initVal, timestamp: Date.now() / 1000 };
    });
    return {
      section_id: 1,
      profiles:     JSON.parse(JSON.stringify(_DEFAULT_PROFILES)),
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

  return { get, save, reset };
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

  /** GET /configs — all configs */
  async getConfigs() {
    await delay();
    const d = Store.get();
    const res = { section_id: d.section_id, configs: d.configs };
    Log.api("GET", "/configs", null, res);
    return res;
  },

  /** GET /config — active config */
  async getConfig() {
    await delay();
    const d = Store.get();
    const c = d.configs.find(c => c.selected) || d.configs[0];
    const res = { section_id: d.section_id, ...c };
    Log.api("GET", "/config", null, res);
    return res;
  },

  /** PUT /config  (section_id must match) */
  async updateConfig(payload) {
    await delay();
    const d = Store.get();
    if (payload.section_id !== d.section_id) {
      const err = { error: `section_id mismatch: expected ${d.section_id}, got ${payload.section_id}` };
      Log.api("PUT", "/config", payload, err, 409);
      throw new Error(err.error);
    }
    const idx = d.configs.findIndex(c => c.config_name === payload.config_name);
    if (idx < 0) throw new Error("Config not found");
    d.configs[idx] = { ...d.configs[idx], ...payload };
    d.section_id++;
    Store.save();
    Log.api("PUT", "/config", payload, d.configs[idx]);
    return d.configs[idx];
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

  /** GET /signals — current snapshot */
  async getSignals() {
    await delay();
    const d = Store.get();
    const signals = Object.entries(d.signal_values).map(([name, sv]) => ({ name, value: sv.value, timestamp: sv.timestamp }));
    const res = { timestamp: new Date().toISOString(), signals };
    Log.api("GET", "/signals", null, res);
    return res;
  },

  /** GET /signals/available — full metadata + current value */
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

  /** PUT /signals/:name — single signal write */
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

  /** POST /signals/batch_update — sync multiple writable signals */
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
        if (s.states.length > 0) return; // enum signals: skip auto-drift
        const cur = d2.signal_values[s.name]?.value ?? (s.min + s.max) / 2;
        const range = s.max - s.min;
        const drift = (Math.random() - 0.5) * range * 0.025;
        const nv = +Math.max(s.min, Math.min(s.max, cur + drift)).toFixed(2);
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

  send(data) {
    Log.ws("SEND →", typeof data === "string" ? data : JSON.stringify(data));
  }

  close() {
    clearInterval(this._intervalId);
    this.readyState = 3; // CLOSED
    Log.ws("DISCONNECTED", this.url);
    this.onclose?.({ type: "close" });
  }
}
