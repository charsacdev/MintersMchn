// Live candle builder — streams ticks from the public Deriv gateway and shows
// the candle forming tick by tick, the way tick_replay_app does off a CSV.
//
// Nothing here trades and nothing here needs a token: market data on the
// current API (api.derivws.com) is public.

// --- Connection state ------------------------------------------------------

let socket = null;
let stopTicks = null;
let activeSymbol = '';
let pipSize = 0.01;
let decimals = 2;

// --- Raw tick series (the source of truth; candles are derived from it) -----

const TS = [];    // epoch ms
const MID = [];   // spot
const BID = [];
const ASK = [];
const MAX_TICKS = 30000;

// --- Candle state ----------------------------------------------------------

let candles = [];         // {start, o, h, l, c, i0, i1, closed}
let mode = 'time';        // 'time' | 'ticks'
let tfMinutes = 1;
let ticksPerCandle = 20;
let histCount = 60;
let theta = 3.0;          // swing filter, in units
let frozen = false;
let unit = 0.01;          // 1 "u" — the spread if the feed quotes one, else the median tick move
let unitFromSpread = false;

// --- DOM -------------------------------------------------------------------

const el = (id) => document.getElementById(id);

const connectBtn = el('connect-btn');
const clearBtn = el('clear-btn');
const exportBtn = el('export-btn');
const assetSelect = el('asset-select');
const modeSelect = el('mode-select');
const tfSelect = el('tf-select');
const tfWrap = el('tf-wrap');
const tpcInput = el('tpc-input');
const tpcWrap = el('tpc-wrap');
const histSlider = el('hist-slider');
const histVal = el('hist-val');
const thSlider = el('th-slider');
const thVal = el('th-val');
const freezeBtn = el('freeze-btn');
const connectionStatus = el('connection-status');
const noticeBar = el('notice-bar');
const unitNote = el('unit-note');

const stats = {
    spot: el('stat-spot'), open: el('stat-open'), high: el('stat-high'), low: el('stat-low'),
    body: el('stat-body'), range: el('stat-range'), tick: el('stat-tick'), left: el('stat-left'),
    candles: el('stat-candles'), ticks: el('stat-ticks'),
};

const histCv = el('hist-canvas'), histCx = histCv.getContext('2d');
const tickCv = el('tick-canvas'), tickCx = tickCv.getContext('2d');
const liveCv = el('live-canvas'), liveCx = liveCv.getContext('2d');

const COL = { grid: '#21262d', axis: '#8b949e', up: '#3fb950', dn: '#f85149', ac: '#58a6ff', dash: '#6e7681' };

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

    // Prefill from history so candles exist immediately instead of only after
    // minutes of streaming. Not every gateway serves this — if it is refused,
    // the chart just starts empty and fills as ticks arrive.
    try {
        const hist = await socket.send({
            ticks_history: activeSymbol, end: 'latest', count: 2000, style: 'ticks',
        });
        const times = hist?.history?.times || [];
        const prices = hist?.history?.prices || [];
        for (let i = 0; i < times.length; i++) {
            const spot = Number(prices[i]);
            if (!Number.isFinite(spot)) continue;
            TS.push(Number(times[i]) * 1000);
            MID.push(spot); BID.push(spot); ASK.push(spot);
        }
        if (TS.length) notify(`Prefilled ${TS.length.toLocaleString()} historical ticks — now streaming live.`);
    } catch {
        notify('No tick history on this gateway — building candles from the live stream only.');
    }

    recomputeUnit();
    rebuildCandles();

    stopTicks = socket.subscribe({ ticks: activeSymbol }, (msg, error) => {
        if (error) { notify(`Tick stream error: ${error.message}`, 'error'); return; }
        if (msg?.tick) processIncomingTick(msg.tick);
    });
}

// --- Tick ingestion --------------------------------------------------------

function processIncomingTick(tick) {
    const timeMs = Number(tick.epoch) * 1000;
    const spot = Number(tick.quote);
    if (!Number.isFinite(timeMs) || !Number.isFinite(spot)) return;

    // Synthetics quote a single spot with no book; fall back to it for bid/ask.
    const ask = Number.isFinite(Number(tick.ask)) ? Number(tick.ask) : spot;
    const bid = Number.isFinite(Number(tick.bid)) ? Number(tick.bid) : spot;

    TS.push(timeMs); MID.push(spot); ASK.push(ask); BID.push(bid);

    if (TS.length > MAX_TICKS) {
        const drop = TS.length - MAX_TICKS;
        TS.splice(0, drop); MID.splice(0, drop); ASK.splice(0, drop); BID.splice(0, drop);
        recomputeUnit();
        rebuildCandles();
    } else {
        recomputeUnit();
        appendTickToCandles(TS.length - 1);
    }

    stats.spot.textContent = fmtP(spot);
    stats.ticks.textContent = TS.length.toLocaleString();
    dirty = true;
}

function resetSeries() {
    TS.length = 0; MID.length = 0; BID.length = 0; ASK.length = 0;
    candles = [];
    stats.ticks.textContent = '0';
    stats.candles.textContent = '0';
    dirty = true;
}

/**
 * 1 unit = the quoted spread when the feed has a book. Synthetics do not, so
 * there the unit falls back to the median absolute tick-to-tick move, which is
 * the natural scale of the series and keeps the swing filter meaningful.
 */
function recomputeUnit() {
    const n = MID.length;
    if (n < 3) { unit = pipSize; unitFromSpread = false; return; }
    const from = Math.max(0, n - 500);

    const spreads = [];
    for (let i = from; i < n; i++) { const s = ASK[i] - BID[i]; if (s > 0) spreads.push(s); }

    if (spreads.length > (n - from) / 2) {
        spreads.sort((a, b) => a - b);
        unit = spreads[Math.floor(spreads.length / 2)];
        unitFromSpread = true;
    } else {
        const moves = [];
        for (let i = Math.max(1, from); i < n; i++) {
            const d = Math.abs(MID[i] - MID[i - 1]);
            if (d > 0) moves.push(d);
        }
        moves.sort((a, b) => a - b);
        unit = moves.length ? moves[Math.floor(moves.length / 2)] : pipSize;
        unitFromSpread = false;
    }
    if (!(unit > 0)) unit = pipSize;

    unitNote.textContent = unitFromSpread
        ? `${fmtP(unit)} (median spread)`
        : `${fmtP(unit)} (median tick move — this feed quotes no spread)`;
}

// --- Candle construction ---------------------------------------------------

function tfMs() { return Math.round(tfMinutes * 60000); }

/** Does tick `i` have to open a new candle, or does it extend the last one? */
function startsNewCandle(i, last) {
    if (!last) return true;
    if (mode === 'time') return Math.floor(TS[i] / tfMs()) !== Math.floor(last.start / tfMs());
    return (last.i1 - last.i0 + 1) >= ticksPerCandle;
}

function appendTickToCandles(i) {
    const last = candles[candles.length - 1];

    if (startsNewCandle(i, last)) {
        if (last) last.closed = true;
        const start = mode === 'time' ? Math.floor(TS[i] / tfMs()) * tfMs() : TS[i];
        candles.push({ start, o: MID[i], h: MID[i], l: MID[i], c: MID[i], i0: i, i1: i, closed: false });
        stats.candles.textContent = candles.length;
        return;
    }

    last.i1 = i;
    last.c = MID[i];
    if (MID[i] > last.h) last.h = MID[i];
    if (MID[i] < last.l) last.l = MID[i];
}

function rebuildCandles() {
    candles = [];
    for (let i = 0; i < TS.length; i++) appendTickToCandles(i);
    stats.candles.textContent = candles.length;
    dirty = true;
}

const liveCandle = () => candles[candles.length - 1] || null;

// --- ZigZag over the ticks of the forming candle ---------------------------

function zigzag(i0, i1) {
    const th = theta * unit;
    if (i1 <= i0 || !(th > 0)) return [];

    const piv = [];
    let dir = null, ep = MID[i0], ei = i0;

    for (let i = i0 + 1; i <= i1; i++) {
        if (dir === null) {
            if (MID[i] >= MID[i0] + th) { dir = 'up'; ep = MID[i]; ei = i; }
            else if (MID[i] <= MID[i0] - th) { dir = 'dn'; ep = MID[i]; ei = i; }
        } else if (dir === 'up') {
            if (MID[i] > ep) { ep = MID[i]; ei = i; }
            else if (MID[i] <= ep - th) { piv.push({ i: ei, p: ep }); dir = 'dn'; ep = MID[i]; ei = i; }
        } else {
            if (MID[i] < ep) { ep = MID[i]; ei = i; }
            else if (MID[i] >= ep + th) { piv.push({ i: ei, p: ep }); dir = 'up'; ep = MID[i]; ei = i; }
        }
    }
    piv.push({ i: ei, p: ep }); // the leg still in progress, so the live swing shows

    let lastHigh = null, lastLow = null;
    for (let j = 0; j < piv.length; j++) {
        let isHigh;
        if (j === 0) isHigh = piv.length > 1 ? piv[1].p < piv[0].p : true;
        else if (j === piv.length - 1) isHigh = piv[j - 1].p < piv[j].p;
        else isHigh = piv[j].p > piv[j - 1].p && piv[j].p > piv[j + 1].p;

        piv[j].type = isHigh ? 'H' : 'L';
        let label = piv[j].type;
        if (isHigh) {
            if (lastHigh !== null) label = piv[j].p > lastHigh ? 'HH' : 'LH';
            lastHigh = piv[j].p;
        } else {
            if (lastLow !== null) label = piv[j].p > lastLow ? 'HL' : 'LL';
            lastLow = piv[j].p;
        }
        piv[j].label = label;
    }
    return piv;
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
    sizeCanvas(histCv, histCx, 300);
    sizeCanvas(tickCv, tickCx, 340);
    sizeCanvas(liveCv, liveCx, 340);
    dirty = true;
}
window.addEventListener('resize', sizeAll);

function priceGrid(cx, W, H, m, lo, hi) {
    cx.strokeStyle = COL.grid; cx.lineWidth = 1;
    cx.fillStyle = COL.axis; cx.font = '10px ui-monospace, monospace';
    for (let k = 0; k <= 5; k++) {
        const price = lo + ((hi - lo) * k) / 5;
        const y = m.t + (1 - (price - lo) / (hi - lo)) * (H - m.t - m.b);
        cx.beginPath(); cx.moveTo(m.l, y); cx.lineTo(W - m.r, y); cx.stroke();
        cx.fillText(fmtP(price), W - m.r + 5, y + 3);
    }
}

function emptyMessage(cx, W, H, text) {
    cx.fillStyle = COL.axis;
    cx.font = '13px sans-serif';
    if (text) cx.fillText(text, 20, H / 2);
}

// --- 1. Candle history, forming candle pinned at the right -----------------

function drawHistory() {
    const W = histCv.clientWidth, H = 300, m = { l: 8, r: 72, t: 16, b: 22 };
    histCx.clearRect(0, 0, W, H);
    if (!candles.length) { emptyMessage(histCx, W, H, 'Awaiting incoming WebSocket stream data…'); return; }

    const view = candles.slice(Math.max(0, candles.length - histCount));

    let lo = Infinity, hi = -Infinity;
    for (const c of view) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    const pad = (hi - lo) * 0.08 || unit * 4;
    lo -= pad; hi += pad;

    priceGrid(histCx, W, H, m, lo, hi);

    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const slot = plotW / view.length;
    const bw = Math.max(1.5, Math.min(slot * 0.68, 22));
    const X = (k) => m.l + slot * (k + 0.5);
    const Y = (p) => m.t + (1 - (p - lo) / (hi - lo)) * plotH;

    view.forEach((c, k) => {
        const bull = c.c >= c.o;
        const col = bull ? COL.up : COL.dn;
        const x = X(k);

        histCx.strokeStyle = col; histCx.lineWidth = 1;
        histCx.beginPath(); histCx.moveTo(x, Y(c.h)); histCx.lineTo(x, Y(c.l)); histCx.stroke();

        const yo = Y(c.o), yc = Y(c.c);
        const top = Math.min(yo, yc), bh = Math.max(Math.abs(yc - yo), 1);
        histCx.fillStyle = col;
        histCx.globalAlpha = c.closed ? 0.85 : 1;
        histCx.fillRect(x - bw / 2, top, bw, bh);
        histCx.globalAlpha = 1;

        // The forming candle gets a halo so it is obvious which one is alive.
        if (!c.closed) {
            histCx.strokeStyle = COL.ac; histCx.lineWidth = 1.4;
            histCx.strokeRect(x - bw / 2 - 2, Y(c.h) - 2, bw + 4, Y(c.l) - Y(c.h) + 4);
        }
    });

    // Spot line + right-hand price tag
    const spot = MID[MID.length - 1];
    if (Number.isFinite(spot)) {
        const y = Y(spot);
        histCx.setLineDash([3, 3]); histCx.strokeStyle = COL.ac; histCx.lineWidth = 1;
        histCx.beginPath(); histCx.moveTo(m.l, y); histCx.lineTo(W - m.r, y); histCx.stroke();
        histCx.setLineDash([]);
        histCx.fillStyle = COL.ac; histCx.fillRect(W - m.r, y - 8, m.r, 16);
        histCx.fillStyle = '#06121f'; histCx.font = 'bold 9px ui-monospace, monospace';
        histCx.fillText(fmtP(spot), W - m.r + 4, y + 3);
    }

    histCx.fillStyle = COL.axis; histCx.font = '10px ui-monospace, monospace';
    const span = mode === 'time'
        ? `${tfMinutes < 1 ? tfMinutes * 60 + 's' : tfMinutes + 'm'} candles`
        : `${ticksPerCandle}-tick candles`;
    histCx.fillText(`${activeSymbol || '—'} · ${span} · showing ${view.length} of ${candles.length}`, m.l + 2, 11);
}

// --- 2. Tick path inside the forming candle --------------------------------

/** Median gap between recent ticks — used to guess how wide a candle will be. */
function estimateTickIntervalMs() {
    const n = TS.length;
    if (n < 5) return 2000;
    const gaps = [];
    for (let i = Math.max(1, n - 60); i < n; i++) gaps.push(TS[i] - TS[i - 1]);
    gaps.sort((a, b) => a - b);
    return Math.max(200, gaps[Math.floor(gaps.length / 2)] || 2000);
}

function drawTickPath() {
    const W = tickCv.clientWidth, H = 340, m = { l: 8, r: 66, t: 16, b: 22 };
    tickCx.clearRect(0, 0, W, H);

    const c = liveCandle();
    if (!c) { emptyMessage(tickCx, W, H, 'Waiting for the first tick of a candle…'); return; }

    let lo = c.l, hi = c.h;
    const pad = (hi - lo) * 0.10 || unit * 3;
    lo -= pad; hi += pad;

    priceGrid(tickCx, W, H, m, lo, hi);

    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const n = c.i1 - c.i0;
    // Reserve room for a whole candle so the path advances left to right as it
    // fills, instead of rescaling the x axis on every single tick.
    const expected = mode === 'ticks'
        ? ticksPerCandle - 1
        : Math.round(tfMs() / estimateTickIntervalMs());
    const span = Math.max(1, n, expected);
    const X = (i) => m.l + ((i - c.i0) / span) * plotW;
    const Y = (p) => m.t + (1 - (p - lo) / (hi - lo)) * plotH;

    // Open, running high, running low
    const guide = (price, color, text) => {
        const y = Y(price);
        tickCx.setLineDash([5, 4]); tickCx.strokeStyle = color; tickCx.lineWidth = 1;
        tickCx.beginPath(); tickCx.moveTo(m.l, y); tickCx.lineTo(W - m.r, y); tickCx.stroke();
        tickCx.setLineDash([]);
        tickCx.fillStyle = color; tickCx.font = '9px ui-monospace, monospace';
        tickCx.fillText(text, W - m.r + 5, y + 3);
    };
    guide(c.o, COL.dash, 'O');
    guide(c.h, COL.up, 'H');
    guide(c.l, COL.dn, 'L');

    // The tick path itself, coloured by where it sits against the open
    const bull = c.c >= c.o;
    tickCx.strokeStyle = bull ? 'rgba(63,185,80,.8)' : 'rgba(248,81,73,.8)';
    tickCx.lineWidth = 1.2;
    tickCx.beginPath();
    for (let i = c.i0; i <= c.i1; i++) {
        const x = X(i), y = Y(MID[i]);
        if (i === c.i0) tickCx.moveTo(x, y); else tickCx.lineTo(x, y);
    }
    tickCx.stroke();

    // Swing structure inside the candle
    const piv = zigzag(c.i0, c.i1);
    if (piv.length > 1) {
        tickCx.strokeStyle = '#388bfd'; tickCx.lineWidth = 1.4;
        tickCx.beginPath();
        piv.forEach((pv, j) => {
            const x = X(pv.i), y = Y(pv.p);
            if (j) tickCx.lineTo(x, y); else tickCx.moveTo(x, y);
        });
        tickCx.stroke();

        tickCx.textAlign = 'center';
        for (const pv of piv) {
            const x = X(pv.i), y = Y(pv.p), isHigh = pv.type === 'H';
            tickCx.fillStyle = isHigh ? COL.up : COL.dn;
            tickCx.beginPath(); tickCx.arc(x, y, 3, 0, Math.PI * 2); tickCx.fill();
            tickCx.font = 'bold 9px ui-monospace, monospace';
            tickCx.fillStyle = pv.label[0] === 'H' ? COL.up : COL.dn;
            tickCx.fillText(pv.label, x, isHigh ? y - 7 : y + 13);
        }
        tickCx.textAlign = 'left';
    }

    // Head of the stream
    tickCx.fillStyle = bull ? COL.up : COL.dn;
    tickCx.beginPath(); tickCx.arc(X(c.i1), Y(c.c), 4, 0, Math.PI * 2); tickCx.fill();

    tickCx.fillStyle = COL.axis; tickCx.font = '10px ui-monospace, monospace';
    tickCx.fillText(`forming candle · opened ${fmtClock(c.start)} · tick ${n + 1}`, m.l + 2, 11);
}

// --- 3. The live candle as one bar -----------------------------------------

function drawLiveCandle() {
    const W = liveCv.clientWidth, H = 340;
    liveCx.clearRect(0, 0, W, H);

    const c = liveCandle();
    if (!c) return;

    const m = { t: 22, b: 30 };
    let lo = c.l, hi = c.h;
    const pad = (hi - lo) * 0.12 || unit * 3;
    lo -= pad; hi += pad;
    const Y = (p) => m.t + (1 - (p - lo) / (hi - lo)) * (H - m.t - m.b);

    liveCx.fillStyle = COL.axis; liveCx.font = '9px ui-monospace, monospace';
    liveCx.textAlign = 'center';
    liveCx.fillText('LIVE CANDLE', W / 2, 13);
    liveCx.textAlign = 'left';

    liveCx.strokeStyle = COL.grid; liveCx.lineWidth = 1;
    for (let k = 0; k <= 5; k++) {
        const y = Y(lo + ((hi - lo) * k) / 5);
        liveCx.beginPath(); liveCx.moveTo(0, y); liveCx.lineTo(W, y); liveCx.stroke();
    }

    // Open reference
    liveCx.setLineDash([3, 3]); liveCx.strokeStyle = COL.dash;
    liveCx.beginPath(); liveCx.moveTo(0, Y(c.o)); liveCx.lineTo(W, Y(c.o)); liveCx.stroke();
    liveCx.setLineDash([]);

    const bull = c.c >= c.o;
    const col = bull ? COL.up : COL.dn;
    const cxMid = W * 0.5, bw = Math.min(46, W * 0.44);

    liveCx.strokeStyle = col; liveCx.lineWidth = 2;
    liveCx.beginPath(); liveCx.moveTo(cxMid, Y(c.h)); liveCx.lineTo(cxMid, Y(c.l)); liveCx.stroke();

    const yo = Y(c.o), yc = Y(c.c);
    const top = Math.min(yo, yc), bh = Math.max(Math.abs(yc - yo), 1.5);
    liveCx.fillStyle = col; liveCx.globalAlpha = 0.8;
    liveCx.fillRect(cxMid - bw / 2, top, bw, bh);
    liveCx.globalAlpha = 1;
    liveCx.lineWidth = 1.4;
    liveCx.strokeRect(cxMid - bw / 2, top, bw, bh);

    // Wick sizes in units, so the shape reads as numbers too
    const upperWick = (c.h - Math.max(c.o, c.c)) / unit;
    const lowerWick = (Math.min(c.o, c.c) - c.l) / unit;
    liveCx.font = '9px ui-monospace, monospace';
    liveCx.textAlign = 'center';
    liveCx.fillStyle = COL.axis;
    liveCx.fillText(`${upperWick.toFixed(1)}u`, cxMid, Y(c.h) - 5);
    liveCx.fillText(`${lowerWick.toFixed(1)}u`, cxMid, Y(c.l) + 12);
    liveCx.fillStyle = col;
    liveCx.fillText(bull ? 'BULL' : 'BEAR', W / 2, H - 8);
    liveCx.textAlign = 'left';
}

// --- HUD -------------------------------------------------------------------

function drawHud() {
    const c = liveCandle();
    if (!c) return;

    stats.open.textContent = fmtP(c.o);
    stats.high.textContent = fmtP(c.h);
    stats.low.textContent = fmtP(c.l);

    const bodyU = (c.c - c.o) / unit;
    stats.body.textContent = `${bodyU >= 0 ? '+' : ''}${bodyU.toFixed(1)}u`;
    stats.body.className = `v ${bodyU >= 0 ? 'up' : 'dn'}`;
    stats.range.textContent = ((c.h - c.l) / unit).toFixed(1);

    const n = c.i1 - c.i0 + 1;
    stats.tick.textContent = mode === 'ticks' ? `${n}/${ticksPerCandle}` : String(n);

    if (mode === 'time') {
        const msLeft = c.start + tfMs() - Date.now();
        if (msLeft <= 0) {
            // The bucket is over but no tick has arrived yet to open the next one.
            stats.left.textContent = 'closing…';
        } else {
            const s = Math.floor(msLeft / 1000);
            stats.left.textContent = s >= 60
                ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
                : `${s}s`;
        }
    } else {
        stats.left.textContent = `${Math.max(0, ticksPerCandle - n)} ticks`;
    }
}

// --- Render loop -----------------------------------------------------------

let dirty = true;
let lastFrame = 0;

function frame(now) {
    requestAnimationFrame(frame);
    if (frozen) return;
    // The countdown needs a beat of its own, so redraw at least 4x a second.
    if (!dirty && now - lastFrame < 250) return;
    lastFrame = now;
    dirty = false;
    drawHistory();
    drawTickPath();
    drawLiveCandle();
    drawHud();
}

// --- Controls --------------------------------------------------------------

assetSelect.addEventListener('change', () => { if (socket?.isOpen) subscribeToTicks(); });

clearBtn.addEventListener('click', resetSeries);

modeSelect.addEventListener('change', (e) => {
    mode = e.target.value;
    tfWrap.hidden = mode !== 'time';
    tpcWrap.hidden = mode !== 'ticks';
    rebuildCandles();
});

tfSelect.addEventListener('change', (e) => {
    tfMinutes = parseFloat(e.target.value);
    rebuildCandles();
});

tpcInput.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    ticksPerCandle = Number.isFinite(v) ? Math.min(500, Math.max(2, v)) : 20;
    e.target.value = ticksPerCandle;
    rebuildCandles();
});

histSlider.addEventListener('input', (e) => {
    histCount = parseInt(e.target.value, 10);
    histVal.textContent = histCount;
    dirty = true;
});

thSlider.addEventListener('input', (e) => {
    theta = parseFloat(e.target.value);
    thVal.textContent = `${theta.toFixed(1)} u`;
    dirty = true;
});

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
        rows.push(`${date}\t${time}\t${BID[i]}\t${ASK[i]}`);
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
