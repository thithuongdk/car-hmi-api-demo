/**
 * Pre-deploy integration test for mock.js APIs
 * Run: node _test_mock.js
 */
const fs = require('fs');

// ── Browser shims ──────────────────────────────────────────────────────────
const _ls = {};
global.localStorage = {
  getItem:    k    => _ls[k] || null,
  setItem:    (k,v)=> { _ls[k] = v; },
  removeItem: k    => { delete _ls[k]; },
};
global.fetch = async (url) => {
  const map = {
    'candb/signal.json': 'candb/signal.json',
    'data/info.json':    'data/info.json',
    'data/config.json':  'data/config.json',
  };
  const f = map[url];
  if (!f || !fs.existsSync(f)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) };
};
global.WebSocket     = class {};
global.clearInterval = clearInterval;
global.setInterval   = setInterval;

// Minimal DOM stub (mock.js uses document for badge/log UI updates)
const _noop = () => ({
  textContent: '', innerHTML: '', style: {}, classList: { add(){}, remove(){}, toggle(){} },
  appendChild(){}, querySelector(){ return _noop(); }, querySelectorAll(){ return []; },
  addEventListener(){}, removeEventListener(){}, scrollTop: 0, scrollHeight: 0,
});
global.document = {
  getElementById:   () => _noop(),
  querySelector:    () => _noop(),
  querySelectorAll: () => [],
  createElement:    () => _noop(),
};

// Load mock.js — use Function() so const bindings are accessible in same scope
const mockSrc = fs.readFileSync('js/mock.js', 'utf8');
const { Store, MockAPI, MockWebSocket } =
  new Function('require', mockSrc + '\n;return {Store, MockAPI, MockWebSocket};')(require);

// ── Tests ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label, val) {
  if (val) { console.log('  ✅', label); passed++; }
  else      { console.error('  ❌', label); failed++; }
}

(async () => {
  console.log('\n=== Store.init ===');
  await Store.init();
  const d = Store.get();
  ok('signals loaded',              d.signals_meta.length === 149);
  ok('profiles loaded from info',   d.profiles.length >= 4);
  ok('active profile set',          d.profiles.some(p => p.selected));
  ok('section_id present',          typeof d.section_id === 'number');
  console.log('   active:', d.profiles.find(p=>p.selected)?.profile_name,
              '| signals:', d.signals_meta.length, '| TX:', d.signals_meta.filter(s=>s.writable).length);

  console.log('\n=== GET /api/profiles ===');
  const profs = await MockAPI.getProfiles();
  ok('returns profiles array',      Array.isArray(profs.profiles));
  ok('has section_id',              typeof profs.section_id === 'number');
  profs.profiles.forEach(p => console.log('   -', p.profile_name, '| sigs:', p.signals.length, p.selected?'[active]':''));

  console.log('\n=== GET /api/profile?name=U0 ===');
  const p0 = await MockAPI.getProfile('U0');
  ok('returns signals array',       Array.isArray(p0.signals));
  ok('U0 has signals',              p0.signals.length > 0);
  console.log('   U0 signals:', p0.signals.length);

  console.log('\n=== Profile CRUD ===');
  const cp = await MockAPI.createProfile({ profile_name: '_TMP', signals: ['HB_FL_ActivationLevel'] });
  ok('createProfile ok',            cp.profile_name === '_TMP');
  const up = await MockAPI.updateProfile({ profile_name: '_TMP', signals: ['HB_FL_ActivationLevel','HB_FR_ActivationLevel'], section_id: d.section_id });
  ok('updateProfile signals count', up.signals.length === 2);
  await MockAPI.deleteProfile('_TMP');
  const afterDel = (await MockAPI.getProfiles()).profiles;
  ok('deleteProfile removed it',    !afterDel.find(p => p.profile_name === '_TMP'));

  console.log('\n=== GET /configs ===');
  const cfgs = await MockAPI.getConfigs();
  ok('has project key',             !!cfgs.project);
  ok('has profiles key',            Array.isArray(cfgs.profiles));
  ok('api_key redacted',            !cfgs.server?.api_key || cfgs.server.api_key === '[REDACTED]');
  console.log('   keys:', Object.keys(cfgs).filter(k=>k!=='section_id').join(', '));

  console.log('\n=== GET /config ===');
  const cfg = await MockAPI.getConfig();
  ok('has hardware.can_bus',        !!cfg.hardware?.can_bus);
  ok('has storage section',         typeof cfg.storage?.retention_days !== 'undefined');
  ok('has safety section',          typeof cfg.safety?.write_access_enabled !== 'undefined');
  ok('has section_id',              typeof cfg.section_id === 'number');
  console.log('   can_bus keys:', Object.keys(cfg.hardware?.can_bus || {}).join(', '));

  const txName = d.signals_meta.find(s => s.writable)?.name;
  console.log('\n=== PUT /config ===');
  const origDays = cfg.storage.retention_days;
  const wcRes = await MockAPI.updateConfig({ section_id: d.section_id, storage: { retention_days: origDays + 1 } });
  ok('updateConfig returns hardware', !!wcRes.hardware);
  ok('updateConfig returns storage',  !!wcRes.storage);
  ok('retention_days updated',        wcRes.storage?.retention_days === origDays + 1);
  d.section_id = Store.get().section_id; // refresh after section_id bump

  console.log('\n=== GET /signals ===');
  const sigs = await MockAPI.getSignals();
  ok('returns signals',             Array.isArray(sigs.signals) && sigs.signals.length > 0);
  ok('has value field',             typeof sigs.signals[0]?.value !== 'undefined');
  console.log('   count:', sigs.signals.length);

  console.log('\n=== GET /signals/available ===');
  const avail = await MockAPI.getSignalsAvailable();
  ok('returns signals_info',        Array.isArray(avail.signals_info));
  ok('has metadata',                typeof avail.signals_info[0]?.description !== 'undefined');
  console.log('   count:', avail.signals_info.length);

  console.log('\n=== PUT /signals/:name ===');
  await MockAPI.updateSignal(txName, 5);
  ok('TX signal write ok',          Store.get().signal_values[txName]?.value === 5);

  const rxName = d.signals_meta.find(s => !s.writable)?.name;
  let rjeced = false;
  try { await MockAPI.updateSignal(rxName, 99); }
  catch(_) { rjeced = true; }
  ok('non-TX write rejected',       rjeced);
  console.log('   non-TX signal tested:', rxName);

  console.log('\n=== POST /signals/batch_update ===');
  const b = await MockAPI.batchUpdateSignals([
    { name: txName, value: 2 },
    { name: rxName, value: 99 },
    { name: '__no_exist__', value: 0 },
  ]);
  ok('has results array',           Array.isArray(b.results));
  ok('TX result ok',                b.results.find(r=>r.name===txName)?.status === 'ok');
  ok('non-TX result not_writable',  b.results.find(r=>r.name===rxName)?.status === 'not_writable');
  ok('missing result not_found',    b.results.find(r=>r.name==='__no_exist__')?.status === 'not_found');

  console.log('\n=== GET /api/info ===');
  const info = await MockAPI.getInfo();
  ok('has project key',             !!info.project);
  ok('api_key redacted',            !info.server?.api_key || info.server.api_key === '[REDACTED]');
  console.log('   project:', info.project?.name || '(none)');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  if (failed === 0) {
    console.log(`✅ ALL ${passed} TESTS PASSED — safe to push to Render/Vercel`);
  } else {
    console.error(`❌ ${failed} FAILED / ${passed} passed`);
    process.exit(1);
  }
})().catch(e => { console.error('❌ FATAL:', e.message, '\n', e.stack?.split('\n').slice(0,4).join('\n')); process.exit(1); });
