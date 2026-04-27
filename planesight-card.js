/**
 * PlaneSight Card — Split-flap departure board for Home Assistant
 *
 * Displays live ADS-B traffic from an ultrafeeder / tar1090 instance as a
 * classic Solari-style flip board.  Sorted by distance from receiver.
 *
 * Card config (Lovelace YAML):
 *
 *   type: custom:planesight-card
 *   url: "http://192.168.1.50:8080"   # direct tar1090 URL (preferred)
 *   # --- OR ---
 *   entity: sensor.planesight_aircraft_list   # read from integration sensor
 *   # ---
 *   title: "DEPARTURES"          # optional header text
 *   max_planes: 15               # max rows shown  (default 15)
 *   height: 480                  # scrollable body max-height in px (default 480)
 *   poll_interval: 5             # seconds between fetches in URL mode (default 5)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const R_NM = 3440.065; // Earth radius in nautical miles
const FEET_TO_METRES = 0.3048;
const KNOTS_TO_KMH = 1.852;
const NM_TO_KM = 1.852;
const DISTANCE_FIELDS = ["distance_nm", "distance", "dist", "dst", "r_dst"];

function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isValidCoordinate(lat, lon) {
  const latN = Number(lat);
  const lonN = Number(lon);
  return (
    Number.isFinite(latN) &&
    Number.isFinite(lonN) &&
    latN >= -90 &&
    latN <= 90 &&
    lonN >= -180 &&
    lonN <= 180
  );
}

function positionAgeSeconds(ac) {
  const age = Number(ac.seen_pos ?? ac.seen ?? 0);
  return Number.isFinite(age) ? age : 0;
}

function existingDistanceNm(ac) {
  for (const field of DISTANCE_FIELDS) {
    if (ac[field] == null) continue;
    const n = Number(ac[field]);
    if (Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

function aircraftKey(ac, idx = 0) {
  return ac.hex || `${ac.lat}:${ac.lon}:${ac.flight || ac.r || idx}`;
}

function isAircraftTypeCode(value) {
  if (value === undefined || value === null) return false;
  const code = String(value).trim().toUpperCase();
  return /^[A-Z0-9]{2,5}$/.test(code) && !["ADSB", "MLAT", "TISB"].includes(code);
}

function formatAlt(alt) {
  if (alt === undefined || alt === null) return "  ---  ";
  if (typeof alt === "string") {
    const value = alt.trim().toLowerCase();
    if (value === "ground") return "  GND  ";
    const numericAlt = Number(alt);
    if (!Number.isFinite(numericAlt)) return "  ---  ";
    alt = numericAlt;
  }
  const metres = Math.round((Number(alt) * FEET_TO_METRES) / 10) * 10;
  if (!Number.isFinite(metres)) return "  ---  ";
  return `${metres.toLocaleString()}m`;
}

function formatSpeed(gs) {
  if (gs === undefined || gs === null) return " --- ";
  const kmh = Math.round(Number(gs) * KNOTS_TO_KMH);
  if (!Number.isFinite(kmh)) return " --- ";
  return `${kmh}km/h`;
}

function formatDist(nm) {
  if (nm === undefined || nm === null) return "  ---  ";
  const n = Number(nm);
  if (Number.isNaN(n)) return "  ---  ";
  const km = n * NM_TO_KM;
  return `${km < 100 ? km.toFixed(1) : Math.round(km)}km`;
}

function formatCallsign(ac) {
  const s = (ac.flight || ac.hex || "????????").trim();
  return s.slice(0, 8).padEnd(8);
}

function formatType(ac) {
  const rawType = [
    ac.t,
    ac.aircraft_type,
    ac.aircraftType,
    ac.icao_type,
    ac.icaoType,
    ac.icaoTypeCode,
    ac.typeCode,
    ac.type_code,
    ac.ac_type,
    ac.model_code,
    ac.type,
  ].find(isAircraftTypeCode);
  const t = rawType ? String(rawType).trim().toUpperCase().slice(0, 7) : "--";
  return t.padEnd(7);
}

/** Vertical-speed indicator appended to altitude cell. */
function vsIndicator(baroRate) {
  if (baroRate === undefined || baroRate === null) return "";
  if (baroRate > 200) return " ↑";
  if (baroRate < -200) return " ↓";
  return " —";
}

/** Build the cell-value objects for a given aircraft entry. */
function buildRowValues(ac) {
  return {
    flight: formatCallsign(ac),
    type: formatType(ac),
    alt: formatAlt(ac.alt_baro) + vsIndicator(ac.baro_rate),
    speed: formatSpeed(ac.gs),
    dist: formatDist(ac.distance_nm),
  };
}

// ---------------------------------------------------------------------------
// Web Component
// ---------------------------------------------------------------------------

class PlaneSightCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    /** @type {Map<string, HTMLElement>} hex → row element */
    this._rows = new Map();
    /** @type {Map<string, object>} hex → last rendered cell values */
    this._prevValues = new Map();

    this._config = {};
    this._hass = null;
    this._pollTimer = null;
    this._receiverLat = null;
    this._receiverLon = null;
    this._receiverFetched = false;
    this._status = "connecting";
  }

  // ------------------------------------------------------------------
  // HA card protocol
  // ------------------------------------------------------------------

  static getStubConfig() {
    return {
      url: "http://192.168.1.1:8080",
      title: "PLANESIGHT",
      max_planes: 15,
    };
  }

  setConfig(config) {
    if (!config.url && !config.entity) {
      throw new Error("PlaneSight card: provide either `url` or `entity`");
    }
    this._config = { ...config };
    this._render();

    if (config.url) {
      this._startPolling();
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._setHomeReceiverFallback();
    // Entity mode: read aircraft list from HA sensor attributes
    if (this._config.entity) {
      const state = hass.states[this._config.entity];
      if (state) {
        const aircraft = state.attributes.aircraft || [];
        const recvLat = state.attributes.receiver_lat;
        const recvLon = state.attributes.receiver_lon;
        if (isValidCoordinate(recvLat, recvLon)) {
          this._receiverLat = Number(recvLat);
          this._receiverLon = Number(recvLon);
        }
        this._updateBoard(aircraft.map((ac) => this._enrichAircraft(ac)));
      }
    }
  }

  getCardSize() {
    const maxPlanes = this._config.max_planes || 15;
    return Math.ceil(maxPlanes / 3) + 2;
  }

  disconnectedCallback() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // Polling (URL mode)
  // ------------------------------------------------------------------

  _startPolling() {
    const intervalMs = (this._config.poll_interval || 5) * 1000;

    const poll = async () => {
      await this._fetchAndUpdate();
    };

    poll(); // immediate first load
    this._pollTimer = setInterval(poll, intervalMs);
  }

  _setHomeReceiverFallback() {
    if (this._receiverLat != null && this._receiverLon != null) return;
    const lat = Number(this._hass?.config?.latitude);
    const lon = Number(this._hass?.config?.longitude);
    if (isValidCoordinate(lat, lon)) {
      this._receiverLat = lat;
      this._receiverLon = lon;
    }
  }

  _enrichAircraft(ac) {
    const copy = { ...ac };
    if (copy.flight) copy.flight = copy.flight.trim();

    if (
      isValidCoordinate(this._receiverLat, this._receiverLon) &&
      isValidCoordinate(copy.lat, copy.lon)
    ) {
      copy.distance_nm =
        Math.round(
          haversineNm(
            Number(this._receiverLat),
            Number(this._receiverLon),
            Number(copy.lat),
            Number(copy.lon)
          ) * 10
        ) / 10;
    } else {
      const distance = existingDistanceNm(copy);
      if (distance != null) copy.distance_nm = distance;
    }

    return copy;
  }

  async _fetchAndUpdate() {
    const base = this._config.url.replace(/\/$/, "");

    try {
      // Fetch receiver position once
      if (!this._receiverFetched) {
        this._receiverFetched = true;
        try {
          const r = await fetch(`${base}/data/receiver.json`);
          if (r.ok) {
            const recv = await r.json();
            if (isValidCoordinate(recv.lat, recv.lon)) {
              this._receiverLat = Number(recv.lat);
              this._receiverLon = Number(recv.lon);
            }
          }
        } catch (_) { /* best-effort */ }
        this._setHomeReceiverFallback();
      }

      const resp = await fetch(`${base}/data/aircraft.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const raw = data.aircraft || [];

      // Filter & enrich
      const visible = raw
        .filter((a) => isValidCoordinate(a.lat, a.lon) && positionAgeSeconds(a) <= 60)
        .map((a) => this._enrichAircraft(a));

      visible.sort((a, b) => (a.distance_nm ?? 9999) - (b.distance_nm ?? 9999));

      this._setStatus("live", visible.length);
      this._updateBoard(visible);
    } catch (err) {
      console.warn("PlaneSight card: fetch error", err);
      this._setStatus("error");
    }
  }

  // ------------------------------------------------------------------
  // Board update logic
  // ------------------------------------------------------------------

  _setStatus(state, count) {
    const dot = this.shadowRoot.getElementById("ps-dot");
    const countEl = this.shadowRoot.getElementById("ps-count");
    if (!dot || !countEl) return;

    if (state === "live") {
      dot.className = "dot dot-live";
      countEl.textContent = `${count} aircraft`;
    } else if (state === "error") {
      dot.className = "dot dot-error";
      countEl.textContent = "no signal";
    } else {
      dot.className = "dot dot-idle";
      countEl.textContent = "connecting…";
    }
  }

  _updateBoard(aircraft) {
    const body = this.shadowRoot.getElementById("ps-body");
    if (!body) return;

    const max = this._config.max_planes ?? 15;
    const visible = aircraft.slice(0, max);
    const activeHexes = new Set(visible.map((a, idx) => aircraftKey(a, idx)));

    // --- Remove stale rows ---
    for (const [hex, row] of this._rows) {
      if (!activeHexes.has(hex)) {
        row.classList.add("row-exit");
        row.addEventListener(
          "animationend",
          () => {
            row.remove();
            this._rows.delete(hex);
            this._prevValues.delete(hex);
          },
          { once: true }
        );
      }
    }

    // --- Add or update rows ---
    visible.forEach((ac, idx) => {
      const hex = aircraftKey(ac, idx);
      const vals = buildRowValues(ac);

      if (this._rows.has(hex)) {
        // Update changed cells with flip animation
        const row = this._rows.get(hex);
        const prev = this._prevValues.get(hex) || {};
        Object.keys(vals).forEach((col) => {
          if (vals[col] !== prev[col]) {
            const cell = row.querySelector(`[data-col="${col}"]`);
            if (cell) this._flipCell(cell, vals[col]);
          }
        });
      } else {
        // New row — enter with staggered cascade
        const row = this._buildRow(hex, vals, idx);
        body.appendChild(row);
        this._rows.set(hex, row);
      }

      this._prevValues.set(hex, vals);

      // Maintain visual order via CSS order property
      const row = this._rows.get(hex);
      if (row) row.style.order = idx;
    });

    // Update header count
    this._setStatus("live", aircraft.length);

    // Pulse the live dot
    const dot = this.shadowRoot.getElementById("ps-dot");
    if (dot) {
      dot.classList.remove("dot-pulse");
      void dot.offsetWidth; // force reflow
      dot.classList.add("dot-pulse");
    }
  }

  _buildRow(hex, vals, idx) {
    const row = document.createElement("div");
    row.className = "ac-row row-enter";
    row.dataset.hex = hex;
    row.style.animationDelay = `${idx * 25}ms`;

    const COLS = ["flight", "type", "alt", "speed", "dist"];
    COLS.forEach((col, colIdx) => {
      const cell = document.createElement("div");
      cell.className = `cell col-${col}`;
      cell.dataset.col = col;
      cell.textContent = vals[col];
      cell.style.animationDelay = `${idx * 25 + colIdx * 18}ms`;
      row.appendChild(cell);
    });

    setTimeout(() => row.classList.remove("row-enter"), 600);
    return row;
  }

  _flipCell(cell, newValue) {
    if (cell._flipping) return;
    cell._flipping = true;
    cell.classList.add("flipping");
    // Swap text at the midpoint of the animation
    setTimeout(() => {
      cell.textContent = newValue;
    }, 120);
    cell.addEventListener(
      "animationend",
      () => {
        cell.classList.remove("flipping");
        cell._flipping = false;
      },
      { once: true }
    );
  }

  // ------------------------------------------------------------------
  // Render (skeleton)
  // ------------------------------------------------------------------

  _render() {
    const title = (this._config.title || "PLANESIGHT").toUpperCase();
    const height = this._config.height || 480;

    this.shadowRoot.innerHTML = `
      <style>${this._css(height)}</style>
      <ha-card>
        <div class="board">

          <!-- ── Header ─────────────────────────────────────────────── -->
          <div class="board-header">
            <div class="header-left">
              <span class="header-icon">✈</span>
              <span class="header-title">${title}</span>
            </div>
            <div class="header-right">
              <span class="dot dot-idle" id="ps-dot"></span>
              <span class="plane-count" id="ps-count">connecting…</span>
            </div>
          </div>

          <!-- ── Column labels ──────────────────────────────────────── -->
          <div class="col-labels">
            <div class="lbl lbl-flight">FLIGHT</div>
            <div class="lbl lbl-type">TYPE</div>
            <div class="lbl lbl-alt">ALT M</div>
            <div class="lbl lbl-speed">KM/H</div>
            <div class="lbl lbl-dist">KM</div>
          </div>

          <!-- ── Scrollable body ────────────────────────────────────── -->
          <div class="board-body" id="ps-body"></div>

        </div>
      </ha-card>
    `;
  }

  _css(height) {
    return `
      /* ── Variables ─────────────────────────────────────────────────── */
      :host {
        --amber:        #ffb347;
        --amber-dim:    #b07830;
        --amber-bright: #ffd060;
        --amber-glow:   rgba(255,179,71,0.25);
        --bg:           #07090d;
        --panel:        #0c0f16;
        --panel-alt:    #0a0d13;
        --border:       #141a26;
        --header-bg:    #050709;
        --label-color:  #3a4560;
        --status-color: #5a6a85;
        --green:        #22c55e;
        --red:          #ef4444;
        --blue:         #60a5fa;
        --board-cols:   minmax(8ch, 1.35fr) minmax(5.5ch, 0.85fr) minmax(7ch, 1fr) minmax(7ch, 0.95fr) minmax(6.5ch, 0.85fr);

        display: block;
        font-family: 'Courier New', 'Lucida Console', 'DejaVu Sans Mono', monospace;
      }

      ha-card {
        background: var(--bg);
        overflow: hidden;
        border: 1px solid #1a2030;
        box-shadow: 0 0 40px rgba(0,0,0,0.8), inset 0 0 80px rgba(0,0,0,0.3);
      }

      /* ── Board shell ────────────────────────────────────────────────── */
      .board {
        position: relative;
      }

      /* Subtle scanline overlay for CRT atmosphere */
      .board::after {
        content: '';
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(
          to bottom,
          transparent,
          transparent 3px,
          rgba(0,0,0,0.04) 3px,
          rgba(0,0,0,0.04) 4px
        );
        pointer-events: none;
        z-index: 10;
      }

      /* ── Header ─────────────────────────────────────────────────────── */
      .board-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px;
        background: var(--header-bg);
        border-bottom: 1px solid #1c2333;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .header-icon {
        font-size: 1.3em;
        color: var(--amber);
        filter: drop-shadow(0 0 6px var(--amber));
      }

      .header-title {
        font-size: 1.15em;
        font-weight: 700;
        letter-spacing: 0.3em;
        color: var(--amber);
        text-shadow: 0 0 18px var(--amber-glow), 0 0 6px rgba(255,179,71,0.4);
      }

      .header-right {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 0.72em;
        color: var(--status-color);
        letter-spacing: 0.05em;
      }

      /* Live indicator dot */
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
        transition: background 0.3s, box-shadow 0.3s;
      }
      .dot-live  { background: var(--green);  box-shadow: 0 0 5px var(--green); }
      .dot-error { background: var(--red);    box-shadow: 0 0 5px var(--red); }
      .dot-idle  { background: #333;          box-shadow: none; }

      .dot-pulse {
        animation: dotPulse 0.6s ease-out;
      }
      @keyframes dotPulse {
        0%   { box-shadow: 0 0 4px var(--green); }
        40%  { box-shadow: 0 0 14px var(--green), 0 0 24px rgba(34,197,94,0.4); }
        100% { box-shadow: 0 0 5px var(--green); }
      }

      /* ── Column labels ──────────────────────────────────────────────── */
      .col-labels {
        display: grid;
        grid-template-columns: var(--board-cols);
        width: 100%;
        box-sizing: border-box;
        gap: 0 3px;
        padding: 5px 12px 4px;
        background: #060810;
        border-bottom: 1px solid #1c2535;
      }

      .lbl {
        font-size: 0.58em;
        font-weight: 700;
        letter-spacing: 0.18em;
        color: var(--label-color);
        text-align: center;
        padding: 1px 2px;
      }

      /* ── Board body (scrollable rows) ───────────────────────────────── */
      .board-body {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        max-height: ${height}px;
        scrollbar-width: thin;
        scrollbar-color: #1e2535 transparent;
      }

      .board-body::-webkit-scrollbar { width: 4px; }
      .board-body::-webkit-scrollbar-track { background: transparent; }
      .board-body::-webkit-scrollbar-thumb { background: #1e2535; border-radius: 2px; }

      /* ── Aircraft rows ──────────────────────────────────────────────── */
      .ac-row {
        display: grid;
        grid-template-columns: var(--board-cols);
        width: 100%;
        box-sizing: border-box;
        gap: 0 3px;
        padding: 3px 12px;
        border-bottom: 1px solid var(--border);
        transition: background 0.15s;
        order: 999; /* overridden per-row by JS */
      }

      .ac-row:nth-child(even) {
        background: rgba(255,255,255,0.012);
      }

      .ac-row:hover {
        background: rgba(255,179,71,0.04);
      }

      /* Row enter animation — slides in from left with stagger */
      .row-enter {
        animation: rowSlideIn 0.35s ease-out both;
      }
      @keyframes rowSlideIn {
        from { opacity: 0; transform: translateX(-18px); }
        to   { opacity: 1; transform: translateX(0); }
      }

      /* Row exit animation */
      .row-exit {
        animation: rowFade 0.4s ease-in forwards;
        pointer-events: none;
      }
      @keyframes rowFade {
        from { opacity: 1; transform: translateX(0); }
        to   { opacity: 0; transform: translateX(14px); }
      }

      /* ── Cells ──────────────────────────────────────────────────────── */
      .cell {
        min-width: 0;
        font-size: 0.82em;
        text-align: center;
        padding: 4px 3px;
        border-radius: 2px;
        background: var(--panel);
        color: var(--amber);
        text-shadow: 0 0 8px rgba(255,179,71,0.3);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transform-style: preserve-3d;
        border: 1px solid rgba(255,179,71,0.05);
        line-height: 1.4;
        letter-spacing: 0.04em;
      }

      /* Column-specific tints */
      .col-flight {
        color: var(--amber-bright);
        font-weight: 700;
        text-shadow: 0 0 10px rgba(255,208,96,0.45);
        border-color: rgba(255,208,96,0.1);
      }
      .col-type   { color: #d4a840; }
      .col-alt    { color: #e2a030; }
      .col-speed  { color: #c9a060; }
      .col-dist   { color: #6ee08a; text-shadow: 0 0 6px rgba(110,224,138,0.25); }

      /* ── Flip animation ─────────────────────────────────────────────── */
      .cell.flipping {
        animation: flipPanel 0.24s ease-in-out both;
      }

      @keyframes flipPanel {
        0%   { transform: perspective(320px) rotateX(0deg);   filter: brightness(1); }
        38%  { transform: perspective(320px) rotateX(-88deg); filter: brightness(0.2); }
        62%  { transform: perspective(320px) rotateX(88deg);  filter: brightness(0.2); }
        100% { transform: perspective(320px) rotateX(0deg);   filter: brightness(1); }
      }
    `;
  }
}

customElements.define("planesight-card", PlaneSightCard);

// Register card metadata for the Lovelace card picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "planesight-card",
  name: "PlaneSight — Flip Board",
  description:
    "Split-flap departure board showing live ADS-B traffic from ultrafeeder / tar1090.",
  preview: true,
  documentationURL: "https://github.com/planesight/planesight",
});
