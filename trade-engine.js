// Shared trading engine for the single-family bot apps.
//
// Rise/Fall and Higher/Lower are the same contract with the barrier in a
// different place — `HIGHER` at barrier "+0" prices identically to `CALL`. So
// the chart, swing engine, contract tracking and auto-trade logic are shared
// here, and each app supplies only what actually differs.
//
//   RiseFall/app.js       CALL / PUT          settles vs the ENTRY SPOT.   1–10 ticks.
//   HigherLower/app.js    HIGHER / LOWER      settles vs a BARRIER you set. 5–10 ticks.
//   TouchNoTouch/app.js   ONETOUCH / NOTOUCH  same barrier for both legs, judged
//                                             CONTINUOUSLY rather than at expiry.
//
// Two settlement models, selected by `pathDependent`:
//
//   expiry  (default)  Only the final tick matters. One reference level splits
//                      the chart into a winning half and a losing half.
//   path               The contract is judged at every moment. What matters is
//                      the CLOSEST APPROACH to the barrier and whether it was
//                      ever reached — so the engine tracks a monotonic extreme
//                      and shades only the strip beyond the barrier.
//
// Confirmed against the live gateway on R_100:
//   - `barrier` must be a signed STRING offset ("+0.5"). A number is rejected
//     with "Invalid barrier"; omitting it gives "Single barrier input is
//     expected".
//   - HIGHER/LOWER below 5 ticks: "Number of ticks must be between 5 and 10."
//     Rise/Fall accepts 1. Touch/No Touch is 5–10.
//   - Intraday floors differ: 15s for Rise/Fall and Higher/Lower, but 120s for
//     Touch/No Touch (119s is rejected, 120s quotes).
//   - The proposal response does NOT echo the barrier back, so the projected
//     barrier drawn before a trade is computed locally from spot + offset. Once
//     bought, `proposal_open_contract.barrier` is authoritative.
//   - Either leg can be priced out on its own ("This contract offers no
//     return") while the other still quotes, so legs are quoted and gated
//     independently.
//
// Usage, at the bottom of each app's own app.js:
//
//   TradeEngine.start({
//       up: 'CALL', down: 'PUT', upLabel: 'RISE', downLabel: 'FALL',
//       needsBarrier: false, minTicks: 1, maxTicks: 10,
//   });

(function (global) {
    'use strict';

    const DEFAULT_MIN_INTRADAY_SECONDS = 15; // contracts_for: intraday min is 15s
    const MAX_INTRADAY_SECONDS = 86400;      // ...and max is 1d
    const QUOTE_POLL_MS = 2500;
    const MAX_TICKS_IN_MEMORY = 5000;
    const CANVAS_HEIGHT = 460;
    const EXPENSIVE_EDGE_PCT = 4.0; // above this the edge chip turns gold

    // --- Resilience --------------------------------------------------------
    // A bot left running online will lose its socket eventually: wifi drops, the
    // laptop sleeps, Deriv cycles a gateway. None of that should end the session.
    const RECONNECT_BASE_MS = 1000;
    const RECONNECT_MAX_MS = 30000;   // ceiling on the backoff
    // R_100 ticks every 2s. A socket that has sent nothing for this long is a
    // zombie — still "open" to the browser, but dead. onclose never fires for
    // these, so silence is the only symptom and it has to be watched for.
    const TICK_STALL_MS = 60000;

    let CFG = null; // the family config supplied by the host app

    // --- Session state -----------------------------------------------------
    let socket = null;
    let stopTicks = null;
    let quoteTimer = null;
    let quoteInFlight = false;

    let isBotArmed = false;
    let isTradeInFlight = false;
    let liveContract = null;
    let stopContractStream = null;
    const settledContracts = new Set();

    // Reconnection state. `sessionCreds` is what makes an unattended restart
    // possible at all — without the token held in memory there is nothing to
    // reconnect WITH.
    let sessionCreds = null;
    let autoReconnect = true;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let reconnecting = false;
    let realAccountConfirmed = false;
    let lastTickAt = 0;
    let watchdogTimer = null;
    // contract_id -> handler. Replayed onto every new socket so a contract
    // opened before a drop still reports its settlement afterwards.
    const contractWatches = new Map();

    let ticksSinceTrade = Infinity;
    let lastSignalPivotTime = null;

    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalTouched = 0; // path-dependent only: contracts where the barrier was reached
    let netProfit = 0;

    // Which legs the server will actually price right now. A barrier far enough
    // out prices ONETOUCH happily while NOTOUCH comes back "This contract offers
    // no return" — and the same happens to HIGHER/LOWER at 5 ticks. The dead leg
    // is disabled rather than left to fail at buy time.
    const quotable = { up: false, down: false };

    // --- Market state ------------------------------------------------------
    let activeSymbol = '';
    let pipSize = 0.01;
    // Last balance the gateway reported. Percentage-of-balance staking reads
    // this, so it must come from the account rather than from a local tally.
    let accountBalance = null;
    let tickCount = 0;

    // Bridge listeners. A page can bolt on a second bot (RiseFall/hedge-cycle.js
    // runs a two-leg cycle alongside the single-leg swing bot) and it needs the
    // same socket, symbol and tick feed rather than a competing connection.
    const tickListeners = [];
    const sessionListeners = [];

    function emit(listeners, ...args) {
        for (const fn of listeners) {
            // One bad listener must not kill the tick loop for the chart.
            try { fn(...args); } catch (error) { console.error('TradeEngine listener failed:', error); }
        }
    }

    let TS = [];
    let BID = [];
    let ASK = [];
    let MID = [];
    let timeframeBreaks = [];
    let pivots = [];

    let tfMinutes = 15;
    let theta = 3.0;
    let visibleWindow = 700;
    let showBidAsk = true;
    let showSwings = true;

    // --- DOM ---------------------------------------------------------------
    // Barrier controls are absent from the Rise/Fall page and the path-tracking
    // cells are absent from both expiry-judged pages, so every lookup is
    // optional and every use is guarded.
    const el = (id) => document.getElementById(id);

    let appIdInput, tokenInput, accountSelect, connectBtn, previewBtn,
        connectionStatus, balanceDisplay, noticeBar,
        assetSelect, durationInput, unitSelect, stakeInput, currencyLabel, durationNote,
        barrierRow, barrierInput, barrierSide, barrierPreview,
        quoteUp, quoteDn, quoteNote, edgeBadge, buyUpBtn, buyDnBtn, buyUpLabel, buyDnLabel,
        signalSelect, instrumentSelect, instrumentNote,
        cooldownInput, slInput, tpInput, startBtn, stopBtn, signalStatus,
        tfSelect, thSlider, thVal, winSlider, winVal, baToggle, swingToggle, clearBtn,
        statSpot, statAsk, statBid, statSpread, statTicks, statLastPivot, statBias,
        openPanel, ocType, ocEntry, ocBarrier, ocCurrent, ocRemaining, ocPl, ocVerdict,
        ocClosest, ocGap, ocProgressFill,
        statTotal, statWins, statLosses, statRate, statTouched, statProfit, historyRows,
        canvas, ctx;

    const margins = { left: 8, right: 84, top: 20, bottom: 25 };

    function cacheDom() {
        appIdInput = el('appid-input'); tokenInput = el('token-input');
        accountSelect = el('account-select'); connectBtn = el('connect-btn');
        previewBtn = el('preview-btn'); connectionStatus = el('connection-status');
        balanceDisplay = el('balance-display'); noticeBar = el('notice-bar');

        assetSelect = el('asset-select'); durationInput = el('duration-input');
        unitSelect = el('unit-select'); stakeInput = el('stake-input');
        currencyLabel = el('currency-label'); durationNote = el('duration-note');

        barrierRow = el('barrier-row'); barrierInput = el('barrier-input');
        barrierSide = el('barrier-side'); barrierPreview = el('barrier-preview');

        quoteUp = el('quote-up'); quoteDn = el('quote-dn'); quoteNote = el('quote-note');
        edgeBadge = el('edge-badge');
        buyUpBtn = el('buy-up-btn'); buyDnBtn = el('buy-dn-btn');
        buyUpLabel = el('buy-up-label'); buyDnLabel = el('buy-dn-label');

        signalSelect = el('signal-select'); cooldownInput = el('cooldown-input');
        instrumentSelect = el('instrument-select'); instrumentNote = el('instrument-note');
        slInput = el('sl-input'); tpInput = el('tp-input');
        startBtn = el('start-btn'); stopBtn = el('stop-btn'); signalStatus = el('signal-status');

        tfSelect = el('tf-select'); thSlider = el('th-slider'); thVal = el('th-val');
        winSlider = el('win-slider'); winVal = el('win-val');
        baToggle = el('ba'); swingToggle = el('show-swings'); clearBtn = el('clear-btn');

        statSpot = el('stat-spot'); statAsk = el('stat-ask'); statBid = el('stat-bid');
        statSpread = el('stat-spread'); statTicks = el('stat-ticks');
        statLastPivot = el('stat-last-pivot'); statBias = el('stat-bias');

        openPanel = el('open-panel'); ocType = el('oc-type'); ocEntry = el('oc-entry');
        ocBarrier = el('oc-barrier'); ocCurrent = el('oc-current');
        ocRemaining = el('oc-remaining'); ocPl = el('oc-pl'); ocVerdict = el('oc-verdict');
        ocClosest = el('oc-closest'); ocGap = el('oc-gap');
        ocProgressFill = el('oc-progress-fill');

        statTotal = el('stat-total'); statWins = el('stat-wins');
        statLosses = el('stat-losses'); statRate = el('stat-rate');
        statTouched = el('stat-touched');
        statProfit = el('stat-profit'); historyRows = el('history-rows');

        canvas = el('chart-canvas');
        ctx = canvas.getContext('2d');
    }

    // --- Helpers -----------------------------------------------------------

    function notify(message, kind = 'info') {
        noticeBar.textContent = message;
        noticeBar.className = `notice ${kind}`;
        noticeBar.hidden = !message;
        if (kind === 'error') console.error(message);
    }

    function decimals() {
        return Math.max(2, String(pipSize).split('.')[1]?.length || 2);
    }

    const fmt = (price) => (Number.isFinite(Number(price)) ? Number(price).toFixed(decimals()) : '—');

    function currency() {
        return socket?.meta?.currency || 'USD';
    }

    /** Index of the first tick at or after `timeMs`, or -1. TS is sorted. */
    function indexAtTime(timeMs) {
        let lo = 0;
        let hi = TS.length - 1;
        let found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (TS[mid] >= timeMs) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
        }
        return found;
    }

    // =======================================================================
    // Connection
    // =======================================================================

    async function startSession({ token, accountType = 'demo' }, { isReconnect = false } = {}) {
        setBusy(true);
        notify(isReconnect ? 'Reconnecting…' : 'Connecting…');

        // Held so an unattended reconnect has something to reconnect WITH. A
        // fresh manual connect resets the consent and the backoff.
        if (!isReconnect) {
            sessionCreds = { token, accountType };
            realAccountConfirmed = false;
            reconnectAttempt = 0;
            autoReconnect = true;
        }

        try {
            if (socket) socket.close();

            socket = token
                ? await DerivAPI.connectAuthed(token, { accountType })
                : await DerivAPI.connectPublic();

            socket.onClose = (event, closedByUs) => {
                if (closedByUs) return;
                stopWatchdog();
                clearInterval(quoteTimer);
                emit(sessionListeners, { mode: 'disconnected', state: 'down', symbol: activeSymbol });
                scheduleReconnect(`Socket closed (code ${event.code})`);
            };

            await populateSymbols();

            if (socket.mode === 'authed') await enterTradingMode();
            else enterPreviewMode();

            beginTickStream();
            startQuotePolling();
            startWatchdog();

            // Contracts bought before the drop are still live on Deriv's side.
            // Re-attaching their streams is what lets an interrupted cycle finish
            // and book, instead of stranding the bot waiting for a settlement
            // that can no longer arrive.
            const replayed = replayContractWatches();

            reconnectAttempt = 0;
            reconnecting = false;
            if (isReconnect) {
                notify(
                    `Reconnected to ${socket.mode === 'authed' ? socket.meta.accountId : 'the public feed'}.` +
                    (replayed ? ` Re-attached ${replayed} open contract stream(s).` : ''),
                    'ok',
                );
            }
            emit(sessionListeners, {
                mode: socket.mode, meta: socket.meta, symbol: activeSymbol, state: 'connected',
            });
        } catch (error) {
            notify(error.message, 'error');
            // A failed RECONNECT must keep trying; a failed first connect is the
            // user's to retry, since the credentials themselves may be wrong.
            if (isReconnect) scheduleReconnect(error.message);
            else resetUIOnDisconnect();
        } finally {
            setBusy(false);
        }
    }

    // =======================================================================
    // Reconnection
    // =======================================================================

    /** Exponential backoff, capped, with the attempt count shown in the badge. */
    function scheduleReconnect(reason) {
        if (!autoReconnect || !sessionCreds || reconnecting) return;
        reconnecting = true;
        isTradeInFlight = false;

        const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
        reconnectAttempt++;

        connectionStatus.textContent = `Reconnecting… (${reconnectAttempt})`;
        connectionStatus.className = 'status-badge preview';
        setBuyEnabled(false);
        notify(`${reason}. Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${reconnectAttempt}).`, 'error');

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            reconnecting = false;
            startSession(sessionCreds, { isReconnect: true });
        }, delay);
    }

    /** Skip the backoff — used when the OS reports the network is back. */
    function reconnectNow(reason) {
        if (!autoReconnect || !sessionCreds || socket?.isOpen) return;
        clearTimeout(reconnectTimer);
        reconnecting = false;
        reconnectAttempt = 0;
        notify(`${reason} — reconnecting now.`, 'info');
        startSession(sessionCreds, { isReconnect: true });
    }

    /**
     * Watchdog for a socket that has stopped delivering without closing.
     *
     * This is the failure mode that actually strands an unattended bot: the
     * browser still reports readyState OPEN, onclose never fires, and ticks
     * simply stop arriving. Silence is the only symptom.
     */
    function startWatchdog() {
        stopWatchdog();
        lastTickAt = Date.now();
        watchdogTimer = setInterval(() => {
            if (!socket?.isOpen || reconnecting) return;
            if (Date.now() - lastTickAt < TICK_STALL_MS) return;
            stopWatchdog();
            try { socket.close(); } catch { /* already gone */ }
            socket = null;
            emit(sessionListeners, { mode: 'disconnected', state: 'down', symbol: activeSymbol });
            scheduleReconnect(`No ticks for ${TICK_STALL_MS / 1000}s — socket looks dead`);
        }, 5000);
    }

    function stopWatchdog() {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }

    /**
     * Watch one contract to settlement, surviving reconnects.
     *
     * Bots register through here rather than calling socket.subscribe directly,
     * so the engine can re-attach every live stream after a drop.
     */
    function watchContract(contractId, handler) {
        contractWatches.set(contractId, { handler, stop: null });
        attachContractWatch(contractId);
        return () => {
            const entry = contractWatches.get(contractId);
            if (entry?.stop) entry.stop();
            contractWatches.delete(contractId);
        };
    }

    function attachContractWatch(contractId) {
        const entry = contractWatches.get(contractId);
        if (!entry || !socket?.isOpen) return;
        entry.stop = socket.subscribe(
            { proposal_open_contract: 1, contract_id: contractId },
            (msg, error) => entry.handler(msg, error),
        );
    }

    function replayContractWatches() {
        let count = 0;
        for (const contractId of contractWatches.keys()) {
            attachContractWatch(contractId);
            count++;
        }
        return count;
    }

    async function enterTradingMode() {
        const { accountType, accountId } = socket.meta;
        const isReal = accountType === 'real';

        if (isReal && !realAccountConfirmed) {
            const proceed = confirm(
                `⚠️ REAL MONEY ACCOUNT (${accountId})\n\n` +
                `Every ${CFG.label} contract bought here — manual or automatic — uses real funds. Continue?`,
            );
            if (!proceed) throw new Error('Cancelled. Switch the account selector to Demo.');
            // Consent is per session, not per socket: a reconnect must not
            // stop and wait for a dialog nobody is there to answer.
            realAccountConfirmed = true;
        }

        connectionStatus.textContent = isReal ? `REAL — ${accountId} ⚠️` : `DEMO — ${accountId}`;
        connectionStatus.className = `status-badge ${isReal ? 'disconnected' : 'connected'}`;
        if (currencyLabel) currencyLabel.textContent = currency();

        socket.subscribe({ balance: 1 }, (msg, error) => {
            if (error || !msg?.balance) return;
            const value = Number(msg.balance.balance);
            if (Number.isFinite(value)) accountBalance = value;
            balanceDisplay.innerHTML =
                `Balance: <strong>${value.toFixed(2)} ${msg.balance.currency}</strong>`;
        });

        connectBtn.textContent = 'Linked ✔';
        setTradingEnabled(true);
        notify(`Connected to ${accountType} account ${accountId}.`, 'ok');
    }

    function enterPreviewMode() {
        connectionStatus.textContent = 'Preview (no account)';
        connectionStatus.className = 'status-badge preview';
        balanceDisplay.innerHTML = 'Balance: <strong>—</strong>';
        setTradingEnabled(false);
        notify('Preview mode: live chart and live pricing only. Paste a token to enable buying.', 'info');
    }

    /** Build the asset list from what is actually tradable right now. */
    async function populateSymbols() {
        const previous = assetSelect.value;
        const response = await socket.send({ active_symbols: 'brief' });
        const symbols = (response.active_symbols || [])
            .filter((s) => s.market === 'synthetic_index' && s.exchange_is_open === 1 && !s.is_trading_suspended)
            .sort((a, b) => a.underlying_symbol_name.localeCompare(b.underlying_symbol_name));

        if (!symbols.length) return; // keep the static fallback rather than emptying the UI

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

    // =======================================================================
    // Tick stream
    // =======================================================================

    function beginTickStream() {
        if (stopTicks) stopTicks();

        activeSymbol = assetSelect.value;
        pipSize = Number(assetSelect.selectedOptions[0]?.dataset.pipSize) || 0.01;
        resetSeries();

        stopTicks = socket.subscribe({ ticks: activeSymbol }, (msg, error) => {
            if (error) {
                notify(`Tick stream error: ${error.message}`, 'error');
                haltBot('Tick stream failed.');
                return;
            }
            if (msg?.tick) onTick(msg.tick);
        });
    }

    function onTick(tick) {
        lastTickAt = Date.now();
        const timeMs = Number(tick.epoch) * 1000;
        const spot = Number(tick.quote);
        // Some synthetics quote without a bid/ask book; fall back to the spot.
        const ask = Number.isFinite(Number(tick.ask)) ? Number(tick.ask) : spot;
        const bid = Number.isFinite(Number(tick.bid)) ? Number(tick.bid) : spot;

        tickCount++;
        ticksSinceTrade++;

        statSpot.textContent = fmt(spot);
        statAsk.textContent = fmt(ask);
        statBid.textContent = fmt(bid);
        statSpread.textContent = fmt(ask - bid);
        statTicks.textContent = tickCount;

        TS.push(timeMs); BID.push(bid); ASK.push(ask); MID.push(spot);

        // Record where each timeframe block starts so we can draw separators.
        const tfMs = tfMinutes * 60 * 1000;
        if (TS.length > 1) {
            const current = Math.floor(timeMs / tfMs);
            const previous = Math.floor(TS[TS.length - 2] / tfMs);
            if (current !== previous) timeframeBreaks.push(TS.length - 1);
        }

        if (TS.length > MAX_TICKS_IN_MEMORY) {
            TS.shift(); BID.shift(); ASK.shift(); MID.shift();
            timeframeBreaks = timeframeBreaks.map((i) => i - 1).filter((i) => i >= 0);
        }

        calculateZigZag();
        updateBarrierPreview();
        // A path-dependent contract is judged tick by tick, so the path has to be
        // re-measured on every tick rather than only when a contract frame lands.
        if (CFG.pathDependent && liveContract) { trackPath(); renderOpenContract(); }
        drawChart();

        if (isBotArmed) evaluateSignal();

        emit(tickListeners, { spot, bid, ask, timeMs, pipSize, symbol: activeSymbol });
    }

    function resetSeries() {
        TS = []; BID = []; ASK = []; MID = [];
        timeframeBreaks = [];
        pivots = [];
        tickCount = 0;
        statTicks.textContent = '0';
        statLastPivot.textContent = '—';
        statBias.textContent = '—';
        drawChart();
    }

    // =======================================================================
    // ZigZag swing engine
    // =======================================================================

    function calculateZigZag() {
        const n = MID.length;
        if (n < 2) return;

        pivots = [];
        let dir = null;
        let extreme = MID[0];
        let extremeIndex = 0;

        for (let i = 1; i < n; i++) {
            // A zero spread would collapse the threshold, so floor it at one pip.
            const spread = Math.max(ASK[i] - BID[i], pipSize);
            const th = theta * spread;

            if (dir === null) {
                if (MID[i] >= MID[0] + th) { dir = 'up'; extreme = MID[i]; extremeIndex = i; }
                else if (MID[i] <= MID[0] - th) { dir = 'dn'; extreme = MID[i]; extremeIndex = i; }
            } else if (dir === 'up') {
                if (MID[i] > extreme) { extreme = MID[i]; extremeIndex = i; }
                else if (MID[i] <= extreme - th) {
                    pivots.push({ price: extreme, type: 'H', timeIndex: extremeIndex });
                    dir = 'dn'; extreme = MID[i]; extremeIndex = i;
                }
            } else {
                if (MID[i] < extreme) { extreme = MID[i]; extremeIndex = i; }
                else if (MID[i] >= extreme + th) {
                    pivots.push({ price: extreme, type: 'L', timeIndex: extremeIndex });
                    dir = 'up'; extreme = MID[i]; extremeIndex = i;
                }
            }
        }

        // HH / LH / LL / HL, each pivot compared against the previous of its kind.
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
            statLastPivot.textContent = `${last.label} @ ${fmt(last.price)}`;
            statBias.textContent = describeBias();
            statBias.className = `v ${biasDirection() === 'up' ? 'up' : biasDirection() === 'down' ? 'dn' : ''}`;
        }
    }

    /** Uptrend needs a higher high and a higher low; downtrend the mirror image. */
    function biasDirection() {
        const highs = pivots.filter((p) => p.type === 'H');
        const lows = pivots.filter((p) => p.type === 'L');
        const lastHigh = highs[highs.length - 1]?.label;
        const lastLow = lows[lows.length - 1]?.label;
        if (lastHigh === 'HH' && lastLow === 'HL') return 'up';
        if (lastHigh === 'LH' && lastLow === 'LL') return 'down';
        return 'range';
    }

    function describeBias() {
        return { up: 'Uptrend (HH/HL)', down: 'Downtrend (LH/LL)', range: 'Ranging' }[biasDirection()];
    }

    // =======================================================================
    // Contract parameters
    // =======================================================================

    /**
     * Which side of spot the barrier sits on, as "+" or "-".
     *
     * For Higher/Lower the leg implies the side: "auto" puts the barrier on the
     * far side of the trade, the reading most traders expect from "I think it
     * rises by at least this much".
     *
     * For Touch/No Touch it does not. Both legs are opposite bets on the SAME
     * barrier, so the side is its own dial and "auto" follows the swing
     * structure instead. `sideOverride` is how the bot aims it per trade.
     */
    function barrierSideFor(direction, sideOverride = null) {
        if (sideOverride) return sideOverride;
        if (barrierSide.value !== 'auto') return barrierSide.value;
        if (CFG.sharedBarrier) return biasDirection() === 'down' ? '-' : '+';
        return direction === 'up' ? '+' : '-';
    }

    /** The signed barrier offset string the API expects, e.g. "+0.5". */
    function barrierOffsetFor(direction, sideOverride = null) {
        if (!CFG.needsBarrier || !barrierInput) return null;
        const magnitude = Math.abs(Number(barrierInput.value));
        if (!Number.isFinite(magnitude)) return null;
        return `${barrierSideFor(direction, sideOverride)}${magnitude}`;
    }

    /** Absolute price a barrier offset resolves to against the current spot. */
    function barrierPriceFor(direction, sideOverride = null) {
        const spot = MID[MID.length - 1];
        if (!Number.isFinite(spot)) return null;
        const offset = barrierOffsetFor(direction, sideOverride);
        if (offset === null) return null;
        return spot + Number(offset);
    }

    function validateContractParams() {
        const stake = Number(stakeInput.value);
        const duration = Number(durationInput.value);
        const unit = unitSelect.value;

        if (!(stake > 0)) throw new Error('Stake must be greater than zero.');

        if (unit === 't') {
            if (!Number.isInteger(duration) || duration < CFG.minTicks || duration > CFG.maxTicks) {
                throw new Error(
                    `${CFG.label} accepts ${CFG.minTicks}–${CFG.maxTicks} ticks.` +
                    (CFG.minTicks > 1 ? ` There is no 1–${CFG.minTicks - 1} tick contract.` : ''),
                );
            }
        } else {
            const seconds = unit === 'm' ? duration * 60 : duration;
            const floor = CFG.minIntradaySeconds;
            if (!(seconds >= floor && seconds <= MAX_INTRADAY_SECONDS)) {
                throw new Error(
                    `${CFG.label} intraday duration must be between ` +
                    `${floor >= 60 ? `${floor / 60} minutes` : `${floor} seconds`} and 24 hours (got ${seconds}s).`,
                );
            }
        }

        if (CFG.needsBarrier && !(Math.abs(Number(barrierInput.value)) > 0)) {
            throw new Error(`${CFG.label} needs a barrier offset greater than zero.`);
        }
    }

    function proposalRequest(direction, sideOverride = null) {
        const request = {
            proposal: 1,
            amount: Number(stakeInput.value),
            basis: 'stake',
            currency: currency(),
            contract_type: direction === 'up' ? CFG.up : CFG.down,
            underlying_symbol: assetSelect.value,
            duration: Number(durationInput.value),
            duration_unit: unitSelect.value,
        };
        // The API rejects a numeric barrier — it must be a signed string.
        if (CFG.needsBarrier) request.barrier = barrierOffsetFor(direction, sideOverride);
        return request;
    }

    // =======================================================================
    // Live quote polling
    // =======================================================================

    function startQuotePolling() {
        clearInterval(quoteTimer);
        quoteTimer = setInterval(refreshQuotes, QUOTE_POLL_MS);
        refreshQuotes();
    }

    function clearQuotes(message) {
        quoteUp.textContent = `${CFG.upGlyph} —`;
        quoteDn.textContent = `${CFG.downGlyph} —`;
        quoteNote.textContent = message;
        quoteNote.className = 'muted warn';
        showEdge(NaN);
        quotable.up = false;
        quotable.down = false;
        setBuyEnabled(socket?.mode === 'authed');
    }

    /**
     * The two legs price the same event from opposite sides only when they share
     * a reference level: always for Rise/Fall (the entry spot) and Touch/No Touch
     * (one barrier), but for Higher/Lower only while the side is pinned — "auto"
     * puts the two legs on two different barriers, which are not complements.
     */
    function legsAreComplementary() {
        if (!CFG.needsBarrier) return true;
        if (CFG.sharedBarrier) return true;
        return barrierSide?.value !== 'auto';
    }

    /**
     * Implied probabilities of two complementary legs must sum to 1 in a fair
     * market. Everything above that is the house margin, read live off the
     * quotes rather than assumed.
     */
    function showEdge(edgePct) {
        if (!edgeBadge) return;
        if (!Number.isFinite(edgePct)) { edgeBadge.hidden = true; return; }
        const expensive = edgePct > EXPENSIVE_EDGE_PCT;
        edgeBadge.hidden = false;
        edgeBadge.textContent = `edge ${edgePct.toFixed(2)}%`;
        edgeBadge.className = `edge-badge ${expensive ? 'hot' : 'ok'}`;
        edgeBadge.title = expensive
            ? 'Well above the 2.3–3.2% the rest of the surface prices at. Tick-duration Touch is the '
              + 'single most expensive corner — intraday durations cost roughly a third of this.'
            : 'Implied probabilities of the two legs, summed. The excess over 100% is the house margin.';
    }

    async function refreshQuotes() {
        if (!socket?.isOpen || quoteInFlight || isTradeInFlight) return;

        try {
            validateContractParams();
        } catch (error) {
            clearQuotes(error.message);
            return;
        }

        quoteInFlight = true;
        try {
            // allSettled, not all: one leg being priced out must not blank the
            // other. A far barrier quotes ONETOUCH while NOTOUCH returns "This
            // contract offers no return", and the same happens to HIGHER/LOWER
            // at short durations.
            const [up, down] = await Promise.allSettled([
                socket.send(proposalRequest('up')),
                socket.send(proposalRequest('down')),
            ]);

            const stake = Number(stakeInput.value);
            const payoutOf = (settled) => (settled.status === 'fulfilled'
                ? Number(settled.value.proposal.payout)
                : NaN);
            const upPayout = payoutOf(up);
            const dnPayout = payoutOf(down);

            quotable.up = Number.isFinite(upPayout);
            quotable.down = Number.isFinite(dnPayout);
            setBuyEnabled(socket?.mode === 'authed');

            const leg = (ok, glyph, label, payout, stakeAmount) => (ok
                ? `${glyph} ${label} pays ${payout.toFixed(2)}` +
                  (CFG.showImplied ? ` (~${((stakeAmount / payout) * 100).toFixed(1)}%)` : '')
                : `${glyph} —`);
            quoteUp.textContent = leg(quotable.up, CFG.upGlyph, CFG.upLabel, upPayout, stake);
            quoteDn.textContent = leg(quotable.down, CFG.downGlyph, CFG.downLabel, dnPayout, stake);

            const bothPriced = quotable.up && quotable.down;
            showEdge(bothPriced && legsAreComplementary()
                ? (stake / upPayout + stake / dnPayout - 1) * 100
                : NaN);

            if (bothPriced) {
                quoteNote.textContent =
                    `Return ${(((upPayout - stake) / stake) * 100).toFixed(0)}% / ` +
                    `${(((dnPayout - stake) / stake) * 100).toFixed(0)}% on a ${stake} ${currency()} stake.`;
                quoteNote.className = 'muted';
            } else if (quotable.up || quotable.down) {
                const dead = quotable.up ? down : up;
                const why = (dead.reason?.message || 'rejected').replace(/\.$/, '');
                quoteNote.textContent =
                    `${quotable.up ? CFG.downLabel : CFG.upLabel} is not priceable here — ${why}. ` +
                    `${CFG.needsBarrier ? 'Move the barrier closer, or lengthen the duration.' : ''}`;
                quoteNote.className = 'muted warn';
            } else {
                const why = (up.reason?.message || down.reason?.message || 'rejected').replace(/\.$/, '');
                quoteNote.textContent = `${why}.`;
                quoteNote.className = 'muted warn';
            }
        } catch (error) {
            clearQuotes(error.message);
        } finally {
            quoteInFlight = false;
        }
    }

    // =======================================================================
    // Buying
    // =======================================================================

    async function placeTrade(direction, origin, sideOverride = null) {
        if (socket?.mode !== 'authed') {
            notify('Buying needs a token. Preview mode is chart and pricing only.', 'error');
            return;
        }
        if (isTradeInFlight) return;

        isTradeInFlight = true;
        setBuyEnabled(false);

        try {
            validateContractParams();

            const request = proposalRequest(direction, sideOverride);
            const { proposal } = await socket.send(request);

            // Pay at most the quoted ask — the server rejects anything cheaper.
            const { buy } = await socket.send({ buy: proposal.id, price: proposal.ask_price });

            ticksSinceTrade = 0;
            notify(
                `${origin === 'auto' ? 'Auto' : 'Manual'} buy: ${request.contract_type} ` +
                `${request.duration}${request.duration_unit}` +
                `${request.barrier ? ` barrier ${request.barrier}` : ''} — contract ${buy.contract_id}.`,
                'ok',
            );
            monitorContract(buy.contract_id, request);
        } catch (error) {
            notify(`Trade failed: ${error.message}`, 'error');
            // A failed buy never opens a contract, so the lock is released here.
            isTradeInFlight = false;
            setBuyEnabled(true);
            if (['InsufficientBalance', 'InvalidToken'].includes(error.code)) {
                haltBot(`Bot halted: ${error.message}`);
            }
        }
    }

    /** Watch one contract until it settles, feeding the chart overlay as it runs. */
    function monitorContract(contractId, request) {
        const spot = MID[MID.length - 1];
        liveContract = {
            id: contractId,
            type: request.contract_type,
            // Read the direction off the contract itself, not the dropdown — the
            // dropdown can be changed while a manual contract is still running.
            direction: [CFG.up].includes(request.contract_type) ? 'up' : 'down',
            needsBarrier: Boolean(request.barrier),
            entrySpot: null,
            // Provisional barrier from spot + offset. The proposal does not echo
            // one back, so this is what the chart draws until the contract
            // stream supplies the authoritative level.
            barrier: request.barrier && Number.isFinite(spot)
                ? spot + Number(request.barrier)
                : null,
            // Path tracking. `origin` is fixed for the life of the contract; it
            // must never be re-read from the live price, or `above` would flip
            // on the very tick that decides the contract.
            origin: Number.isFinite(spot) ? spot : null,
            above: Number(request.barrier) > 0,
            extreme: null,
            touched: false,
            startTime: TS[TS.length - 1] || null,
            expiryTime: null,
            current: null,
            profit: 0,
            ticksTotal: request.duration_unit === 't' ? request.duration : null,
            ticksDone: 0,
        };
        openPanel.hidden = false;
        if (CFG.pathDependent) trackPath();
        renderOpenContract();

        stopContractStream = socket.subscribe(
            { proposal_open_contract: 1, contract_id: contractId },
            (msg, error) => {
                if (error) {
                    notify(`Contract ${contractId}: ${error.message}`, 'error');
                    closeOutContract();
                    return;
                }
                const contract = msg?.proposal_open_contract;
                if (!contract) return;

                applyContractUpdate(contract);

                const isSettled = contract.is_sold === 1 || contract.is_expired === 1
                    || ['won', 'lost', 'sold', 'cancelled'].includes(contract.status);
                if (isSettled) bookResult(contract);
            },
        );
    }

    function applyContractUpdate(contract) {
        if (!liveContract) return;

        // Field names vary by contract stage; take whichever is present.
        const entry = contract.entry_spot ?? contract.entry_tick;
        if (Number.isFinite(Number(entry))) liveContract.entrySpot = Number(entry);
        if (Number.isFinite(Number(contract.barrier))) liveContract.barrier = Number(contract.barrier);
        if (Number.isFinite(Number(contract.current_spot))) liveContract.current = Number(contract.current_spot);
        if (Number.isFinite(Number(contract.profit))) liveContract.profit = Number(contract.profit);
        if (contract.date_start) liveContract.startTime = Number(contract.date_start) * 1000;
        if (contract.date_expiry) liveContract.expiryTime = Number(contract.date_expiry) * 1000;
        if (Number.isFinite(Number(contract.tick_count))) liveContract.ticksTotal = Number(contract.tick_count);
        if (Array.isArray(contract.tick_stream)) liveContract.ticksDone = contract.tick_stream.length;

        if (CFG.pathDependent) trackPath(contract);
        renderOpenContract();
        drawChart();
    }

    /** True when the current price is on the winning side of the reference level. */
    function isWinningNow(c) {
        const reference = c.needsBarrier ? c.barrier : c.entrySpot;
        const price = c.current ?? MID[MID.length - 1];
        if (!Number.isFinite(reference) || !Number.isFinite(price)) return null;
        return c.direction === 'up' ? price > reference : price < reference;
    }

    // =======================================================================
    // Path tracking — path-dependent families only
    // =======================================================================

    /**
     * Measure how close the path has come to the barrier.
     *
     * `tick_stream` is preferred when present: those are the ticks Deriv itself
     * judged the contract against. Our own series is the fallback, and covers
     * the gap between contract frames so the panel keeps moving every tick.
     *
     * The extreme is monotonic. Once price has been somewhere it has been there,
     * and for a contract judged at every moment that is the whole story — a
     * ONETOUCH that reached its barrier stays won however far price retraces.
     */
    function trackPath(contract = null) {
        const c = liveContract;
        if (!c || !Number.isFinite(c.barrier)) return;

        if (Number.isFinite(c.entrySpot)) c.origin = c.entrySpot;
        if (!Number.isFinite(c.origin)) return;

        const above = c.barrier > c.origin;
        if (c.above !== above) { c.above = above; c.extreme = null; } // origin moved sides

        let best = Number.isFinite(c.extreme) ? c.extreme : c.origin;
        const consider = (value) => {
            if (!Number.isFinite(value)) return;
            if (above ? value > best : value < best) best = value;
        };

        if (Array.isArray(contract?.tick_stream) && contract.tick_stream.length) {
            for (const t of contract.tick_stream) consider(Number(t.tick ?? t.quote));
        } else if (c.startTime) {
            const start = indexAtTime(c.startTime);
            if (start >= 0) for (let i = start; i < MID.length; i++) consider(MID[i]);
        }
        consider(c.current);

        c.extreme = best;
        c.touched = above ? best >= c.barrier : best <= c.barrier;
    }

    /** How far the closest approach got toward the barrier, as 0–1. */
    function touchProgress(c) {
        if (!Number.isFinite(c.origin) || !Number.isFinite(c.barrier) || !Number.isFinite(c.extreme)) return null;
        const span = Math.abs(c.barrier - c.origin);
        if (!(span > 0)) return null;
        return Math.max(0, Math.min(1, Math.abs(c.extreme - c.origin) / span));
    }

    /** Does reaching the barrier win this contract, or lose it? */
    function touchWins(c) {
        return c.direction === CFG.touchLeg;
    }

    function renderOpenContract() {
        const c = liveContract;
        if (!c) { openPanel.hidden = true; return; }

        ocType.textContent = c.type;
        ocEntry.textContent = fmt(c.entrySpot);
        ocBarrier.textContent = c.needsBarrier
            ? `${fmt(c.barrier)}${CFG.pathDependent ? (c.above ? ' ▲' : ' ▼') : ''}`
            : 'entry spot';
        ocCurrent.textContent = fmt(c.current ?? MID[MID.length - 1]);

        if (CFG.pathDependent) renderPathCells(c);

        if (c.ticksTotal) {
            ocRemaining.textContent = `${Math.max(0, c.ticksTotal - c.ticksDone)} / ${c.ticksTotal} ticks`;
        } else if (c.expiryTime) {
            const left = Math.max(0, Math.round((c.expiryTime - (TS[TS.length - 1] || 0)) / 1000));
            ocRemaining.textContent = `${left}s`;
        } else {
            ocRemaining.textContent = '—';
        }

        ocPl.textContent = `${c.profit >= 0 ? '+' : ''}${c.profit.toFixed(2)}`;
        ocPl.className = `v sm ${c.profit >= 0 ? 'up' : 'dn'}`;

        if (CFG.pathDependent) { renderPathVerdict(c); return; }

        const winning = isWinningNow(c);
        const against = c.needsBarrier ? 'barrier' : 'entry spot';
        if (winning === null) {
            ocVerdict.textContent = 'Waiting for the entry tick…';
            ocVerdict.className = 'verdict';
        } else {
            ocVerdict.textContent = winning
                ? `Currently WINNING — price is on the ${c.direction === 'up' ? 'high' : 'low'} side of the ${against}.`
                : `Currently LOSING — price is on the wrong side of the ${against}.`;
            ocVerdict.className = `verdict ${winning ? 'ok' : 'bad'}`;
        }
    }

    function renderPathCells(c) {
        const won = touchWins(c);

        if (ocClosest) ocClosest.textContent = fmt(c.extreme);

        if (ocGap) {
            const gap = Number.isFinite(c.extreme) && Number.isFinite(c.barrier)
                ? Math.abs(c.barrier - c.extreme)
                : null;
            ocGap.textContent = c.touched ? 'reached' : (gap === null ? '—' : fmt(gap));
            ocGap.className = `v sm ${c.touched ? (won ? 'up' : 'dn') : ''}`;
        }

        if (ocProgressFill) {
            const progress = touchProgress(c);
            ocProgressFill.style.width = progress === null ? '0%' : `${(progress * 100).toFixed(1)}%`;
            ocProgressFill.className = `touch-fill ${c.touched ? (won ? 'win' : 'lose') : ''}`;
        }
    }

    function renderPathVerdict(c) {
        const progress = touchProgress(c);
        if (progress === null) {
            ocVerdict.textContent = 'Waiting for the entry tick…';
            ocVerdict.className = 'verdict';
            return;
        }

        const won = touchWins(c);
        if (c.touched) {
            ocVerdict.textContent = won
                ? `BARRIER REACHED — ${CFG.upLabel} is won. It stays won even if price retraces.`
                : `BARRIER REACHED — ${CFG.downLabel} is lost. There is no recovering from this one.`;
            ocVerdict.className = `verdict ${won ? 'ok' : 'bad'}`;
            return;
        }

        const pct = (progress * 100).toFixed(0);
        ocVerdict.textContent = won
            ? `Not reached yet — closest approach covered ${pct}% of the distance. ` +
              'One moment at the barrier, at any point before expiry, wins it.'
            : `Not reached — closest approach covered ${pct}% of the distance. ` +
              'Winning, but only until the barrier is touched even once.';
        ocVerdict.className = `verdict ${won ? '' : 'ok'}`;
    }

    function closeOutContract() {
        if (stopContractStream) stopContractStream();
        stopContractStream = null;
        liveContract = null;
        openPanel.hidden = true;
        isTradeInFlight = false;
        setBuyEnabled(socket?.mode === 'authed');
        drawChart();
    }

    function bookResult(contract) {
        const contractId = contract.contract_id;
        if (settledContracts.has(contractId)) return; // the stream can repeat the final frame
        settledContracts.add(contractId);

        const profit = Number(contract.profit) || 0;
        const won = profit > 0;
        const c = liveContract;

        // A settled Touch that won, or a settled No Touch that lost, means the
        // barrier was reached. The settlement confirms what the local path
        // tracking already saw, and covers the case where a touch landed
        // between two of our own ticks.
        const touched = CFG.pathDependent && c
            ? (touchWins(c) ? won : !won) || c.touched
            : false;

        recordTrade(contract, profit, won, touched, c?.extreme ?? null);
        closeOutContract();
        enforceRiskLimits();
    }

    /**
     * Add one settled contract to the session counters and the history table.
     *
     * Split out of bookResult so a second bot on the page can post its own
     * contracts here. The hedge-cycle bot buys on the same account through the
     * same socket, so its trades belong in the same running totals — the split
     * keeps that from also dragging in liveContract teardown and the risk limits,
     * which are the swing bot's business alone.
     */
    function recordTrade(contract, profit, won, touched = false, closest = null) {
        totalTrades++;
        if (won) totalWins++; else totalLosses++;
        if (touched) totalTouched++;
        netProfit += profit;

        if (statTotal) statTotal.textContent = totalTrades;
        if (statWins) statWins.textContent = totalWins;
        if (statLosses) statLosses.textContent = totalLosses;
        if (statRate) statRate.textContent = `${((totalWins / totalTrades) * 100).toFixed(0)}%`;
        if (statTouched) statTouched.textContent = `${totalTouched} / ${totalTrades}`;
        if (statProfit) {
            statProfit.textContent = `${netProfit >= 0 ? '+' : ''}${netProfit.toFixed(2)}`;
            statProfit.className = `v ${netProfit >= 0 ? 'up' : 'dn'}`;
        }

        addHistoryRow(contract, profit, won, touched, closest);
    }

    function addHistoryRow(contract, profit, won, touched, closest) {
        // A page may drop the history table entirely and keep only the counters.
        if (!historyRows) return;
        historyRows.querySelector('.empty')?.remove();

        const row = document.createElement('tr');
        row.className = won ? 'row-win' : 'row-loss';
        const cells = [
            contract.contract_id,
            contract.contract_type || '—',
            fmt(contract.entry_spot ?? contract.entry_tick),
        ];
        if (CFG.needsBarrier) cells.push(fmt(contract.barrier));
        if (CFG.pathDependent) cells.push(fmt(closest));
        cells.push(fmt(contract.exit_tick ?? contract.current_spot));

        row.innerHTML =
            cells.map((v) => `<td>${v}</td>`).join('') +
            (CFG.pathDependent
                ? `<td class="${touched ? 'gold' : 'mut'}">${touched ? 'YES' : 'no'}</td>`
                : '') +
            `<td class="${won ? 'up' : 'dn'}">${(contract.status || '').toUpperCase()}</td>` +
            `<td class="${profit >= 0 ? 'up' : 'dn'}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)}</td>`;
        historyRows.insertBefore(row, historyRows.firstChild);
    }

    // =======================================================================
    // Auto-trade engine
    // =======================================================================

    /**
     * The swing-engine controls are optional.
     *
     * RiseFall/ drops that panel entirely and runs only the hedge-cycle bot, so
     * every one of these nodes can be absent. The three callers that run on
     * every page load — setTradingEnabled, resetUIOnDisconnect and wireControls
     * — would otherwise throw before the chart ever appears.
     */
    const hasSwingUI = () => Boolean(startBtn && signalSelect);

    function setSwingStatus(text) { if (signalStatus) signalStatus.textContent = text; }

    function setSwingButtons(startDisabled, stopDisabled) {
        if (startBtn) startBtn.disabled = startDisabled;
        if (stopBtn) stopBtn.disabled = stopDisabled;
    }

    function armBot() {
        if (!hasSwingUI()) return; // this page has no swing engine
        if (socket?.mode !== 'authed') {
            notify('Auto-trading needs a token. Preview mode cannot place orders.', 'error');
            return;
        }
        try {
            validateContractParams();
        } catch (error) {
            notify(error.message, 'error');
            return;
        }

        // Only pivots formed AFTER arming should fire, so adopt the current one as
        // already seen. Otherwise the bot would immediately trade on old structure.
        lastSignalPivotTime = pivots.length ? TS[pivots[pivots.length - 1].timeIndex] : null;
        ticksSinceTrade = Infinity;

        isBotArmed = true;
        setSwingButtons(true, false);
        setConfigDisabled(true);
        setSwingStatus(
            `Armed — watching for ${signalSelect.value === 'trend' ? 'trend continuation' : 'reversal'} pivots.`);
        notify(`Bot armed. It buys ${CFG.label} on the next confirmed swing pivot that matches the signal.`, 'ok');
    }

    function haltBot(message) {
        if (!isBotArmed && !message) return;
        isBotArmed = false;
        setSwingButtons(socket?.mode !== 'authed', true);
        setConfigDisabled(false);
        setSwingStatus('Idle.');
        if (message) notify(message, 'info');
    }

    /** Called once per tick while armed. */
    function evaluateSignal() {
        if (isTradeInFlight || !pivots.length) return;

        const cooldown = Number(cooldownInput?.value) || 0;
        if (ticksSinceTrade < cooldown) {
            setSwingStatus(`Cooling down — ${cooldown - ticksSinceTrade} ticks to go.`);
            return;
        }

        const last = pivots[pivots.length - 1];
        const pivotTime = TS[last.timeIndex];
        if (pivotTime === lastSignalPivotTime) return; // already acted on this pivot
        lastSignalPivotTime = pivotTime;

        const swing = directionFromPivot(last);
        if (!swing) {
            setSwingStatus(`New ${last.label} pivot — no trade (does not match the signal).`);
            return;
        }

        // For a directional family the swing IS the leg. Touch/No Touch has to
        // translate: the same view is expressed either as a barrier ahead of the
        // move (Touch) or behind it (No Touch).
        const plan = CFG.planTrade ? CFG.planTrade(swing) : { direction: swing, side: null };
        if (!plan) {
            setSwingStatus(`New ${last.label} pivot — no trade.`);
            return;
        }

        const label = plan.direction === 'up' ? CFG.upLabel : CFG.downLabel;
        setSwingStatus(`New ${last.label} pivot → buying ${label}` +
            (plan.side ? ` with the barrier ${plan.side === '+' ? 'above' : 'below'} spot.` : '.'));
        placeTrade(plan.direction, 'auto', plan.side);
    }

    /**
     * Reversal: a confirmed low starts an up-leg, a confirmed high starts a down-leg.
     * Trend:    only pullback pivots that agree with the established structure —
     *           a higher low in an uptrend, a lower high in a downtrend.
     */
    function directionFromPivot(pivot) {
        // Reachable from the debug export on a page with no swing panel.
        if ((signalSelect?.value || 'reversal') === 'reversal') {
            return pivot.type === 'L' ? 'up' : 'down';
        }
        const bias = biasDirection();
        if (bias === 'up' && pivot.label === 'HL') return 'up';
        if (bias === 'down' && pivot.label === 'LH') return 'down';
        return null;
    }

    function enforceRiskLimits() {
        if (!isBotArmed || !slInput || !tpInput) return;
        const stopLoss = Number(slInput.value);
        const takeProfit = Number(tpInput.value);

        if (stopLoss > 0 && netProfit <= -stopLoss) {
            haltBot(`Stop loss hit at ${netProfit.toFixed(2)} ${currency()}. Bot disarmed.`);
        } else if (takeProfit > 0 && netProfit >= takeProfit) {
            haltBot(`Take profit hit at +${netProfit.toFixed(2)} ${currency()}. Bot disarmed.`);
        }
    }

    // =======================================================================
    // Canvas
    // =======================================================================

    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = CANVAS_HEIGHT * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawChart();
    }

    function drawChart() {
        const W = canvas.clientWidth;
        const H = CANVAS_HEIGHT;

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

        // The barrier and entry lines must stay on screen, so they take part in
        // the vertical range just like the price series does.
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = a; i <= b; i++) {
            const high = showBidAsk ? ASK[i] : MID[i];
            const low = showBidAsk ? BID[i] : MID[i];
            if (low < lo) lo = low;
            if (high > hi) hi = high;
        }
        for (const level of referenceLevels()) {
            if (level < lo) lo = level;
            if (level > hi) hi = level;
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

        drawWinLoseZones(W, H, getY);
        drawGrid(W, lo, hi, getY);
        drawTimeframeBreaks(a, b, H, getX);
        if (showBidAsk) drawBidAskEnvelope(a, b, getX, getY);
        drawSpotLine(a, b, getX, getY);
        if (showSwings) drawSwings(a, b, getX, getY);
        drawContractOverlay(W, a, b, getX, getY);
        drawSpotTracker(W, b, getX, getY);
    }

    /** Levels that must remain visible: the live barrier/entry/path, or the projected barrier. */
    function referenceLevels() {
        const levels = [];
        if (liveContract) {
            for (const level of [liveContract.entrySpot, liveContract.barrier,
                CFG.pathDependent ? liveContract.extreme : null]) {
                if (Number.isFinite(level)) levels.push(level);
            }
            return levels;
        }
        if (CFG.needsBarrier) {
            // A shared barrier has only one projected level; a per-leg one has two.
            for (const direction of projectedDirections()) {
                const price = barrierPriceFor(direction);
                if (Number.isFinite(price)) levels.push(price);
            }
        }
        return levels;
    }

    /** Which legs to draw a projected barrier for while idle. */
    function projectedDirections() {
        if (CFG.sharedBarrier) return ['up'];                    // one barrier, both legs
        if (barrierSide?.value !== 'auto') return ['up'];         // pinned side, one level
        return ['up', 'down'];
    }

    /**
     * Expiry-judged: tint the half of the chart that wins the contract.
     * Path-dependent: there is no winning half — there is a strip beyond the
     * barrier that price only has to enter for an instant, so tint that instead.
     */
    function drawWinLoseZones(W, H, getY) {
        const c = liveContract;
        const width = W - margins.left - margins.right;

        if (CFG.pathDependent) {
            const barrier = c ? c.barrier : barrierPriceFor('up');
            if (!Number.isFinite(barrier)) return;
            const above = c ? c.above : barrierSideFor('up') === '+';
            const y = getY(barrier);
            // Idle: neutral gold, since which leg gets bought decides the meaning.
            ctx.fillStyle = c
                ? (touchWins(c) ? 'rgba(63,185,80,0.09)' : 'rgba(248,81,73,0.09)')
                : 'rgba(212,160,23,0.07)';
            if (above) ctx.fillRect(margins.left, margins.top, width, Math.max(0, y - margins.top));
            else ctx.fillRect(margins.left, y, width, Math.max(0, H - margins.bottom - y));
            return;
        }

        if (!c) return;
        const reference = c.needsBarrier ? c.barrier : c.entrySpot;
        if (!Number.isFinite(reference)) return;

        const y = getY(reference);
        const winAbove = c.direction === 'up';
        ctx.fillStyle = winAbove ? 'rgba(63,185,80,0.07)' : 'rgba(248,81,73,0.07)';
        ctx.fillRect(margins.left, margins.top, width, Math.max(0, y - margins.top));
        ctx.fillStyle = winAbove ? 'rgba(248,81,73,0.07)' : 'rgba(63,185,80,0.07)';
        ctx.fillRect(margins.left, y, width, Math.max(0, H - margins.bottom - y));
    }

    function drawGrid(W, lo, hi, getY) {
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
            ctx.fillText(fmt(price), W - margins.right + 6, y + 3);
        }
    }

    function drawTimeframeBreaks(a, b, H, getX) {
        ctx.strokeStyle = '#2d333b';
        ctx.setLineDash([2, 4]);
        for (const index of timeframeBreaks) {
            if (index < a || index > b) continue;
            const x = getX(index);
            ctx.beginPath();
            ctx.moveTo(x, margins.top);
            ctx.lineTo(x, H - margins.bottom);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    function drawBidAskEnvelope(a, b, getX, getY) {
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

    function drawSpotLine(a, b, getX, getY) {
        ctx.strokeStyle = '#7d8590';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = a; i <= b; i++) {
            const x = getX(i);
            const y = getY(MID[i]);
            if (i === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    function drawSwings(a, b, getX, getY) {
        const visible = pivots.filter((p) => p.timeIndex >= a && p.timeIndex <= b);
        if (!visible.length) return;

        ctx.strokeStyle = '#388bfd';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        visible.forEach((pivot, j) => {
            const x = getX(pivot.timeIndex);
            const y = getY(pivot.price);
            if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();

        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        for (const pivot of visible) {
            const x = getX(pivot.timeIndex);
            const y = getY(pivot.price);
            const isHigh = pivot.type === 'H';
            ctx.fillStyle = isHigh ? '#3fb950' : '#f85149';
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillText(pivot.label, x, isHigh ? y - 8 : y + 14);
        }
        ctx.textAlign = 'left';
    }

    /** Entry marker, barrier line and start marker for the running contract —
     *  or, when idle, the barrier the next trade would get. */
    function drawContractOverlay(W, a, b, getX, getY) {
        const right = W - margins.right;

        if (!liveContract) {
            if (!CFG.needsBarrier) return;
            // Projected barriers, so you can see where the level sits before buying.
            const directions = projectedDirections();
            for (const direction of directions) {
                const price = barrierPriceFor(direction);
                if (!Number.isFinite(price)) continue;
                // With one shared level there is no leg to name it after.
                const label = directions.length === 1 && CFG.sharedBarrier
                    ? `barrier ${fmt(price)}`
                    : `${direction === 'up' ? CFG.upLabel : CFG.downLabel} barrier ${fmt(price)}`;
                drawLevel(getY(price), '#d4a017', 0.45, [4, 4], right, label);
            }
            return;
        }

        const c = liveContract;

        if (Number.isFinite(c.entrySpot)) {
            drawLevel(getY(c.entrySpot), '#c9d1d9', 0.8, [2, 3], right, `entry ${fmt(c.entrySpot)}`);
        }
        if (c.needsBarrier && Number.isFinite(c.barrier)) {
            drawLevel(getY(c.barrier), '#d4a017', 1, [], right,
                `barrier ${fmt(c.barrier)}${CFG.pathDependent && c.touched ? ' — REACHED' : ''}`);
        }
        // The closest approach is the number that decides a path-dependent
        // contract, so it gets its own line rather than living only in the panel.
        if (CFG.pathDependent && Number.isFinite(c.extreme) && !c.touched) {
            drawLevel(getY(c.extreme), touchWins(c) ? '#3fb950' : '#f85149', 0.7, [1, 3], right,
                `closest ${fmt(c.extreme)}`);
        }

        // Vertical marker where the contract started.
        if (c.startTime) {
            const index = indexAtTime(c.startTime);
            if (index >= a && index <= b) {
                ctx.strokeStyle = 'rgba(201,209,217,0.5)';
                ctx.setLineDash([3, 3]);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(getX(index), margins.top);
                ctx.lineTo(getX(index), CANVAS_HEIGHT - margins.bottom);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.fillStyle = '#c9d1d9';
                ctx.font = 'bold 9px ui-monospace, monospace';
                ctx.fillText(c.type, getX(index) + 4, margins.top + 10);
            }
        }
    }

    function drawLevel(y, color, alpha, dash, right, label) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(margins.left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.fillText(label, margins.left + 6, y - 4);
        ctx.restore();
    }

    function drawSpotTracker(W, b, getX, getY) {
        const spot = MID[b];
        const y = getY(spot);

        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margins.left, y);
        ctx.lineTo(W - margins.right, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#58a6ff';
        ctx.fillRect(W - margins.right, y - 8, margins.right, 16);
        ctx.fillStyle = '#06121f';
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.fillText(fmt(spot), W - margins.right + 4, y + 3);

        ctx.fillStyle = '#58a6ff';
        ctx.beginPath();
        ctx.arc(getX(b), y, 4, 0, 2 * Math.PI);
        ctx.fill();
    }

    // =======================================================================
    // UI plumbing
    // =======================================================================

    function setBusy(busy) {
        connectBtn.disabled = busy;
        previewBtn.disabled = busy;
        if (busy) connectBtn.textContent = 'Connecting…';
        else if (connectBtn.textContent === 'Connecting…') connectBtn.textContent = 'Connect';
    }

    function setBuyEnabled(enabled) {
        // Manual buys stay locked while the bot is armed — one contract at a time.
        // A leg the server refuses to price stays locked regardless.
        const allow = enabled && !isTradeInFlight && !isBotArmed;
        buyUpBtn.disabled = !(allow && quotable.up);
        buyDnBtn.disabled = !(allow && quotable.down);
    }

    function setTradingEnabled(enabled) {
        if (startBtn) startBtn.disabled = !enabled;
        setBuyEnabled(enabled);
    }

    function setConfigDisabled(disabled) {
        const controls = [assetSelect, durationInput, unitSelect, stakeInput, signalSelect];
        if (CFG.needsBarrier) controls.push(barrierInput, barrierSide);
        for (const control of controls) if (control) control.disabled = disabled;
        setBuyEnabled(socket?.mode === 'authed');
    }

    function resetUIOnDisconnect() {
        autoReconnect = false;
        clearTimeout(reconnectTimer);
        stopWatchdog();
        isBotArmed = false;
        isTradeInFlight = false;
        stopTicks = null;
        stopContractStream = null;
        liveContract = null;
        openPanel.hidden = true;
        clearInterval(quoteTimer);

        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        connectionStatus.textContent = 'Disconnected';
        connectionStatus.className = 'status-badge disconnected';
        setSwingButtons(true, true);
        setBuyEnabled(false);
        setConfigDisabled(false);
        setSwingStatus('Idle.');
    }

    function updateBarrierPreview() {
        if (!CFG.needsBarrier || !barrierPreview) return;
        const up = barrierPriceFor('up');
        if (!Number.isFinite(up)) { barrierPreview.textContent = 'Barrier —'; return; }

        // One shared barrier: describe the level and what each leg does with it.
        if (CFG.sharedBarrier) {
            const above = barrierSideFor('up') === '+';
            barrierPreview.textContent =
                `Barrier ${fmt(up)} — ${above ? 'above' : 'below'} spot. ` +
                `${CFG.upLabel} wins on reaching it, ${CFG.downLabel} wins on never reaching it.` +
                (barrierSide.value === 'auto' ? ` · auto → ${describeBias().toLowerCase()}` : '');
            return;
        }

        barrierPreview.textContent = barrierSide.value === 'auto'
            ? `${CFG.upLabel} above ${fmt(up)} · ${CFG.downLabel} below ${fmt(barrierPriceFor('down'))}`
            : `Barrier at ${fmt(up)}`;
    }

    function syncUI() {
        if (buyUpLabel) buyUpLabel.textContent = CFG.upLabel;
        if (buyDnLabel) buyDnLabel.textContent = CFG.downLabel;
        if (barrierRow) barrierRow.hidden = !CFG.needsBarrier;

        // Clamp the duration into the family's real range instead of letting the
        // first buy fail on the server.
        const unit = unitSelect.value;
        if (unit === 't') {
            durationInput.min = CFG.minTicks;
            durationInput.max = CFG.maxTicks;
            const value = Number(durationInput.value);
            if (value < CFG.minTicks) durationInput.value = CFG.minTicks;
            if (value > CFG.maxTicks) durationInput.value = CFG.maxTicks;
        } else {
            // Intraday floors differ by family — Touch/No Touch starts at 2 minutes.
            const floor = unit === 'm'
                ? Math.max(1, Math.ceil(CFG.minIntradaySeconds / 60))
                : CFG.minIntradaySeconds;
            durationInput.min = floor;
            durationInput.max = unit === 'm' ? MAX_INTRADAY_SECONDS / 60 : MAX_INTRADAY_SECONDS;
            if (Number(durationInput.value) < floor) durationInput.value = floor;
        }

        if (durationNote && CFG.durationNote) {
            const note = CFG.durationNote(unit) || {};
            durationNote.textContent = note.text || '';
            durationNote.className = `muted ${note.warn ? 'warn' : ''}`;
        }
        if (instrumentNote && CFG.instrumentNote) {
            instrumentNote.textContent = CFG.instrumentNote(instrumentSelect?.value);
        }

        updateBarrierPreview();
        drawChart();
        refreshQuotes();
    }

    function wireControls() {
        appIdInput.value = DerivAPI.getAppId();
        appIdInput.addEventListener('change', () => DerivAPI.setAppId(appIdInput.value));

        previewBtn.addEventListener('click', () => startSession({ token: null }));

        connectBtn.addEventListener('click', () => {
            const token = tokenInput.value.trim();
            if (!token) {
                notify('Paste a Personal Access Token, or use "Preview without token" for chart-only mode.', 'error');
                return;
            }
            if (!appIdInput.value.trim()) {
                notify('An App ID is required alongside the token — register one at home.deriv.com/dashboard/create', 'error');
                return;
            }
            DerivAPI.setAppId(appIdInput.value);
            startSession({ token, accountType: accountSelect.value });
        });

        buyUpBtn.addEventListener('click', () => placeTrade('up', 'manual'));
        buyDnBtn.addEventListener('click', () => placeTrade('down', 'manual'));

        if (startBtn) startBtn.addEventListener('click', armBot);
        if (stopBtn) {
            stopBtn.addEventListener('click',
                () => haltBot('Bot stopped. Any open contract still settles on its own.'));
        }

        unitSelect.addEventListener('change', syncUI);
        if (instrumentSelect) instrumentSelect.addEventListener('change', syncUI);

        const reprice = () => { updateBarrierPreview(); drawChart(); refreshQuotes(); };
        for (const control of [durationInput, stakeInput, barrierInput, barrierSide]) {
            if (control) control.addEventListener('change', reprice);
        }

        assetSelect.addEventListener('change', () => {
            if (!socket?.isOpen) return;
            if (isBotArmed) {
                notify('Disarm the bot before switching asset.', 'error');
                assetSelect.value = activeSymbol;
                return;
            }
            beginTickStream();
            refreshQuotes();
        });

        clearBtn.addEventListener('click', resetSeries);

        tfSelect.addEventListener('change', (event) => {
            tfMinutes = parseInt(event.target.value, 10);
            timeframeBreaks = [];
            drawChart();
        });

        thSlider.addEventListener('input', (event) => {
            theta = parseFloat(event.target.value);
            thVal.textContent = `${theta.toFixed(1)} spr`;
            calculateZigZag();
            drawChart();
        });

        winSlider.addEventListener('input', (event) => {
            visibleWindow = parseInt(event.target.value, 10);
            winVal.textContent = visibleWindow;
            drawChart();
        });

        baToggle.addEventListener('change', (event) => {
            showBidAsk = event.target.checked;
            drawChart();
        });

        swingToggle.addEventListener('change', (event) => {
            showSwings = event.target.checked;
            drawChart();
        });

        window.addEventListener('resize', resizeCanvas);

        // The OS knows the network is back before any timer would.
        window.addEventListener('online', () => reconnectNow('Network is back'));
        window.addEventListener('offline', () => notify('Network went offline. Waiting for it to return.', 'error'));
        // A tab restored from sleep can hold a socket that died while hidden.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && sessionCreds && !socket?.isOpen) {
                reconnectNow('Tab resumed');
            }
        });
    }

    // =======================================================================
    // Entry point
    // =======================================================================

    function start(config) {
        CFG = {
            label: 'Contract',
            upLabel: config.up,
            downLabel: config.down,
            upGlyph: '▲',
            downGlyph: '▼',
            needsBarrier: false,
            minTicks: 1,
            maxTicks: 10,
            minIntradaySeconds: DEFAULT_MIN_INTRADAY_SECONDS,
            // Both legs quote against ONE barrier (Touch/No Touch) rather than
            // one each side (Higher/Lower).
            sharedBarrier: false,
            // Judged continuously rather than at expiry.
            pathDependent: false,
            // Which leg wins when the barrier is reached. Only read when
            // pathDependent.
            touchLeg: 'up',
            // Show each leg's implied probability next to its payout.
            showImplied: false,
            // Optional hooks. planTrade turns a swing direction into a leg plus
            // an explicit barrier side; the note hooks fill in per-family copy.
            planTrade: null,
            durationNote: null,
            instrumentNote: null,
            ...config,
        };

        cacheDom();
        wireControls();
        syncUI();
        resizeCanvas();
        // Market data is public, so the chart starts without waiting for a token.
        startSession({ token: null });
    }

    global.TradeEngine = {
        start,

        /**
         * Live handles for a second bot sharing this page.
         *
         * `debug` below is for inspection; this is load-bearing. The hedge-cycle
         * bot buys, sells and settles on the same socket the chart is streaming
         * on, so it reads the connection through here instead of opening its own
         * (which would need the token pasted twice and double the tick traffic).
         */
        bridge: {
            get socket() { return socket; },
            get symbol() { return activeSymbol; },
            get pipSize() { return pipSize; },
            get currency() { return currency(); },
            get spot() { return MID.length ? MID[MID.length - 1] : null; },
            get isAuthed() { return socket?.mode === 'authed'; },
            onTick(fn) { tickListeners.push(fn); },
            onSession(fn) { sessionListeners.push(fn); },
            get isConnected() { return Boolean(socket?.isOpen); },
            // null until the first balance frame arrives.
            get balance() { return accountBalance; },
            // Market structure off the zigzag: 'up' (HH/HL), 'down' (LH/LL) or
            // 'range'. Sensitivity is the chart's swing slider, so the same
            // reading the chart draws is the one a bot filters on.
            get structure() { return biasDirection(); },
            get structureLabel() { return describeBias(); },
            // Pivots confirmed so far. 'range' means nothing when this is still
            // 0 or 1 — there is not enough history to call a trend yet.
            get pivotCount() { return pivots.length; },
            get isReconnecting() { return reconnecting; },
            // Register a contract stream that survives reconnects. Bots should
            // use this instead of socket.subscribe for open contracts.
            watchContract,
            notify,
            fmt,
            // Post a settled contract into this page's session totals and
            // history, so both bots report into one set of numbers.
            recordTrade,
        },

        /**
         * Read-only handles on the engine's internals.
         *
         * Everything above is closed over, which is what keeps three apps from
         * treading on each other — but a trading bot has to be inspectable, both
         * from the browser console and from the headless checks that exercise
         * the settlement and path logic without spending real contracts.
         * Nothing here is used by the apps themselves.
         */
        debug: {
            get config() { return CFG; },
            get liveContract() { return liveContract; },
            get pivots() { return pivots; },
            get quotable() { return quotable; },
            setLiveContract(contract) { liveContract = contract; },
            trackPath,
            touchProgress,
            proposalRequest,
            barrierOffsetFor,
            renderOpenContract,
            addHistoryRow,
            calculateZigZag,
            directionFromPivot,
            describeBias,
            seedSeries(mid, pip = 0.01) {
                pipSize = pip;
                TS = []; BID = []; ASK = []; MID = [];
                for (const price of mid) {
                    TS.push(TS.length * 1000); MID.push(price);
                    BID.push(price - pip); ASK.push(price + pip);
                }
            },
        },
    };
}(window));
