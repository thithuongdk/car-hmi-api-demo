/**
 * app.js — CAN-HMI API Demo application
 * Handles mode, profiles, configs, signals dashboard, API log.
 * All API calls go through MockAPI (mock.js). No real backend needed.
 */

// ── App state ─────────────────────────────────────────────────────────────────
const App = {
  mode: "dev",            // "user" | "dev"
  activeProfile: null,    // profile object
  ws: null,               // MockWebSocket instance
  signalsMeta: [],        // from GET /signals/available
  currentValues: {},      // { name: { value, timestamp } }
  _wsBadge: null,
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  App._wsBadge = document.getElementById("ws-badge");

  // Load signal.json into Store before any other init
  await Store.init();

  _setupTabs();
  _setupModeToggle();
  _setupApiLog();
  document.getElementById("btn-reset").addEventListener("click", () => {
    if (confirm("Reset all demo data to defaults?")) { Store.reset(); location.reload(); }
  });

  // Load initial data
  await _loadSignalsMeta();
  await _loadProfiles();
  await _loadConfigs();
  _initDashboard();
  _connectWS();
  // Pre-load info so first tab click is instant
  MockAPI.getInfo().then(_renderInfoPanel).catch(() => {});
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
function _setupTabs() {
  document.querySelectorAll(".nav-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "api-log") _renderApiLog();
      if (btn.dataset.tab === "signals-info") _renderSignalsInfo();
      if (btn.dataset.tab === "system-info") _loadInfo();
    });
  });
}

// ── Mode toggle ───────────────────────────────────────────────────────────────
function _setupModeToggle() {
  document.querySelectorAll(".toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      App.mode = btn.dataset.mode;
      document.querySelectorAll(".toggle-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === App.mode));
      _applyMode();
    });
  });
}

function _applyMode() {
  const isDev = App.mode === "dev";
  // Show/hide dev-only tabs
  document.querySelectorAll(".nav-tab.dev-only").forEach(t => t.classList.toggle("dev-hidden", !isDev));
  // Rebuild dashboard with mode filter
  _renderDashboard();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function _connectWS() {
  if (App.ws) App.ws.close();

  App.ws = new MockWebSocket("ws://localhost:8000/ws/signals");
  App._wsBadge.textContent = "● WS";
  App._wsBadge.className = "badge badge--warn";

  App.ws.onopen = () => {
    App._wsBadge.textContent = "● WS Connected";
    App._wsBadge.className = "badge badge--ok";
  };

  App.ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    for (const sig of payload.signals) {
      App.currentValues[sig.name] = { value: sig.value, timestamp: payload.timestamp };
    }
    _updateSignalCards(payload.signals);
  };

  App.ws.onclose = () => {
    App._wsBadge.textContent = "● WS Disconnected";
    App._wsBadge.className = "badge badge--dis";
  };
}

// ── Signals metadata ─────────────────────────────────────────────────────────
async function _loadSignalsMeta() {
  const res = await MockAPI.getSignalsAvailable();
  App.signalsMeta = res.signals_info;
  // seed currentValues from meta
  res.signals_info.forEach(s => {
    App.currentValues[s.name] = { value: s.value, timestamp: s.timestamp };
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function _initDashboard() { _renderDashboard(); }

function _getVisibleSignals() {
  if (App.mode === "dev") return App.signalsMeta;
  if (!App.activeProfile) return [];
  const names = new Set(App.activeProfile.signals);
  return App.signalsMeta.filter(s => names.has(s.name));
}

function _renderDashboard() {
  const grid = document.getElementById("signals-grid");
  grid.innerHTML = "";
  const visible = _getVisibleSignals();
  if (!visible.length) {
    grid.innerHTML = `<p style="color:var(--muted);grid-column:1/-1">No signals for this profile or mode.</p>`;
    return;
  }
  visible.forEach(meta => {
    const card = _buildSignalCard(meta);
    grid.appendChild(card);
  });
}

function _buildSignalCard(meta) {
  const sv = App.currentValues[meta.name];
  const val = sv ? sv.value : 0;

  const card = document.createElement("div");
  card.className = "signal-card";
  card.dataset.signal = meta.name;

  const isEnum = meta.states.length > 0;
  const pct = isEnum ? (val / meta.max) * 100 : ((val - meta.min) / (meta.max - meta.min)) * 100;
  const alarm = val > meta.max * 0.95 ? "crit" : val > meta.max * 0.8 ? "warn" : "";
  if (alarm) card.classList.add("alarm-" + alarm);

  const ts = sv ? new Date(sv.timestamp * 1000).toLocaleTimeString("en-GB") : "—";

  let barOrStates = "";
  if (!isEnum) {
    barOrStates = `
      <div class="bar-track"><div class="bar-fill ${alarm}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
      <div class="bar-minmax"><span>${meta.min} ${meta.unit}</span><span>${meta.max} ${meta.unit}</span></div>`;
  }

  let writeCtrl = "";
  if (meta.writable) {
    if (isEnum) {
      const opts = meta.states.map(st =>
        `<option value="${st.value}" ${st.value === val ? "selected" : ""}>${st.description}</option>`
      ).join("");
      writeCtrl = `<div class="write-ctrl">
        <label>Write</label>
        <select class="write-enum" data-signal="${meta.name}">${opts}</select>
        <button class="btn-write" data-signal="${meta.name}" data-type="enum">Send</button>
      </div>`;
    } else {
      writeCtrl = `<div class="write-ctrl">
        <label>Write</label>
        <input type="range" class="write-range" min="${meta.min}" max="${meta.max}" step="${((meta.max - meta.min) / 100).toFixed(1)}" value="${val}" data-signal="${meta.name}" />
        <span class="write-val" id="wv-${meta.name}">${val}</span>
        <button class="btn-write" data-signal="${meta.name}" data-type="range">Send</button>
      </div>`;
    }
  }

  card.innerHTML = `
    <div class="signal-header">
      <span class="signal-name">${meta.name}</span>
      <span class="signal-unit">${meta.unit}</span>
    </div>
    <div class="signal-value ${alarm}" id="sv-${meta.name}">${_fmt(val, isEnum, meta)}</div>
    ${barOrStates}
    ${writeCtrl}
    <div class="signal-ts" id="st-${meta.name}">${ts}</div>`;

  // Wire range input live preview
  const range = card.querySelector(".write-range");
  if (range) {
    range.addEventListener("input", () => {
      const el = card.querySelector(".write-val");
      if (el) el.textContent = range.value;
    });
  }

  // Wire write buttons
  card.querySelectorAll(".btn-write").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.signal;
      let value;
      if (btn.dataset.type === "enum") {
        value = parseInt(card.querySelector(`.write-enum[data-signal="${name}"]`).value, 10);
      } else {
        value = parseFloat(card.querySelector(`.write-range[data-signal="${name}"]`).value);
      }
      try {
        await MockAPI.updateSignal(name, value);
        App.currentValues[name] = { value, timestamp: Date.now() / 1000 };
        _updateCard(name);
      } catch (e) {
        alert("Write error: " + e.message);
      }
    });
  });

  return card;
}

function _fmt(val, isEnum, meta) {
  if (isEnum) {
    const st = meta.states.find(s => s.value === val);
    return st ? `${st.description} (${val})` : val;
  }
  return `${val} ${meta.unit}`;
}

function _updateSignalCards(updates) {
  updates.forEach(({ name, value }) => _updateCard(name, value));
}

function _updateCard(name, v) {
  const sv = App.currentValues[name];
  const val = v !== undefined ? v : sv.value;
  const meta = App.signalsMeta.find(s => s.name === name);
  if (!meta) return;

  const card = document.querySelector(`.signal-card[data-signal="${name}"]`);
  if (!card) return;

  const isEnum = meta.states.length > 0;
  const pct = isEnum ? (val / meta.max) * 100 : ((val - meta.min) / (meta.max - meta.min)) * 100;
  const alarm = val > meta.max * 0.95 ? "crit" : val > meta.max * 0.8 ? "warn" : "";

  card.className = "signal-card" + (alarm ? ` alarm-${alarm}` : "");

  const valEl = document.getElementById(`sv-${name}`);
  if (valEl) { valEl.textContent = _fmt(val, isEnum, meta); valEl.className = `signal-value ${alarm}`; }

  const fill = card.querySelector(".bar-fill");
  if (fill) { fill.style.width = `${Math.min(100, pct).toFixed(1)}%`; fill.className = `bar-fill ${alarm}`; }

  const tsEl = document.getElementById(`st-${name}`);
  if (tsEl) tsEl.textContent = new Date().toLocaleTimeString("en-GB");
}

// ── Profiles ──────────────────────────────────────────────────────────────────
async function _loadProfiles() {
  const res = await MockAPI.getProfiles();
  const sel = document.getElementById("profile-select");
  sel.innerHTML = "";
  res.profiles.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.profile_name;
    opt.textContent = p.profile_name + (p.selected ? " ✓" : "");
    if (p.selected) { opt.selected = true; App.activeProfile = p; }
    sel.appendChild(opt);
  });
  sel.addEventListener("change", async () => {
    await MockAPI.selectProfile(sel.value);
    await _loadProfiles();
    _renderDashboard();
  });
  _renderProfilesPanel(res.profiles, res.section_id);
}

function _renderProfilesPanel(profiles, sectionId) {
  const container = document.getElementById("profiles-list");
  container.innerHTML = `
    <div class="section-id-bar">
      <span>section_id (optimistic lock):</span><strong>${sectionId}</strong>
      <span style="color:var(--muted);font-size:11px">— PUT/DELETE must send matching section_id or BE will deny (409)</span>
    </div>
    <div class="card-grid" id="profiles-grid"></div>`;

  const grid = document.getElementById("profiles-grid");
  profiles.forEach(p => {
    const card = document.createElement("div");
    card.className = "item-card" + (p.selected ? " selected" : "");
    const chips = p.signals.slice(0, 6).map(s => {
      const m = App.signalsMeta.find(x => x.name === s);
      return `<span class="chip ${m?.writable ? "writable" : ""}">${s}</span>`;
    }).join("") + (p.signals.length > 6 ? `<span class="chip">+${p.signals.length - 6}</span>` : "");

    const writableCount = p.signals.filter(n => App.signalsMeta.find(s => s.name === n)?.writable).length;
    card.innerHTML = `
      <div class="item-card-header">
        <span class="item-card-name">${p.profile_name}</span>
        <div class="item-card-actions">
          ${p.selected ? '<span class="badge badge--selected">Active</span>' : `<button class="btn btn-sm" onclick="App._selectProfile('${p.profile_name}')">Set Active</button>`}
          <button class="btn btn-sm" onclick="App._editProfile('${p.profile_name}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="App._deleteProfile('${p.profile_name}')">Del</button>
        </div>
      </div>
      <div class="item-card-body">
        <div>${p.signals.length} signals &nbsp;<span style="color:var(--accent);font-size:11px">${writableCount} writable</span></div>
        <div class="signals-chips">${chips}</div>
      </div>`;
    grid.appendChild(card);
  });
}

App._selectProfile = async (name) => {
  await MockAPI.selectProfile(name);
  await _loadProfiles();
  _renderDashboard();
};

App._editProfile = async (name) => {
  try {
    const profile = await MockAPI.getProfile(name);
    _openProfileModal(profile);
  } catch (e) { alert(e.message); }
};

App._deleteProfile = async (name) => {
  if (!confirm(`Delete profile "${name}"?`)) return;
  try {
    await MockAPI.deleteProfile(name);
    await _loadProfiles();
    _renderDashboard();
  } catch (e) { alert(e.message); }
};

// Add/Edit profile modal wiring
let _activeGroup = "ALL";

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-add-profile").addEventListener("click", () => _openProfileModal(null));

  document.getElementById("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode    = document.getElementById("pf-mode").value;
    const nameEl  = document.getElementById("pf-name");
    const name    = (nameEl.value || nameEl.dataset.editName || "").trim();
    const signals = [...document.querySelectorAll("#pf-signals-checks input:checked")].map(i => i.value);
    if (!name) return alert("Profile name required");
    try {
      if (mode === "edit") {
        const d = Store.get();
        await MockAPI.updateProfile({ profile_name: name, signals, section_id: d.section_id });
      } else {
        await MockAPI.createProfile({ profile_name: name, signals });
      }
      _closeProfileModal();
      await _loadProfiles();
      _renderDashboard();
    } catch (e) { alert(e.message); }
  });

  document.getElementById("btn-cancel-profile").addEventListener("click", _closeProfileModal);
  document.getElementById("profile-modal-backdrop").addEventListener("click", (e) => {
    if (e.target === document.getElementById("profile-modal-backdrop")) _closeProfileModal();
  });

  // Search filter
  document.getElementById("pf-search").addEventListener("input", _filterSignalChecks);

  // Group filter buttons
  document.querySelectorAll(".pf-grp-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pf-grp-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _activeGroup = btn.dataset.group;
      _filterSignalChecks();
    });
  });

  // Select all / none (visible only)
  document.getElementById("btn-check-all").addEventListener("click", () => {
    document.querySelectorAll("#pf-signals-checks .check-item").forEach(item => {
      if (item.style.display !== "none") item.querySelector("input").checked = true;
    });
    _updateCheckCount();
  });
  document.getElementById("btn-check-none").addEventListener("click", () => {
    document.querySelectorAll("#pf-signals-checks input").forEach(i => i.checked = false);
    _updateCheckCount();
  });

  // Live count when checking individual items
  document.getElementById("pf-signals-checks").addEventListener("change", _updateCheckCount);
});

function _openProfileModal(profile = null) {
  const isEdit = !!profile;
  const checks  = document.getElementById("pf-signals-checks");
  const nameEl  = document.getElementById("pf-name");
  const searchEl = document.getElementById("pf-search");

  checks.innerHTML = "";
  searchEl.value   = "";
  _activeGroup     = "ALL";
  document.querySelectorAll(".pf-grp-btn").forEach(b => b.classList.toggle("active", b.dataset.group === "ALL"));

  nameEl.value = isEdit ? profile.profile_name : "";
  nameEl.disabled = isEdit;
  nameEl.dataset.editName = isEdit ? profile.profile_name : "";
  document.getElementById("pf-mode").value = isEdit ? "edit" : "create";
  document.getElementById("profile-modal-title").textContent = isEdit ? `Edit Profile — ${profile.profile_name}` : "New Profile";
  document.getElementById("btn-save-profile").textContent = isEdit ? "Update" : "Save";

  const selected = new Set(isEdit ? profile.signals : []);
  App.signalsMeta.forEach(s => {
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `<input type="checkbox" value="${s.name}" ${selected.has(s.name) ? "checked" : ""} />${s.name}`;
    checks.appendChild(label);
  });

  _updateCheckCount();
  document.getElementById("profile-modal-backdrop").classList.remove("hidden");
}

function _filterSignalChecks() {
  const q = document.getElementById("pf-search").value.toLowerCase();
  document.querySelectorAll("#pf-signals-checks .check-item").forEach(item => {
    const name = item.querySelector("input").value;
    const matchQ = !q || name.toLowerCase().includes(q);
    const matchG = _activeGroup === "ALL"  ? true
                 : _activeGroup === "TX"   ? !!App.signalsMeta.find(s => s.name === name)?.writable
                 : name.includes(`_${_activeGroup}_`);
    item.style.display = (matchQ && matchG) ? "" : "none";
  });
}

function _updateCheckCount() {
  const n = document.querySelectorAll("#pf-signals-checks input:checked").length;
  const el = document.getElementById("pf-check-count");
  if (el) el.textContent = `${n} selected`;
}

function _closeProfileModal() {
  document.getElementById("profile-modal-backdrop").classList.add("hidden");
}

// ── Configs ───────────────────────────────────────────────────────────────────
async function _loadConfigs() {
  const [infoRes, configRes] = await Promise.all([
    MockAPI.getConfigs(),
    MockAPI.getConfig(),
  ]);
  _renderConfigsPanel(infoRes, configRes);
}

function _renderConfigsPanel(infoRes, configRes) {
  const container = document.getElementById("configs-list");
  const INFO_SECTIONS = [
    { key: "project",  label: "Project",  icon: "🚗" },
    { key: "server",   label: "Server",   icon: "🌐" },
    { key: "hardware", label: "Hardware", icon: "🔧" },
    { key: "storage",  label: "Storage",  icon: "💾" },
    { key: "safety",   label: "Safety",   icon: "🛡️" },
    { key: "video",    label: "Video",    icon: "📷" },
  ];

  const infoHTML = INFO_SECTIONS.map(sec => {
    const data = infoRes[sec.key];
    if (!data) return '';
    const rows = _flatKeys(data).map(([k, v]) =>
      `<tr><td style="font-weight:500;width:220px;padding:4px 8px">${k}</td>
           <td style="padding:4px 8px"><code style="font-size:11px">${_escHtml(String(v))}</code></td></tr>`
    ).join('');
    return `<div style="margin-bottom:10px">
      <div style="font-weight:600;padding:5px 8px;background:var(--surface2,#2a2a2a);border-radius:4px 4px 0 0;font-size:12px">
        ${sec.icon} ${sec.label}
      </div>
      <table class="data-table" style="margin:0;border-radius:0 0 4px 4px"><tbody>${rows}</tbody></table>
    </div>`;
  }).join('');

  const sectionId = configRes.section_id;
  // Build editable form from config.json sections: hardware, storage, safety
  const CFG_SECTIONS = [
    { key: "hardware", label: "Hardware (CAN Bus)", icon: "🔧" },
    { key: "storage",  label: "Storage",            icon: "💾" },
    { key: "safety",   label: "Safety",             icon: "🛡️" },
  ];

  const cfgFormHTML = CFG_SECTIONS.map(sec => {
    const data = configRes[sec.key];
    if (!data) return '';
    const rows = _flatKeys(data).map(([k, v]) => {
      const inputId = `cfg-inp-${sec.key}__${k.replace(/\./g, '_')}`;
      const isNum  = typeof v === 'number';
      const isBool = typeof v === 'boolean';
      const ctrl = isBool
        ? `<select id="${inputId}" data-section="${sec.key}" data-path="${k}" class="cfg-field" style="width:80px">
             <option value="true" ${v ? 'selected' : ''}>true</option>
             <option value="false" ${!v ? 'selected' : ''}>false</option>
           </select>`
        : `<input id="${inputId}" data-section="${sec.key}" data-path="${k}" class="cfg-field"
             type="${isNum ? 'number' : 'text'}" value="${_escHtml(String(v))}"
             style="width:${isNum ? '90px' : '200px'};padding:2px 6px;border-radius:4px;border:1px solid var(--border,#333);background:var(--surface2,#1e1e1e);color:inherit;font-size:11px" />`;
      return `<tr>
        <td style="padding:4px 8px;font-weight:500;font-size:11px;width:200px">${k}</td>
        <td style="padding:4px 8px">${ctrl}</td>
      </tr>`;
    }).join('');
    return `<div style="margin-bottom:10px">
      <div style="font-weight:600;padding:5px 8px;background:var(--surface2,#2a2a2a);border-radius:4px 4px 0 0;font-size:12px;display:flex;justify-content:space-between;align-items:center">
        <span>${sec.icon} ${sec.label}</span>
        <button class="btn btn-sm btn-primary" onclick="App._saveConfigSection('${sec.key}',${sectionId})">Save</button>
      </div>
      <table class="data-table" style="margin:0;border-radius:0 0 4px 4px"><tbody>${rows}</tbody></table>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="section-id-bar" style="margin-bottom:16px">
      <span>section_id:</span><strong>${sectionId}</strong>
      <span style="color:var(--muted);font-size:11px">— PUT /config must send matching section_id (409 on mismatch)</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">
      <div>
        <h3 style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.05em">GET /configs — System Info (info.json, read-only)</h3>
        ${infoHTML}
      </div>
      <div>
        <h3 style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.05em">GET /config — Editable Config (config.json)</h3>
        ${cfgFormHTML}
      </div>
    </div>`;
}

App._saveConfigSection = async (sectionKey, sectionId) => {
  const container = document.getElementById("configs-list");
  // Collect all inputs for this section
  const fields = container.querySelectorAll(`.cfg-field[data-section="${sectionKey}"]`);
  // Rebuild nested object from dot-path keys
  function setDeep(obj, path, val) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }
  const nested = {};
  fields.forEach(el => {
    const rawVal = el.tagName === 'SELECT' ? el.value : el.value;
    let val;
    if (el.tagName === 'SELECT') {
      val = rawVal === 'true' ? true : rawVal === 'false' ? false : rawVal;
    } else if (el.type === 'number') {
      val = parseFloat(rawVal);
    } else {
      val = rawVal;
    }
    setDeep(nested, el.dataset.path, val);
  });
  try {
    await MockAPI.updateConfig({ section_id: sectionId, [sectionKey]: nested });
    await _loadConfigs();
  } catch (e) { alert(e.message); }
};

// ── Signals Info table ────────────────────────────────────────────────────────
function _renderSignalsInfo() {
  const tbody = document.querySelector("#signals-info-table tbody");
  tbody.innerHTML = "";
  App.signalsMeta.forEach(s => {
    const tr = document.createElement("tr");
    const statesHtml = s.states.length
      ? s.states.map(st => `<span class="chip">${st.value}:${st.description}</span>`).join(" ")
      : '<span style="color:var(--muted)">—</span>';
    tr.innerHTML = `
      <td><strong>${s.name}</strong></td>
      <td>${s.unit || "—"}</td>
      <td>${s.min}</td>
      <td>${s.max}</td>
      <td><span class="badge ${s.writable ? "badge--ok" : "badge--neutral"}">${s.writable ? "Yes" : "No"}</span></td>
      <td style="color:var(--muted)">${s.description}</td>
      <td style="font-size:11px">${statesHtml}</td>`;
    tbody.appendChild(tr);
  });
}

// ── API Log ───────────────────────────────────────────────────────────────────
function _setupApiLog() {
  document.getElementById("btn-clear-log").addEventListener("click", () => {
    Log.clear();
    _renderApiLog();
  });

  // Auto-append new entries when log tab is active
  Log.onNew(entry => {
    const activeTab = document.querySelector(".nav-tab.active")?.dataset.tab;
    if (activeTab === "api-log") _prependLogEntry(entry);
  });
}

function _renderApiLog() {
  const container = document.getElementById("api-log");
  container.innerHTML = "";
  Log.all().forEach(e => container.appendChild(_buildLogEntry(e)));
}

function _prependLogEntry(entry) {
  const container = document.getElementById("api-log");
  container.prepend(_buildLogEntry(entry));
}

function _buildLogEntry(e) {
  const div = document.createElement("div");

  if (e.type === "ws") {
    div.className = "log-entry ws-entry";
    div.innerHTML = `
      <div class="log-entry-header">
        <span class="log-ts">${e.ts}</span>
        <span class="log-method WS">WS</span>
        <span class="log-url">${e.event}</span>
        <span class="log-status" style="color:var(--muted)">${typeof e.detail === "string" ? e.detail.substring(0, 60) : ""}</span>
      </div>`;
  } else {
    const isErr = e.status >= 400;
    div.className = "log-entry api-entry" + (isErr ? " err" : "");
    const reqBody = e.request ? JSON.stringify(e.request, null, 2) : "";
    const resBody = e.response ? JSON.stringify(e.response, null, 2) : "";
    div.innerHTML = `
      <div class="log-entry-header" style="cursor:pointer">
        <span class="log-ts">${e.ts}</span>
        <span class="log-method ${e.method}">${e.method}</span>
        <span class="log-url">${e.url}</span>
        <span class="log-status ${isErr ? "err" : "ok"}"> → ${e.status}</span>
      </div>
      <div class="log-body">${reqBody ? `<b>REQUEST:</b>\n${reqBody}\n\n` : ""}<b>RESPONSE:</b>\n${resBody}</div>`;
    div.querySelector(".log-entry-header").addEventListener("click", () => div.classList.toggle("expanded"));
  }
  return div;
}

// ── System Info ───────────────────────────────────────────────────────────────
async function _loadInfo() {
  try {
    const info = await MockAPI.getInfo();
    _renderInfoPanel(info);
  } catch (e) {
    const el = document.getElementById("info-content");
    if (el) el.innerHTML = `<p style="color:var(--muted);padding:12px">System info unavailable.</p>`;
  }
}

function _renderInfoPanel(info) {
  const el = document.getElementById("info-content");
  if (!el || !info) return;

  const SECTIONS = [
    { key: "project",  label: "Project",  icon: "🚗" },
    { key: "server",   label: "Server",   icon: "🌐" },
    { key: "hardware", label: "Hardware", icon: "🔧" },
    { key: "storage",  label: "Storage",  icon: "💾" },
    { key: "safety",   label: "Safety",   icon: "🛡️" },
    { key: "video",    label: "Video",    icon: "📷" },
  ];

  el.innerHTML = SECTIONS.map(sec => {
    const data = info[sec.key];
    if (!data) return '';
    const rows = _flatKeys(data).map(([k, v]) =>
      `<tr><td style="font-weight:500;width:240px;padding:5px 8px">${k}</td>
           <td style="padding:5px 8px"><code style="font-size:12px">${_escHtml(String(v))}</code></td></tr>`
    ).join('');
    return `<div style="margin-bottom:12px">
      <div style="font-weight:600;padding:6px 8px;background:var(--surface2,#2a2a2a);border-radius:4px 4px 0 0">
        ${sec.icon} ${sec.label}
      </div>
      <table class="data-table" style="margin:0;border-radius:0 0 4px 4px"><tbody>${rows}</tbody></table>
    </div>`;
  }).join('');
}

function _flatKeys(obj, prefix) {
  const result = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result.push(..._flatKeys(v, key));
    } else {
      result.push([key, Array.isArray(v) ? v.join(', ') : v]);
    }
  }
  return result;
}

function _escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
