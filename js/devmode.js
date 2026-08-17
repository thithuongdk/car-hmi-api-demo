/**
 * devmode.js - developer-only view.
 *
 * View A: multi-seat signal actuation with lock renew.
 * View B: CAN/Ethernet/ELK status for PUMA, PANTHER and NVIDIA JETSON.
 */

const DEVMODE_SEATS = [
	{ id: "fl", label: "FL", title: "Front Left" },
	{ id: "fr", label: "FR", title: "Front Right" },
	{ id: "rl1", label: "RL1", title: "Rear Left 1" },
	{ id: "rl2", label: "RL2", title: "Rear Left 2" },
	{ id: "rr1", label: "RR1", title: "Rear Right 1" },
];

const DEVMODE_COMPONENTS = [
	...DEVMODE_SEATS.map((seat) => ({
		id: `puma-${seat.id}`,
		title: `PUMA ${seat.label}`,
		subtitle: seat.title,
		rows: [
			{ label: "CAN", signal: `COM_Status_Puma${seat.label}Can`, kind: "com" },
			{ label: "Ethernet", signal: `COM_Status_Puma${seat.label}Ethernet`, kind: "com" },
			{ label: "ELK", signal: `ELK_${seat.label}_ActuatorStatus`, kind: "elk" },
		],
	})),
	{
		id: "panther",
		title: "PANTHER",
		subtitle: "PANTHER computer",
		rows: [
			{ label: "CAN", signal: "COM_Status_PantherCan", kind: "com" },
			{ label: "Ethernet", signal: "COM_Status_PantherEthernet", kind: "com" },
		],
	},
	{
		id: "jetson",
		title: "NVIDIA JETSON",
		subtitle: "NVIDIA JETSON computer",
		rows: [
			{ label: "CAN", signal: "COM_Status_NvidiaJetsonCan", kind: "com" },
			{ label: "Ethernet", signal: "COM_Status_NvidiaJetsonEthernet", kind: "com" },
		],
	},
];

const ELK_STATE_TEXT = {
	0: { text: "Lock", level: "ok" },
	1: { text: "Failure at previous", level: "warn" },
	2: { text: "Failure now", level: "bad" },
	3: { text: "Unknown", level: "unknown" },
};

const devmodeState = {
	initialized: false,
	viewActive: false,
	catalog: null,
	blockTimeoutSec: 60,
	selectedSeats: new Set(),
	activeFamily: null,
	renewTimer: null,
	lockExpiresAt: null,
	signalValues: new Map(),
	signalTimestamps: new Map(),
	statusStaleTimeoutSec: 30,
	elkStatusTimer: null,
};

function _devApi() {
	if (typeof API !== "undefined" && API) return API;
	if (typeof RealAPI !== "undefined" && RealAPI) return RealAPI;
	if (typeof MockAPI !== "undefined" && MockAPI) return MockAPI;
	return null;
}

function _devError(error, fallback) {
	return String(error?.detail?.message || error?.detail || error?.message || fallback);
}

async function fetchDevmodeCatalog() {
	const api = _devApi();
	if (!api || typeof api.getDevmodeCatalog !== "function") {
		throw new Error("Dev Mode API is not available");
	}
	return api.getDevmodeCatalog();
}

async function fetchDevmodeStatus() {
	const api = _devApi();
	if (!api || typeof api.getDevmodeStatus !== "function") {
		throw new Error("Dev Mode API is not available");
	}
	return api.getDevmodeStatus();
}

async function selectDevmodeSeats(seats, blockTimeoutSec) {
	const api = _devApi();
	return api.selectDevmodeSeats({
		seats,
		block_timeout_sec: blockTimeoutSec,
	});
}

async function applyDevmodeSignal(familyName, value, seats, blockTimeoutSec) {
	const api = _devApi();
	return api.applyDevmodeSignal({
		signal_name: familyName,
		value,
		seats,
		block_timeout_sec: blockTimeoutSec,
	});
}

async function exitDevmode(options) {
	const api = _devApi();
	if (!api || typeof api.exitDevmode !== "function") return { released: [] };
	if (options?.keepalive && typeof navigator !== "undefined" && navigator.sendBeacon) {
		try {
			const body = new Blob([JSON.stringify({})], { type: "application/json" });
			navigator.sendBeacon("/api/devmode/exit", body);
			return { released: [] };
		} catch (_) {
			// Fall through to regular call.
		}
	}
	return api.exitDevmode();
}

async function writeSignal(name, value) {
	const api = _devApi();
	if (!api) throw new Error("Signal API is not available");
	if (typeof api.updateSignal === "function") return api.updateSignal(name, value);
	throw new Error("Signal write API is not available");
}

document.addEventListener("DOMContentLoaded", () => {
	const tabDevmode = document.querySelector('.nav-tab[data-tab="devmode"]');
	const paneDevmode = document.getElementById("tab-devmode");
	const viewDevmode = document.getElementById("view-devmode");
	if (!tabDevmode || !paneDevmode || !viewDevmode) return;

	const otherTabs = Array.from(document.querySelectorAll(".nav-tab"))
		.filter((el) => el !== tabDevmode);

	otherTabs.forEach((btn) => {
		btn.addEventListener("click", () => {
			if (!devmodeState.viewActive) return;
			devmodeState.viewActive = false;
			viewDevmode.style.display = "none";
			if (devmodeState.initialized) {
				void leaveDevmode({ quiet: true, leavingView: true });
			}
		});
	});

	tabDevmode.addEventListener("click", () => {
		devmodeState.viewActive = true;
		viewDevmode.style.display = "flex";
		if (!devmodeState.initialized) {
			void initDevmode();
		} else {
			startElkStatusMonitor();
			void refreshDevmodeStatus();
		}
	});

	document.getElementById("devmode-subtab-a")?.addEventListener("click", () => showDevmodeSubview("a"));
	document.getElementById("devmode-subtab-b")?.addEventListener("click", () => showDevmodeSubview("b"));
	document.getElementById("devmode-exit-btn")?.addEventListener("click", () => void leaveDevmode());
	document.getElementById("devmode-elk-reset-btn")?.addEventListener("click", () => void resetElockingFailureMemory());

	window.addEventListener("beforeunload", () => {
		clearInterval(devmodeState.renewTimer);
		void exitDevmode({ keepalive: true }).catch(() => {});
	});
});

function showDevmodeSubview(which) {
	const isA = which === "a";
	document.getElementById("devmode-view-a").style.display = isA ? "" : "none";
	document.getElementById("devmode-view-b").style.display = isA ? "none" : "";
	document.getElementById("devmode-subtab-a").classList.toggle("active", isA);
	document.getElementById("devmode-subtab-b").classList.toggle("active", !isA);
}

async function initDevmode() {
	devmodeState.initialized = true;
	renderComponentGrid();
	try {
		const catalog = await fetchDevmodeCatalog();
		devmodeState.catalog = catalog;
		devmodeState.blockTimeoutSec = catalog.block_timeout_sec || 60;
		devmodeState.statusStaleTimeoutSec = catalog.status_stale_timeout_sec || 30;
		devmodeState.activeFamily = catalog.families?.[0]?.signal_name || null;
	} catch (error) {
		devmodeLog(`Dev Mode catalog could not be loaded: ${_devError(error, "unknown error")}`, "error");
	}

	const label = document.getElementById("devmode-timeout-label");
	if (label) label.textContent = String(Math.round(devmodeState.blockTimeoutSec));

	renderSeatSwitches();
	renderFamilyTabs();
	renderFamilyStates();
	if (devmodeState.viewActive) startElkStatusMonitor();
	await refreshDevmodeStatus();
}

function renderSeatSwitches() {
	const host = document.getElementById("devmode-seat-switches");
	if (!host) return;
	host.innerHTML = "";
	DEVMODE_SEATS.forEach((seat) => {
		const wrap = document.createElement("label");
		wrap.className = "seat-switch";
		wrap.id = `seat-switch-${seat.id}`;
		wrap.title = seat.title;
		wrap.innerHTML = `
			<input type="checkbox" data-seat="${seat.id}" />
			<span class="seat-switch__track"><span class="seat-switch__thumb"></span></span>
			<span class="seat-switch__label">${seat.label}</span>
			<span class="seat-switch__state" id="seat-state-${seat.id}">idle</span>
		`;
		wrap.querySelector("input").addEventListener("change", (event) => {
			void toggleSeat(seat.id, event.target.checked);
		});
		host.appendChild(wrap);
	});
}

async function toggleSeat(seatId, selected) {
	if (selected) devmodeState.selectedSeats.add(seatId);
	else devmodeState.selectedSeats.delete(seatId);
	setSeatState(seatId, selected ? "selected" : "idle", selected ? "ok" : "muted");
	updateLockBadge();
	scheduleLockRenew();

	try {
		const result = await selectDevmodeSeats({ [seatId]: selected }, devmodeState.blockTimeoutSec);
		applySeatSelectionResult(result);
	} catch (error) {
		const applied = error?.detail?.applied?.[seatId] || error?.applied?.[seatId];
		devmodeLog(
			`Seat ${seatId.toUpperCase()}: ${applied?.reason || _devError(error, "select failed")}`,
			"error"
		);
		setSeatState(seatId, applied?.error || "lock rejected", "warn");
	}
}

function applySeatSelectionResult(result) {
	const applied = result?.applied || {};
	Object.entries(applied).forEach(([seatId, entry]) => {
		if (entry.error) {
			setSeatState(seatId, entry.error, "warn");
			devmodeLog(`Seat ${seatId.toUpperCase()}: ${entry.reason || entry.error}`, "error");
			return;
		}
		if (entry.selected) setSeatState(seatId, "locked by this section", "ok");
		else if (!devmodeState.selectedSeats.has(seatId)) setSeatState(seatId, "idle", "muted");
	});
	devmodeState.lockExpiresAt = result?.expires_at || devmodeState.lockExpiresAt;
}

function setSeatState(seatId, text, level) {
	const el = document.getElementById(`seat-state-${seatId}`);
	if (!el) return;
	el.textContent = text;
	el.dataset.level = level || "muted";
}

function selectedSeatMap(includeUnselected) {
	const map = {};
	DEVMODE_SEATS.forEach((seat) => {
		const isSelected = devmodeState.selectedSeats.has(seat.id);
		if (isSelected || includeUnselected) map[seat.id] = isSelected;
	});
	return map;
}

function scheduleLockRenew() {
	clearInterval(devmodeState.renewTimer);
	if (!devmodeState.viewActive || !devmodeState.selectedSeats.size) {
		devmodeState.renewTimer = null;
		return;
	}
	const intervalMs = Math.max(5000, (devmodeState.blockTimeoutSec * 1000) / 2);
	devmodeState.renewTimer = setInterval(async () => {
		if (!devmodeState.selectedSeats.size) return;
		try {
			applySeatSelectionResult(
				await selectDevmodeSeats(selectedSeatMap(), devmodeState.blockTimeoutSec)
			);
			updateLockBadge();
		} catch (error) {
			devmodeLog(`Lock renew failed: ${_devError(error, "unknown error")}`, "error");
		}
	}, intervalMs);
}

function updateLockBadge() {
	const badgeEl = document.getElementById("devmode-lock-badge");
	if (!badgeEl) return;
	const count = devmodeState.selectedSeats.size;
	if (!count) {
		badgeEl.textContent = "No seat locked";
		badgeEl.className = "badge badge--disconnected";
		return;
	}
	const seats = [...devmodeState.selectedSeats].map((s) => s.toUpperCase()).join(", ");
	badgeEl.textContent = `Locked: ${seats}`;
	badgeEl.className = "badge badge--connected";
}

async function refreshDevmodeStatus() {
	try {
		const status = await fetchDevmodeStatus();
		Object.entries(status.seats || {}).forEach(([seatId, info]) => {
			const input = document.querySelector(`#seat-switch-${seatId} input`);
			if (info.owned) {
				devmodeState.selectedSeats.add(seatId);
				if (input) input.checked = true;
				setSeatState(seatId, "locked by this section", "ok");
			} else if (info.selected) {
				if (input) input.checked = false;
				devmodeState.selectedSeats.delete(seatId);
				setSeatState(seatId, "locked by another section", "warn");
			} else {
				if (input) input.checked = false;
				devmodeState.selectedSeats.delete(seatId);
				setSeatState(seatId, info.connected ? "idle" : "not connected", info.connected ? "muted" : "bad");
			}
		});
	} catch (error) {
		devmodeLog(`Dev Mode status could not be read: ${_devError(error, "unknown error")}`, "error");
	}
	updateLockBadge();
	if (devmodeState.viewActive) scheduleLockRenew();
}

async function leaveDevmode(options) {
	const opts = options || {};
	clearInterval(devmodeState.renewTimer);
	devmodeState.renewTimer = null;
	if (opts.leavingView) stopElkStatusMonitor();
	try {
		const result = await exitDevmode();
		devmodeState.selectedSeats.clear();
		DEVMODE_SEATS.forEach((seat) => {
			const input = document.querySelector(`#seat-switch-${seat.id} input`);
			if (input) {
				input.checked = false;
				input.disabled = false;
			}
			setSeatState(seat.id, "idle", "muted");
		});
		if (!opts.quiet) {
			devmodeLog(`Released locks: ${(result.released || []).join(", ") || "none"}`);
		}
	} catch (error) {
		if (!opts.quiet) devmodeLog(`Exit Dev Mode failed: ${_devError(error, "unknown error")}`, "error");
	}
	updateLockBadge();
}

function renderFamilyTabs() {
	const host = document.getElementById("devmode-family-tabs");
	if (!host || !devmodeState.catalog) return;
	host.innerHTML = "";
	devmodeState.catalog.families.forEach((family) => {
		const btn = document.createElement("button");
		btn.className = "devmode-tab";
		btn.textContent = family.signal_name.split("_")[0];
		btn.title = family.signal_name;
		btn.classList.toggle("active", family.signal_name === devmodeState.activeFamily);
		btn.addEventListener("click", () => {
			devmodeState.activeFamily = family.signal_name;
			renderFamilyTabs();
			renderFamilyStates();
		});
		host.appendChild(btn);
	});
}

function renderFamilyStates() {
	const host = document.getElementById("devmode-family-states");
	if (!host || !devmodeState.catalog) return;
	const family = devmodeState.catalog.families.find(
		(f) => f.signal_name === devmodeState.activeFamily
	);
	host.innerHTML = "";
	if (!family) return;

	const caption = document.createElement("p");
	caption.className = "devmode-hint";
	caption.textContent = `${family.signal_name} - click a state to apply it to every enabled seat.`;
	host.appendChild(caption);

	const grid = document.createElement("div");
	grid.className = family.kind === "color" ? "state-grid state-grid--color" : "state-grid";
	(family.states || []).forEach((state) => {
		const btn = document.createElement("button");
		btn.className = "state-btn";
		if (family.kind === "color" || family.signal_name === "ISB_Color") {
			const hex = `#${Number(state.value).toString(16).padStart(6, "0")}`;
			btn.classList.add("state-btn--color");
			btn.innerHTML = `<span class="state-swatch" style="background:${hex};"></span><span>${state.description}</span>`;
		} else {
			btn.innerHTML = `<strong>${state.value}</strong><span>${state.description || ""}</span>`;
		}
		btn.addEventListener("click", () => void applyFamilyState(family.signal_name, state));
		grid.appendChild(btn);
	});
	host.appendChild(grid);
}

async function applyFamilyState(familyName, state) {
	if (!devmodeState.selectedSeats.size) {
		devmodeLog("No seat selected - turn on at least one switch before sending a signal.", "error");
		return;
	}
	try {
		const result = await applyDevmodeSignal(
			familyName,
			Number(state.value),
			selectedSeatMap(),
			devmodeState.blockTimeoutSec
		);
		devmodeState.lockExpiresAt = result?.expires_at || devmodeState.lockExpiresAt;
		Object.entries(result.applied || {}).forEach(([seatId, entry]) => {
			if (entry.error) {
				devmodeLog(`${familyName} -> ${seatId.toUpperCase()}: ${entry.reason || entry.error}`, "error");
			} else {
				devmodeLog(`${familyName} = ${state.value} -> ${seatId.toUpperCase()} OK`);
			}
		});
	} catch (error) {
		const applied = error?.detail?.applied || error?.applied || {};
		const reasons = Object.entries(applied)
			.map(([seatId, entry]) => `${seatId.toUpperCase()}: ${entry.reason || entry.error}`)
			.join("; ");
		devmodeLog(`${familyName} failed - ${reasons || _devError(error, "unknown error")}`, "error");
	}
}

function devmodeLog(message, level) {
	const host = document.getElementById("devmode-apply-log");
	if (!host) return;
	const line = document.createElement("div");
	line.className = `devmode-log__line devmode-log__line--${level || "info"}`;
	line.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
	host.prepend(line);
	while (host.childElementCount > 30) host.lastElementChild.remove();
}

function renderComponentGrid() {
	const host = document.getElementById("devmode-component-grid");
	if (!host || host.childElementCount) return;
	DEVMODE_COMPONENTS.forEach((component) => {
		const card = document.createElement("div");
		card.className = "component-card";
		const rows = component.rows
			.map(
				(row) => `
				<div class="component-row" data-signal="${row.signal}" data-kind="${row.kind}">
					<span class="component-row__label">${row.label}</span>
					<span class="component-row__value" id="comp-${row.signal}">
						<span class="dot dot--unknown"></span><span class="txt">no data</span>
					</span>
				</div>`
			)
			.join("");
		card.innerHTML = `
			<div class="component-card__head">
				<strong>${component.title}</strong>
				<span>${component.subtitle}</span>
			</div>
			${rows}
		`;
		host.appendChild(card);
	});
}

function renderComponentValue(signalName, value) {
	const cell = document.getElementById(`comp-${signalName}`);
	if (!cell) return;
	const kind = cell.closest(".component-row")?.dataset.kind;
	const dot = cell.querySelector(".dot");
	const txt = cell.querySelector(".txt");
	if (!dot || !txt) return;

	if (kind === "elk") {
		const info = ELK_STATE_TEXT[Number(value)];
		dot.className = `dot dot--${info ? info.level : "unknown"}`;
		txt.textContent = info ? info.text : `unknown (${value})`;
	} else {
		const connected = Number(value) === 1;
		dot.className = `dot dot--${connected ? "ok" : "bad"}`;
		txt.textContent = connected ? "connected" : "disconnected";
	}
	updateElkSummary();
}

function updateElkSummary() {
	const badgeEl = document.getElementById("devmode-elk-summary");
	if (!badgeEl) return;
	const now = Date.now() / 1000;
	let failure = false;
	let unavailable = false;

	DEVMODE_SEATS.forEach((seat) => {
		const signalName = `ELK_${seat.label}_ActuatorStatus`;
		const value = devmodeState.signalValues.get(signalName);
		const timestamp = devmodeState.signalTimestamps.get(signalName);
		const isMissing = value === undefined || !Number.isFinite(timestamp);
		const isStale = !isMissing && (now - timestamp) > devmodeState.statusStaleTimeoutSec;

		if (isMissing || isStale) {
			unavailable = true;
			const cell = document.getElementById(`comp-${signalName}`);
			if (cell) {
				const dot = cell.querySelector(".dot");
				const txt = cell.querySelector(".txt");
				if (dot) dot.className = "dot dot--unknown";
				if (txt) txt.textContent = isStale ? "stale" : "no data";
			}
			return;
		}
		if (value === -1 || value === 2 || value === 3) failure = true;
	});

	if (failure) {
		badgeEl.textContent = "Failure Detected";
		badgeEl.className = "badge badge--disconnected";
	} else if (unavailable) {
		badgeEl.textContent = "Status Unknown";
		badgeEl.className = "badge badge--warning";
	} else {
		badgeEl.textContent = "No Failure";
		badgeEl.className = "badge badge--connected";
	}
}

function startElkStatusMonitor() {
	stopElkStatusMonitor();
	updateElkSummary();
	devmodeState.elkStatusTimer = setInterval(updateElkSummary, 1000);
}

function stopElkStatusMonitor() {
	clearInterval(devmodeState.elkStatusTimer);
	devmodeState.elkStatusTimer = null;
}

async function resetElockingFailureMemory() {
	try {
		const api = _devApi();
		if (api && typeof api.resetElkFailureMemory === "function") {
			await api.resetElkFailureMemory();
		} else {
			await writeSignal("ELK_ResetErrorFlags", 1);
		}
		devmodeLog("Sent ELK_ResetErrorFlags = 1");
		if (typeof window.showUiNotice === "function") {
			window.showUiNotice("Reset E-Locking failure memory request sent.", {
				source: "devmode",
				code: "elk_reset_ok",
			});
		}
	} catch (error) {
		devmodeLog(`Reset E-Locking failed: ${_devError(error, "unknown error")}`, "error");
		if (typeof window.showUiNotice === "function") {
			window.showUiNotice(`Reset E-Locking failed: ${_devError(error, "unknown error")}`, {
				level: "error",
				source: "devmode",
				code: "elk_reset_failed",
			});
		}
	}
}

const _previousSignalHook = window.onSignalStreamValue;
window.onSignalStreamValue = (signalName, value, timestamp) => {
	if (typeof _previousSignalHook === "function") {
		_previousSignalHook(signalName, value, timestamp);
	}
	devmodeState.signalValues.set(signalName, Number(value));
	const parsedTimestamp = Number(timestamp);
	devmodeState.signalTimestamps.set(
		signalName,
		Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now() / 1000
	);
	renderComponentValue(signalName, value);
};
