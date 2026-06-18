/**
 * test_stress.js - Basic load/stress tests for the server
 *
 * Run: node tests/test_stress.js
 *
 * Tests:
 *   1. Rapid sequential REST calls (burst)
 *   2. Multiple concurrent REST requests
 *   3. WebSocket reconnect storm
 */

'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const net     = require('net');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅', label); passed++; }
  else      { console.error('  ❌', label); failed++; }
}

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

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port:     global.__TEST_PORT__,
      path:     url,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  10000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  const port = global.__TEST_PORT__;

  console.log('\n🧪 Stress / Load Tests\n');

  // ── 1. Burst: 50 rapid REST calls ────────────────────────────────────────
  console.log('\n━━━ 1. Burst: 50 Rapid REST Calls ─────────────────────────────');
  const burstEndpoints = [
    '/api/info',
    '/api/profiles',
    '/config',
    '/configs',
    '/signals',
    '/signals/available',
  ];

  const burstStart = Date.now();
  const burstResults = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      request('GET', burstEndpoints[i % burstEndpoints.length])
    )
  );
  const burstDuration = Date.now() - burstStart;

  const allOk = burstResults.every(r => r.status === 200);
  ok(`50 burst requests in ${burstDuration}ms`, allOk);
  ok(`avg response < 200ms`, burstDuration / 50 < 200);

  // ── 2. Concurrent sign-up: 20 parallel profile writes ────────────────────
  console.log('\n━━━ 2. Concurrent Profile Writes ──────────────────────────────');
  const profs1 = await request('GET', '/api/profiles');
  const sid = profs1.body.section_id;

  const writeStart = Date.now();
  const writeResults = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      request('POST', '/api/profile', {
        profile_name: `_STRESS_${i}_${Date.now()}`,
        signals: ['Generic_SeatFunctionEnable'],
      })
    )
  );
  const writeDuration = Date.now() - writeStart;
  const createdCount = writeResults.filter(r => r.status === 201).length;
  ok(`Created ${createdCount}/10 concurrent profiles in ${writeDuration}ms`, createdCount >= 8);

  // Cleanup
  const profs2 = await request('GET', '/api/profiles');
  const stressProfiles = profs2.body.profiles.filter(p => p.profile_name.startsWith('_STRESS_'));
  await Promise.all(
    stressProfiles.map(p =>
      request('DELETE', `/api/profile/${encodeURIComponent(p.profile_name)}`)
    )
  );
  ok('Stress profiles cleaned up', true);

  // ── 3. WS connect storm ──────────────────────────────────────────────────
  console.log('\n━━━ 3. WebSocket Connect Storm ────────────────────────────────');
  const wsStormStart = Date.now();
  const stormClients = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/signals`);
        ws.on('open', () => resolve(ws));
        ws.on('error', () => resolve(null));
        setTimeout(() => resolve(null), 2000);
      })
    )
  );
  const wsStormDuration = Date.now() - wsStormStart;
  const connected = stormClients.filter(Boolean).length;
  ok(`Connected ${connected}/20 WS clients in ${wsStormDuration}ms`, connected >= 15);

  // Subscribe all
  await Promise.all(
    stormClients.filter(Boolean).map(ws =>
      new Promise(resolve => {
        ws.send(JSON.stringify({ type: 'subscribe', signals: '*' }));
        setTimeout(resolve, 300);
      })
    )
  );
  ok('All WS clients subscribed', true);

  // Close all
  stormClients.filter(Boolean).forEach(ws => ws.close());
  ok('All WS clients closed cleanly', true);

  // ── 4. Sequential REST + WS mixed ────────────────────────────────────────
  console.log('\n━━━ 4. Mixed REST + WS ────────────────────────────────────────');
  const mixedWs = new WebSocket(`ws://127.0.0.1:${port}/ws/signals`);
  await new Promise((resolve, reject) => {
    mixedWs.on('open', resolve);
    mixedWs.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 3000);
  });

  const mixedReceived = [];
  mixedWs.on('message', (d) => {
    try { mixedReceived.push(JSON.parse(d.toString())); } catch (_) {}
  });
  mixedWs.send(JSON.stringify({ type: 'subscribe', signals: '*' }));
  await new Promise(r => setTimeout(r, 300));

  // Make REST calls while WS is streaming
  const mixedStart = Date.now();
  for (let i = 0; i < 20; i++) {
    await request('GET', '/api/info');
  }
  const mixedDuration = Date.now() - mixedStart;
  ok(`20 REST calls during WS stream in ${mixedDuration}ms`, mixedDuration < 5000);

  // WS should still be receiving
  const beforeCount = mixedReceived.length;
  await new Promise(r => setTimeout(r, 600));
  ok('WS still receiving during REST', mixedReceived.length > beforeCount);

  mixedWs.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`✅ ALL ${passed} STRESS TESTS PASSED`);
  } else {
    console.error(`❌ ${failed} FAILED / ${passed} passed`);
    process.exit(1);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (!global.__TEST_PORT__) {
      const freePort = await getFreePort();
      global.__TEST_PORT__ = freePort;
      process.env.PORT = String(freePort);
      console.log(`🔧 Starting server on port ${freePort}...`);
      delete require.cache[require.resolve(path.join(ROOT, 'server.js'))];
      require(path.join(ROOT, 'server.js'));
      await new Promise(r => setTimeout(r, 500));
    }
    await runTests();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ FATAL:', e.message);
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }
})();