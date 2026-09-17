/* Reference-compatible operations for static/offline demo use. */
(() => {
  const system = DemoSystemConfig.create();
  const clone = value => JSON.parse(JSON.stringify(value));
  let generalDefaults;
  const overrides = {};
  let processor = { max_queue_size: 10000, queue_policy: 'drop_oldest' };
  const options = { System: ['fusion', 'camera', 'non_adapt'], Age: ['35y', '65y'], Seatbelt: ['3-point'], Velocity: [40, 50, 56], Weight: [49, 58.67, 70], Height: [155, 159.67, 170], Distance: [1440, 1534, 1620] };
  const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, detail: { code, message } }); };
  function merge(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(422, 'invalid_body', 'Expected a JSON object');
    for (const [key, value] of Object.entries(patch)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(422, 'invalid_field', 'Invalid field');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
        merge(target[key], value);
      } else target[key] = clone(value);
    }
    return target;
  }
  const config = name => {
    const meta = _resolveSignalMeta(name);
    if (!meta) fail(404, 'signal_not_found', 'Signal not found');
    return { signal_name: meta.name, unit: meta.unit || null, min_value: meta.min, max_value: meta.max, group_name: null, widget_type: null, writable: meta.writable, ...overrides[meta.name] };
  };
  const started = Date.now();
  const info = () => ({ name: 'CAN-HMI Signal API', version: '1.0.0', description: 'Offline demo simulator', uptime_seconds: (Date.now() - started) / 1000, bus_connected: true, db_connected: true, signal_count: _SIGNALS_META.length, simulated: true });
  MockAPI.request = async function (method, rawPath, body, headers = {}) {
    const url = new URL(rawPath, 'http://demo.local');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const dev = headers['X-Dev-Mode'] === 'true';
    const profiles = Store.get().profiles;
    const profile = profiles.find(p => (p.name || p.profile_name) === (headers['X-Profile-Name'] || localStorage.getItem('car_hmi_profile_name'))) || profiles.find(p => p.selected);
    const entries = _normalizeProfileSignals(profile?.signals);
    function gate(permission, name) {
      if (dev) return;
      const allowed = entries.some(e => (!name || e.name === name || e.name === '*') && (e.permission.includes('full') || e.permission.includes(permission)));
      if (!allowed) fail(403, 'profile_permission_denied', `Profile lacks ${permission} permission${name ? ` for ${name}` : ''}`);
    }
    const finish = (status, response) => { Log.api(method, rawPath, body ?? null, response, status); return { status, body: response }; };
    try {
      if (path.startsWith('/config') && method !== 'GET') gate('full');
      if (path.startsWith('/config/system')) {
        const result = method === 'PATCH' && path === '/config/system' ? { status: 200, body: system.apply(body) } : system.request(method, path);
        return finish(result.status, result.body);
      }
      if (path === '/config' && method === 'GET') return finish(200, _SIGNALS_META.map(s => config(s.name)));
      if (path.startsWith('/config/signal/')) {
        const name = decodeURIComponent(path.split('/').at(-1));
        const current = config(name);
        if (method === 'PATCH') {
          const patch = Object.fromEntries(Object.entries(body || {}).filter(([key]) => ['unit', 'min_value', 'max_value', 'widget_type', 'writable'].includes(key)));
          overrides[current.signal_name] = { ...overrides[current.signal_name], ...patch };
        } else if (method !== 'GET') fail(404, 'route_not_found', 'Unknown operation');
        return finish(200, config(name));
      }
      if (path === '/config/general' || path === '/config/general/reset') {
        generalDefaults ||= clone(_CONFIG_DATA || {});
        if (method === 'PATCH' && path === '/config/general') merge(_CONFIG_DATA, body);
        else if (method === 'POST' && path.endsWith('/reset')) _CONFIG_DATA = clone(generalDefaults);
        else if (method !== 'GET' || path !== '/config/general') fail(404, 'route_not_found', 'Unknown operation');
        return finish(200, path.endsWith('/reset') ? { ok: true, default: clone(_CONFIG_DATA) } : clone(_CONFIG_DATA));
      }
      if (path === '/config/processor') {
        if (method === 'POST') {
          if ((body?.max_queue_size !== undefined && (!Number.isInteger(body.max_queue_size) || body.max_queue_size < 1)) || (body?.queue_policy !== undefined && !['drop_oldest', 'reject'].includes(body.queue_policy))) fail(422, 'invalid_processor_config', 'Invalid queue size or policy');
          processor = { ...processor, ...body };
        } else if (method !== 'GET') fail(404, 'route_not_found', 'Unknown operation');
        return finish(200, clone(processor));
      }
      if (['/system/can/retry', '/api/can/retry', '/system/reboot', '/api/reboot'].includes(path) && method === 'POST') {
        if (!headers['X-API-Key'] || ['default', 'changeme', 'change-me-in-production'].includes(headers['X-API-Key'].toLowerCase())) fail(401, 'unauthorized', 'Enter a real API key for the control demo');
        if (!dev) fail(403, 'dev_mode_required', 'X-Dev-Mode: true is required');
        const reboot = path.endsWith('/reboot');
        if (reboot) system.reboot();
        return finish(reboot ? 202 : 200, reboot ? { status: 'reboot_scheduled', simulated: true } : { scheduled: [true], count: 1, simulated: true });
      }
      if (method === 'GET' && /^\/(system|api)\/(info|health|ready|metrics)$/.test(path)) {
        const kind = path.split('/').at(-1);
        return finish(200, kind === 'info' ? info() : kind === 'health' ? { status: 'ok', uptime_seconds: info().uptime_seconds, bus_connected: true, db_connected: true, simulated: true } : kind === 'ready' ? { ready: true, details: { bus: true, db: true }, simulated: true } : { timestamp: Date.now() / 1000, cpu_percent: 12, ram_percent: 24, disk_percent: 30, queue_size: 0, queue_maxsize: processor.max_queue_size, uptime_seconds: info().uptime_seconds, simulated: true });
      }
      if (path === '/adaptive_restraint/available' && method === 'GET') return finish(200, clone(options));
      if (path === '/adaptive_restraint/chart_info' && method === 'GET') {
        const controls = Object.fromEntries(Object.entries(options).map(([key, all]) => {
          const values = url.searchParams.getAll(key);
          return [key, values.length ? values.map(v => typeof all[0] === 'number' ? Number(v) : v) : all];
        }));
        controls.RawData = query.RawData !== 'false';
        const datas = [];
        for (const sys of controls.System) for (const age of controls.Age) datas.push({ [`injury_risk_${sys}_${age}`]: { values: [0.0031, 0.0045, 0.0052], min: 0.0031, max: 0.0052, 'lower fence': 0.0031, q1: 0.0038, median: 0.0045, q3: 0.0049, 'upper fence': 0.0052 } });
        return finish(200, { controls, datas, available_options: clone(options), ...(controls.RawData ? { raw_rows: [{ injury_risk_fusion_35y: 0.0031 }] } : {}), simulated: true });
      }
      if (path === '/api/camera/status' && method === 'GET') return finish(200, { enabled: false, stream_url: null, connected: false, viewer_count: 0, last_error: 'No camera in offline demo' });
      if (path === '/api/camera/stream') fail(503, 'camera_unavailable', 'No camera in offline demo');
      if (path.startsWith('/signals/')) {
        const name = decodeURIComponent(path.split('/')[2]);
        if (name !== 'available' && name !== 'batch_update') gate(method === 'GET' ? 'read' : 'write', _resolveSignalName(name) || name);
        if (path.endsWith('/history') && method === 'GET') {
          const sv = await MockAPI.getSignal(name);
          const limit = Number(query.limit ?? 100), offset = Number(query.offset ?? 0);
          if (!Number.isInteger(limit) || limit < 1 || limit > 10000 || !Number.isInteger(offset) || offset < 0 || ['start', 'end'].some(k => query[k] !== undefined && !Number.isFinite(Number(query[k])))) fail(422, 'invalid_history_query', 'Invalid history query');
          const inRange = (query.start === undefined || sv.timestamp >= Number(query.start)) && (query.end === undefined || sv.timestamp <= Number(query.end));
          return finish(200, { items: inRange && !offset ? [sv] : [], total: inRange ? 1 : 0, warnings: [], simulated: true });
        }
        if (method === 'PUT') {
          const meta = _resolveSignalMeta(name);
          if (!meta) fail(404, 'signal_not_found', 'Signal not found');
          if (!meta.writable) fail(403, 'not_tx', 'Signal is not writable');
          if (!Number.isFinite(body?.value) || body.value < meta.min || body.value > meta.max) fail(422, 'out_of_range', 'Value is outside signal range');
        }
      }
      const routes = {
        'GET /api/profiles': () => MockAPI.getProfiles(), 'GET /api/profile': () => MockAPI.getProfile(query.name),
        'POST /api/profile': () => MockAPI.createProfile(body), 'PUT /api/profile': () => MockAPI.updateProfile(body),
        'PUT /api/profile/active': () => MockAPI.selectProfile(body.name), 'GET /api/profile/sessions': () => MockAPI.getProfileSessions(),
        'POST /api/profile/heartbeat': () => MockAPI.heartbeatProfile(), 'POST /api/profile/offline': () => MockAPI.setProfileOffline(),
        'GET /signals': () => MockAPI.getSignals(), 'GET /signals/available': () => MockAPI.getSignalsAvailable(),
        'POST /signals/batch_update': () => { gate('write'); for (const s of body?.signals || []) gate('write', _resolveSignalName(s.signal_name || s.name)); return MockAPI.batchUpdateSignals(body.signals); },
        'GET /api/devmode/catalog': () => MockAPI.getDevmodeCatalog(), 'GET /api/devmode/status': () => MockAPI.getDevmodeStatus(),
        'POST /api/devmode/seats/select': () => MockAPI.selectDevmodeSeats(body), 'POST /api/devmode/exit': () => MockAPI.exitDevmode(),
        'POST /api/devmode/signals': () => MockAPI.applyDevmodeSignal(body), 'GET /api/restraints/match': () => MockAPI.matchRestraints(query),
      };
      let handler = routes[`${method} ${path}`];
      if (!handler && method === 'DELETE' && path.startsWith('/api/profile/')) handler = () => MockAPI.deleteProfile(decodeURIComponent(path.split('/').at(-1)));
      if (!handler && /^\/signals\/[^/]+$/.test(path)) {
        const name = decodeURIComponent(path.split('/').at(-1));
        if (method === 'GET') handler = () => MockAPI.getSignal(name);
        if (method === 'PUT') handler = () => MockAPI.updateSignal(name, body.value);
      }
      if (!handler) fail(404, 'route_not_found', 'Unknown demo operation');
      const response = await handler();
      return { status: method === 'DELETE' ? 204 : method === 'POST' && path === '/api/profile' ? 201 : (method === 'PUT' && path.startsWith('/signals/')) || path === '/signals/batch_update' ? 202 : 200, body: response };
    } catch (error) {
      error.status ||= 400;
      error.response ||= { detail: error.detail || error.message };
      Log.api(method, rawPath, body ?? null, error.response, error.status);
      throw error;
    }
  };
})();
