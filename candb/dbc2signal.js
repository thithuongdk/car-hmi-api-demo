#!/usr/bin/env node
/**
 * dbc2signal.js - Convert a .dbc file to candb/signal.json
 *
 * Usage:
 *   node candb/dbc2signal.js [input.dbc] [output.json]
 *
 * Defaults:
 *   input  = candb/p_v3.dbc
 *   output = candb/signal.json
 *
 * The existing output file is automatically backed up as:
 *   candb/signal.bk_001.json, candb/signal.bk_002.json, …
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── CLI args ────────────────────────────────────────────────────────────────
const ROOT    = path.resolve(__dirname, '..');
const dbcFile = path.resolve(process.argv[2] || path.join(__dirname, 'p_v3.dbc'));
const outFile = path.resolve(process.argv[3] || path.join(__dirname, 'signal.json'));

if (!fs.existsSync(dbcFile)) {
  console.error(`[ERROR] DBC file not found: ${dbcFile}`);
  process.exit(1);
}

// ── Backup helper ────────────────────────────────────────────────────────────
function backup(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const dir  = path.dirname(filePath);
  const ext  = path.extname(filePath);            // .json
  const base = path.basename(filePath, ext);      // signal

  let index = 1;
  let dest;
  do {
    dest = path.join(dir, `${base}.bk_${String(index).padStart(3, '0')}${ext}`);
    index++;
  } while (fs.existsSync(dest));

  fs.copyFileSync(filePath, dest);
  return dest;
}

// ── DBC parser ───────────────────────────────────────────────────────────────
function parseDbc(content) {
  const lines = content.split(/\r?\n/);

  // message map: id → { sender, signals: { name → sigObj } }
  const messages = {};
  // comment accumulator: `${id}:${name}` → [text, ...]
  const comments  = {};
  // value table: `${id}:${name}` → [{value,description}, ...]
  const valTables = {};

  let currentMsgId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // ── BO_ (message definition) ─────────────────────────────────────────
    const boMatch = line.match(/^BO_\s+(\d+)\s+\S+\s*:\s*\d+\s+(\S+)/);
    if (boMatch) {
      currentMsgId = parseInt(boMatch[1], 10);
      messages[currentMsgId] = { sender: boMatch[2], signals: {} };
      continue;
    }

    // ── SG_ (signal definition) ──────────────────────────────────────────
    //   SG_ Name : bitstart|bits@endian sign (factor,offset) [min|max] "unit" dest1,dest2
    const sgMatch = line.match(
      /^SG_\s+(\S+)\s*:\s*\d+\|(\d+)@\d+[+-]\s+\([^)]+\)\s+\[([^\]]*)\]\s+"([^"]*)"\s*(.*)/
    );
    if (sgMatch && currentMsgId !== null) {
      const [, sigName, , range, unit, destStr] = sgMatch;
      const [minStr, maxStr] = range.split('|');
      const destinations = destStr
        .split(',')
        .map(d => d.trim())
        .filter(d => d && d !== 'Vector__XXX');

      messages[currentMsgId].signals[sigName] = {
        name:         sigName,
        unit:         unit || '',
        min:          parseFloat(minStr) || 0,
        max:          parseFloat(maxStr) || 0,
        destinations,
      };
      continue;
    }

    // ── CM_ SG_ (signal comment) ─────────────────────────────────────────
    //   CM_ SG_ msgId signalName "text";
    //   May span multiple lines; handle the simple single-line case.
    const cmMatch = line.match(/^CM_\s+SG_\s+(\d+)\s+(\S+)\s+"([^"]*)"\s*;?/);
    if (cmMatch) {
      const key = `${cmMatch[1]}:${cmMatch[2]}`;
      if (!comments[key]) comments[key] = [];
      comments[key].push(cmMatch[3]);
      continue;
    }

    // ── VAL_ (value / enum table) ─────────────────────────────────────────
    //   VAL_ msgId signalName 0 "desc0" 1 "desc1" ... ;
    const valMatch = line.match(/^VAL_\s+(\d+)\s+(\S+)\s+(.*?)\s*;?$/);
    if (valMatch) {
      const key   = `${valMatch[1]}:${valMatch[2]}`;
      const pairs = valMatch[3].matchAll(/(\d+)\s+"([^"]*)"/g);
      valTables[key] = [];
      for (const [, val, desc] of pairs) {
        valTables[key].push({ value: parseInt(val, 10), description: desc });
      }
      continue;
    }

    // Reset currentMsgId on blank line between message blocks
    if (line === '') currentMsgId = null;
  }

  return { messages, comments, valTables };
}

// ── Build signal list ────────────────────────────────────────────────────────
function buildSignals({ messages, comments, valTables }) {
  const signals = [];

  for (const [msgIdStr, msg] of Object.entries(messages)) {
    const msgId = parseInt(msgIdStr, 10);

    for (const sig of Object.values(msg.signals)) {
      const key  = `${msgId}:${sig.name}`;
      const cms  = comments[key] || [];

      // First CM_ = description; second that starts with "Signalvalues:" = unit hint
      let description = cms.find(t => !t.startsWith('Signalvalues:')) || '';
      let unitHint    = '';
      const svLine    = cms.find(t => t.startsWith('Signalvalues:'));
      if (svLine) unitHint = svLine.replace(/^Signalvalues:\s*/i, '').trim();

      // Unit: prefer explicit unit from SG_ line, fall back to hint from CM_
      // Clean up encoding artefacts (e.g. "ï¿½C" → "°C")
      let unit = sig.unit || unitHint;
      unit = unit
        .replace(/ï¿½/g, '°')
        .replace(/\xC2\xB0/g, '°')
        .replace(/\u00B0/g, '°');

      // Unless unit is a simple base unit, keep unitHint as description suffix
      const isBaseUnit = /^(mm|deg|rpm|°C|%|kg|m|s|V|A|Hz|W|km\/h|mph)$/i.test(unit);
      if (!isBaseUnit) unit = '';

      // states: from VAL_ table; fall back to parsing "Signalvalues: A, B, C" comment
      let states = valTables[key] || [];
      if (states.length === 0 && unitHint) {
        // Case 1: "Level X-Y" → expand range → [{value:X, description:"Level X"}, ..., {value:Y, description:"Level Y"}]
        const levelRange = unitHint.match(/^([A-Za-z][A-Za-z0-9 ]*?)\s+(\d+)-(\d+)$/);
        if (levelRange) {
          const prefix = levelRange[1].trim();
          const from   = parseInt(levelRange[2], 10);
          const to     = parseInt(levelRange[3], 10);
          if (to >= from) {
            states = [];
            for (let v = from; v <= to; v++) {
              states.push({ value: v, description: `${prefix} ${v}` });
            }
          }
        }

        // Case 2: comma-separated labels e.g. "Buckled, Unbuckled" or "25%, 50%, 95% Occupant"
        // Each token may itself be a range like "Haptic 1-6" → expand to Haptic 1 … Haptic 6
        if (states.length === 0) {
          const hasComma = unitHint.includes(',');
          const isScalarUnit = !hasComma && /^[\d°%\-+]|mm$|deg$|rpm$|°C$|kg$|km\/h$/i.test(unitHint);
          if (hasComma || (!isScalarUnit && unitHint.length > 0)) {
            const tokens = unitHint.split(',').map(s => s.trim()).filter(Boolean);
            const expanded = [];
            for (const tok of tokens) {
              const m = tok.match(/^([A-Za-z][A-Za-z0-9 ]*?)\s+(\d+)-(\d+)$/);
              if (m) {
                const pfx  = m[1].trim();
                const from = parseInt(m[2], 10);
                const to   = parseInt(m[3], 10);
                if (to >= from) {
                  for (let v = from; v <= to; v++) expanded.push(`${pfx} ${v}`);
                } else {
                  expanded.push(tok); // invalid range, keep literal
                }
              } else {
                expanded.push(tok);
              }
            }
            if (expanded.length >= 2) {
              states = expanded.map((desc, idx) => ({ value: idx, description: desc }));
            }
          }
        }
      }

      // source = sender node of the message
      const source = msg.sender !== 'Vector__XXX' ? [msg.sender] : [];

      // destination = receivers listed in SG_ line
      const destination = sig.destinations;

      // RX = signal is received/readable in HMI (default true for all)
      // TX = signal is writable by HMI (true if CAR_PC is in source)
      const RX = true;
      const TX = source.includes('CAR_PC');

      signals.push({
        name:        sig.name,
        value:       0,
        source,
        destination,
        timestamp:   0,
        description,
        unit,
        min:         sig.min,
        max:         sig.max,
        RX,
        TX,
        states,
      });
    }
  }

  return signals;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const content = fs.readFileSync(dbcFile, 'utf8');
const parsed  = parseDbc(content);
const signals = buildSignals(parsed);

const output = JSON.stringify({ signals }, null, 4);

// Backup existing output file
const backupPath = backup(outFile);
if (backupPath) {
  console.log(`[backup] ${path.relative(ROOT, outFile)} → ${path.relative(ROOT, backupPath)}`);
}

fs.writeFileSync(outFile, output, 'utf8');
console.log(`[done]   ${signals.length} signals written to ${path.relative(ROOT, outFile)}`);
console.log(`         source DBC: ${path.relative(ROOT, dbcFile)}`);
