/**
 * app.js - CAN-HMI API Demo application
 * Handles mode, profiles, configs, signals dashboard, API log.
 * All API calls go through MockAPI (mock.js). No real backend needed.
 */

// ── App state ─────────────────────────────────────────────────────────────────
const App = {
  mode: "dev",            // "user" | "dev"
  activeProfile: null,    // profile object
  profiles: [],
  ws: null,               // WebSocket / MockWebSocket instance
  signalsMeta: [],        // from GET /signals/available
  currentValues: {},      // { name: { value, timestamp } }
  _wsBadge: null,
  sectionId: 1,           // tracks latest section_id from server
  profileSessions: null,
  heartbeatTimer: null,
};

// Auto-detect real server vs local/static mock.
// On Vercel (static-only deploy) server.js is NOT running → treat as mock.
// Detection: try GET /api/signals with a short timeout; if it responds → real server.
let _onRealServer = false;
function _apiBase() {
  return new URLSearchParams(location.search).get('api_base')
    || window.CAR_HMI_API_BASE
    || localStorage.getItem('car_hmi_api_base')
    || location.origin;
}

function _wsBase() {
  const base = _apiBase();
  try {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.origin;
  } catch (_) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }
}

async function _detectServer() {
  const forcedBase = new URLSearchParams(location.search).get('api_base')
    || window.CAR_HMI_API_BASE
    || localStorage.getItem('car_hmi_api_base');
  if (forcedBase) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${_apiBase()}/signals`, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok || res.status < 500;
    } catch (_) {
      return false;
    }
  }

  // Try probing even on localhost so demo can use a real backend at :8000.
  if (typeof location !== 'undefined' && location.protocol === 'file:') return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${_apiBase()}/signals`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500; // 200/404 means server running; timeout/network error means static
  } catch (_) {
    return false; // fetch failed = no real server (Vercel static or offline)
  }
}
// API is resolved after _detectServer() runs in DOMContentLoaded
let API = MockAPI; // default until detection completes

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  App._wsBadge = document.getElementById("ws-badge");

  // Detect real server (handles Vercel static vs Render full deploy)
  _onRealServer = await _detectServer();
  if (_onRealServer) API = RealAPI;

  // Load can0.json into Store (only needed for mock; skip on real server)
  if (!_onRealServer) await Store.init();

  // Update header tag to show LIVE vs MOCK
  const tag = document.getElementById('server-tag');
  if (tag) { tag.textContent = _onRealServer ? 'LIVE' : 'MOCK'; tag.style.background = _onRealServer ? '#166534' : ''; }

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
  _startProfileHeartbeat();

  window.addEventListener('beforeunload', () => {
    if (API && typeof API.setProfileOffline === 'function') {
      API.setProfileOffline().catch(() => {});
    }
  });
  // Pre-load info so first tab click is instant
  API.getInfo().then(_renderInfoPanel).catch(() => {});
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
  // Re-subscribe WS: dev = all signals, user = active profile's signals only
  _wsSubscribe(isDev ? '*' : (App.activeProfile?.signals || '*'));
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

/**
 * Send a subscribe/unsubscribe message to the active WS connection.
 * @param {string[]|'*'} signals  Array of signal names, or '*' for all.
 * @param {'subscribe'|'unsubscribe'} [type='subscribe']
 */
function _wsSubscribe(signals, type = 'subscribe') {
  if (!App.ws || App.ws.readyState !== 1) return;
  App.ws.send(JSON.stringify({ type, signals }));
}

function _connectWS() {
  if (App.ws) { try { App.ws.close(); } catch (_) {} }

  let ws;
  if (_onRealServer) {
    const url = (typeof RealAPI?.wsUrl === 'function') ? RealAPI.wsUrl('/ws/signals') : `${_wsBase()}/ws/signals`;
    ws = new WebSocket(url);
  } else {
    ws = new MockWebSocket('ws://localhost:8000/ws/signals');
  }
  App.ws = ws;

  App._wsBadge.textContent = "● WS";
  App._wsBadge.className = "badge badge--warn";

  ws.onopen = () => {
    App._wsBadge.textContent = "● WS Connected";
    App._wsBadge.className = "badge badge--ok";
    if (_onRealServer) Log.ws('CONNECTED', _wsBase().replace(/^wss?:\/\//, '') + '/ws/signals');
    // Subscribe to active profile signals (all in dev mode)
    const sigs = App.mode === 'dev' ? '*' : (App.activeProfile?.signals || '*');
    _wsSubscribe(sigs);
  };

  ws.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.type === 'subscribed' || payload.type === 'subscribe_ack') {
      const label = payload.signals === '*' ? 'ALL signals' : `${payload.count} signals`;
      Log.ws('SUBSCRIBED', label);
      return;
    }
    if (payload.type === 'unsubscribe_ack') {
      Log.ws('UNSUBSCRIBED', `${payload.count || 0} channels`);
      return;
    }
    if (payload.type === 'metrics') {
      Log.ws('METRICS', `cpu=${payload.cpu_percent ?? '-'} ram=${payload.ram_percent ?? '-'}`);
      return;
    }
    if (payload.type === 'alarm') {
      Log.ws('ALARM', `${payload.signal_name || '-'} ${payload.level || '-'}`);
      return;
    }
    if (payload.type === 'pong') return;
    for (const sig of (payload.signals || [])) {
      const sigName = sig.name || sig.signal_name;
      if (!sigName) continue;
      App.currentValues[sigName] = { value: sig.value, timestamp: payload.timestamp };
    }
    _updateSignalCards((payload.signals || []).map(s => ({ ...s, name: s.name || s.signal_name })));
  };

  ws.onclose = () => {
    App._wsBadge.textContent = "● WS Disconnected";
    App._wsBadge.className = "badge badge--dis";
    // Auto-reconnect after 3s on real server
    if (_onRealServer) setTimeout(_connectWS, 3000);
  };

  ws.onerror = () => {
    App._wsBadge.textContent = "● WS Error";
    App._wsBadge.className = "badge badge--dis";
  };
}

function _startProfileHeartbeat() {
  if (!API || typeof API.heartbeatProfile !== 'function') return;
  if (App.heartbeatTimer) clearInterval(App.heartbeatTimer);
  API.heartbeatProfile().catch(() => {});
  App.heartbeatTimer = setInterval(() => {
    API.heartbeatProfile().catch(() => {});
  }, 30000);
}

// ── Signals metadata ─────────────────────────────────────────────────────────
async function _loadSignalsMeta() {
  const res = await API.getSignalsAvailable();
  App.signalsMeta = (res.signals_info || []).map(s => ({
    ...s,
    name: s.name || s.signal_name,
    min: s.min ?? s.min_value ?? 0,
    max: s.max ?? s.max_value ?? 100,
    states: Array.isArray(s.states) ? s.states : [],
    writable: Boolean(s.writable),
    description: s.description || '',
  }));
  // seed currentValues from meta
  App.signalsMeta.forEach(s => {
    App.currentValues[s.name] = { value: s.value, timestamp: s.timestamp };
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function _initDashboard() { _renderDashboard(); }

function _getVisibleSignals() {
  if (App.mode === "dev") return App.signalsMeta;
  if (!App.activeProfile) return [];
  const names = new Set(App.activeProfile.signals);
  return App.signalsMeta.filter(s => names.has(s.name) || names.has(s.std_name));
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

  const ts = sv ? new Date(sv.timestamp * 1000).toLocaleTimeString("en-GB") : "-";

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
        await API.updateSignal(name, value);
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
function _profileName(p) {
  return p?.name || p?.profile_name || '';
}

function _profileSignals(p) {
  return Array.isArray(p?.signals) ? p.signals : [];
}

function _profilePermission(p) {
  const raw = Array.isArray(p?.permission) ? p.permission : [];
  if (!raw.length) return ['read'];
  return raw;
}

function _normalizeProfilesResponse(res) {
  const profiles = Array.isArray(res?.profiles) ? res.profiles.map(p => {
    const name = _profileName(p);
    const signals = _profileSignals(p);
    const permission = _profilePermission(p);
    const selected = Boolean(p?.selected) || (res?.active && name === res.active);
    return {
      ...p,
      profile_name: name,
      name,
      signals,
      permission,
      selected,
      description: p?.description || '',
    };
  }) : [];

  let active = profiles.find(p => p.selected) || null;
  if (!active && profiles.length) active = profiles[0];

  return {
    profiles,
    active,
    activeName: res?.active || active?.name || null,
    globalActive: res?.global_active || null,
    total: res?.total ?? profiles.length,
    sectionId: res?.section_id ?? App.sectionId,
  };
}

async function _loadProfiles() {
  const res = await API.getProfiles();
  const normalized = _normalizeProfilesResponse(res);
  App.sectionId = normalized.sectionId;
  App.profiles = normalized.profiles;
  App.activeProfile = normalized.active;
  if (normalized.activeName) localStorage.setItem('car_hmi_profile_name', normalized.activeName);

  const sel = document.getElementById("profile-select");
  sel.innerHTML = "";
  normalized.profiles.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.name;
    const perm = p.permission?.join('/') || 'read';
    opt.textContent = `${p.name}${p.selected ? ' ✓' : ''} [${perm}]`;
    if (p.selected) { opt.selected = true; }
    sel.appendChild(opt);
  });

  sel.onchange = async () => {
    await API.selectProfile(sel.value, { devMode: App.mode === 'dev' });
    await _loadProfiles();
    _renderDashboard();
    if (App.mode !== 'dev') _wsSubscribe(App.activeProfile?.signals || '*');
  };

  if (API.getProfileSessions) {
    try {
      App.profileSessions = await API.getProfileSessions({ devMode: App.mode === 'dev' });
    } catch (_) {
      App.profileSessions = null;
    }
  }

  _renderProfilesPanel(normalized, App.profileSessions);
}

function _renderProfilesPanel(profileData, sessionsData) {
  const profiles = profileData.profiles;
  const sectionId = profileData.sectionId;
  const container = document.getElementById("profiles-list");
  container.innerHTML = `
    <div class="section-id-bar">
      <span>section_id (optimistic lock):</span><strong>${sectionId}</strong>
      <span style="color:var(--muted);font-size:11px">- PUT/DELETE must send matching section_id or BE will deny (409)</span>
    </div>
    ${sessionsData ? `<div class="section-id-bar" style="margin-top:8px">
      <span>sessions:</span><strong>${sessionsData.total || 0}</strong>
      <span style="color:var(--muted);font-size:11px">online ${sessionsData.online_total || 0} / offline ${sessionsData.offline_total || 0}</span>
    </div>` : ''}
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
    const permissionLabel = (p.permission || ['read']).join(' / ');
    card.innerHTML = `
      <div class="item-card-header">
        <span class="item-card-name">${p.name}</span>
        <div class="item-card-actions">
          ${p.selected ? '<span class="badge badge--selected">Active</span>' : `<button class="btn btn-sm" onclick="App._selectProfile('${p.name}')">Set Active</button>`}
          <button class="btn btn-sm" onclick="App._editProfile('${p.name}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="App._deleteProfile('${p.name}')">Del</button>
        </div>
      </div>
      <div class="item-card-body">
        <div style="margin-bottom:4px"><span class="badge badge--neutral">${permissionLabel}</span></div>
        <div>${p.signals.length} signals &nbsp;<span style="color:var(--accent);font-size:11px">${writableCount} writable</span></div>
        <div class="signals-chips">${chips}</div>
      </div>`;
    grid.appendChild(card);
  });
}

App._selectProfile = async (name) => {
  await API.selectProfile(name, { devMode: App.mode === 'dev' });
  localStorage.setItem('car_hmi_profile_name', name);
  await _loadProfiles();
  _renderDashboard();
  if (App.mode !== 'dev') _wsSubscribe(App.activeProfile?.signals || '*');
};

App._editProfile = async (name) => {
  try {
    const profile = await API.getProfile(name);
    _openProfileModal(profile);
  } catch (e) { alert(e.message); }
};

App._deleteProfile = async (name) => {
  if (!confirm(`Delete profile "${name}"?`)) return;
  try {
    await API.deleteProfile(name);
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
    let permission = [...document.querySelectorAll("#pf-permission input:checked")].map(i => i.value);
    if (!permission.length) permission = ['read'];
    if (permission.includes('full')) permission = ['full'];
    const description = (document.getElementById('pf-description').value || '').trim();
    if (!name) return alert("Profile name required");
    try {
      if (mode === "edit") {
        await API.updateProfile({ name, signals, permission, description, section_id: String(App.sectionId).padStart(12, '0').slice(-12) });
      } else {
        await API.createProfile({ name, signals, permission, description });
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

  // Permission normalization: full overrides others, and at least one permission remains.
  document.querySelectorAll('#pf-permission input').forEach(el => {
    el.addEventListener('change', () => {
      const full = document.querySelector('#pf-permission input[value="full"]');
      const read = document.querySelector('#pf-permission input[value="read"]');
      const write = document.querySelector('#pf-permission input[value="write"]');
      if (el.value === 'full' && el.checked) {
        read.checked = false;
        write.checked = false;
      }
      if ((el.value === 'read' || el.value === 'write') && el.checked) {
        full.checked = false;
      }
      const anyChecked = [full, read, write].some(i => i.checked);
      if (!anyChecked) read.checked = true;
    });
  });
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

  nameEl.value = isEdit ? _profileName(profile) : "";
  nameEl.disabled = isEdit;
  nameEl.dataset.editName = isEdit ? _profileName(profile) : "";
  document.getElementById("pf-mode").value = isEdit ? "edit" : "create";
  document.getElementById("profile-modal-title").textContent = isEdit ? `Edit Profile - ${_profileName(profile)}` : "New Profile";
  document.getElementById("btn-save-profile").textContent = isEdit ? "Update" : "Save";
  document.getElementById('pf-description').value = isEdit ? (profile.description || '') : '';

  const selectedPerm = new Set(isEdit ? _profilePermission(profile) : ['read']);
  document.querySelectorAll('#pf-permission input').forEach(i => {
    i.checked = selectedPerm.has(i.value) || (i.value === 'read' && selectedPerm.size === 0);
  });

  const selected = new Set(isEdit ? _profileSignals(profile) : []);
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
  try {
    const [infoRes, configRes] = await Promise.all([
      API.getConfigs(),
      API.getConfig(),
    ]);
    _renderConfigsPanel(infoRes, configRes);
  } catch (e) {
    const container = document.getElementById("configs-list");
    if (container) {
      container.innerHTML = `<div class="section-id-bar"><span>Config unavailable:</span><strong>${_escHtml(e.message)}</strong></div>`;
    }
  }
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
      <span style="color:var(--muted);font-size:11px">- PUT /config must send matching section_id (409 on mismatch)</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">
      <div>
        <h3 style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.05em">GET /configs - System Info (info.json, read-only)</h3>
        ${infoHTML}
      </div>
      <div>
        <h3 style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.05em">GET /config - Editable Config (config.json)</h3>
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
    await API.updateConfig({ section_id: App.sectionId, [sectionKey]: nested });
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
      : '<span style="color:var(--muted)">-</span>';
    tr.innerHTML = `
      <td><strong>${s.name}</strong></td>
      <td>${s.unit || "-"}</td>
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
    const info = await API.getInfo();
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

// ── Restraints ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btn-rst-match");
  if (!btn) return;
  btn.addEventListener("click", _doRestraintsMatch);
});

async function _doRestraintsMatch() {
  const weight = parseFloat(document.getElementById("rst-weight").value);
  const height = parseFloat(document.getElementById("rst-height").value);
  const crash_severity = document.getElementById("rst-crash-severity").value;
  const seat = document.getElementById("rst-seat").value;
  const seatbelt_system = document.querySelector("input[name='rst-belt']:checked")?.value;
  const seatXRaw = document.getElementById("rst-seat-x").value.trim();
  const seat_x_mm = seatXRaw === "" ? undefined : parseFloat(seatXRaw);

  const result = document.getElementById("rst-result");
  result.innerHTML = `<p style="color:var(--muted);font-size:12px">Matching…</p>`;

  try {
    const res = await API.matchRestraints({
      weight,
      height,
      crash_severity,
      seatbelt_system,
      seat,
      seat_x_mm,
    });
    _renderRestraintsResult(result, res, {
      weight,
      height,
      crash_severity,
      seatbelt_system,
      seat,
      seat_x_mm,
    });
  } catch (e) {
    result.innerHTML = `<p style="color:var(--crit);font-size:12px">Error: ${_escHtml(e.message)}</p>`;
  }
}

function _resolveApiUrl(pathOrUrl) {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = window.__CAR_HMI_API_BASE || location.origin;
  try {
    return new URL(pathOrUrl, base).toString();
  } catch (_) {
    return pathOrUrl;
  }
}

function _renderRestraintsResult(container, res, params) {
  if (!res.matched || !res.video) {
    const context = res.context || {};
    container.innerHTML = `
      <div class="rst-result-card">
        <span class="badge badge--dis" style="font-size:12px">✗ No match</span>
        <div style="margin-top:8px;color:var(--muted);font-size:12px">
          Không tìm thấy video phù hợp trong thư mục media/. Candidates: ${context.candidates_found ?? 0}
        </div>
      </div>`;
    return;
  }

  const videoUrl = _resolveApiUrl(res.video.url);
  const scoreColor = res.score >= 5.5 ? 'var(--ok)' : res.score >= 4 ? 'var(--warn)' : 'var(--crit)';
  const ctx = res.context || {};
  container.innerHTML = `
    <div class="rst-result-card">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="badge badge--ok" style="font-size:12px">
          ✓ Matched
        </span>
        <div style="display:flex;flex-direction:column;align-items:center">
          <span style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em">Score</span>
          <span class="rst-score" style="color:${scoreColor}">${Number(res.score).toFixed(3)}</span>
        </div>
      </div>

      <div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">VIDEO FILE</div>
        <div class="rst-filename">${_escHtml(res.video.filename)}</div>
        <a href="${_escHtml(videoUrl)}" class="btn btn-sm" style="margin-top:6px;display:inline-block" target="_blank">
          ▶ Open URL
        </a>
        <video controls preload="metadata" style="display:block;margin-top:8px;max-width:100%;border-radius:8px;background:#000" src="${_escHtml(videoUrl)}"></video>
      </div>

      <div class="rst-meta-grid">
        <span class="k">Seat</span>            <span class="v">${_escHtml(params.seat)}</span>
        <span class="k">Seatbelt system</span> <span class="v">${_escHtml(res.video.seatbelt)}</span>
        <span class="k">Crash severity</span>  <span class="v">${_escHtml(params.crash_severity)}</span>
        <span class="k">Velocity</span>        <span class="v">${res.video.velocity_kmh} km/h</span>
        <span class="k">Percentile</span>      <span class="v">${res.video.percentile}th</span>
        <span class="k">Seat position</span>   <span class="v">${_escHtml(res.video.seat_position)}</span>
        <span class="k">Derived percentile</span><span class="v">${ctx.derived_percentile ?? '-'}</span>
        <span class="k">Effective percentile</span><span class="v">${ctx.effective_percentile ?? '-'}</span>
        <span class="k">Seat X source</span>   <span class="v">${_escHtml(ctx.seat_x_source || '-')}</span>
      </div>
    </div>`;
}
