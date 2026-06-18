/**
 * api.js - RealAPI: same interface as MockAPI, uses real fetch() + WebSocket.
 * Automatically selected by app.js when hostname is not localhost / 127.0.0.1.
 * All methods call Log.api() so the API Log tab still works on the real server.
 */

const RealAPI = (() => {
  // Build base URL from current browser origin (works on any domain/port)
  const _base = location.origin;

  async function _req(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    };
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
      throw Object.assign(new Error(json.error || `HTTP ${res.status}`), json);
    }

    // Keep App.sectionId in sync with whatever the server last returned
    if (json.section_id !== undefined) App.sectionId = json.section_id;

    return json;
  }

  return {
    // ── Profiles ─────────────────────────────────────────────────────────────
    getProfiles()           { return _req('GET',    '/api/profiles'); },
    getProfile(name)        { return _req('GET',    `/api/profile?name=${encodeURIComponent(name)}`); },
    createProfile(payload)  { return _req('POST',   '/api/profile', payload); },
    updateProfile(payload)  { return _req('PUT',    '/api/profile', payload); },
    deleteProfile(name)     { return _req('DELETE', `/api/profile/${encodeURIComponent(name)}`); },

    // selectProfile: server uses PUT /api/profile with selected:true
    async selectProfile(name) {
      return _req('PUT', '/api/profile', {
        profile_name: name,
        selected: true,
        section_id: App.sectionId,
      });
    },

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
    matchRestraints({ seat, seat_belt, crash_pulse = 'OLC18' } = {}) {
      const params = new URLSearchParams({ seat, seat_belt, crash_pulse });
      return _req('GET', `/api/restraints/match?${params}`);
    },
  };
})();
