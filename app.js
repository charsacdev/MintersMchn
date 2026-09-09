// Deriv Digit bot — rewritten for the current Deriv API (api.derivws.com).
//
// Two modes:
//   Preview  — no token. Live ticks + live pricing from the public gateway.
//   Trading  — paste an `ory_at_...` OAuth token. Adds balance, buy and settlement.
//
// The old v3 endpoint this app used (ws.derivws.com/websockets/v3) no longer
// serves these symbols, which is why nothing was streaming.

let socket = null;
let isBotActive = false;
let isTradeInFlight = false;
let stopTicks = null;      // unsubscribe fn for the tick stream
let openContracts = new Map(); // contract_id -> unsubscribe fn
let settledContracts = new Set();

let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let totalProfitLoss = 0.0;

const el = (id) => document.getElementById(id);

const connectBtn = el('connect-btn');
const previewBtn = el('preview-btn');
const tokenInput = el('token-input');
const appIdInput = el('appid-input');
const accountSelect = el('account-select');
const connectionStatus = el('connection-status');
const balanceDisplay = el('balance-display');
const assetSelect = el('asset-select');
const contractSelect = el('contract-select');
const stakeInput = el('stake-input');
const ticksInput = el('ticks-input');
const startBtn = el('start-btn');
const stopBtn = el('stop-btn');
const lastTickDisplay = el('last-tick');
const noticeBar = el('notice-bar');

const statTotal = el('stat-total');
const statWins = el('stat-wins');
const statLosses = el('stat-losses');
const statProfit = el('stat-profit');
const historyRows = el('history-rows');

function notify(message, kind = 'info') {
    noticeBar.textContent = message;
    noticeBar.className = `notice ${kind}`;
    noticeBar.hidden = !message;
    if (kind === 'error') console.error(message);
}

// --- Connection ------------------------------------------------------------

previewBtn.addEventListener('click', () => startSession({ token: null }));

// The app id is public and tedious to retype; the token is a secret and is not stored.
appIdInput.value = DerivAPI.getAppId();
appIdInput.addEventListener('change', () => DerivAPI.setAppId(appIdInput.value));

connectBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) {
        notify('Paste a Personal Access Token, or use "Preview without token" for market data only.', 'error');
        return;
    }
    if (!appIdInput.value.trim()) {
        notify('An App ID is required alongside the token — register one at home.deriv.com/dashboard/create', 'error');
        return;
    }
    DerivAPI.setAppId(appIdInput.value);
    startSession({ token, accountType: accountSelect.value });
});

async function startSession({ token, accountType = 'demo' }) {
    setConnectingUI(true);
    notify('Connecting…');

    try {
        if (socket) socket.close();

        socket = token
            ? await DerivAPI.connectAuthed(token, { accountType })
            : await DerivAPI.connectPublic();

        socket.onClose = (event, closedByUs) => {
            if (closedByUs) return;
            haltBot();
            resetUIOnDisconnect();
            notify(`Disconnected (code ${event.code}). Reconnect to continue.`, 'error');
        };

        await populateSymbols();

        if (socket.mode === 'authed') {
            await enterTradingMode();
        } else {
            enterPreviewMode();
        }

        beginTickStream();
    } catch (error) {
        notify(error.message, 'error');
        resetUIOnDisconnect();
    } finally {
        setConnectingUI(false);
    }
}

async function enterTradingMode() {
    const { accountType, accountId, currency } = socket.meta;
    const isReal = accountType === 'real';

    if (isReal) {
        const proceed = confirm(
            `⚠️ REAL MONEY ACCOUNT (${accountId})\n\n` +
            'Every trade this bot places will use real funds. Continue?',
        );
        if (!proceed) throw new Error('Cancelled — switch the account selector to Demo.');
    }

    connectionStatus.textContent = isReal ? `REAL — ${accountId} ⚠️` : `DEMO — ${accountId}`;
    connectionStatus.className = `status-badge ${isReal ? 'disconnected' : 'connected'}`;

    // Live balance. The first message carries the current value.
    socket.subscribe({ balance: 1 }, (msg, error) => {
        if (error || !msg?.balance) return;
        balanceDisplay.innerHTML =
            `Balance: <strong>${Number(msg.balance.balance).toFixed(2)} ${msg.balance.currency}</strong>`;
    });

    startBtn.disabled = false;
    connectBtn.textContent = 'Linked ✔';
    notify(`Connected to ${accountType} account ${accountId} (${currency}).`, 'ok');
}

function enterPreviewMode() {
    connectionStatus.textContent = 'Preview (no account)';
    connectionStatus.className = 'status-badge preview';
    balanceDisplay.innerHTML = 'Balance: <strong>—</strong>';
    startBtn.disabled = true;
    notify('Preview mode: live prices only. Paste a token to enable trading.', 'info');
}

/** Replace the hardcoded dropdown with whatever is actually tradable right now. */
async function populateSymbols() {
    const previous = assetSelect.value;
    const response = await socket.send({ active_symbols: 'brief' });
    const symbols = (response.active_symbols || [])
        .filter((s) => s.market === 'synthetic_index' && s.exchange_is_open === 1 && !s.is_trading_suspended)
        .sort((a, b) => a.underlying_symbol_name.localeCompare(b.underlying_symbol_name));

    if (!symbols.length) return; // keep the static list rather than emptying the UI

    assetSelect.innerHTML = '';
    for (const s of symbols) {
        const option = document.createElement('option');
        option.value = s.underlying_symbol;
        option.textContent = s.underlying_symbol_name;
        assetSelect.appendChild(option);
    }
    if (symbols.some((s) => s.underlying_symbol === previous)) assetSelect.value = previous;
}

// --- Market data -----------------------------------------------------------

function beginTickStream() {
    if (stopTicks) stopTicks();
    lastTickDisplay.textContent = '—';

    stopTicks = socket.subscribe({ ticks: assetSelect.value }, (msg, error) => {
        if (error) {
            notify(`Tick stream error: ${error.message}`, 'error');
            haltBot();
            return;
        }
        if (!msg?.tick) return;

        const quote = msg.tick.quote;
        const lastDigit = String(quote).replace('.', '').slice(-1);
        lastTickDisplay.innerHTML = `${quote} <span class="digit">${lastDigit}</span>`;

        if (isBotActive && !isTradeInFlight) runTradeCycle();
    });
}

assetSelect.addEventListener('change', () => {
    if (!socket?.isOpen) return;
    if (isBotActive) {
        notify('Stop the bot before switching asset.', 'error');
        return;
    }
    beginTickStream();
});

// --- Trade cycle -----------------------------------------------------------

async function runTradeCycle() {
    isTradeInFlight = true;
    try {
        const stake = Number(stakeInput.value);
        const duration = parseInt(ticksInput.value, 10);
        if (!(stake > 0)) throw new Error('Stake must be greater than zero.');
        if (!(duration >= 1 && duration <= 10)) throw new Error('Duration must be 1–10 ticks.');

        const { proposal } = await socket.send({
            proposal: 1,
            amount: stake,
            basis: 'stake',
            currency: socket.meta.currency || 'USD',
            contract_type: contractSelect.value,
            underlying_symbol: assetSelect.value,
            duration,
            duration_unit: 't',
        });

        if (!isBotActive) return; // stopped while the quote was in flight

        // Pay at most the quoted ask; the server rejects anything cheaper.
        const { buy } = await socket.send({ buy: proposal.id, price: proposal.ask_price });

        monitorContract(buy.contract_id);
    } catch (error) {
        notify(`Trade failed: ${error.message}`, 'error');
        // A failed buy never opens a contract, so release the lock here.
        isTradeInFlight = false;
        if (error.code === 'InsufficientBalance' || error.code === 'InvalidToken') haltBot();
    }
}

/** Watch one contract until it settles, then book the result. */
function monitorContract(contractId) {
    const stop = socket.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (msg, error) => {
        if (error) {
            notify(`Contract ${contractId}: ${error.message}`, 'error');
            releaseContract(contractId);
            return;
        }
        const contract = msg?.proposal_open_contract;
        if (!contract) return;

        const isSettled = contract.is_sold === 1 || contract.is_expired === 1
            || ['won', 'lost', 'sold', 'cancelled'].includes(contract.status);
        if (isSettled) bookResult(contract);
    });

    openContracts.set(contractId, stop);
}

function releaseContract(contractId) {
    const stop = openContracts.get(contractId);
    if (stop) stop();
    openContracts.delete(contractId);
    isTradeInFlight = false;
}

function bookResult(contract) {
    const contractId = contract.contract_id;
    if (settledContracts.has(contractId)) return; // the stream can repeat the final frame
    settledContracts.add(contractId);

    const profit = Number(contract.profit);
    const won = profit > 0;

    totalTrades++;
    if (won) totalWins++; else totalLosses++;
    totalProfitLoss += profit;

    statTotal.textContent = totalTrades;
    statWins.textContent = totalWins;
    statLosses.textContent = totalLosses;
    statProfit.textContent = totalProfitLoss.toFixed(2);
    statProfit.className = `stat-value ${totalProfitLoss >= 0 ? 'win-text' : 'loss-text'}`;

    const row = document.createElement('tr');
    row.className = won ? 'row-win' : 'row-loss';
    row.innerHTML = `
        <td>${contractId}</td>
        <td>${contract.contract_type || contractSelect.value}</td>
        <td class="${won ? 'win-text' : 'loss-text'}">${(contract.status || '').toUpperCase()}</td>
        <td class="${profit >= 0 ? 'win-text' : 'loss-text'}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)}</td>
    `;
    historyRows.insertBefore(row, historyRows.firstChild);

    releaseContract(contractId);
}

// --- Bot controls ----------------------------------------------------------

startBtn.addEventListener('click', () => {
    if (socket?.mode !== 'authed') {
        notify('Trading needs a token. Preview mode cannot place orders.', 'error');
        return;
    }
    isBotActive = true;
    isTradeInFlight = false;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setConfigDisabled(true);
    notify('Bot running — a trade opens on each tick once the previous one settles.', 'ok');
});

stopBtn.addEventListener('click', () => {
    haltBot();
    notify('Bot stopped. Open contracts will still settle on their own.', 'info');
});

function haltBot() {
    isBotActive = false;
    startBtn.disabled = socket?.mode !== 'authed';
    stopBtn.disabled = true;
    setConfigDisabled(false);
}

function setConfigDisabled(disabled) {
    assetSelect.disabled = disabled;
    contractSelect.disabled = disabled;
    stakeInput.disabled = disabled;
    ticksInput.disabled = disabled;
}

function setConnectingUI(busy) {
    connectBtn.disabled = busy;
    previewBtn.disabled = busy;
    if (busy) connectBtn.textContent = 'Connecting…';
    else if (connectBtn.textContent === 'Connecting…') connectBtn.textContent = 'Connect';
}

function resetUIOnDisconnect() {
    isBotActive = false;
    isTradeInFlight = false;
    stopTicks = null;
    openContracts.clear();
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'status-badge disconnected';
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setConfigDisabled(false);
}
