// Swing-map structure: 15m maps the swings, 1m and 15s time the entries.
//
// There is no BOS and no CHoCH here, and no candles anywhere. The only thing
// this tracks is the sequence of swing highs and lows, and the only question it
// asks of them is whether each one is higher or lower than the last:
//
//     HH + HL  ->  BULLISH
//     LH + LL  ->  BEARISH
//     HH + LL  ->  EXPANDING     (broadening — no trend)
//     LH + HL  ->  CONTRACTING   (coiling — no trend)
//
// The two mixed cases are the point of reading it this way. A single-number
// trend has to pick a side; a pair of labels can honestly say "there isn't one".
//
// Nothing here trades and nothing here needs a token.

// --- Connection state ------------------------------------------------------

let socket = null;
let stopTicks = null;
let activeSymbol = '';
let pipSize = 0.01;
let decimals = 2;

// --- The series ------------------------------------------------------------

const TS = [];   // epoch ms
const MID = [];  // spot
const MAX_TICKS = 60000;

let unit = 0.01;       // 1 "u" — median absolute tick move, for readouts
let tickSd = 0.01;     // sd of tick moves, for scaling the swing filter
let tickGapMs = 2000;  // median gap between ticks

// --- Timeframes: map, entry, trigger ---------------------------------------

const TF = { m15: 900000, m1: 60000, s15: 15000 };
const BOX = TF.m15;

const PANELS = [
    { key: 'm15', ms: TF.m15, label: '15m', role: 'swing map' },
    { key: 'm1', ms: TF.m1, label: '1m', role: 'entry' },
    { key: 's15', ms: TF.s15, label: '15s', role: 'trigger' },
];

// --- Settings --------------------------------------------------------------

let lookMult = 20;     // each panel reads lookMult x its own timeframe
let kFilter = 0.50;    // swing filter = kFilter x tickSd x sqrt(ticks in TF)
let soundOn = true;
let frozen = false;

// Fewer ticks than this and a "swing" is noise with a label on it.
const MIN_STRUCT_TICKS = 40;

// --- Derived ---------------------------------------------------------------

let S = { m15: null, m1: null, s15: null };
let align = { dir: 'RANGE', score: 0, aligned: false, note: '' };
let wasAligned = false;
let freshUntil = 0;

// Alignment is decided from confirmed swings, which cannot change faster than
// one swing — but price hovering on a level can still flicker the pending flag,
// so a cooldown keeps the alert honest.
const SIGNAL_COOLDOWN_MS = 60000;
let lastSignalAt = 0;
let lastSignalDir = null;
let signalCount = 0;

// --- DOM -------------------------------------------------------------------

const el = (id) => document.getElementById(id);

const connectBtn = el('connect-btn');
const clearBtn = el('clear-btn');
const exportBtn = el('export-btn');
const assetSelect = el('asset-select');
const lookSlider = el('look-slider'), lookVal = el('look-val');
const kSlider = el('k-slider'), kVal = el('k-val');
const soundChk = el('sound-chk');
const freezeBtn = el('freeze-btn');
const connectionStatus = el('connection-status');
const noticeBar = el('notice-bar');
const unitNote = el('unit-note');

const alignPanel = el('align-panel');
const alignVerdict = el('align-verdict');
const alignMeta = el('align-meta');

const badges = {
    m15: { box: el('badge-15'), trend: el('trend-15'), sw: el('sw-15'), pend: el('pend-15') },
    m1: { box: el('badge-1'), trend: el('trend-1'), sw: el('sw-1'), pend: el('pend-1') },
    s15: { box: el('badge-s'), trend: el('trend-s'), sw: el('sw-s'), pend: el('pend-s') },
};

const stats = {
    spot: el('stat-spot'), open: el('stat-open'), high: el('stat-high'), low: el('stat-low'),
    range: el('stat-range'), left: el('stat-left'), inbox: el('stat-inbox'), gap: el('stat-gap'),
    ticks: el('stat-ticks'), signals: el('stat-signals'),
};

const boxCv = el('box-canvas'), boxCx = boxCv.getContext('2d');
const canvases = {
    m15: { cv: el('tf15-canvas'), cx: el('tf15-canvas').getContext('2d') },
    m1: { cv: el('tf1-canvas'), cx: el('tf1-canvas').getContext('2d') },
    s15: { cv: el('tfs-canvas'), cx: el('tfs-canvas').getContext('2d') },
};

const COL = {
    grid: '#21262d', axis: '#8b949e', up: '#3fb950', dn: '#f85149',
    ac: '#58a6ff', gold: '#d4a017', dash: '#6e7681', path: '#7d8590',
};

// The four readings a pair of labels can produce.
const TREND_COL = {
    BULLISH: '#3fb950', BEARISH: '#f85149',
    EXPANDING: '#d4a017', CONTRACTING: '#a371f7', FORMING: '#6e7681',
};
const TREND_NOTE = {
    BULLISH: 'higher highs and higher lows',
    BEARISH: 'lower highs and lower lows',
    EXPANDING: 'higher high but lower low — broadening, no trend',
    CONTRACTING: 'lower high but higher low — coiling, no trend',
    FORMING: 'not enough swings to read yet',
};

function notify(message, kind = 'info') {
    noticeBar.textContent = message;
    noticeBar.className = `notice ${kind}`;
    noticeBar.hidden = !message;
    if (kind === 'error') console.error(message);
}

const fmtP = (p) => p.toFixed(decimals);

function fmtClock(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --- Connection ------------------------------------------------------------

connectBtn.addEventListener('click', () => connect());

async function connect() {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    notify('Connecting to the public market-data gateway…');

    try {
        if (socket) socket.close();
        socket = await DerivAPI.connectPublic();

        socket.onClose = (event, closedByUs) => {
            if (closedByUs) return;
            connectionStatus.textContent = 'Disconnected';
            connectionStatus.className = 'status-badge disconnected';
            connectBtn.textContent = 'Connect & Stream';
            connectBtn.disabled = false;
            notify(`Stream dropped (code ${event.code}). Press connect to resume.`, 'error');
        };

        await populateSymbols();
        await subscribeToTicks();

        connectionStatus.textContent = 'Streaming (public)';
        connectionStatus.className = 'status-badge connected';
        connectBtn.textContent = 'Streaming ✔';
    } catch (error) {
        notify(error.message, 'error');
        connectBtn.textContent = 'Connect & Stream';
    } finally {
        connectBtn.disabled = false;
    }
}

/** Build the asset list from what is actually open for trading right now. */
async function populateSymbols() {
    const previous = assetSelect.value;
    const response = await socket.send({ active_symbols: 'brief' });
    const symbols = (response.active_symbols || [])
        .filter((s) => s.market === 'synthetic_index' && s.exchange_is_open === 1)
        .map((s) => ({
            code: s.underlying_symbol || s.symbol,
            name: s.underlying_symbol_name || s.display_name,
            pip: s.pip_size,
        }))
        .filter((s) => s.code)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (!symbols.length) return;

    assetSelect.innerHTML = '';
    for (const s of symbols) {
        const option = document.createElement('option');
        option.value = s.code;
        option.textContent = s.name || s.code;
        option.dataset.pipSize = s.pip;
        assetSelect.appendChild(option);
    }
    if (symbols.some((s) => s.code === previous)) assetSelect.value = previous;
}

async function subscribeToTicks() {
    if (stopTicks) stopTicks();

    activeSymbol = assetSelect.value;
    pipSize = Number(assetSelect.selectedOptions[0]?.dataset.pipSize) || 0.01;
    decimals = Math.max(2, String(pipSize).split('.')[1]?.length || 2);
    resetSeries();

    await prefillTicks();
    recomputeScale();
    rebuild();

    stopTicks = socket.subscribe({ ticks: activeSymbol }, (msg, error) => {
        if (error) { notify(`Tick stream error: ${error.message}`, 'error'); return; }
        if (msg?.tick) processIncomingTick(msg.tick);
    });
}

/** Pages back far enough that the 15m swing map has real swings to work with. */
async function prefillTicks() {
    let end = 'latest';
    const want = lookMult * TF.m15 / 2000 * 1.5;
    const batches = [];

    for (let page = 0; page < 5 && batches.reduce((n, b) => n + b.times.length, 0) < want; page++) {
        let response;
        try {
            response = await socket.send({ ticks_history: activeSymbol, end, count: 5000, style: 'ticks' });
        } catch { break; }
        const times = response?.history?.times || [];
        const prices = response?.history?.prices || [];
        if (times.length < 2) break;
        batches.unshift({ times, prices });
        end = String(Number(times[0]) - 1);
    }

    for (const b of batches) {
        for (let i = 0; i < b.times.length; i++) {
            const spot = Number(b.prices[i]), t = Number(b.times[i]) * 1000;
            if (!Number.isFinite(spot) || !Number.isFinite(t)) continue;
            if (TS.length && t <= TS[TS.length - 1]) continue;   // pages overlap
            TS.push(t); MID.push(spot);
        }
    }

    if (TS.length) {
        const hours = (TS[TS.length - 1] - TS[0]) / 3600000;
        notify(`Prefilled ${TS.length.toLocaleString()} ticks (${hours.toFixed(1)}h) — now streaming live.`);
    } else {
        notify('No tick history on this gateway — swings will build as ticks arrive.');
    }
}

// --- Tick ingestion --------------------------------------------------------

function processIncomingTick(tick) {
    const timeMs = Number(tick.epoch) * 1000;
    const spot = Number(tick.quote);
    if (!Number.isFinite(timeMs) || !Number.isFinite(spot)) return;
    if (TS.length && timeMs < TS[TS.length - 1]) return;

    TS.push(timeMs); MID.push(spot);
    if (TS.length > MAX_TICKS) {
        const drop = TS.length - MAX_TICKS;
        TS.splice(0, drop); MID.splice(0, drop);
    }

    recomputeScale();
    rebuild();

    stats.spot.textContent = fmtP(spot);
    stats.ticks.textContent = TS.length.toLocaleString();
    dirty = true;
}

function resetSeries() {
    TS.length = 0; MID.length = 0;
    S = { m15: null, m1: null, s15: null };
    wasAligned = false;
    lastSignalAt = 0;
    lastSignalDir = null;
    signalCount = 0;
    stats.ticks.textContent = '0';
    stats.signals.textContent = '0';
    dirty = true;
}

/**
 * unit    — median |move|, the natural "u" for readouts
 * tickSd  — sd of moves, what the swing filter rides on
 * tickGap — median spacing, so a timeframe converts into a tick count
 */
function recomputeScale() {
    const n = MID.length;
    if (n < 20) return;
    const from = Math.max(1, n - 1000);

    const moves = [], gaps = [];
    let sum = 0, sumSq = 0, count = 0;
    for (let i = from; i < n; i++) {
        const d = MID[i] - MID[i - 1];
        sum += d; sumSq += d * d; count++;
        if (d !== 0) moves.push(Math.abs(d));
        gaps.push(TS[i] - TS[i - 1]);
    }
    if (moves.length) {
        moves.sort((a, b) => a - b);
        unit = moves[Math.floor(moves.length / 2)];
    }
    if (count > 1) {
        const mean = sum / count;
        tickSd = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    }
    if (gaps.length) {
        gaps.sort((a, b) => a - b);
        tickGapMs = Math.max(100, gaps[Math.floor(gaps.length / 2)] || 2000);
    }
    if (!(unit > 0)) unit = pipSize;
    if (!(tickSd > 0)) tickSd = unit;

    const perTF = PANELS.map((p) => `${p.label} ≈ ${Math.max(2, Math.round(p.ms / tickGapMs))}t`).join(' · ');
    unitNote.textContent =
        `${fmtP(unit)} (median tick move) · σ ${fmtP(tickSd)} · ${(tickGapMs / 1000).toFixed(1)}s per tick · ${perTF}`;
}

// --- Windows ---------------------------------------------------------------

/** First tick index at or after `t`. */
function indexAtTime(t) {
    let lo = 0, hi = TS.length - 1, best = TS.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (TS[mid] >= t) { best = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return best;
}

/** The tick index range covering the last `spanMs` of the stream. */
function windowFor(spanMs) {
    if (!TS.length) return null;
    const end = TS.length - 1;
    const i0 = indexAtTime(TS[end] - spanMs);
    return [Math.min(i0, end), end];
}

const boxAnchor = () => (TS.length ? Math.floor(TS[TS.length - 1] / BOX) * BOX : Math.floor(Date.now() / BOX) * BOX);

/**
 * Swing filter for a timeframe. Over n ticks a driftless series drifts about
 * σ√n, so scaling the threshold that way keeps one slider meaningful on 15s and
 * 15m at once — which a fixed price threshold could never do.
 */
function thresholdFor(tfMs) {
    const nTicks = Math.max(2, tfMs / tickGapMs);
    return kFilter * tickSd * Math.sqrt(nTicks);
}

function rebuild() {
    for (const p of PANELS) {
        const w = windowFor(p.ms * lookMult);
        S[p.key] = w ? readSwings(w[0], w[1], thresholdFor(p.ms), p) : null;
    }
    evaluateAlignment();
    dirty = true;
}

// --- Swings ----------------------------------------------------------------

/**
 * ZigZag over the raw quotes. A swing only turns once price has retraced `th`
 * from the running extreme, which is what stops every tick becoming a pivot.
 * The extreme still in progress comes back separately as `running`: it is
 * drawn, because you want to see the live leg, but it never gets a label,
 * because an unconfirmed swing has nothing to be compared against yet.
 */
function zigzag(i0, i1, th) {
    const piv = [];
    if (i1 - i0 < 2 || !(th > 0)) return { piv, running: null };

    let hi = MID[i0], hiI = i0, lo = MID[i0], loI = i0;
    let dir = null, ep = 0, ei = 0;

    for (let i = i0 + 1; i <= i1; i++) {
        const p = MID[i];

        if (dir === null) {
            if (p > hi) { hi = p; hiI = i; }
            if (p < lo) { lo = p; loI = i; }
            if (hi - lo >= th) {
                if (hiI < loI) { piv.push({ i: hiI, p: hi, type: 'H' }); dir = 'dn'; ep = lo; ei = loI; }
                else { piv.push({ i: loI, p: lo, type: 'L' }); dir = 'up'; ep = hi; ei = hiI; }
            }
            continue;
        }

        if (dir === 'up') {
            if (p > ep) { ep = p; ei = i; }
            else if (ep - p >= th) { piv.push({ i: ei, p: ep, type: 'H' }); dir = 'dn'; ep = p; ei = i; }
        } else {
            if (p < ep) { ep = p; ei = i; }
            else if (p - ep >= th) { piv.push({ i: ei, p: ep, type: 'L' }); dir = 'up'; ep = p; ei = i; }
        }
    }

    const running = dir ? { i: ei, p: ep, type: dir === 'up' ? 'H' : 'L', live: true } : null;
    return { piv, running };
}

/**
 * The whole trend read, from two labels.
 *
 * A single-number trend has to commit to a direction even when the swings are
 * telling you two different things. Reading the last high against the last low
 * lets the mixed cases say so out loud instead of being rounded into a bias.
 */
function trendFromLabels(lastH, lastL) {
    const h = lastH?.label, l = lastL?.label;
    // 'H'/'L' are the first of their kind — nothing to compare them against.
    if (!h || !l || h === 'H' || l === 'L') return { trend: 'FORMING', bias: 'RANGE' };
    if (h === 'HH' && l === 'HL') return { trend: 'BULLISH', bias: 'BULL' };
    if (h === 'LH' && l === 'LL') return { trend: 'BEARISH', bias: 'BEAR' };
    if (h === 'HH' && l === 'LL') return { trend: 'EXPANDING', bias: 'RANGE' };
    return { trend: 'CONTRACTING', bias: 'RANGE' };   // LH + HL
}

/** Map a stretch of ticks into labelled swings and the trend they describe. */
function readSwings(i0, i1, th, panel) {
    const base = {
        key: panel.key, label: panel.label, role: panel.role, tfMs: panel.ms,
        i0, i1, th, piv: [], running: null, lastH: null, lastL: null,
        trend: 'FORMING', bias: 'RANGE', pending: null,
    };
    if (i1 - i0 < MIN_STRUCT_TICKS) return base;

    const { piv, running } = zigzag(i0, i1, th);

    // Each swing is labelled against the previous swing of the same kind.
    let prevH = null, prevL = null;
    for (const p of piv) {
        if (p.type === 'H') { p.label = prevH === null ? 'H' : (p.p > prevH ? 'HH' : 'LH'); prevH = p.p; }
        else { p.label = prevL === null ? 'L' : (p.p > prevL ? 'HL' : 'LL'); prevL = p.p; }
    }

    const lastH = [...piv].reverse().find((p) => p.type === 'H') || null;
    const lastL = [...piv].reverse().find((p) => p.type === 'L') || null;
    const { trend, bias } = trendFromLabels(lastH, lastL);

    // Price beyond the last swing is on its way to making a new one, but it is
    // not a swing until it retraces. Shown, never counted.
    const spot = MID[i1];
    let pending = null;
    if (lastH && spot > lastH.p) pending = { kind: 'HH', dir: 'up', level: lastH.p };
    else if (lastL && spot < lastL.p) pending = { kind: 'LL', dir: 'dn', level: lastL.p };

    return { ...base, piv, running, lastH, lastL, trend, bias, pending };
}

// --- Alignment -------------------------------------------------------------

function evaluateAlignment() {
    const m15 = S.m15, m1 = S.m1, s15 = S.s15;
    if (!m15 || !m1 || !s15) return;

    // The 15m swing map owns the direction. 1m and 15s only get to agree.
    const dir = m15.bias;
    const agree1 = dir !== 'RANGE' && m1.bias === dir;
    const agreeS = dir !== 'RANGE' && s15.bias === dir;
    const score = dir === 'RANGE' ? 0 : 1 + (agree1 ? 1 : 0) + (agreeS ? 1 : 0);
    const aligned = score === 3;

    let note = '';
    if (dir === 'RANGE') note = `15m is ${m15.trend.toLowerCase()} — no direction to follow`;
    else if (!agree1) note = `1m is ${m1.trend.toLowerCase()} — waiting for it to turn ${dir === 'BULL' ? 'up' : 'down'}`;
    else if (!agreeS) note = `1m agrees, 15s is ${s15.trend.toLowerCase()} — waiting on the trigger`;
    else note = `all three ${dir === 'BULL' ? 'HH/HL' : 'LH/LL'}`;

    align = { dir, score, aligned, note };

    const flipped = aligned && dir !== lastSignalDir;
    const cooledDown = Date.now() - lastSignalAt >= SIGNAL_COOLDOWN_MS;
    if (aligned && cooledDown && (flipped || !wasAligned)) markSignal();
    wasAligned = aligned;
}

function markSignal() {
    lastSignalAt = Date.now();
    lastSignalDir = align.dir;
    signalCount++;
    stats.signals.textContent = signalCount;
    freshUntil = Date.now() + 2000;
    beep(align.dir);
}

let audioCtx = null;
function beep(dir) {
    if (!soundOn) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = dir === 'BULL' ? 880 : 440;
        osc.connect(gain); gain.connect(audioCtx.destination);
        const t = audioCtx.currentTime;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.start(t); osc.stop(t + 0.36);
    } catch { /* autoplay policy — the visual alert stands alone */ }
}

// --- Canvas plumbing -------------------------------------------------------

function sizeCanvas(canvas, context, cssHeight) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(50, canvas.clientWidth || 300);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function sizeAll() {
    sizeCanvas(boxCv, boxCx, 360);
    for (const p of PANELS) sizeCanvas(canvases[p.key].cv, canvases[p.key].cx, 200);
    dirty = true;
}
window.addEventListener('resize', sizeAll);

function priceGrid(cx, left, right, m, H, lo, hi) {
    cx.strokeStyle = COL.grid; cx.lineWidth = 1;
    cx.fillStyle = COL.axis; cx.font = '10px ui-monospace, monospace';
    for (let k = 0; k <= 4; k++) {
        const price = lo + ((hi - lo) * k) / 4;
        const y = m.t + (1 - (price - lo) / (hi - lo)) * (H - m.t - m.b);
        cx.beginPath(); cx.moveTo(left, y); cx.lineTo(right, y); cx.stroke();
        cx.fillText(fmtP(price), right + 5, y + 3);
    }
}

function emptyMessage(cx, W, H, text) {
    cx.fillStyle = COL.axis; cx.font = '13px sans-serif';
    cx.fillText(text, 20, H / 2);
}

function extent(i0, i1) {
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (MID[i] < lo) lo = MID[i]; if (MID[i] > hi) hi = MID[i]; }
    return [lo, hi];
}

/**
 * Draw the tick path. When there are more ticks than pixels, each column is
 * drawn as its own min-to-max bar so a spike never gets skipped over — striding
 * would quietly delete the very extremes the swings are built from.
 */
function tickPath(cx, i0, i1, X, Y, plotW) {
    const n = i1 - i0 + 1;
    cx.beginPath();
    if (n <= plotW * 2) {
        for (let i = i0; i <= i1; i++) {
            const x = X(i), y = Y(MID[i]);
            if (i === i0) cx.moveTo(x, y); else cx.lineTo(x, y);
        }
    } else {
        const per = n / plotW;
        let started = false;
        for (let c = 0; c < plotW; c++) {
            const a = i0 + Math.floor(c * per);
            const b = Math.min(i1, i0 + Math.floor((c + 1) * per) - 1);
            if (b < a) continue;
            let mn = MID[a], mx = MID[a];
            for (let i = a; i <= b; i++) { if (MID[i] < mn) mn = MID[i]; if (MID[i] > mx) mx = MID[i]; }
            const x = X(a);
            if (!started) { cx.moveTo(x, Y(mn)); started = true; }
            cx.lineTo(x, Y(mn));
            cx.lineTo(x, Y(mx));
        }
    }
    cx.stroke();
}

// --- 1. The current 15m box, tick by tick ---------------------------------

function drawBox() {
    const W = boxCv.clientWidth, H = 360, m = { l: 8, r: 70, t: 26, b: 24 };
    boxCx.clearRect(0, 0, W, H);
    if (TS.length < 2) { emptyMessage(boxCx, W, H, 'Awaiting incoming WebSocket stream data…'); return; }

    const anchor = boxAnchor();
    const i0 = indexAtTime(anchor);
    const i1 = TS.length - 1;
    if (i1 <= i0) { emptyMessage(boxCx, W, H, 'A new 15m box just opened — waiting for ticks…'); return; }

    let [lo, hi] = extent(i0, i1);
    const pad = (hi - lo) * 0.12 || unit * 6;
    lo -= pad; hi += pad;

    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const X = (i) => m.l + Math.min(1, (TS[i] - anchor) / BOX) * plotW;
    const Y = (p) => m.t + (1 - (p - lo) / (hi - lo)) * plotH;

    priceGrid(boxCx, m.l, W - m.r, m, H, lo, hi);

    for (let k = 1; k < 15; k++) {
        const x = m.l + (k / 15) * plotW;
        const isFive = k % 5 === 0;
        boxCx.strokeStyle = isFive ? 'rgba(88,166,255,.35)' : 'rgba(125,133,144,.18)';
        boxCx.lineWidth = 1;
        boxCx.setLineDash(isFive ? [] : [2, 4]);
        boxCx.beginPath(); boxCx.moveTo(x, m.t); boxCx.lineTo(x, m.t + plotH); boxCx.stroke();
        boxCx.setLineDash([]);
        if (isFive) {
            boxCx.fillStyle = 'rgba(88,166,255,.55)';
            boxCx.font = '9px ui-monospace, monospace';
            boxCx.fillText(`${k}m`, x + 3, m.t + plotH + 12);
        }
    }

    // The last 1m and the last 15s, shaded — the two entry scales in context
    const shade = (spanMs, fill) => {
        const from = Math.max(anchor, TS[i1] - spanMs);
        const x0 = m.l + Math.min(1, (from - anchor) / BOX) * plotW;
        const x1 = m.l + Math.min(1, (TS[i1] - anchor) / BOX) * plotW;
        boxCx.fillStyle = fill;
        boxCx.fillRect(x0, m.t, Math.max(1, x1 - x0), plotH);
    };
    shade(TF.m1, 'rgba(88,166,255,.07)');
    shade(TF.s15, 'rgba(212,160,23,.12)');

    const open = MID[i0];
    const guide = (price, color, text, dash) => {
        const y = Y(price);
        boxCx.setLineDash(dash); boxCx.strokeStyle = color; boxCx.lineWidth = 1;
        boxCx.beginPath(); boxCx.moveTo(m.l, y); boxCx.lineTo(W - m.r, y); boxCx.stroke();
        boxCx.setLineDash([]);
        boxCx.fillStyle = color; boxCx.font = '9px ui-monospace, monospace';
        boxCx.fillText(text, W - m.r + 5, y + 3);
    };
    const [rawLo, rawHi] = extent(i0, i1);
    guide(open, COL.dash, 'O', [4, 4]);
    guide(rawHi, 'rgba(63,185,80,.7)', 'H', [5, 4]);
    guide(rawLo, 'rgba(248,81,73,.7)', 'L', [5, 4]);

    const bull = MID[i1] >= open;
    boxCx.strokeStyle = bull ? 'rgba(63,185,80,.9)' : 'rgba(248,81,73,.9)';
    boxCx.lineWidth = 1.3;
    tickPath(boxCx, i0, i1, X, Y, plotW);

    boxCx.fillStyle = bull ? COL.up : COL.dn;
    boxCx.beginPath(); boxCx.arc(X(i1), Y(MID[i1]), 4, 0, Math.PI * 2); boxCx.fill();

    const ySpot = Y(MID[i1]);
    boxCx.fillStyle = COL.ac; boxCx.fillRect(W - m.r, ySpot - 8, m.r, 16);
    boxCx.fillStyle = '#06121f'; boxCx.font = 'bold 9px ui-monospace, monospace';
    boxCx.fillText(fmtP(MID[i1]), W - m.r + 4, ySpot + 3);

    boxCx.fillStyle = COL.axis; boxCx.font = '10px ui-monospace, monospace';
    boxCx.fillText(
        `${activeSymbol || '—'} · box opened ${fmtClock(anchor)} · ${(i1 - i0 + 1).toLocaleString()} ticks in · ` +
        `blue = last 1m, gold = last 15s`, m.l + 2, 15);
}

// --- 2. One timeframe's swing map -----------------------------------------

function drawPanel(T) {
    const { cv, cx } = canvases[T ? T.key : 'm15'];
    const W = cv.clientWidth, H = 200, m = { l: 6, r: 70, t: 22, b: 16 };
    cx.clearRect(0, 0, W, H);

    if (!T || T.i1 - T.i0 < 4) {
        emptyMessage(cx, W, H, `${T ? T.label : ''} — not enough ticks yet…`);
        return;
    }

    const { i0, i1 } = T;
    let [lo, hi] = extent(i0, i1);
    for (const p of [T.lastH, T.lastL]) {
        if (!p) continue;
        if (p.p < lo) lo = p.p;
        if (p.p > hi) hi = p.p;
    }
    const pad = (hi - lo) * 0.10 || unit * 6;
    lo -= pad; hi += pad;

    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const span = Math.max(1, i1 - i0);
    const X = (i) => m.l + ((i - i0) / span) * plotW;
    const Y = (p) => m.t + (1 - (p - lo) / (hi - lo)) * plotH;

    // The current 15m box, shaded on every panel so the same stretch of ticks
    // is identifiable across all three at a glance.
    const anchor = boxAnchor();
    if (TS[i1] >= anchor) {
        const bi = Math.max(i0, indexAtTime(anchor));
        const bx = X(bi);
        cx.fillStyle = 'rgba(88,166,255,.07)';
        cx.fillRect(bx, m.t, W - m.r - bx, plotH);
        cx.setLineDash([3, 3]); cx.strokeStyle = 'rgba(88,166,255,.35)'; cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(bx, m.t); cx.lineTo(bx, m.t + plotH); cx.stroke();
        cx.setLineDash([]);
    }

    priceGrid(cx, m.l, W - m.r, m, H, lo, hi);

    cx.strokeStyle = COL.path; cx.lineWidth = 1;
    tickPath(cx, i0, i1, X, Y, plotW);

    // The last swing high and low: the two prices that decide the next label.
    const level = (p, color, text) => {
        if (!p) return;
        const y = Y(p.p);
        cx.setLineDash([6, 4]); cx.strokeStyle = color; cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(m.l, y); cx.lineTo(W - m.r, y); cx.stroke();
        cx.setLineDash([]);
        cx.fillStyle = color; cx.font = '9px ui-monospace, monospace';
        cx.fillText(text, W - m.r + 5, y + 3);
    };
    level(T.lastH, 'rgba(63,185,80,.65)', 'above→HH');
    level(T.lastL, 'rgba(248,81,73,.65)', 'below→LL');

    // The zigzag, plus the leg still in progress
    const drawn = [...T.piv];
    if (T.running) drawn.push(T.running);
    if (drawn.length > 1) {
        cx.strokeStyle = '#388bfd'; cx.lineWidth = 1.6;
        cx.beginPath();
        drawn.forEach((p, j) => {
            const x = X(p.i), y = Y(p.p);
            if (j) cx.lineTo(x, y); else cx.moveTo(x, y);
        });
        cx.stroke();
    }

    cx.textAlign = 'center';
    for (const p of drawn) {
        const x = X(p.i), y = Y(p.p), isHigh = p.type === 'H';
        cx.globalAlpha = p.live ? 0.45 : 1;
        cx.fillStyle = isHigh ? COL.up : COL.dn;
        cx.beginPath(); cx.arc(x, y, 3.5, 0, Math.PI * 2); cx.fill();
        if (p.label) {
            // The two swings that set the current reading are drawn larger.
            const decisive = p === T.lastH || p === T.lastL;
            cx.font = `bold ${decisive ? 11 : 9}px ui-monospace, monospace`;
            cx.fillStyle = p.label[0] === 'H' ? COL.up : COL.dn;
            cx.fillText(p.label, x, isHigh ? y - 8 : y + 15);
        }
        cx.globalAlpha = 1;
    }
    cx.textAlign = 'left';

    // Head of the stream
    cx.fillStyle = COL.ac;
    cx.beginPath(); cx.arc(X(i1), Y(MID[i1]), 3.5, 0, Math.PI * 2); cx.fill();

    // Header
    const tcol = TREND_COL[T.trend];
    cx.fillStyle = COL.axis; cx.font = 'bold 10px ui-monospace, monospace';
    cx.fillText(T.label, m.l + 2, 13);
    cx.fillStyle = COL.dash; cx.font = '9px ui-monospace, monospace';
    cx.fillText(T.role, m.l + 36, 13);
    const roleW = cx.measureText(T.role).width;
    let x = m.l + 44 + roleW;
    cx.fillStyle = tcol; cx.font = 'bold 10px ui-monospace, monospace';
    cx.fillText(T.trend, x, 13);
    x += cx.measureText(T.trend).width + 8;
    cx.fillStyle = COL.up; cx.font = 'bold 9px ui-monospace, monospace';
    const pair = `${T.lastH?.label || '—'} / ${T.lastL?.label || '—'}`;
    cx.fillStyle = COL.axis;
    cx.fillText(pair, x, 13);
    x += cx.measureText(pair).width + 10;
    if (T.pending) {
        cx.fillStyle = COL.gold;
        cx.fillText(`${T.pending.kind} forming`, x, 13);
        x += cx.measureText(`${T.pending.kind} forming`).width + 10;
    }
    cx.fillStyle = COL.dash; cx.font = '9px ui-monospace, monospace';
    cx.fillText(
        `${(i1 - i0 + 1).toLocaleString()} ticks · filter ${(T.th / unit).toFixed(1)}u · ${T.piv.length} swings`,
        x, 13);
}

// --- HUD -------------------------------------------------------------------

const BIAS_CLASS = { BULL: 'bull', BEAR: 'bear', RANGE: 'range' };

function paintBadge(badge, T) {
    if (!T) return;
    const cls = BIAS_CLASS[T.bias];
    badge.box.className = `tfbadge ${cls}`;
    badge.trend.className = `tfbias ${cls}`;
    badge.trend.textContent =
        T.trend === 'BULLISH' ? '▲ BULLISH' : T.trend === 'BEARISH' ? '▼ BEARISH' : `— ${T.trend}`;

    const h = T.lastH?.label, l = T.lastL?.label;
    badge.sw.innerHTML =
        `<span class="${h && h[0] === 'H' ? 'up' : 'dn'}">${h || '—'}</span>` +
        ` <span class="muted">/</span> ` +
        `<span class="${l && l[0] === 'H' ? 'up' : 'dn'}">${l || '—'}</span>` +
        `<span class="note">${TREND_NOTE[T.trend]}</span>`;

    if (T.pending) {
        badge.pend.innerHTML = `<span class="pending">${T.pending.kind} forming</span> ` +
            `past ${fmtP(T.pending.level)} — not counted until it retraces`;
    } else {
        const need = T.lastH && T.lastL
            ? `next: above ${fmtP(T.lastH.p)} = HH · below ${fmtP(T.lastL.p)} = LL`
            : 'waiting for the first swings';
        badge.pend.textContent = need;
    }
}

function drawHud() {
    for (const p of PANELS) paintBadge(badges[p.key], S[p.key]);

    const stillFresh = Date.now() < freshUntil;
    alignPanel.className = `align ${align.aligned ? BIAS_CLASS[align.dir] : ''}${stillFresh ? ' fresh' : ''}`;

    if (!S.m15) {
        alignVerdict.textContent = 'Waiting for data…';
        alignVerdict.className = 'align-verdict wait';
    } else if (align.aligned) {
        alignVerdict.textContent = align.dir === 'BULL'
            ? '▲ FOLLOW THE TREND UP — 15m, 1m and 15s all HH/HL'
            : '▼ FOLLOW THE TREND DOWN — 15m, 1m and 15s all LH/LL';
        alignVerdict.className = `align-verdict ${BIAS_CLASS[align.dir]}`;
    } else if (align.score === 2) {
        alignVerdict.textContent = `${align.dir === 'BULL' ? '▲' : '▼'} 2 of 3 — ${align.note}`;
        alignVerdict.className = 'align-verdict wait';
    } else if (align.score === 1) {
        alignVerdict.textContent = `${align.dir === 'BULL' ? '▲' : '▼'} 15m only — ${align.note}`;
        alignVerdict.className = 'align-verdict wait';
    } else {
        alignVerdict.textContent = `No trend to follow — ${align.note}`;
        alignVerdict.className = 'align-verdict wait';
    }

    alignMeta.textContent = S.m15
        ? `${activeSymbol || '—'} · ${align.score}/3 · ` +
          PANELS.map((p) => `${p.label} ${S[p.key]?.trend ?? '—'}`).join(' · ')
        : '—';

    if (TS.length < 2) return;

    const anchor = boxAnchor();
    const i0 = indexAtTime(anchor), i1 = TS.length - 1;
    if (i1 > i0) {
        const [lo, hi] = extent(i0, i1);
        stats.open.textContent = fmtP(MID[i0]);
        stats.high.textContent = fmtP(hi);
        stats.low.textContent = fmtP(lo);
        stats.range.textContent = ((hi - lo) / unit).toFixed(1);
        stats.inbox.textContent = `${(i1 - i0 + 1).toLocaleString()}`;
    }
    stats.gap.textContent = `${(tickGapMs / 1000).toFixed(1)}s`;

    const msLeft = anchor + BOX - Date.now();
    if (msLeft <= 0) {
        stats.left.textContent = 'closing…';
    } else {
        const s = Math.floor(msLeft / 1000);
        stats.left.textContent = `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    }
}

// --- Render loop -----------------------------------------------------------

let dirty = true;
let lastFrame = 0;

function frame(now) {
    requestAnimationFrame(frame);
    if (frozen) return;
    if (!dirty && now - lastFrame < 250) return;
    lastFrame = now;
    dirty = false;

    drawBox();
    for (const p of PANELS) drawPanel(S[p.key]);
    drawHud();
}

// --- Controls --------------------------------------------------------------

assetSelect.addEventListener('change', () => { if (socket?.isOpen) subscribeToTicks(); });

clearBtn.addEventListener('click', resetSeries);

lookSlider.addEventListener('input', (e) => {
    lookMult = parseInt(e.target.value, 10);
    lookVal.textContent = `${lookMult} ×`;
    rebuild();
});

kSlider.addEventListener('input', (e) => {
    kFilter = parseFloat(e.target.value);
    kVal.textContent = `${kFilter.toFixed(2)} × σ√n`;
    rebuild();
});

soundChk.addEventListener('change', (e) => { soundOn = e.target.checked; });

freezeBtn.addEventListener('click', () => {
    frozen = !frozen;
    freezeBtn.textContent = frozen ? '▶ Resume view' : '❚❚ Freeze view';
    freezeBtn.className = frozen ? 'on' : 'sec';
    dirty = true;
});

/** Dump the streamed ticks in the shape the offline replay tools expect. */
exportBtn.addEventListener('click', () => {
    if (!TS.length) { notify('Nothing streamed yet.', 'error'); return; }
    const p = (n) => String(n).padStart(2, '0');
    const rows = ['<DATE>\t<TIME>\t<BID>\t<ASK>'];
    for (let i = 0; i < TS.length; i++) {
        const d = new Date(TS[i]);
        const date = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
        const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000`;
        rows.push(`${date}\t${time}\t${MID[i]}\t${MID[i]}`);
    }
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSymbol || 'ticks'}_${TS.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
});

sizeAll();
requestAnimationFrame(frame);
connect(); // market data is public — start streaming without waiting for a click
