/**
 * api.js - RealAPI: same interface as MockAPI, uses real fetch() + WebSocket.
 * Automatically selected by app.js when hostname is not localhost / 127.0.0.1.
 * All methods call Log.api() so the API Log tab still works on the real server.
 */

const RealAPI = (() => {
  function _resolveBaseUrl() {
    const fromQuery = new URLSearchParams(location.search).get('api_base');
    const fromStorage = localStorage.getItem('car_hmi_api_base');
    const fromWindow = window.CAR_HMI_API_BASE;
    const raw = fromQuery || fromWindow || fromStorage;
    if (!raw) return location.origin;
    try {
      return new URL(raw, location.origin).origin;
    } catch (_) {
      return location.origin;
    }
  }

  // Optional override via ?api_base=... or localStorage['car_hmi_api_base']
  const _base = _resolveBaseUrl();
  window.__CAR_HMI_API_BASE = _base;

  function _getApiKey() {
    const fromQuery = new URLSearchParams(location.search).get('api_key');
    const fromStorage = localStorage.getItem('car_hmi_api_key');
    const fromWindow = window.CAR_HMI_API_KEY;
    return fromQuery || fromWindow || fromStorage || '';
  }

  function _getClientId() {
    let id = localStorage.getItem('car_hmi_client_id');
    if (!id) {
      id = `client-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('car_hmi_client_id', id);
    }
    return id;
  }

  function _getProfileName() {
    return localStorage.getItem('car_hmi_profile_name') || '';
  }

  function _setProfileName(name) {
    if (!name) return;
    localStorage.setItem('car_hmi_profile_name', name);
  }

  async function _req(method, path, body, extraHeaders) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Client-Id': _getClientId(),
      },
    };
    const apiKey = _getApiKey();
    if (apiKey) opts.headers['X-API-Key'] = apiKey;
    const profileName = _getProfileName();
    if (profileName) opts.headers['X-Profile-Name'] = profileName;
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(opts.headers, extraHeaders);
    }
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res, json;
    try {
      res  = await fetch(_base + path, opts);
      json = await res.json().catch(() => ({}));
    } catch (e) {
      Log.api(method, path, body ?? null, { error: e.message }, 0);
      throw e;
    }

    Log.api(method, path, body ?? null, json, res.status);

    if (res.status >= 400) {
      const detailMsg = typeof json?.detail === 'string'
        ? json.detail
        : (json?.detail?.message || json?.error || `HTTP ${res.status}`);
      throw Object.assign(new Error(detailMsg), json);
    }

    // Keep App.sectionId in sync with whatever the server last returned
    if (json.section_id !== undefined) App.sectionId = json.section_id;

    if (json.active) _setProfileName(json.active);

    return json;
  }

  return {
    // ── Profiles ─────────────────────────────────────────────────────────────
    getProfiles()           { return _req('GET',    '/api/profiles'); },
    getProfile(name)        {
      const q = name ? `?name=${encodeURIComponent(name)}` : '';
      return _req('GET', `/api/profile${q}`);
    },
    createProfile(payload)  { return _req('POST',   '/api/profile', payload); },
    updateProfile(payload)  { return _req('PUT',    '/api/profile', payload); },
    deleteProfile(name)     { return _req('DELETE', `/api/profile/${encodeURIComponent(name)}`); },

    // car-hmi compatible active profile endpoint
    async selectProfile(name, options = {}) {
      const extraHeaders = {};
      if (options.devMode) extraHeaders['X-Dev-Mode'] = 'true';
      const res = await _req('PUT', '/api/profile/active', { name }, extraHeaders);
      _setProfileName(name);
      return res;
    },

    getProfileSessions(options = {}) {
      const extraHeaders = {};
      if (options.devMode) extraHeaders['X-Dev-Mode'] = 'true';
      return _req('GET', '/api/profile/sessions', undefined, extraHeaders);
    },
    heartbeatProfile()      { return _req('POST', '/api/profile/heartbeat', {}); },
    setProfileOffline()     { return _req('POST', '/api/profile/offline', {}); },

    // ── Configs ───────────────────────────────────────────────────────────────
    getConfigs()           { return _req('GET', '/configs'); },
    getConfig()            { return _req('GET', '/config'); },
    updateConfig(payload)  { return _req('PUT', '/config', payload); },

    // ── Signals ───────────────────────────────────────────────────────────────
    getSignals()                 { return _req('GET',  '/signals'); },
    getSignal(name)              { return _req('GET',  `/signals/${encodeURIComponent(name)}`); },
    getSignalsAvailable()        { return _req('GET',  '/signals/available'); },
    updateSignal(name, value)    { return _req('PUT',  `/signals/${encodeURIComponent(name)}`, { value }); },
    batchUpdateSignals(signals)  { return _req('POST', '/signals/batch_update', { signals }); },

    // ── Info ──────────────────────────────────────────────────────────────────
    getInfo()  { return _req('GET', '/api/info'); },

    // ── Restraints ────────────────────────────────────────────────────────────
    matchRestraints({ weight, height, crash_severity, seatbelt_system, seat = 'fl', seat_x_mm } = {}) {
      const params = new URLSearchParams({
        weight: String(weight ?? ''),
        height: String(height ?? ''),
        crash_severity: String(crash_severity ?? ''),
        seatbelt_system: String(seatbelt_system ?? ''),
        seat: String(seat ?? 'fl'),
      });
      if (seat_x_mm !== undefined && seat_x_mm !== null && seat_x_mm !== '') {
        params.set('seat_x_mm', String(seat_x_mm));
      }
      return _req('GET', `/api/restraints/match?${params}`);
    },

    wsUrl(path = '/ws/signals') {
      const u = new URL(_base);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.pathname = path;
      const key = _getApiKey();
      const profile = _getProfileName();
      const cid = _getClientId();
      if (key) u.searchParams.set('api_key', key);
      if (profile) u.searchParams.set('profile_name', profile);
      if (cid) u.searchParams.set('client_id', cid);
      return u.toString();
    },
  };
})();
