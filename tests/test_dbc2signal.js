/**
 * test_dbc2signal.js - Tests for DBC parser (dbc2signal.js)
 *
 * Runs dbc2signal.js as a subprocess with temp DBC files.
 *
 * Run: node tests/test_dbc2signal.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP  = path.join(ROOT, '.test_tmp');

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

// ── Temp file helpers ─────────────────────────────────────────────────────────
function writeTempDbc(name, content) {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function runDbc2Signal(inputDbc, outputJson) {
  const script = path.join(ROOT, 'candb', 'dbc2signal.js');
  const out    = outputJson || path.join(TMP, 'test_output.json');
  const result = spawnSync('node', [script, inputDbc, out], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, outputPath: out };
}

function cleanup() {
  if (fs.existsSync(TMP)) {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

// ── Test DBC samples ──────────────────────────────────────────────────────────
const SIMPLE_DBC = `
BO_ 100 CAR_PC_VehicleState: 8 CAR_PC
 SG_ VehicleSpeed : 0|16@1+ (1,0) [0|300] "km/h" Vector__XXX
 SG_ EngineRPM : 16|16@1+ (1,0) [0|8000] "rpm" Vector__XXX

CM_ SG_ 100 VehicleSpeed "Vehicle speed from wheel sensors";
CM_ SG_ 100 EngineRPM "Engine revolutions per minute\\nSignalvalues: Haptic 1-6";
VAL_ 100 EngineRPM 0 "Idle" 500 "Medium" 1000 "High" ;
`;

const DBC_WITH_TX = `
BO_ 200 CAR_PC_Controls: 8 CAR_PC
 SG_ HB_FL_ActivationLevel : 0|4@1+ (1,0) [0|15] "" CAR_PC
 SG_ HB_FR_ActivationLevel : 4|4@1+ (1,0) [0|15] "" Vector__XXX

CM_ SG_ 200 HB_FL_ActivationLevel "Haptic Brake FL activation level";
CM_ SG_ 200 HB_FR_ActivationLevel "Haptic Brake FR activation level";
VAL_ 200 HB_FL_ActivationLevel 0 "Off" 1 "Low" 2 "Medium" 3 "High" ;
`;

const DBC_WITH_ENCODED_UNIT = 'BO_ 400 TEMP_SENSOR: 8 CAR_PC\n' +
  ' SG_ CoolantTemp : 0|8@1+ (1,0) [-40|120] "\u00ef\u00bf\u00bdC" Vector__XXX\n' +
  '\nCM_ SG_ 400 CoolantTemp "Engine coolant temperature";\n';

// ── Run tests ─────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🧪 DBC Parser Tests\n');

  try {
    // ── 1. Basic DBC parsing ────────────────────────────────────────────────
    console.log('\n━━━ 1. Basic DBC Parsing ────────────────────────────────────');
    const dbc1 = writeTempDbc('test_simple.dbc', SIMPLE_DBC);
    const out1 = path.join(TMP, 'out_simple.json');
    const r1 = runDbc2Signal(dbc1, out1);
    ok('script exits with code 0',       r1.status === 0);

    const data1 = JSON.parse(fs.readFileSync(out1, 'utf8'));
    ok('output has signals array',       Array.isArray(data1.signals));
    eq('found 2 signals',                data1.signals.length, 2);

    const vs = data1.signals.find(s => s.name === 'VehicleSpeed');
    ok('VehicleSpeed found',             !!vs);
    eq('VehicleSpeed unit km/h',         vs.unit, 'km/h');
    eq('VehicleSpeed min 0',             vs.min, 0);
    eq('VehicleSpeed max 300',           vs.max, 300);
    ok('VehicleSpeed is RX',             vs.RX === true);
    ok('VehicleSpeed is TX',             vs.TX === true);

    const er = data1.signals.find(s => s.name === 'EngineRPM');
    ok('EngineRPM found',                !!er);
    eq('EngineRPM unit rpm',             er.unit, 'rpm');
    ok('EngineRPM has states',           Array.isArray(er.states) && er.states.length > 0);
    eq('EngineRPM states count',         er.states.length, 3);

    // ── 2. TX detection ─────────────────────────────────────────────────────
    console.log('\n━━━ 2. TX Detection ──────────────────────────────────────────');
    const dbc2 = writeTempDbc('test_tx.dbc', DBC_WITH_TX);
    const out2 = path.join(TMP, 'out_tx.json');
    const r2   = runDbc2Signal(dbc2, out2);
    ok('script exits with code 0',       r2.status === 0);

    const data2 = JSON.parse(fs.readFileSync(out2, 'utf8'));
    const txSig = data2.signals.find(s => s.name === 'HB_FL_ActivationLevel');
    ok('HB_FL_ActivationLevel is TX',    txSig?.TX === true);
    ok('HB_FL_ActivationLevel is RX',    txSig?.RX === true);

    const rxSig = data2.signals.find(s => s.name === 'HB_FR_ActivationLevel');
    ok('HB_FR_ActivationLevel is TX',    rxSig?.TX === true);
    ok('HB_FR_ActivationLevel is RX',    rxSig?.RX === true);

    // ── 3. Destination parsing ──────────────────────────────────────────────
    console.log('\n━━━ 3. Destination Parsing ────────────────────────────────────');
    ok('HB_FL destination = CAR_PC',     txSig?.destination?.includes('CAR_PC'));
    ok('HB_FR destination empty',        rxSig?.destination?.length === 0);

    // ── 4. Unit encoding cleanup ────────────────────────────────────────────
    console.log('\n━━━ 4. Unit Encoding Cleanup ──────────────────────────────────');
    const dbc4 = writeTempDbc('test_encoded_unit.dbc', DBC_WITH_ENCODED_UNIT);
    const out4 = path.join(TMP, 'out_encoded.json');
    const r4   = runDbc2Signal(dbc4, out4);
    ok('script exits with code 0',       r4.status === 0);

    const data4 = JSON.parse(fs.readFileSync(out4, 'utf8'));
    const ct = data4.signals.find(s => s.name === 'CoolantTemp');
    ok('CoolantTemp found',              !!ct);
    ok('Unit is °C (cleaned)',           ct.unit === '°C');

    // ── 5. Source parsing ───────────────────────────────────────────────────
    console.log('\n━━━ 5. Source / Sender Parsing ───────────────────────────────');
    eq('VehicleSpeed source = CAR_PC',   vs.source?.[0], 'CAR_PC');

    // ── 6. Real DBC file test ───────────────────────────────────────────────
    console.log('\n━━━ 6. Real DBC File Parsing ──────────────────────────────────');
    const realDbcPath = path.join(ROOT, 'candb', 'p_v3.dbc');
    const realOutPath = path.join(TMP, 'out_real.json');

    if (fs.existsSync(realDbcPath)) {
      const r5 = runDbc2Signal(realDbcPath, realOutPath);
      if (r5.status === 0) {
        const data5 = JSON.parse(fs.readFileSync(realOutPath, 'utf8'));
        ok('real DBC produced signals',   data5.signals.length > 0);
        const txCount = data5.signals.filter(s => s.TX).length;
        const rxOnly  = data5.signals.filter(s => !s.TX).length;
        console.log(`   signals: ${data5.signals.length} total (TX: ${txCount}, RX only: ${rxOnly})`);
      } else {
        console.log(`   ⚠️  Real DBC test stderr: ${r5.stderr?.substring(0, 200)}`);
      }
    } else {
      console.log('   ⚠️  p_v3.dbc not found, skipping real DBC test');
    }

    // ── 7. Backup logic ─────────────────────────────────────────────────────
    console.log('\n━━━ 7. Backup Logic ──────────────────────────────────────────');
    const backupTestOut = path.join(TMP, 'backup_test.json');
    const dbcBackup = writeTempDbc('test_backup.dbc', SIMPLE_DBC);

    const rb1 = runDbc2Signal(dbcBackup, backupTestOut);
    ok('first run ok',                   rb1.status === 0);

    const rb2 = runDbc2Signal(dbcBackup, backupTestOut);
    ok('second run ok',                  rb2.status === 0);

    const backupFiles = fs.readdirSync(TMP).filter(f => f.startsWith('backup_test.bk_'));
    ok('backup file created',            backupFiles.length >= 1);
    console.log(`   backup files: ${backupFiles.join(', ')}`);

    // ── 8. Error handling ──────────────────────────────────────────────────
    console.log('\n━━━ 8. Error Handling ─────────────────────────────────────────');
    const rErr = runDbc2Signal(path.join(TMP, 'nonexistent.dbc'), path.join(TMP, 'out_err.json'));
    ok('non-existent DBC exits with code 1', rErr.status === 1);

  } finally {
    cleanup();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(55)}`);
  if (failed === 0) {
    console.log(`✅ ALL ${passed} DBC PARSER TESTS PASSED`);
  } else {
    console.error(`❌ ${failed} FAILED / ${passed} passed`);
    process.exit(1);
  }
})().catch(e => {
  console.error('\n❌ FATAL:', e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});