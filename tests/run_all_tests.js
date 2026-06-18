/**
 * run_all_tests.js - Run all project tests sequentially
 *
 * Usage:
 *   node tests/run_all_tests.js              # Run all tests
 *   node tests/run_all_tests.js --quick      # Skip server startup tests
 *
 * This script:
 *   1. Tests DBC parser (no server needed)
 *   2. Tests Mock API (no server needed)
 *   3. Starts server on random port
 *   4. Tests REST API endpoints
 *   5. Tests WebSocket endpoints
 *   6. Stops the server
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const ROOT    = path.resolve(__dirname, '..');
const TESTS   = __dirname;

const colors = {
  reset:  '\x1b[0m',
  bright: '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
};

function run(label, scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`\n${colors.bright}${colors.cyan}══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}${colors.yellow}  ${label}${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════${colors.reset}\n`);

    if (!fs.existsSync(scriptPath)) {
      console.warn(`  ⚠️  Test script not found: ${scriptPath}`);
      return resolve({ passed: 0, failed: 0, skipped: true });
    }

    const proc = spawn('node', [scriptPath, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    });

    proc.on('exit', (code) => {
      if (code === 0) resolve({ passed: 1, failed: 0, skipped: false });
      else reject(new Error(`${label} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

(async () => {
  const quickMode = process.argv.includes('--quick');

  console.log(`\n${colors.bright}${colors.cyan}╔══════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}║     CAR-HMI API DEMO - TEST SUITE       ║${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}╚══════════════════════════════════════════╝${colors.reset}`);
  console.log(`   Started: ${new Date().toISOString()}`);
  console.log(`   Mode:    ${quickMode ? 'Quick (offline tests only)' : 'Full'}\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests  = 0;

  // ── Test 1: DBC Parser ────────────────────────────────────────────────────
  totalTests++;
  try {
    await run('📄 Test 1/5: DBC Parser', path.join(TESTS, 'test_dbc2signal.js'));
    totalPassed++;
  } catch (e) {
    totalFailed++;
    console.error(`\n  ❌ DBC Parser tests failed`);
  }

  // ── Test 2: Mock API ──────────────────────────────────────────────────────
  totalTests++;
  try {
    await run('🧪 Test 2/5: Mock API', path.join(ROOT, '_test_mock.js'));
    totalPassed++;
  } catch (e) {
    totalFailed++;
    console.error(`\n  ❌ Mock API tests failed`);
  }

  if (quickMode) {
    console.log(`\n${colors.bright}${colors.yellow}── Quick mode: skipping server-dependent tests ──${colors.reset}`);
  } else {
    // ── Test 3: Server REST API ─────────────────────────────────────────────
    totalTests++;
    try {
      await run('🌐 Test 3/5: Server REST API', path.join(TESTS, 'test_server_api.js'));
      totalPassed++;
    } catch (e) {
      totalFailed++;
      console.error(`\n  ❌ Server API tests failed`);
    }

    // ── Test 4: WebSocket ───────────────────────────────────────────────────
    totalTests++;
    try {
      await run('🔌 Test 4/5: WebSocket', path.join(TESTS, 'test_websocket.js'));
      totalPassed++;
    } catch (e) {
      totalFailed++;
      console.error(`\n  ❌ WebSocket tests failed`);
    }

    // ── Test 5: Stress/Load (bonus) ─────────────────────────────────────────
    totalTests++;
    try {
      await run('⚡ Test 5/5: Stress / Load (basic)', path.join(TESTS, 'test_stress.js'));
      totalPassed++;
    } catch (e) {
      totalFailed++;
      console.error(`\n  ❌ Stress tests failed`);
    }
  }

  // ── Final Summary ─────────────────────────────────────────────────────────
  console.log(`\n${colors.bright}${colors.cyan}══════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright} FINAL SUMMARY${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════${colors.reset}`);
  console.log(`   Test suites: ${totalTests}`);
  console.log(`   Passed:      ${colors.green}${totalPassed}${colors.reset}`);
  console.log(`   Failed:      ${totalFailed > 0 ? colors.red + totalFailed : totalFailed}${colors.reset}`);
  console.log(`   Finished:    ${new Date().toISOString()}`);

  if (totalFailed > 0) {
    console.error(`\n${colors.red}${colors.bright}❌ Some test suites FAILED${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`\n${colors.green}${colors.bright}✅ ALL TEST SUITES PASSED${colors.reset}\n`);
    process.exit(0);
  }
})().catch(e => {
  console.error('\n❌ FATAL:', e.message);
  process.exit(1);
});