#!/usr/bin/env node
'use strict';

/**
 * ws_smoke_cli.js - WebSocket smoke test for deployed endpoint
 *
 * Usage:
 *   node tests/ws_smoke_cli.js
 *   node tests/ws_smoke_cli.js --base https://car-hmi-api-demo.onrender.com
 *   node tests/ws_smoke_cli.js --base http://localhost:8000
 *   node tests/ws_smoke_cli.js --base https://host --api-key your_key
 *
 * Exit codes:
 *   0 = all smoke checks passed
 *   1 = one or more checks failed
 *   2 = invalid arguments/runtime error
 */

let WebSocket;
try {
  WebSocket = require('ws');
} catch (_) {
  console.error('FAIL dependency: "ws" module not found. Run: npm install');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    base: 'https://car-hmi-api-demo.onrender.com',
    apiKey: '',
    timeoutMs: 8000,
    stayOpenMs: 1200,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base' && argv[i + 1]) {
      out.base = argv[++i];
    } else if (a === '--api-key' && argv[i + 1]) {
      out.apiKey = argv[++i];
    } else if (a === '--timeout-ms' && argv[i + 1]) {
      out.timeoutMs = Number(argv[++i]);
    } else if (a === '--stay-open-ms' && argv[i + 1]) {
      out.stayOpenMs = Number(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) {
    console.error('Invalid --timeout-ms (must be >= 1000)');
    process.exit(2);
  }
  if (!Number.isFinite(out.stayOpenMs) || out.stayOpenMs < 0) {
    console.error('Invalid --stay-open-ms (must be >= 0)');
    process.exit(2);
  }

  return out;
}

function printHelp() {
  console.log('WebSocket smoke test CLI');
  console.log('Options:');
  console.log('  --base <url>         Base URL, default: https://car-hmi-api-demo.onrender.com');
  console.log('  --api-key <key>      Optional API key for ws auth query');
  console.log('  --timeout-ms <n>     Per-check timeout in ms, default: 8000');
  console.log('  --stay-open-ms <n>   Keep connection open after first success, default: 1200');
}

function toWsOrigin(base) {
  const u = new URL(base);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`Unsupported scheme: ${u.protocol}`);
  }
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

function wsUrl(wsOrigin, path, apiKey) {
  const u = new URL(wsOrigin + path);
  if (apiKey) u.searchParams.set('api_key', apiKey);
  return u.toString();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

async function openSocket(url, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  }), timeoutMs, `open ${url}`);
}

async function closeSocket(ws) {
  if (!ws || ws.readyState >= WebSocket.CLOSING) return;
  await new Promise(resolve => {
    ws.once('close', () => resolve());
    ws.close();
    setTimeout(resolve, 1200);
  });
}

async function waitForMessage(ws, timeoutMs) {
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = data => {
      cleanup();
      resolve(data.toString());
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`closed before message: code=${code} reason=${String(reason || '')}`));
    };
    const onError = err => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  }), timeoutMs, 'wait message');
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

async function runCase(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const dur = Date.now() - started;
    console.log(`PASS ${name} (${dur}ms)${detail ? ` - ${detail}` : ''}`);
    return true;
  } catch (e) {
    const dur = Date.now() - started;
    console.log(`FAIL ${name} (${dur}ms) - ${e.message}`);
    return false;
  }
}

async function caseSignalsSubscribeStar(wsOrigin, cfg) {
  const url = wsUrl(wsOrigin, '/ws/signals', cfg.apiKey);
  const ws = await openSocket(url, cfg.timeoutMs);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', signals: ['*'] }));
    const first = await waitForMessage(ws, cfg.timeoutMs);
    const data = parseJson(first);
    if (!data) throw new Error('first frame is not JSON');

    const isAck = data.type === 'subscribe_ack' || data.type === 'subscribed';
    const isSnapshot = Array.isArray(data.signals) && data.signals.length >= 1;
    if (!isAck && !isSnapshot) {
      throw new Error(`unexpected first frame: ${first.slice(0, 160)}`);
    }

    await wait(cfg.stayOpenMs);
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error('socket closed shortly after subscribe');
    }
    return isAck ? `ack=${data.type}` : `snapshot=${data.signals.length}`;
  } finally {
    await closeSocket(ws);
  }
}

async function caseSignalsPingPong(wsOrigin, cfg) {
  const url = wsUrl(wsOrigin, '/ws/signals', cfg.apiKey);
  const ws = await openSocket(url, cfg.timeoutMs);
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, cfg.timeoutMs);
    const data = parseJson(msg);
    if (!data || data.type !== 'pong') {
      throw new Error(`expected pong, got: ${msg.slice(0, 160)}`);
    }
    return 'pong';
  } finally {
    await closeSocket(ws);
  }
}

async function caseSignalsSubscribeSpecific(wsOrigin, cfg) {
  const url = wsUrl(wsOrigin, '/ws/signals', cfg.apiKey);
  const ws = await openSocket(url, cfg.timeoutMs);
  try {
    ws.send(JSON.stringify({ type: 'subscribe', signals: ['HMI_CrashSeverity'] }));
    const msg = await waitForMessage(ws, cfg.timeoutMs);
    const data = parseJson(msg);
    if (!data) throw new Error('response is not JSON');
    const ok = data.type === 'subscribe_ack' || data.type === 'subscribed' || Array.isArray(data.signals);
    if (!ok) throw new Error(`unexpected frame: ${msg.slice(0, 160)}`);
    return data.type || 'signal-frame';
  } finally {
    await closeSocket(ws);
  }
}

async function caseWsAllPingPong(wsOrigin, cfg) {
  const url = wsUrl(wsOrigin, '/ws/all', cfg.apiKey);
  const ws = await openSocket(url, cfg.timeoutMs);
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, cfg.timeoutMs);
    const data = parseJson(msg);
    if (!data || data.type !== 'pong') {
      throw new Error(`expected pong, got: ${msg.slice(0, 160)}`);
    }
    return 'pong';
  } finally {
    await closeSocket(ws);
  }
}

async function caseWsAlarmsPingPong(wsOrigin, cfg) {
  const url = wsUrl(wsOrigin, '/ws/alarms', cfg.apiKey);
  const ws = await openSocket(url, cfg.timeoutMs);
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
    const msg = await waitForMessage(ws, cfg.timeoutMs);
    const data = parseJson(msg);
    if (!data || data.type !== 'pong') {
      throw new Error(`expected pong, got: ${msg.slice(0, 160)}`);
    }
    return 'pong';
  } finally {
    await closeSocket(ws);
  }
}

(async () => {
  const cfg = parseArgs(process.argv);
  let wsOrigin;
  try {
    wsOrigin = toWsOrigin(cfg.base);
  } catch (e) {
    console.error(`Invalid --base: ${e.message}`);
    process.exit(2);
  }

  console.log('WS smoke target:', wsOrigin);
  console.log('timeoutMs:', cfg.timeoutMs, 'stayOpenMs:', cfg.stayOpenMs, 'apiKey:', cfg.apiKey ? '[set]' : '[not set]');

  const checks = [
    ['signals subscribe *', () => caseSignalsSubscribeStar(wsOrigin, cfg)],
    ['signals ping/pong', () => caseSignalsPingPong(wsOrigin, cfg)],
    ['signals subscribe specific', () => caseSignalsSubscribeSpecific(wsOrigin, cfg)],
    ['ws/all ping/pong', () => caseWsAllPingPong(wsOrigin, cfg)],
    ['ws/alarms ping/pong', () => caseWsAlarmsPingPong(wsOrigin, cfg)],
  ];

  let passed = 0;
  for (const [name, fn] of checks) {
    // eslint-disable-next-line no-await-in-loop
    if (await runCase(name, fn)) passed += 1;
  }

  const failed = checks.length - passed;
  console.log(`\nRESULT: ${passed}/${checks.length} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('FATAL', err && err.message ? err.message : err);
  process.exit(2);
});
