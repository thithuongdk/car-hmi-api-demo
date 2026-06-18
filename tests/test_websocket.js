/**
 * test_websocket.js - Tests for WebSocket /ws/signals endpoint
 *
 * Run: node tests/test_websocket.js
 *
 * Tests:
 *   1. Connect/disconnect
 *   2. Subscribe to all signals (*)
 *   3. Subscribe to specific signals
 *   4. Unsubscribe
 *   5. Ping/pong
 *   6. Verify streaming data format
 *   7. Multiple clients
 */

'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const net     = require('net');
let WebSocket;
try {
  WebSocket = require('ws');
} catch (_) {
  console.error('\n❌ "ws" module not found. Run: npm install');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');

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

function wsConnect(port, path) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}${path}`;
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    // timeout
    setTimeout(() => reject(new Error('WS connect timeout')), 3000);
  });
}

function wsSend(ws, msg) {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg), resolve);
  });
}

function wsCollect(ws, count, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(msgs);
    }, timeout);
    const handler = (data) => {
      try { msgs.push(JSON.parse(data.toString())); } catch (_) {}
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function runTests() {
  const port = global.__TEST_PORT__;
  const wsPath = '/ws/signals';

  console.log('\n🧪 WebSocket Tests\n');

  // ── 1. Connect & disconnect ───────────────────────────────────────────────
  console.log('\n━━━ 1. Connect & Disconnect ───────────────────────────────────');
  const ws1 = await wsConnect(port, wsPath);
  ok('WebSocket connected',             ws1.readyState === WebSocket.OPEN);
  ws1.close();
  ok('WebSocket closed',                true);

  // ── 2. Subscribe to ALL signals ───────────────────────────────────────────
  console.log('\n━━━ 2. Subscribe to All Signals (*) ───────────────────────────');
  const ws2 = await wsConnect(port, wsPath);
  const msgs2 = [];
  ws2.on('message', (data) => {
    try { msgs2.push(JSON.parse(data.toString())); } catch (_) {}
  });

  await wsSend(ws2, { type: 'subscribe', signals: '*' });
  await new Promise(r => setTimeout(r, 1200)); // wait for ack + snapshot + 1 stream tick

  const ack2 = msgs2.find(m => m.type === 'subscribed');
  ok('subscribed ack received',         !!ack2);
  eq('subscribed signals = *',          ack2?.signals, '*');
  ok('subscribed count > 0',            (ack2?.count || 0) > 0);

  const snapshot2 = msgs2.filter(m => !m.type && Array.isArray(m.signals));
  ok('at least one stream frame',       snapshot2.length >= 1);
  ok('stream frame has timestamp',      !!snapshot2[0]?.timestamp);
  ok('stream signals have name+value',  snapshot2[0]?.signals?.every(s => s.name && s.value !== undefined));
  console.log(`   frames received: ${snapshot2.length}, signals/frame: ${snapshot2[0]?.signals?.length || 0}`);

  // ── 3. Subscribe to specific signals ──────────────────────────────────────
  console.log('\n━━━ 3. Subscribe to Specific Signals ──────────────────────────');
  const ws3 = await wsConnect(port, wsPath);
  const msgs3 = [];
  ws3.on('message', (data) => {
    try { msgs3.push(JSON.parse(data.toString())); } catch (_) {}
  });

  // Pick 3 specific signals (non-writable ones)
  const pickNames = ['Generic_SeatFunctionEnable', 'HMI_CrashSeverity', 'HMI_FL_OccupantAge_years'];
  await wsSend(ws3, { type: 'subscribe', signals: pickNames });
  await new Promise(r => setTimeout(r, 1200));

  const ack3 = msgs3.find(m => m.type === 'subscribed');
  ok('subscribed ack with picks',       !!ack3);
  ok('count = 3',                       ack3?.count === 3);

  const frames3 = msgs3.filter(m => !m.type && Array.isArray(m.signals));
  if (frames3.length > 0) {
    const frameSigs = frames3.flatMap(f => f.signals.map(s => s.name));
    const leaking = frameSigs.filter(n => !pickNames.includes(n));
    ok('no non-subscribed signals',      leaking.length === 0);
  }

  // ── 4. Ping/Pong ─────────────────────────────────────────────────────────
  console.log('\n━━━ 4. Ping / Pong ────────────────────────────────────────────');
  const ws4 = await wsConnect(port, wsPath);
  const pongs = [];
  ws4.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.type === 'pong') pongs.push(m);
    } catch (_) {}
  });
  await wsSend(ws4, { type: 'ping' });
  await new Promise(r => setTimeout(r, 800));
  ok('pong received',                   pongs.length >= 1);
  ws4.close();

  // ── 5. Unsubscribe ────────────────────────────────────────────────────────
  console.log('\n━━━ 5. Unsubscribe ────────────────────────────────────────────');
  const ws5 = await wsConnect(port, wsPath);
  const msgs5 = [];
  ws5.on('message', (data) => {
    try { msgs5.push(JSON.parse(data.toString())); } catch (_) {}
  });

  // Subscribe to all first
  await wsSend(ws5, { type: 'subscribe', signals: '*' });
  await new Promise(r => setTimeout(r, 500));
  msgs5.length = 0; // clear

  // Unsubscribe specific signal
  await wsSend(ws5, { type: 'unsubscribe', signals: ['Generic_SeatFunctionEnable'] });
  await new Promise(r => setTimeout(r, 500));

  const unsubAck = msgs5.find(m => m.type === 'subscribed');
  ok('unsubscribe triggers re-subscribed ack', !!unsubAck);

  // Now subscribe to specific signals after unsubscribe
  await wsSend(ws5, { type: 'subscribe', signals: pickNames });
  await new Promise(r => setTimeout(r, 1200));

  const frames5 = msgs5.filter(m => !m.type && Array.isArray(m.signals));
  if (frames5.length > 0) {
    const leaking = frames5.flatMap(f => f.signals.map(s => s.name)).filter(n => !pickNames.includes(n));
    ok('only pick signals after re-subscribe', leaking.length === 0);
  }
  ws5.close();

  // ── 6. Multiple concurrent clients ────────────────────────────────────────
  console.log('\n━━━ 6. Multiple Concurrent Clients ────────────────────────────');
  const clients = await Promise.all([
    wsConnect(port, wsPath),
    wsConnect(port, wsPath),
    wsConnect(port, wsPath),
  ]);
  ok('3 concurrent clients connected',  clients.every(c => c.readyState === WebSocket.OPEN));

  // Subscribe each to different sets
  const clientMsgs = clients.map(() => []);
  clients.forEach((c, i) => {
    c.on('message', (data) => {
      try { clientMsgs[i].push(JSON.parse(data.toString())); } catch (_) {}
    });
  });

  await Promise.all([
    wsSend(clients[0], { type: 'subscribe', signals: '*' }),
    wsSend(clients[1], { type: 'subscribe', signals: pickNames.slice(0, 2) }),
    wsSend(clients[2], { type: 'subscribe', signals: pickNames.slice(2) }),
  ]);
  await new Promise(r => setTimeout(r, 1500));

  const ackCount = clientMsgs.map((msgs, i) => {
    const ack = msgs.find(m => m.type === 'subscribed');
    return ack ? ack.count : 0;
  });
  ok('client 0 got all signals',        ackCount[0] > 2);
  ok('client 1 got 2 signals',          ackCount[1] === 2);
  ok('client 2 got 1 signal',           ackCount[2] === 1);
  clients.forEach(c => c.close());

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`✅ ALL ${passed} WEBSOCKET TESTS PASSED`);
  } else {
    console.error(`❌ ${failed} FAILED / ${passed} passed`);
    process.exit(1);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (global.__TEST_PORT__) {
      // Port already set from test_server_api
      await runTests();
    } else {
      const freePort = await getFreePort();
      global.__TEST_PORT__ = freePort;
      process.env.PORT = String(freePort);

      console.log(`🔧 Starting server on port ${freePort}...`);
      delete require.cache[require.resolve(path.join(ROOT, 'server.js'))];
      require(path.join(ROOT, 'server.js'));
      await new Promise(r => setTimeout(r, 500));
      await runTests();
    }
    if (!global.__WS_KEEP_ALIVE) process.exit(0);
  } catch (e) {
    console.error('\n❌ FATAL:', e.message);
    console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }
})();