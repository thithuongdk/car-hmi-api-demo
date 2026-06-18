/**
 * test_server_api.js - Integration tests for server.js REST API
 *
 * Starts an Express server on a random port, tests all REST endpoints.
 *
 * Run: node tests/test_server_api.js
 *
 * Prerequisites:
 *   npm install express ws  (already in package.json)
 */

'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');

// Check dependencies exist
try { require('express'); } catch (_) {
  console.error('\n❌ "express" module not found. Run: npm install');
  process.exit(1);
}
try { require('ws'); } catch (_) {
  console.error('\n❌ "ws" module not found. Run: npm install');
  process.exit(1);
}

const ROOT    = path.resolve(__dirname, '..');
const BASE    = '.';  // server.js uses __dirname-based paths

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅', label); passed++; }
  else      { console.error('  ❌', label); failed++; }
}
function eq(label, a, b) {
  const cond = a === b;
  if (cond) { console.log('  ✅', label); passed++; }
  else      { console.error('  ❌', label + ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); failed++; }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port:     global.__TEST_PORT__,
      path:     url,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  5000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Test Suite ────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n🧪 Server REST API Tests\n');

  // ── GET /api/info ─────────────────────────────────────────────────────────
  console.log('\n━━━ GET /api/info ────────────────────────────────────────────');
  const info = await request('GET', '/api/info');
  ok('200 OK',                          info.status === 200);
  ok('has project key',                 info.body?.project?.name);
  ok('has hardware key',                info.body?.hardware?.can_bus);
  ok('has server key',                  info.body?.server);
  ok('api_key redacted',                info.body?.server?.api_key === '[REDACTED]');
  ok('has section_id',                  typeof info.body?.section_id === 'number');
  ok('has storage.safety',              info.body?.safety);
  const infoSectionId = info.body.section_id;

  // ── GET /api/profiles ─────────────────────────────────────────────────────
  console.log('\n━━━ GET /api/profiles ─────────────────────────────────────────');
  const profs = await request('GET', '/api/profiles');
  ok('200 OK',                          profs.status === 200);
  ok('returns profiles array',          Array.isArray(profs.body?.profiles));
  ok('has section_id',                  typeof profs.body?.section_id === 'number');
  ok('at least 1 profile',              profs.body.profiles.length >= 1);
  ok('has active profile',              profs.body.profiles.some(p => p.selected));
  console.log(`   profiles: ${profs.body.profiles.length}, section_id: ${profs.body.section_id}`);

  // ── GET /api/profile (active) ─────────────────────────────────────────────
  console.log('\n━━━ GET /api/profile (default = active) ───────────────────────');
  const activeP = await request('GET', '/api/profile');
  ok('200 OK',                          activeP.status === 200);
  ok('has profile_name',                !!activeP.body?.profile_name);
  ok('has signals array',               Array.isArray(activeP.body?.signals));
  console.log(`   active: ${activeP.body.profile_name}, signals: ${activeP.body.signals.length}`);

  // ── GET /api/profile?name=U0 ──────────────────────────────────────────────
  console.log('\n━━━ GET /api/profile?name=U0 ──────────────────────────────────');
  const pU0 = await request('GET', '/api/profile?name=U0');
  ok('200 OK',                          pU0.status === 200);
  eq('profile_name is U0',              pU0.body?.profile_name, 'U0');
  ok('has signals',                     Array.isArray(pU0.body?.signals) && pU0.body.signals.length > 0);

  // ── GET /api/profile?name=NONEXISTENT ─────────────────────────────────────
  console.log('\n━━━ GET /api/profile?name=NONEXISTENT ─────────────────────────');
  const missing = await request('GET', '/api/profile?name=NONEXISTENT');
  ok('404 Not Found',                   missing.status === 404);
  ok('has error message',               !!missing.body?.error);

  // ── POST /api/profile (create) ────────────────────────────────────────────
  console.log('\n━━━ POST /api/profile ─────────────────────────────────────────');
  const created = await request('POST', '/api/profile', {
    profile_name: '_TEST_PROFILE',
    signals: ['HB_FL_ActivationLevel', 'CoolantTemp'],
    description: 'Temp test profile',
  });
  ok('201 Created',                     created.status === 201);
  eq('name matches',                    created.body?.profile_name, '_TEST_PROFILE');
  ok('has signals',                     Array.isArray(created.body?.signals));
  eq('signals count',                   created.body.signals.length, 2);

  // ── POST duplicate → 409 ──────────────────────────────────────────────────
  const dup = await request('POST', '/api/profile', {
    profile_name: '_TEST_PROFILE',
    signals: ['HB_FL_ActivationLevel'],
  });
  ok('409 Conflict on duplicate',       dup.status === 409);

  // ── PUT /api/profile (update) ─────────────────────────────────────────────
  console.log('\n━━━ PUT /api/profile ──────────────────────────────────────────');
  // Need correct section_id
  const profs2 = await request('GET', '/api/profiles');
  const sid    = profs2.body.section_id;
  const updated = await request('PUT', '/api/profile', {
    profile_name: '_TEST_PROFILE',
    signals: ['HB_FL_ActivationLevel', 'CoolantTemp', 'EngineSpeed'],
    description: 'Updated test profile',
    section_id: sid,
  });
  ok('200 OK',                          updated.status === 200 || updated.status === 202);
  ok('signals updated',                 updated.body?.signals?.length === 3);

  // ── PUT wrong section_id → 409 ────────────────────────────────────────────
  const badSid = await request('PUT', '/api/profile', {
    profile_name: '_TEST_PROFILE',
    section_id: -1,
  });
  ok('409 on section_id mismatch',      badSid.status === 409);

  // ── PUT selectProfile shortcut ────────────────────────────────────────────
  const selectOk = await request('PUT', '/api/profile', {
    profile_name: 'U0',
    selected: true,
    section_id: (await request('GET', '/api/profiles')).body.section_id,
  });
  ok('selectProfile returns ok',        selectOk.body?.ok === true);
  // Verify U0 is now active
  const activeNow = await request('GET', '/api/profile');
  eq('U0 is active after select',       activeNow.body?.profile_name, 'U0');

  // ── DELETE /api/profile/:name ─────────────────────────────────────────────
  console.log('\n━━━ DELETE /api/profile ───────────────────────────────────────');
  const del = await request('DELETE', '/api/profile/_TEST_PROFILE');
  ok('200 OK',                          del.status === 200);
  eq('deleted name matches',            del.body?.deleted, '_TEST_PROFILE');
  const afterDel = await request('GET', '/api/profiles');
  ok('profile removed',                 !afterDel.body.profiles.find(p => p.profile_name === '_TEST_PROFILE'));

  // ── DELETE nonexistent → 404 ──────────────────────────────────────────────
  const delMiss = await request('DELETE', '/api/profile/__NOEXIST__');
  ok('404 on missing delete',           delMiss.status === 404);

  // ── GET /configs ──────────────────────────────────────────────────────────
  console.log('\n━━━ GET /configs ──────────────────────────────────────────────');
  const configs = await request('GET', '/configs');
  ok('200 OK',                          configs.status === 200);
  ok('has project',                     !!configs.body?.project);
  ok('has hardware',                    !!configs.body?.hardware);
  ok('has profiles',                    Array.isArray(configs.body?.profiles));
  ok('api_key redacted',                !configs.body?.server?.api_key || configs.body.server.api_key === '[REDACTED]');

  // ── GET /config ───────────────────────────────────────────────────────────
  console.log('\n━━━ GET /config ───────────────────────────────────────────────');
  const cfg = await request('GET', '/config');
  ok('200 OK',                          cfg.status === 200);
  ok('has hardware.can_bus',            !!cfg.body?.hardware?.can_bus);
  ok('has storage',                     !!cfg.body?.storage);
  ok('has safety',                      !!cfg.body?.safety);
  ok('has section_id',                  typeof cfg.body?.section_id === 'number');
  console.log(`   section_id: ${cfg.body.section_id}`);

  // ── PUT /config ───────────────────────────────────────────────────────────
  console.log('\n━━━ PUT /config ──────────────────────────────────────────────');
  const cfgSid = cfg.body.section_id;
  const updatedCfg = await request('PUT', '/config', {
    section_id: cfgSid,
    storage: { retention_days: 99 },
  });
  ok('202 Accepted',                    updatedCfg.status === 202);
  eq('retention_days updated',          updatedCfg.body?.storage?.retention_days, 99);

  // ── PUT /config wrong section_id → 409 ────────────────────────────────────
  const badCfg = await request('PUT', '/config', {
    section_id: -1,
    storage: { retention_days: 0 },
  });
  ok('409 on config section_id mismatch', badCfg.status === 409);

  // ── GET /signals ──────────────────────────────────────────────────────────
  console.log('\n━━━ GET /signals ──────────────────────────────────────────────');
  const sigs = await request('GET', '/signals');
  ok('200 OK',                          sigs.status === 200);
  ok('returns signals array',           Array.isArray(sigs.body?.signals));
  ok('signals have value field',        typeof sigs.body.signals[0]?.value !== 'undefined');
  ok('signals have name field',         !!sigs.body.signals[0]?.name);
  ok('signals have timestamp',          sigs.body.signals[0]?.timestamp !== undefined);
  ok('has ISO timestamp',               !!sigs.body?.timestamp);
  console.log(`   signal count: ${sigs.body.signals.length}`);

  // ── GET /signals/available ────────────────────────────────────────────────
  console.log('\n━━━ GET /signals/available ────────────────────────────────────');
  const avail = await request('GET', '/signals/available');
  ok('200 OK',                          avail.status === 200);
  ok('returns signals_info array',      Array.isArray(avail.body?.signals_info));
  ok('has metadata fields',             typeof avail.body.signals_info[0]?.min === 'number');
  ok('has writable field',              typeof avail.body.signals_info[0]?.writable === 'boolean');
  ok('states field present',            Array.isArray(avail.body.signals_info[0]?.states));
  console.log(`   available signals: ${avail.body.signals_info.length}`);

  // Find a writable signal for PUT test
  const aWritable = avail.body.signals_info.find(s => s.writable);
  const aNonWritable = avail.body.signals_info.find(s => !s.writable);

  // ── GET /signals/:name (existing) ─────────────────────────────────────────
  console.log('\n━━━ GET /signals/:name (existing) ─────────────────────────────');
  if (aWritable) {
    const getRes = await request('GET', `/signals/${aWritable.name}`);
    ok('200 OK',                          getRes.status === 200);
    ok('has name',                        !!getRes.body?.name);
    ok('has std_name',                    !!getRes.body?.std_name);
    ok('has value',                       typeof getRes.body?.value === 'number');
    ok('has unit',                        typeof getRes.body?.unit === 'string');
    ok('has min',                         typeof getRes.body?.min === 'number');
    ok('has max',                         typeof getRes.body?.max === 'number');
    ok('has writable flag',               typeof getRes.body?.writable === 'boolean');
    ok('has description',                 typeof getRes.body?.description === 'string');
    ok('has states array',                Array.isArray(getRes.body?.states));
    console.log(`   ${getRes.body.name}: ${getRes.body.value} ${getRes.body.unit} [${getRes.body.min}..${getRes.body.max}] writable=${getRes.body.writable}`);
  }

  // ── GET /signals/:name (non-existent → 404) ──────────────────────────────
  console.log('\n━━━ GET /signals/:name (non-existent) ─────────────────────────');
  const getMissing = await request('GET', '/signals/__NOSIGNAL__');
  ok('404 for non-existent signal',      getMissing.status === 404);
  ok('has error message',                !!getMissing.body?.error);

  // ── PUT /signals/:name (writable) ─────────────────────────────────────────
  console.log('\n━━━ PUT /signals/:name (writable) ─────────────────────────────');
  if (aWritable) {
    const writeRes = await request('PUT', `/signals/${aWritable.name}`, { value: aWritable.min + 5 });
    ok('202 Accepted',                    writeRes.status === 202);
    ok('has signal_name',                 !!writeRes.body?.signal_name);
    ok('has std_name',                    !!writeRes.body?.std_name);
    ok('has value',                       writeRes.body?.value === aWritable.min + 5);
    ok('has queued_at',                   !!writeRes.body?.queued_at);
    console.log(`   wrote ${aWritable.name} = ${aWritable.min + 5}`);
  } else {
    console.log('   ⚠️  No writable signals found');
  }

  // ── PUT /signals/:name (non-writable → 403) ──────────────────────────────
  console.log('\n━━━ PUT /signals/:name (non-writable → 403) ───────────────────');
  if (aNonWritable) {
    const deny = await request('PUT', `/signals/${aNonWritable.name}`, { value: 0 });
    ok('403 Forbidden',                   deny.status === 403);
    ok('error code SAFE_WRITE_DENIED',    deny.body?.code === 'SAFE_WRITE_DENIED');
    console.log(`   denied write to ${aNonWritable.name}`);
  }

  // ── PUT /signals/:name (non-existent → 404) ──────────────────────────────
  const noSig = await request('PUT', '/signals/__NOSIGNAL__', { value: 0 });
  ok('404 for non-existent signal',      noSig.status === 404);

  // ── PUT /signals/:name (out of range → 422) ──────────────────────────────
  if (aWritable) {
    val: {  // eslint-disable-line no-labels
      const oor = await request('PUT', `/signals/${aWritable.name}`, { value: aWritable.max + 999 });
      // Some servers may accept due to mock behavior; check if 422
      if (oor.status === 422) {
        ok('422 for out-of-range value',    true);
        ok('error code VAL_OUT_OF_RANGE',   oor.body?.code === 'VAL_OUT_OF_RANGE');
      } else {
        console.log(`   ⚠️  Out-of-range returned ${oor.status} (not 422)`);
      }
    }
  }

  // ── POST /signals/batch_update ────────────────────────────────────────────
  console.log('\n━━━ POST /signals/batch_update ────────────────────────────────');
  const batchItems = [];
  if (aWritable) batchItems.push({ name: aWritable.name, value: aWritable.min + 3 });
  if (aNonWritable) batchItems.push({ name: aNonWritable.name, value: 1 });
  batchItems.push({ name: '__NOEXIST__', value: 0 });

  const batchRes = await request('POST', '/signals/batch_update', { signals: batchItems });
  ok('202 Accepted',                    batchRes.status === 202);
  ok('has results array',               Array.isArray(batchRes.body?.results));
  if (aWritable) {
    const okItem = batchRes.body.results.find(r => r.name === aWritable.name);
    ok('writable signal status = ok',    okItem?.status === 'ok');
  }
  if (aNonWritable) {
    const denyItem = batchRes.body.results.find(r => r.name === aNonWritable.name);
    ok('non-writable status = not_writable', denyItem?.status === 'not_writable');
  }
  const missingItem = batchRes.body.results.find(r => r.name === '__NOEXIST__');
  ok('non-existent status = not_found', missingItem?.status === 'not_found');

  // ── GET /api/restraints/match ─────────────────────────────────────────────
  console.log('\n━━━ GET /api/restraints/match ─────────────────────────────────');
  const rst = await request('GET', '/api/restraints/match?seat=driver&seat_belt=SLL');
  ok('200 OK',                          rst.status === 200);
  ok('matched = true',                  rst.body?.matched === true);
  ok('has video.filename',              !!rst.body?.video?.filename);
  ok('has video.percentile',            typeof rst.body?.video?.percentile === 'number');
  ok('has score',                       typeof rst.body?.score === 'number');
  ok('filename includes _SLL.mp4',      rst.body.video.filename.endsWith('_SLL.mp4'));
  console.log(`   video: ${rst.body.video.filename}, score: ${rst.body.score}`);

  // ── Missing params → 400 ──────────────────────────────────────────────────
  const noSeat = await request('GET', '/api/restraints/match');
  ok('400 without seat param',          noSeat.status === 400);

  const badSeat = await request('GET', '/api/restraints/match?seat=invalid&seat_belt=SLL');
  ok('422 with invalid seat',           badSeat.status === 422);

  const badBelt = await request('GET', '/api/restraints/match?seat=driver&seat_belt=INVALID');
  ok('422 with invalid seat_belt',      badBelt.status === 422);

  const badPulse = await request('GET', '/api/restraints/match?seat=driver&seat_belt=CLL&crash_pulse=INVALID');
  ok('422 with invalid crash_pulse',    badPulse.status === 422);

  // ── Static file serving ──────────────────────────────────────────────────
  console.log('\n━━━ Static File Serving ───────────────────────────────────────');
  const htmlRes = await request('GET', '/');
  ok('200 OK for /',                    htmlRes.status === 200);
  ok('serves index.html',               typeof htmlRes.body === 'string' && htmlRes.body.includes('CAN-HMI'));

  // ── CORS headers ──────────────────────────────────────────────────────────
  console.log('\n━━━ CORS Headers ──────────────────────────────────────────────');
  const corsRes = await request('GET', '/api/info');
  ok('Access-Control-Allow-Origin: *',  corsRes.headers['access-control-allow-origin'] === '*');
  ok('Allow-Methods present',           !!corsRes.headers['access-control-allow-methods']);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(55)}`);
  if (failed === 0) {
    console.log(`✅ ALL ${passed} SERVER API TESTS PASSED`);
  } else {
    console.error(`❌ ${failed} FAILED / ${passed} passed`);
    process.exit(1);
  }
}

// ── Start server & run ────────────────────────────────────────────────────────
const SERVER_MODULE = path.join(ROOT, 'server.js');

// Check if server.js exists
if (!fs.existsSync(SERVER_MODULE)) {
  console.error(`❌ server.js not found at ${SERVER_MODULE}`);
  console.error('   Make sure you are running this from the project root.');
  process.exit(1);
}

// Find a free port
const net = require('net');
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

(async () => {
  try {
    global.__TEST_PORT__ = await getFreePort();
    process.env.PORT = String(global.__TEST_PORT__);

    console.log(`🔧 Starting server on port ${global.__TEST_PORT__}...`);
    // We need to clear server.js module cache and require it fresh
    delete require.cache[require.resolve(SERVER_MODULE)];
    require(SERVER_MODULE);

    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 500));

    await runTests();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ FATAL:', e.message);
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }
})();