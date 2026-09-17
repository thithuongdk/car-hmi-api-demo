'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ROOT = require('node:path').resolve(__dirname, '..');
const DemoSystemConfig = require('../js/demo-system-config');
const source = file => fs.readFileSync(`${ROOT}/${file}`, 'utf8');
const catalog = vm.runInNewContext(`${source('js/api-catalog.js')}\nAPI_OPERATIONS`);
const readme = source('docs/api_reference_vi.md');
const expected = [...readme.matchAll(/^### `(GET|POST|PUT|PATCH|DELETE) ([^`]+)`/gm)].map(m => `${m[1]} ${m[2]}`);
assert.deepEqual(Array.from(catalog, op => `${op.method} ${op.path}`), expected);
assert.equal(catalog.length, 53);
const system = DemoSystemConfig.create();
const before = system.snapshot();
assert.throws(() => system.apply({ reader: { stale_threshold_sec: 5 }, unknown: true }), e => e.status === 422);
assert.deepEqual(system.snapshot(), before, 'invalid patch is atomic');
assert.throws(() => system.apply({ can_db_file: 'other' }), e => e.detail.code === 'immutable_field');
assert.throws(() => system.apply({ reader: { stale_threshold_sec: -1 } }), e => e.status === 422);
const changed = system.apply({ reader: { stale_threshold_sec: 5 }, camera: { enabled: true } });
assert.deepEqual(changed.reload.live, ['reader.stale_threshold_sec']);
assert.equal(changed.reboot_required, true);
const restore = system.request('POST', `/config/system/backups/${changed.backup.id}/restore`);
assert.equal(restore.body.config.reader.stale_threshold_sec, 30);
assert.equal(restore.body.config.processor.queue_policy, 'drop_oldest');
assert.equal(system.request('POST', '/config/system/reload').body.reboot_required, true);
system.reboot();
assert.equal(system.snapshot().reboot_required, false);
assert.throws(() => system.request('POST', '/config/system/backups/missing/restore'), e => e.status === 404);

async function mockTests() {
  const storage = new Map();
  const sandbox = {
    console, setTimeout: cb => setTimeout(cb, 0), clearTimeout, setInterval, clearInterval, TextEncoder, URL,
    DemoSystemConfig, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    window: {}, location: { origin: 'http://demo.local', search: '' }, URLSearchParams,
    document: { addEventListener() {}, getElementById: () => ({ textContent: '' }) },
    fetch: async file => { try { const json = JSON.parse(source(file)); return { ok: true, json: async () => json }; } catch { return { ok: false }; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source('js/mock.js')}\n${source('js/mock-extensions.js')}\nglobalThis.testApi = MockAPI; globalThis.testStore = Store;`, sandbox);
  await sandbox.testStore.init();
  // Classic scripts share function names: loading app.js must preserve mock permissions.
  vm.runInContext(source('js/app.js'), sandbox);
  const api = sandbox.testApi;
  const admin = (await api.getProfiles()).profiles.find(p => p.name === 'admin');
  assert.equal(admin.signals[0].permission[0], 'full');
  const headers = { 'X-Profile-Name': 'admin' };
  assert.ok(Array.isArray((await api.request('GET', '/config')).body));
  await assert.rejects(api.request('PATCH', '/config/system', { reader: { stale_threshold_sec: 5 } }, { 'X-Profile-Name': 'U0' }), e => e.status === 403);
  const update = await api.request('PATCH', '/config/system', { reader: { stale_threshold_sec: 5 } }, headers);
  await api.request('POST', `/config/system/backups/${update.body.backup.id}/restore`, undefined, headers);
  assert.equal((await api.request('GET', '/config/system')).body.config.reader.stale_threshold_sec, 30);
  await api.request('PATCH', '/config/general', { storage: { retention_days: 73 } }, headers);
  assert.equal((await api.request('GET', '/config/general')).body.storage.retention_days, 73);
  const chart = await api.request('GET', '/adaptive_restraint/chart_info?System=camera&System=fusion&Age=65y&RawData=false');
  assert.equal(chart.body.datas.length, 2);
  assert.equal(chart.body.raw_rows, undefined);
  await assert.rejects(api.request('POST', '/system/reboot', undefined, { 'X-Dev-Mode': 'true' }), e => e.status === 401);
}

async function transportTests() {
  const storage = new Map([['car_hmi_api_key', 'test-key'], ['car_hmi_client_id', 'client-test'], ['car_hmi_profile_name', 'admin']]);
  const calls = [];
  const sandbox = { URL, URLSearchParams, window: {}, App: {}, location: { origin: 'http://test.local', search: '' }, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) }, Log: { api() {} }, fetch: async (url, opts) => { calls.push({ url, opts }); return { status: url.endsWith('/failure') ? 423 : 200, json: async () => url.endsWith('/failure') ? { detail: { code: 'locked', message: 'Seat locked' } } : { ok: true } }; } };
  vm.createContext(sandbox);
  vm.runInContext(`${source('js/api.js')}\nglobalThis.testApi = RealAPI`, sandbox);
  const api = sandbox.testApi;
  await api.getConfig();
  assert.equal(calls.at(-1).url, 'http://test.local/config/general');
  await api.updateConfig({ storage: { retention_days: 19 } });
  assert.equal(calls.at(-1).opts.method, 'PATCH');
  await api.getSignalHistory('test / signal', { limit: 12, offset: 2 });
  assert.equal(calls.at(-1).url, 'http://test.local/signals/test%20%2F%20signal/history?limit=12&offset=2');
  const result = await api.request('POST', '/system/can/retry', undefined, { 'X-Dev-Mode': 'true' });
  assert.equal(result.status, 200);
  assert.equal(calls.at(-1).opts.headers['X-API-Key'], 'test-key');
  assert.equal(calls.at(-1).opts.headers['X-Client-Id'], 'client-test');
  assert.equal(calls.at(-1).opts.headers['X-Profile-Name'], 'admin');
  assert.equal(calls.at(-1).opts.headers['X-Dev-Mode'], 'true');
  await assert.rejects(api.request('GET', '/failure'), error => error.status === 423 && error.response.detail.code === 'locked');
}

async function serverTests() {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', API_KEY: 'reference-suite-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 6000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/); if (match && match[1] !== '0') { clearTimeout(timer); resolve(match[1]); } });
      child.on('error', e => { clearTimeout(timer); reject(e); });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': 'reference-suite-key', 'X-Profile-Name': 'admin', 'X-Client-Id': 'reference-tests' };
    async function req(method, path, body, overrides = {}) {
      const response = await fetch(base + path, { method, headers: { ...headers, ...overrides }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 204) return { status: 204, body: null };
      assert.ok((response.headers.get('content-type') || '').includes('application/json'), `${method} ${path} must return JSON`);
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await req('POST', '/system/reboot')).status, 403);
    assert.equal((await req('POST', '/api/reboot', undefined, { 'X-Dev-Mode': 'true', 'X-API-Key': 'wrong' })).status, 401);
    assert.equal((await req('POST', '/api/reboot', undefined, { 'X-Dev-Mode': 'true' })).body.simulated, true);
    assert.equal((await req('POST', '/system/can/retry', undefined, { 'X-Dev-Mode': 'true' })).status, 200);
    assert.equal((await req('GET', '/api/devmode/catalog', undefined, { 'X-API-Key': 'wrong' })).status, 401);
    const adaptive = await req('GET', '/adaptive_restraint/chart_info?System=camera&System=fusion&Age=65y&RawData=false');
    assert.equal(adaptive.body.datas.length, 2);
    assert.ok(adaptive.body.datas[0].injury_risk_camera_65y);
    assert.equal(adaptive.body.raw_rows, undefined);
    const metadata = (await req('GET', '/signals/available')).body.signals_info;
    const writable = metadata.find(s => s.writable);
    const backup = (await req('POST', '/config/system/backups')).body.backup.id;
    for (const op of catalog) {
      // Public binary routes are verified separately below.
      if (op.path.includes('/video/') || op.path === '/api/camera/stream') continue;
      let path = op.path.replace('{signal_name}', encodeURIComponent(writable.signal_name)).replace('{backup_id}', backup).replace('{name}', 'reference-temp');
      let body = op.body === null ? undefined : structuredClone(op.body);
      if (path === '/api/profile' && op.method === 'POST') body = { name: 'reference-temp', signals: [{ name: '*', permission: ['full'] }] };
      if (path === '/api/profile' && op.method === 'PUT') { const profile = (await req('GET', '/api/profile?name=reference-temp')).body; body = { ...profile, description: 'updated by test' }; }
      if (path === '/api/profile/active') body = { name: 'admin' };
      if (op.method === 'PUT' && path.startsWith('/signals/')) body = { value: writable.states?.[0]?.value ?? writable.min_value };
      if (path === '/signals/batch_update') body = { signals: [{ signal_name: writable.signal_name, value: writable.states?.[0]?.value ?? writable.min_value }] };
      if (op.query) path += `?${op.query}`;
      const response = await req(op.method, path, body, { 'X-Dev-Mode': 'true' });
      assert.ok(response.status < 500, `${op.method} ${path}: ${JSON.stringify(response.body)}`);
      assert.notEqual(response.body?.detail?.code, 'route_not_found');
    }
    const changed = await req('PATCH', '/config/system', { reader: { stale_threshold_sec: 7 } });
    assert.equal(changed.body.config.reader.stale_threshold_sec, 7);
    const restored = await req('POST', `/config/system/backups/${changed.body.backup.id}/restore`);
    assert.equal(restored.body.config.reader.stale_threshold_sec, 30);
    assert.equal((await req('POST', '/config/processor', { queue_policy: 'invalid' })).status, 422);
    assert.equal((await req('GET', `/signals/${writable.signal_name}/history?offset=1`)).body.items.length, 0);
    assert.equal((await req('GET', `/signals/${writable.signal_name}/history?limit=10001`)).status, 422);
    assert.equal((await req('GET', '/api/camera/stream')).status, 503);
    const filename = fs.readdirSync(`${ROOT}/media`).find(name => name.endsWith('.mp4'));
    const video = await fetch(`${base}/api/restraints/video/${encodeURIComponent(filename)}`);
    assert.equal(video.status, 200);
    assert.ok(video.headers.get('content-type').startsWith('video/'));
    await video.arrayBuffer();
  } finally { child.kill(); await exited; }
}
(async () => { await mockTests(); await transportTests(); if (!process.argv.includes('--quick')) await serverTests(); console.log('PASS: 53 operation catalog, system policies, backup/restore, mock and HTTP reference coverage'); })().catch(error => { console.error(error); process.exitCode = 1; });
