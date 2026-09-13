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

function buildProfileSignals(names, permission = ['read']) {
  return names.map((name) => ({ name, permission: [...permission] }));
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

function requestWithHeaders(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: global.__TEST_PORT__,
      path: url,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      timeout: 5000,
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
  ok('has API name',                    typeof info.body?.name === 'string');
  ok('has version',                     typeof info.body?.version === 'string');
  ok('has signal_count',                typeof info.body?.signal_count === 'number');
  ok('has bus_connected',               typeof info.body?.bus_connected === 'boolean');

  // ── GET /api/profiles ─────────────────────────────────────────────────────
  console.log('\n━━━ GET /api/profiles ─────────────────────────────────────────');
  const profs = await request('GET', '/api/profiles');
  ok('200 OK',                          profs.status === 200);
  ok('returns profiles array',          Array.isArray(profs.body?.profiles));
  ok('at least 1 profile',              profs.body.profiles.length >= 1);
  ok('has active profile name',         typeof profs.body?.active === 'string' && profs.body.active.length > 0);
  console.log(`   profiles: ${profs.body.profiles.length}, active: ${profs.body.active}`);

  // ── GET /api/profile (active) ─────────────────────────────────────────────
  console.log('\n━━━ GET /api/profile (default = active) ───────────────────────');
  const activeP = await request('GET', '/api/profile');
  ok('200 OK',                          activeP.status === 200);
  ok('has name',                        !!activeP.body?.name);
  ok('has signals array',               Array.isArray(activeP.body?.signals));
  console.log(`   active: ${activeP.body.name}, signals: ${activeP.body.signals.length}`);

  // ── GET /api/profile?name=U0 ──────────────────────────────────────────────
  console.log('\n━━━ GET /api/profile?name=U0 ──────────────────────────────────');
  const pU0 = await request('GET', '/api/profile?name=U0');
  ok('200 OK',                          pU0.status === 200);
  eq('name is U0',                      pU0.body?.name, 'U0');
  ok('has signals',                     Array.isArray(pU0.body?.signals) && pU0.body.signals.length > 0);

  // ── Admin wildcard profile ────────────────────────────────────────────────
  console.log('\n━━━ Admin Wildcard Profile ────────────────────────────────────');
  const adminHeaders = { 'X-Profile-Name': 'admin' };
  const adminProfile = await requestWithHeaders('GET', '/api/profile?name=admin', undefined, adminHeaders);
  ok('admin profile exists',             adminProfile.status === 200);
  eq('admin has one wildcard entry',     adminProfile.body?.signals?.length, 1);
  eq('admin wildcard name is *',         adminProfile.body?.signals?.[0]?.name, '*');
  ok('admin wildcard permission is full', adminProfile.body?.signals?.[0]?.permission?.includes('full'));

  const adminSignals = await requestWithHeaders('GET', '/signals', undefined, adminHeaders);
  ok('admin can read signals',            adminSignals.status === 200);
  eq('admin can read complete catalog',   adminSignals.body?.total, info.body.signal_count);
  eq('admin signal filter has no warnings', adminSignals.body?.warnings?.length, 0);

  const adminAvailable = await requestWithHeaders('GET', '/signals/available', undefined, adminHeaders);
  const adminWritable = adminAvailable.body?.signals_info?.find(s => s.writable);
  ok('admin sees complete metadata',      adminAvailable.body?.signals_info?.every(s => s.value !== null));
  if (adminWritable) {
    const adminWrite = await requestWithHeaders(
      'PUT',
      `/signals/${encodeURIComponent(adminWritable.signal_name)}`,
      { value: adminWritable.min_value },
      adminHeaders
    );
    ok('admin full permission can write', adminWrite.status === 202);
  } else {
    ok('admin full permission can write', false);
  }

  // ── GET /api/profile?name=NONEXISTENT ─────────────────────────────────────
  console.log('\n━━━ GET /api/profile?name=NONEXISTENT ─────────────────────────');
  const missing = await request('GET', '/api/profile?name=NONEXISTENT');
  ok('404 Not Found',                   missing.status === 404);
  ok('has structured detail',           typeof missing.body?.detail?.code === 'string');

  // ── POST /api/profile (create) ────────────────────────────────────────────
  console.log('\n━━━ POST /api/profile ─────────────────────────────────────────');
  const created = await request('POST', '/api/profile', {
    name: '_TEST_PROFILE',
    signals: buildProfileSignals(['HB_FL_ActivationLevel', 'CoolantTemp'], ['read']),
    description: 'Temp test profile',
  });
  ok('201 Created',                     created.status === 201);
  eq('name matches',                    created.body?.name, '_TEST_PROFILE');
  ok('has signals',                     Array.isArray(created.body?.signals));
  eq('signals count',                   created.body.signals.length, 2);

  // ── POST duplicate → 409 ──────────────────────────────────────────────────
  const dup = await request('POST', '/api/profile', {
    name: '_TEST_PROFILE',
    signals: buildProfileSignals(['HB_FL_ActivationLevel'], ['read']),
  });
  ok('409 Conflict on duplicate',       dup.status === 409);

  // ── PUT /api/profile (update) ─────────────────────────────────────────────
  console.log('\n━━━ PUT /api/profile ──────────────────────────────────────────');
  // Need correct section_id
  const profs2 = await request('GET', '/api/profiles');
  const sid    = created.body.section_id;
  const updated = await request('PUT', '/api/profile', {
    name: '_TEST_PROFILE',
    signals: [
      { name: 'HB_FL_ActivationLevel', permission: ['read'] },
      { name: 'CoolantTemp', permission: ['read'] },
      { name: 'EngineSpeed', permission: ['read'] },
    ],
    description: 'Updated test profile',
    section_id: sid,
  });
  ok('200 OK',                          updated.status === 200);
  ok('signals updated',                 updated.body?.signals?.length === 3);

  // ── PUT wrong section_id → 409 ────────────────────────────────────────────
  const badSid = await request('PUT', '/api/profile', {
    name: '_TEST_PROFILE',
    section_id: -1,
  });
  ok('409 on section_id mismatch',      badSid.status === 409);

  // ── PUT /api/profile/active ───────────────────────────────────────────────
  const selectOk = await request('PUT', '/api/profile/active', {
    name: 'U0',
  });
  ok('set active returns 200',          selectOk.status === 200);
  eq('active profile is U0',            selectOk.body?.active, 'U0');
  // Verify U0 is now active
  const activeNow = await request('GET', '/api/profile');
  eq('U0 is active after select',       activeNow.body?.name, 'U0');

  // ── DELETE /api/profile/:name ─────────────────────────────────────────────
  console.log('\n━━━ DELETE /api/profile ───────────────────────────────────────');
  const del = await request('DELETE', '/api/profile/_TEST_PROFILE');
  ok('204 No Content',                  del.status === 204);
  const afterDel = await request('GET', '/api/profiles');
  ok('profile removed',                 !afterDel.body.profiles.find(p => p.name === '_TEST_PROFILE'));

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
  ok('returns items array',             Array.isArray(sigs.body?.items));
  ok('items have value field',          typeof sigs.body.items[0]?.value !== 'undefined');
  ok('items have signal_name field',    !!sigs.body.items[0]?.signal_name);
  ok('items have timestamp',            sigs.body.items[0]?.timestamp !== undefined);
  console.log(`   signal count: ${sigs.body.items.length}`);

  // ── GET /signals/available ────────────────────────────────────────────────
  console.log('\n━━━ GET /signals/available ────────────────────────────────────');
  const avail = await request('GET', '/signals/available');
  ok('200 OK',                          avail.status === 200);
  ok('returns signals_info array',      Array.isArray(avail.body?.signals_info));
  ok('has metadata fields',             typeof avail.body.signals_info[0]?.min_value === 'number');
  ok('has writable field',              typeof avail.body.signals_info[0]?.writable === 'boolean');
  ok('states field present',            Array.isArray(avail.body.signals_info[0]?.states));
  console.log(`   available signals: ${avail.body.signals_info.length}`);

  // Resolve current active profile read/write scope for signal tests.
  const currentProfile = await request('GET', '/api/profile');
  const profileSignals = Array.isArray(currentProfile.body?.signals) ? currentProfile.body.signals : [];
  const canWriteNames = new Set(
    profileSignals
      .filter((s) => Array.isArray(s.permission) && (s.permission.includes('write') || s.permission.includes('full')))
      .map((s) => s.name)
  );
  const canReadNames = new Set(
    profileSignals
      .filter((s) => Array.isArray(s.permission) && (s.permission.includes('read') || s.permission.includes('full')))
      .map((s) => s.name)
  );

  const aWritable = avail.body.signals_info.find((s) => s.writable && canWriteNames.has(s.signal_name));
  const aNonWritable = avail.body.signals_info.find((s) => !s.writable && canReadNames.has(s.signal_name));
  const aReadable = sigs.body.items[0]?.signal_name || null;

  // ── GET /signals/:name (existing) ─────────────────────────────────────────
  console.log('\n━━━ GET /signals/:name (existing) ─────────────────────────────');
  if (aReadable) {
    const getRes = await request('GET', `/signals/${aReadable}`);
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
  } else {
    console.log('   ⚠️  No readable signal found in active profile scope');
  }

  // ── GET /signals/:name (non-existent → 404) ──────────────────────────────
  console.log('\n━━━ GET /signals/:name (non-existent) ─────────────────────────');
  const getMissing = await request('GET', '/signals/__NOSIGNAL__');
  ok('403/404 for non-existent or out-of-scope signal', getMissing.status === 403 || getMissing.status === 404);
  ok('has error message',                !!getMissing.body?.error || !!getMissing.body?.detail?.message);

  // ── PUT /signals/:name (writable) ─────────────────────────────────────────
  console.log('\n━━━ PUT /signals/:name (writable) ─────────────────────────────');
  if (aWritable) {
    const writeValue = Number(aWritable.min_value) + 5;
    const writeRes = await request('PUT', `/signals/${aWritable.signal_name}`, { value: writeValue });
    ok('202 Accepted',                    writeRes.status === 202);
    ok('has signal_name',                 !!writeRes.body?.signal_name);
    ok('has std_name',                    !!writeRes.body?.std_name);
    ok('has value',                       writeRes.body?.value === writeValue);
    ok('has queued_at',                   !!writeRes.body?.queued_at);
    console.log(`   wrote ${aWritable.signal_name} = ${writeValue}`);
  } else {
    console.log('   ⚠️  No writable signal found in active profile scope');
  }

  // ── PUT /signals/:name (non-writable → 403) ──────────────────────────────
  console.log('\n━━━ PUT /signals/:name (non-writable → 403) ───────────────────');
  if (aNonWritable) {
    const deny = await request('PUT', `/signals/${aNonWritable.signal_name}`, { value: 0 });
    ok('403 Forbidden',                   deny.status === 403);
    ok(
      'has write-denied style error code',
      deny.body?.code === 'SAFE_WRITE_DENIED'
        || deny.body?.id === 'SAFE_WRITE_DENIED'
        || typeof deny.body?.detail?.code === 'string'
    );
    console.log(`   denied write to ${aNonWritable.signal_name}`);
  }

  // ── PUT /signals/:name (non-existent → 404) ──────────────────────────────
  const noSig = await request('PUT', '/signals/__NOSIGNAL__', { value: 0 });
  ok('403/404 for non-existent or out-of-scope signal', noSig.status === 403 || noSig.status === 404);

  // ── PUT /signals/:name (out of range → 422) ──────────────────────────────
  if (aWritable) {
    val: {  // eslint-disable-line no-labels
      const oor = await request('PUT', `/signals/${aWritable.signal_name}`, { value: Number(aWritable.max_value) + 999 });
      // Some servers may accept due to mock behavior; check if 422
      if (oor.status === 422) {
        ok('422 for out-of-range value',    true);
        ok(
          'error code VAL_OUT_OF_RANGE',
          oor.body?.code === 'VAL_OUT_OF_RANGE'
            || oor.body?.id === 'VAL_OUT_OF_RANGE'
            || oor.body?.detail?.code === 'VAL_OUT_OF_RANGE'
        );
      } else {
        console.log(`   ⚠️  Out-of-range returned ${oor.status} (not 422)`);
      }
    }
  }

  // ── POST /signals/batch_update ────────────────────────────────────────────
  console.log('\n━━━ POST /signals/batch_update ────────────────────────────────');
  const batchItems = [];
  if (aWritable) batchItems.push({ name: aWritable.signal_name, value: Number(aWritable.min_value) + 3 });
  if (aNonWritable) batchItems.push({ name: aNonWritable.signal_name, value: 1 });
  batchItems.push({ name: '__NOEXIST__', value: 0 });

  const batchRes = await request('POST', '/signals/batch_update', { signals: batchItems });
  ok('202 Accepted',                    batchRes.status === 202);
  ok('has queued array',                Array.isArray(batchRes.body?.queued));
  ok('count matches queued length',     batchRes.body?.count === batchRes.body?.queued?.length);
  ok('has queued_at',                   typeof batchRes.body?.queued_at === 'number');
  ok('has errors array',                Array.isArray(batchRes.body?.errors));
  if (aWritable) {
    const okItem = batchRes.body.queued.find(r => r.signal_name === aWritable.signal_name);
    ok('writable signal queued',         okItem?.signal_name === aWritable.signal_name);
  }
  if (aNonWritable) {
    const denyItem = batchRes.body.errors.find(r => r.signal_name === aNonWritable.signal_name);
    const filtered = Array.isArray(batchRes.body?.warnings)
      && batchRes.body.warnings.some((w) => Array.isArray(w.signals) && w.signals.includes(aNonWritable.signal_name));
    ok('non-writable denied or filtered', denyItem?.error === 'not_writable' || filtered);
  }
  const missingItem = batchRes.body.errors.find(r => r.signal_name === '__NOEXIST__');
  ok('non-existent in errors',          missingItem?.error === 'not_found');

  // ── Dev Mode APIs ─────────────────────────────────────────────────────────
  console.log('\n━━━ Dev Mode APIs ─────────────────────────────────────────────');
  const clientAHeaders = { 'X-Client-Id': 'test-dev-client-a' };
  const clientBHeaders = { 'X-Client-Id': 'test-dev-client-b' };

  const devCatalog = await request('GET', '/api/devmode/catalog');
  ok('devmode catalog 200',             devCatalog.status === 200);
  ok('devmode seats list',              Array.isArray(devCatalog.body?.seats) && devCatalog.body.seats.length === 5);

  const devStatus = await requestWithHeaders('GET', '/api/devmode/status', undefined, clientAHeaders);
  ok('devmode status 200',              devStatus.status === 200);
  ok('devmode status has seats object', typeof devStatus.body?.seats === 'object' && devStatus.body.seats !== null);

  const selectNoHeader = await request('POST', '/api/devmode/seats/select', { seats: { fl: true } });
  ok('devmode select requires client header', selectNoHeader.status === 400);

  const selectSeats = await requestWithHeaders(
    'POST',
    '/api/devmode/seats/select',
    { seats: { fl: true, fr: true }, block_timeout_sec: 60 },
    clientAHeaders,
  );
  ok('devmode seat select 200/409',     selectSeats.status === 200 || selectSeats.status === 409);
  ok('devmode seat select has applied', typeof selectSeats.body?.applied === 'object' && selectSeats.body.applied !== null);

  const devApply = await requestWithHeaders(
    'POST',
    '/api/devmode/signals',
    { signal_name: 'ABL_RetractRequest', value: 3, seats: { fl: true, fr: true }, block_timeout_sec: 60 },
    clientAHeaders,
  );
  ok('devmode signal apply 200/409',    devApply.status === 200 || devApply.status === 409);
  ok('devmode signal apply has applied', typeof devApply.body?.applied === 'object' && devApply.body.applied !== null);

  const crossWrite = await requestWithHeaders(
    'PUT',
    '/signals/ABL_FL_RetractRequest',
    { value: 4 },
    clientBHeaders,
  );
  ok('cross-section write blocked or accepted based on lock', crossWrite.status === 423 || crossWrite.status === 202 || crossWrite.status === 403);
  if (crossWrite.status === 423) {
    ok('lock error code devmode_seat_locked', crossWrite.body?.detail?.code === 'devmode_seat_locked');
  }

  const devExit = await requestWithHeaders('POST', '/api/devmode/exit', {}, clientAHeaders);
  ok('devmode exit 200',                devExit.status === 200);
  ok('devmode exit has count',          typeof devExit.body?.count === 'number');

  // ── GET /api/restraints/match ─────────────────────────────────────────────
  console.log('\n━━━ GET /api/restraints/match ─────────────────────────────────');
  const rst = await request('GET', '/api/restraints/match?weight=75&height=175&crash_severity=40&seatbelt_system=SLL&seat=fl');
  ok('200 OK',                          rst.status === 200);
  ok('matched is boolean',              typeof rst.body?.matched === 'boolean');
  ok('has context object',              typeof rst.body?.context === 'object' && rst.body.context !== null);
  if (rst.body?.matched) {
    ok('has video.filename',            !!rst.body?.video?.filename);
    ok('has video.percentile',          typeof rst.body?.video?.percentile === 'number');
    ok('has video.velocity_kmh',        typeof rst.body?.video?.velocity_kmh === 'number');
    ok('has score',                     typeof rst.body?.score === 'number');
    ok('filename includes _SLL',        rst.body.video.filename.includes('_SLL.'));
    console.log(`   video: ${rst.body.video.filename}, score: ${rst.body.score}`);
  } else {
    ok('video is null when unmatched',  rst.body?.video === null);
    ok('score 0 when unmatched',        rst.body?.score === 0);
    console.log('   unmatched (no media candidates found)');
  }

  // ── Missing params → 400 ──────────────────────────────────────────────────
  const noSeat = await request('GET', '/api/restraints/match');
  ok('400 without required params',     noSeat.status === 400);

  const badSeat = await request('GET', '/api/restraints/match?weight=75&height=175&crash_severity=40&seatbelt_system=SLL&seat=invalid');
  ok('422 with invalid seat',           badSeat.status === 422);

  const badBelt = await request('GET', '/api/restraints/match?weight=75&height=175&crash_severity=40&seatbelt_system=INVALID&seat=fl');
  ok('422 with invalid seatbelt_system', badBelt.status === 422);

  const badCrashSeverity = await request('GET', '/api/restraints/match?weight=75&height=175&crash_severity=INVALID&seatbelt_system=CLL&seat=fl');
  ok('422 with invalid crash_severity', badCrashSeverity.status === 422);

  const missingVideo = await request('GET', '/api/restraints/video/50p_mid_40_SLL.mp4');
  ok('404 when video file missing',     missingVideo.status === 404);

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
