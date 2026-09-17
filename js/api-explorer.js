/* All HTTP operations and three WS endpoints from api_reference_vi.md. */
(() => {
  const $ = id => document.getElementById(id);
  let socket = null;
  let mediaBlob = null;
  const esc = value => _escHtml(String(value));
  function cleanMedia() {
    $('explorer-media').querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    $('explorer-media').replaceChildren();
    if (mediaBlob) URL.revokeObjectURL(mediaBlob);
    mediaBlob = null;
  }
  function operation() { return API_OPERATIONS[Number($('explorer-operation').value)]; }
  function selectOperation() {
    const op = operation();
    $('explorer-description').textContent = op.label;
    $('explorer-auth').textContent = op.auth;
    $('explorer-params').innerHTML = op.parameters.filter(p => p.where === 'path').map(p => `<label>${esc(p.name)}<input class="input" data-param="${esc(p.name)}" required placeholder="${esc(p.name)}"></label>`).join('');
    const signal = App.signalsMeta.find(s => s.writable) || App.signalsMeta[0];
    const nameInput = $('explorer-params').querySelector('[data-param="signal_name"]');
    if (nameInput) nameInput.value = signal?.name || '';
    const profileInput = $('explorer-params').querySelector('[data-param="name"]');
    if (profileInput) profileInput.value = App.activeProfile?.name || App.activeProfile?.profile_name || '';
    $('explorer-query').value = op.query;
    $('explorer-query-hint').textContent = op.parameters.filter(p => p.where === 'query').map(p => `${p.name} (${p.kind}${p.limits ? `; ${p.limits}` : ''})`).join(' · ') || 'Không có query bắt buộc.';
    let body = op.body;
    if (body?.signals && op.path === '/signals/batch_update') body = { signals: App.signalsMeta.filter(s => s.writable).slice(0, 2).map(s => ({ signal_name: s.name, value: s.states?.[0]?.value ?? s.min })) };
    if (op.method === 'PUT' && op.path === '/signals/{signal_name}') body = { value: signal?.states?.[0]?.value ?? signal?.min ?? 0 };
    $('explorer-body').value = body === null ? '' : JSON.stringify(body, null, 2);
    $('explorer-body-row').hidden = ['GET', 'DELETE'].includes(op.method);
    $('explorer-response').textContent = 'Chưa gửi request.';
    $('explorer-status').textContent = `${op.method} ${op.path}`;
    cleanMedia();
  }
  function showResponse(status, body, elapsed) {
    $('explorer-status').textContent = `${status ? `HTTP ${status}` : 'Lỗi kết nối / dữ liệu'}${elapsed !== undefined ? ` · ${elapsed} ms` : ''}`;
    $('explorer-status').dataset.error = status >= 400 || !status ? 'true' : 'false';
    $('explorer-response').textContent = JSON.stringify(body, null, 2);
  }
  function headers() {
    const result = { 'X-Client-Id': localStorage.getItem('car_hmi_client_id') || _getClientId() };
    const key = localStorage.getItem('car_hmi_api_key');
    const profile = localStorage.getItem('car_hmi_profile_name');
    if (key) result['X-API-Key'] = key;
    if (profile) result['X-Profile-Name'] = profile;
    if ($('explorer-dev').checked) result['X-Dev-Mode'] = 'true';
    return result;
  }
  async function send(event) {
    event.preventDefault();
    const op = operation();
    let path = op.path;
    for (const input of $('explorer-params').querySelectorAll('input')) {
      if (!input.value.trim()) { input.reportValidity(); return; }
      path = path.replace(`{${input.dataset.param}}`, encodeURIComponent(input.value.trim()));
    }
    const query = $('explorer-query').value.trim().replace(/^\?/, '');
    if (query) path += `?${query}`;
    let body;
    try { if (!['GET', 'DELETE'].includes(op.method) && $('explorer-body').value.trim()) body = JSON.parse($('explorer-body').value); }
    catch (error) { showResponse(0, { error: `JSON không hợp lệ: ${error.message}` }); return; }
    if ((op.method === 'DELETE' || /\/(reset|restore|reboot)$/.test(op.path)) && !confirm(`Thực hiện ${op.method} ${path} trên ${_onRealServer ? _apiBase() : 'demo offline'}?`)) return;
    $('explorer-send').disabled = true;
    const started = performance.now();
    cleanMedia();
    try {
      if (op.path === '/api/camera/stream') {
        const status = await API.request('GET', '/api/camera/status', undefined, headers());
        if (!status.body.enabled) { showResponse(status.status, { detail: status.body.last_error || 'Camera chưa bật', camera_status: status.body }); return; }
        const img = document.createElement('img'); img.alt = 'Camera MJPEG'; img.src = API.mediaUrl(path);
        img.onerror = () => showResponse(0, { detail: 'Không mở được camera stream' });
        $('explorer-media').append(img); $('explorer-status').textContent = 'Đang mở camera stream'; $('explorer-response').textContent = JSON.stringify({ stream: path, camera_status: status.body }, null, 2);
      } else if (op.path === '/api/restraints/video/{filename}') {
        const source = _onRealServer ? API.mediaUrl(path) : `media/${encodeURIComponent(decodeURIComponent(path.split('/').at(-1)))}`;
        const response = await fetch(source);
        if (!response.ok || !(response.headers.get('content-type') || '').startsWith('video/')) {
          const detail = await response.text();
          const error = Object.assign(new Error('Không tải được video'), { status: response.ok ? 404 : response.status, response: { detail } });
          Log.api('GET', path, null, error.response, error.status); throw error;
        }
        mediaBlob = URL.createObjectURL(await response.blob());
        const video = document.createElement('video'); video.controls = true; video.src = mediaBlob;
        $('explorer-media').append(video);
        showResponse(response.status, { media_type: response.headers.get('content-type'), source: path }, Math.round(performance.now() - started));
        Log.api('GET', path, null, { media_type: 'video' }, response.status);
      } else {
        const response = await API.request(op.method, path, body, headers());
        showResponse(response.status, response.body, Math.round(performance.now() - started));
        if (op.path === '/api/profile/active' && body?.name) {
          localStorage.setItem('car_hmi_profile_name', body.name);
          await _loadProfiles(); await _loadSignalsMeta(); _renderDashboard();
          if (App.ws) { App.ws.onclose = null; App.ws.close(); } _connectWS();
        }
      }
    } catch (error) { showResponse(error.status || 0, error.response || error.detail || { error: error.message }, Math.round(performance.now() - started)); }
    finally { $('explorer-send').disabled = false; }
  }
  function wsLog(message) {
    $('explorer-ws-log').textContent = `${new Date().toLocaleTimeString()} ${message}\n${$('explorer-ws-log').textContent}`.slice(0, 18000);
  }
  function closeSocket() { const previous = socket; socket = null; previous?.close(); }
  function connectSocket() {
    closeSocket();
    const path = $('explorer-ws-path').value;
    const connection = _onRealServer ? new WebSocket(RealAPI.wsUrl(path)) : new MockWebSocket(`${_wsBase()}${path}`);
    socket = connection;
    connection.onopen = () => { if (socket === connection) wsLog(`CONNECTED ${path}`); };
    connection.onmessage = event => {
      if (socket !== connection) return;
      let preview = event.data;
      try {
        const frame = JSON.parse(event.data);
        if (frame.signals?.length > 10) preview = JSON.stringify({ ...frame, signals: frame.signals.slice(0, 10), total_signals: frame.signals.length, preview: '10 signals đầu; frame đầy đủ trong API Log' });
      } catch (_) { /* Keep non-JSON messages visible. */ }
      wsLog(preview); Log.ws('EXPLORER', event.data);
    };
    connection.onerror = () => wsLog('Kết nối WebSocket lỗi');
    connection.onclose = event => { if (socket === connection) socket = null; wsLog(`CLOSED ${event.code || ''} ${event.reason || ''}`); };
  }
  function sendSocket(type) {
    if (!socket || socket.readyState !== 1) { wsLog('Hãy kết nối WebSocket trước.'); return; }
    if ($('explorer-ws-path').value === '/ws/all') { wsLog('/ws/all chỉ nhận frames; chọn /ws/signals để gửi lệnh.'); return; }
    const names = $('explorer-ws-signals').value.split(',').map(s => s.trim()).filter(Boolean);
    const rate = Number($('explorer-ws-rate').value);
    if (!Number.isFinite(rate) || rate < 0) { wsLog('rate_ms phải >= 0'); return; }
    const payload = type === 'ping' ? { type } : { type, signals: names.includes('*') && names.length === 1 ? '*' : names, mode: $('explorer-ws-mode').value, rate_ms: rate };
    socket.send(JSON.stringify(payload)); wsLog(`SENT ${JSON.stringify(payload)}`);
  }
  window.initApiExplorer = () => {
    const groups = new Map();
    API_OPERATIONS.forEach((op, index) => {
      const group = op.path.startsWith('/signals') ? 'Signals' : op.path.startsWith('/config') ? 'Configuration' : op.path.startsWith('/adaptive') ? 'Adaptive restraint' : op.path.includes('/profile') ? 'Profiles & sessions' : op.path.includes('/devmode') ? 'Dev Mode' : op.path.includes('/camera') || op.path.includes('/restraints') ? 'Camera & video' : 'System';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(`<option value="${index}">${esc(op.method + ' ' + op.path)}</option>`);
    });
    $('explorer-operation').innerHTML = [...groups].map(([group, values]) => `<optgroup label="${group}">${values.join('')}</optgroup>`).join('');
    $('explorer-operation').onchange = selectOperation;
    $('explorer-form').onsubmit = send;
    $('connection-base').value = _apiBase();
    $('connection-key').value = localStorage.getItem('car_hmi_api_key') || '';
    $('connection-client').value = localStorage.getItem('car_hmi_client_id') || _getClientId();
    $('connection-profile').value = localStorage.getItem('car_hmi_profile_name') || '';
    $('connection-save').onclick = () => {
      try {
        const base = new URL($('connection-base').value);
        if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Base URL phải dùng HTTP/HTTPS');
        const client = $('connection-client').value.trim();
        if (!client) throw new Error('Client ID bắt buộc');
        if (socket) closeSocket();
        localStorage.setItem('car_hmi_api_base', base.origin);
        localStorage.setItem('car_hmi_api_key', $('connection-key').value.trim());
        localStorage.setItem('car_hmi_client_id', client);
        localStorage.setItem('car_hmi_profile_name', $('connection-profile').value.trim());
        const current = new URL(location.href); current.searchParams.delete('api_base'); current.searchParams.delete('api_key'); current.searchParams.delete('mock'); location.href = current.toString();
      } catch (error) { showResponse(0, { error: error.message }); }
    };
    $('connection-offline').onclick = () => { localStorage.removeItem('car_hmi_api_base'); const url = new URL(location.href); url.searchParams.delete('api_base'); url.searchParams.delete('api_key'); url.searchParams.set('mock', '1'); location.href = url.toString(); };
    $('explorer-ws-connect').onclick = connectSocket;
    $('explorer-ws-close').onclick = closeSocket;
    $('explorer-ws-path').onchange = closeSocket;
    document.querySelectorAll('[data-ws-send]').forEach(btn => { btn.onclick = () => sendSocket(btn.dataset.wsSend); });
    document.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => { if (btn.dataset.tab !== 'api-explorer') { closeSocket(); cleanMedia(); } }));
    window.addEventListener('beforeunload', () => { closeSocket(); cleanMedia(); });
    selectOperation();
  };
})();
