// Live tick plotter — rewritten for the current Deriv API (api.derivws.com).
//
// This chart only consumes market data, and market data on the current API is
// public. So there is no token, no account and no OAuth here: it connects to
// the public gateway and streams immediately.

let socket = null;
let stopTicks = null;
let tickCount = 0;
let activeSymbol = '';
let pipSize = 0.01;
let tfMinutes = 15;
let theta = 3.0;      // swing threshold = theta * rolling spread
let visibleWindow = 700;
let showBidAsk = true;

// Continuous raw tick series
let TS = [];
let BID = [];
let ASK = [];
let MID = [];
let timeframes = [];
let pivots = [];

const el = (id) => document.getElementById(id);

const connectBtn = el('connect-btn');
const assetSelect = el('asset-select');
const tfSelect = el('tf-select');
const thSlider = el('th-slider');
const thVal = el('th-val');
const winSlider = el('win-slider');
const winVal = el('win-val');
const baToggle = el('ba');
const clearBtn = el('clear-btn');
const connectionStatus = el('connection-status');
const noticeBar = el('notice-bar');

const statSpot = el('stat-spot');
const statAsk = el('stat-ask');
const statBid = el('stat-bid');
const statSpread = el('stat-spread');
const statTicks = el('stat-ticks');
const statLastPivot = el('stat-last-pivot');

const canvas = el('chart-canvas');
const ctx = canvas.getContext('2d');
const margins = { left: 8, right: 80, top: 20, bottom: 25 };

function notify(message, kind = 'info') {
    noticeBar.textContent = message;
    noticeBar.className = `notice ${kind}`;
    noticeBar.hidden = !message;
    if (kind === 'error') console.error(message);
}

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = 450 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
}
window.addEventListener('resize', resizeCanvas);

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
        subscribeToTicks();

        connectionStatus.textContent = 'Streaming (public)';
        connectionStatus.className = 'status-badge connected';
        connectBtn.textContent = 'Streaming ✔';
        notify('');
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
        .sort((a, b) => a.underlying_symbol_name.localeCompare(b.underlying_symbol_name));

    if (!symbols.length) return;

    assetSelect.innerHTML = '';
    for (const s of symbols) {
        const option = document.createElement('option');
        option.value = s.underlying_symbol;
        option.textContent = s.underlying_symbol_name;
        option.dataset.pipSize = s.pip_size;
        assetSelect.appendChild(option);
    }
    if (symbols.some((s) => s.underlying_symbol === previous)) assetSelect.value = previous;
}

function subscribeToTicks() {
    if (stopTicks) stopTicks();

    activeSymbol = assetSelect.value;
    pipSize = Number(assetSelect.selectedOptions[0]?.dataset.pipSize) || 0.01;
    resetSeries();

    stopTicks = socket.subscribe({ ticks: activeSymbol }, (msg, error) => {
        if (error) {
            notify(`Tick stream error: ${error.message}`, 'error');
            return;
        }
        if (msg?.tick) processIncomingTick(msg.tick);
    });
}

// --- Tick ingestion --------------------------------------------------------

function processIncomingTick(tick) {
    const timeMs = Number(tick.epoch) * 1000;
    const spot = Number(tick.quote);
    // Some synthetics quote without a bid/ask book; fall back to the spot.
    const ask = Number.isFinite(Number(tick.ask)) ? Number(tick.ask) : spot;
    const bid = Number.isFinite(Number(tick.bid)) ? Number(tick.bid) : spot;
    const spread = ask - bid;

    tickCount++;
    const decimals = Math.max(2, String(pipSize).split('.')[1]?.length || 2);
    statSpot.textContent = spot.toFixed(decimals);
    statAsk.textContent = ask.toFixed(decimals);
    statBid.textContent = bid.toFixed(decimals);
    statSpread.textContent = spread.toFixed(decimals);
    statTicks.textContent = tickCount;

    TS.push(timeMs);
    BID.push(bid);
    ASK.push(ask);
    MID.push(spot);

    // Record where each timeframe block starts so we can draw separators.
    const tfMs = tfMinutes * 60 * 1000;
    if (TS.length > 1) {
        const currentBlock = Math.floor(timeMs / tfMs);
        const previousBlock = Math.floor(TS[TS.length - 2] / tfMs);
        if (currentBlock !== previousBlock) timeframes.push(TS.length - 1);
    }

    const maxMemory = 5000;
    if (TS.length > maxMemory) {
        TS.shift(); BID.shift(); ASK.shift(); MID.shift();
        timeframes = timeframes.map((i) => i - 1).filter((i) => i >= 0);
    }

    calculateZigZag();
    drawChart();
}

function resetSeries() {
    TS = []; BID = []; ASK = []; MID = [];
    timeframes = [];
    pivots = [];
    tickCount = 0;
    statTicks.textContent = '0';
    statLastPivot.textContent = '—';
    drawChart();
}

// --- ZigZag swing engine ---------------------------------------------------

function calculateZigZag() {
    const n = MID.length;
    if (n < 2) return;

    pivots = [];
    let dir = null;
    let ep = MID[0];
    let ei = 0;

    for (let i = 1; i < n; i++) {
        // A zero spread would collapse the threshold, so floor it at one pip.
        const spread = Math.max(ASK[i] - BID[i], pipSize);
        const th = theta * spread;

        if (dir === null) {
            if (MID[i] >= MID[0] + th) { dir = 'up'; ep = MID[i]; ei = i; }
            else if (MID[i] <= MID[0] - th) { dir = 'dn'; ep = MID[i]; ei = i; }
        } else if (dir === 'up') {
            if (MID[i] > ep) { ep = MID[i]; ei = i; }
            else if (MID[i] <= ep - th) {
                pivots.push({ price: ep, type: 'H', timeIndex: ei });
                dir = 'dn'; ep = MID[i]; ei = i;
            }
        } else {
            if (MID[i] < ep) { ep = MID[i]; ei = i; }
            else if (MID[i] >= ep + th) {
                pivots.push({ price: ep, type: 'L', timeIndex: ei });
                dir = 'up'; ep = MID[i]; ei = i;
            }
        }
    }

    // HH / LH / LL / HL labels, comparing each pivot to the previous of its kind.
    let lastHigh = null;
    let lastLow = null;
    for (const pivot of pivots) {
        if (pivot.type === 'H') {
            pivot.label = lastHigh === null ? 'H' : (pivot.price > lastHigh ? 'HH' : 'LH');
            lastHigh = pivot.price;
        } else {
            pivot.label = lastLow === null ? 'L' : (pivot.price < lastLow ? 'LL' : 'HL');
            lastLow = pivot.price;
        }
    }

    if (pivots.length) {
        const last = pivots[pivots.length - 1];
        statLastPivot.textContent = `${last.label} @ ${last.price.toFixed(4)}`;
    }
}

// --- Canvas rendering ------------------------------------------------------

function drawChart() {
    const W = canvas.clientWidth;
    const H = 450;

    ctx.fillStyle = '#161b22';
    ctx.fillRect(0, 0, W, H);

    if (MID.length === 0) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px sans-serif';
        ctx.fillText('Awaiting incoming WebSocket stream data…', 20, H / 2);
        return;
    }

    const b = MID.length - 1;
    const a = Math.max(0, b - visibleWindow + 1);

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i <= b; i++) {
        const high = showBidAsk ? ASK[i] : MID[i];
        const low = showBidAsk ? BID[i] : MID[i];
        if (low < lo) lo = low;
        if (high > hi) hi = high;
    }
    if (lo === hi) { lo -= pipSize * 10; hi += pipSize * 10; }

    const pad = (hi - lo) * 0.1 || pipSize * 10;
    lo -= pad;
    hi += pad;

    const plotW = W - margins.left - margins.right;
    const plotH = H - margins.top - margins.bottom;
    const span = Math.max(1, b - a);
    const getX = (idx) => margins.left + ((idx - a) / span) * plotW;
    const getY = (price) => margins.top + (1 - (price - lo) / (hi - lo)) * plotH;

    // Price grid
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px ui-monospace, monospace';
    for (let k = 0; k <= 5; k++) {
        const price = lo + ((hi - lo) * k) / 5;
        const y = getY(price);
        ctx.beginPath();
        ctx.moveTo(margins.left, y);
        ctx.lineTo(W - margins.right, y);
        ctx.stroke();
        ctx.fillText(price.toFixed(4), W - margins.right + 6, y + 3);
    }

    // Timeframe separators
    ctx.strokeStyle = '#2d333b';
    ctx.setLineDash([2, 4]);
    for (const tfIdx of timeframes) {
        if (tfIdx < a || tfIdx > b) continue;
        const x = getX(tfIdx);
        ctx.beginPath();
        ctx.moveTo(x, margins.top);
        ctx.lineTo(x, H - margins.bottom);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // Bid/ask envelope
    if (showBidAsk) {
        ctx.beginPath();
        for (let i = a; i <= b; i++) {
            const x = getX(i);
            if (i === a) ctx.moveTo(x, getY(ASK[i])); else ctx.lineTo(x, getY(ASK[i]));
        }
        for (let i = b; i >= a; i--) ctx.lineTo(getX(i), getY(BID[i]));
        ctx.closePath();
        ctx.fillStyle = 'rgba(88, 166, 255, 0.10)';
        ctx.fill();
    }

    // Spot line
    ctx.strokeStyle = '#7d8590';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = a; i <= b; i++) {
        const x = getX(i);
        const y = getY(MID[i]);
        if (i === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ZigZag path + structure labels
    const visible = pivots.filter((p) => p.timeIndex >= a && p.timeIndex <= b);
    if (visible.length) {
        ctx.strokeStyle = '#388bfd';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        visible.forEach((pv, j) => {
            const x = getX(pv.timeIndex);
            const y = getY(pv.price);
            if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();

        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        for (const pv of visible) {
            const x = getX(pv.timeIndex);
            const y = getY(pv.price);
            const isHigh = pv.type === 'H';
            ctx.fillStyle = isHigh ? '#3fb950' : '#f85149';
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillText(pv.label, x, isHigh ? y - 8 : y + 14);
        }
        ctx.textAlign = 'left';
    }

    // Current spot tracker
    const spot = MID[b];
    const ySpot = getY(spot);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margins.left, ySpot);
    ctx.lineTo(W - margins.right, ySpot);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#58a6ff';
    ctx.fillRect(W - margins.right, ySpot - 8, margins.right, 16);
    ctx.fillStyle = '#06121f';
    ctx.font = 'bold 9px ui-monospace, monospace';
    ctx.fillText(spot.toFixed(4), W - margins.right + 4, ySpot + 3);

    ctx.fillStyle = '#58a6ff';
    ctx.beginPath();
    ctx.arc(getX(b), ySpot, 4, 0, 2 * Math.PI);
    ctx.fill();
}

// --- Controls --------------------------------------------------------------

assetSelect.addEventListener('change', () => {
    if (socket?.isOpen) subscribeToTicks();
});

clearBtn.addEventListener('click', resetSeries);

tfSelect.addEventListener('change', (e) => {
    tfMinutes = parseInt(e.target.value, 10);
    timeframes = [];
    drawChart();
});

thSlider.addEventListener('input', (e) => {
    theta = parseFloat(e.target.value);
    thVal.textContent = `${theta.toFixed(1)} spr`;
    calculateZigZag();
    drawChart();
});

winSlider.addEventListener('input', (e) => {
    visibleWindow = parseInt(e.target.value, 10);
    winVal.textContent = visibleWindow;
    drawChart();
});

baToggle.addEventListener('change', (e) => {
    showBidAsk = e.target.checked;
    drawChart();
});

resizeCanvas();
connect(); // market data is public — start streaming without waiting for a click
