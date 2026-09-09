// Hedge-cycle bot — two legs per candle, cut the weak one, ride the other.
//
// A DIFFERENT MACHINE from the swing bot in ../trade-engine.js. That one holds
// one contract and enters on confirmed pivots. This one holds two opposing
// contracts at once, enters on the clock, and exits one of them early. They
// share the socket, the symbol, the tick feed and the session totals, borrowed
// through TradeEngine.bridge.
//
// Every order here is a REAL order on the connected account, placed down the
// same proposal -> buy path as the manual RISE / FALL buttons. There is no
// simulation mode: if the page is connected to demo it trades demo, and if it is
// connected to real it trades real.
//
// The cycle, once armed:
//
//   T+0            buy CALL at the candle open
//   T+stagger      buy PUT, same stake, at whatever the spot has become
//   every frame    read both legs' live bid_price off proposal_open_contract
//   any time       if the weak leg's loss reaches the max-loss cap, SELL it
//   T+decideAt     otherwise, SELL whichever leg is behind on extension
//   expiry         the leg we kept always rides to settlement
//   next candle    scan again, repeat
//
// It does not disarm itself. No stop-loss, no take-profit, no streak guard —
// only the Stop button ends it. That is deliberate, and worth knowing before
// leaving it running unattended.
//
// Both legs are posted into the page's session totals and history as they
// settle, exactly like a manually bought contract, so the numbers at the bottom
// of the page cover everything this account did.
//
// Confirmed against the live gateway on R_100:
//   - Rise/Fall intraday duration floor is 15s; 45s quotes fine.
//   - Resale is withheld near expiry, so the last sellable moment is taken as
//     duration - 15s. A cut that misses that window simply does not happen and
//     the leg rides — the cycle stays valid, just unhedged from there.
//   - `sell` takes a FLOOR price, not a target. 0 means "at market".

(function (global) {
    'use strict';

    const FRAME_MS = 250;           // decision cadence, independent of tick arrivals
    const SELL_BLACKOUT_SEC = 15;   // Deriv stops quoting resale this close to expiry
    const SELL_RETRY_MS = 2000;     // backoff after a refused resale
    const MIN_STAKE = 0.35;

    let cfg = null;
    let armed = false;
    let loopTimer = null;
    let nextCycleAt = null;
    let cycle = null;
    let cycleCount = 0;
    let cyclesBooked = 0;
    let pairPeak = 0;

    const dom = {};

    // =======================================================================
    // Config
    // =======================================================================

    function readConfig() {
        const stake = Number(dom.stake.value);
        const durationSec = Number(dom.duration.value);
        const tfMin = Number(dom.timeframe.value);
        const stagger = Number(dom.stagger.value);
        const decideAt = Number(dom.decideAt.value);
        const maxLossPct = Number(dom.maxLoss.value);

        if (!(stake >= MIN_STAKE)) throw new Error(`Stake per leg must be at least ${MIN_STAKE}.`);
        if (!(durationSec >= 15)) throw new Error('Rise/Fall has a 15-second intraday floor.');

        const tfSec = tfMin * 60;
        // Both legs must finish inside the candle, or the next cycle would open
        // while this one is still running and the leg bookkeeping would interleave.
        if (durationSec + stagger > tfSec) {
            throw new Error(
                `${durationSec}s duration + ${stagger}s stagger does not fit inside a ` +
                `${tfMin}m candle (${tfSec}s). Shorten the duration or widen the timeframe.`,
            );
        }
        if (!(stagger >= 0 && stagger < durationSec)) throw new Error('Stagger must be under the duration.');
        if (!(decideAt > stagger)) throw new Error('Decision time must be after the second leg opens.');

        const sellDeadline = durationSec - SELL_BLACKOUT_SEC;
        if (decideAt > sellDeadline) {
            throw new Error(
                `Deciding at ${decideAt}s is inside the resale blackout — Deriv stops quoting a sell ` +
                `in the last ${SELL_BLACKOUT_SEC}s, so the last sellable moment is ${sellDeadline}s.`,
            );
        }
        if (!(maxLossPct > 0 && maxLossPct < 100)) throw new Error('Max loss must be between 0 and 100%.');

        return {
            stake,
            durationSec,
            tfMs: tfSec * 1000,
            stagger,
            decideAt,
            maxLossPct,
            maxLoss: stake * (maxLossPct / 100),
            sellDeadline,
        };
    }

    // =======================================================================
    // Legs
    // =======================================================================

    function makeLeg(dir, entrySpot, entryAt) {
        return {
            dir,
            type: dir === 'up' ? 'CALL' : 'PUT',
            contractId: null,
            entrySpot,          // provisional; the contract stream overwrites it
            entryAt,
            bid: null,
            sold: false,
            selling: false,
            settled: false,
            booked: false,
            stopStream: null,
        };
    }

    /**
     * How far spot has travelled in this leg's favour, in pips.
     *
     * Both legs are measured against the SAME spot, so up + down is a constant —
     * the gap the stagger opened between the two entry spots. Whichever is
     * larger is the side with more extension, and that is the side we keep.
     */
    function extensionPips(leg, spot) {
        const pip = TradeEngine.bridge.pipSize || 0.01;
        return (leg.dir === 'up' ? spot - leg.entrySpot : leg.entrySpot - spot) / pip;
    }

    // =======================================================================
    // Cycle
    // =======================================================================

    function scheduleNextCycle() {
        if (!armed) return;
        // Clock-aligned to the real candle boundary, not "one timeframe after
        // whenever the last cycle happened to finish".
        nextCycleAt = Math.ceil(Date.now() / cfg.tfMs) * cfg.tfMs;
        setStatus(`Armed — next cycle at ${new Date(nextCycleAt).toLocaleTimeString()}.`);
    }

    async function openCycle() {
        cycleCount++;
        cycle = {
            index: cycleCount,
            startedAt: Date.now(),
            legs: {},
            cutDir: null,
            cutReason: null,
            cutExtension: null,
            booked: false,
        };

        try {
            const spotNow = TradeEngine.bridge.spot;
            if (!Number.isFinite(spotNow)) throw new Error('No spot price yet — waiting for ticks.');

            cycle.legs.up = makeLeg('up', spotNow, Date.now());
            await openLeg(cycle.legs.up);

            // The second leg deliberately enters LATER, at whatever the spot has
            // become. That gap is what makes both-win and both-lose possible.
            setTimeout(() => {
                if (!armed || !cycle || cycle.booked) return;
                const spotThen = TradeEngine.bridge.spot;
                cycle.legs.down = makeLeg('down', spotThen, Date.now());
                openLeg(cycle.legs.down).catch(async (error) => {
                    // One leg open and the other refused is an unhedged position,
                    // which is not the strategy. Close what we got and skip.
                    log(`Cycle ${cycle.index}: second leg failed (${error.message}). Closing the first.`, 'error');
                    delete cycle.legs.down;
                    await abortCycle();
                });
            }, cfg.stagger * 1000);
        } catch (error) {
            log(`Cycle ${cycleCount} could not open: ${error.message}`, 'error');
            cycle = null;
            scheduleNextCycle();
        }
    }

    /** Same proposal -> buy path the manual RISE / FALL buttons use. */
    async function openLeg(leg) {
        const socket = TradeEngine.bridge.socket;
        if (!socket?.isOpen) throw new Error('Not connected.');

        const { proposal } = await socket.send({
            proposal: 1,
            amount: cfg.stake,
            basis: 'stake',
            currency: TradeEngine.bridge.currency,
            contract_type: leg.type,
            underlying_symbol: TradeEngine.bridge.symbol,
            duration: cfg.durationSec,
            duration_unit: 's',
        });

        // Pay at most the quoted ask — the server rejects anything cheaper.
        const { buy } = await socket.send({ buy: proposal.id, price: proposal.ask_price });
        leg.contractId = buy.contract_id;

        leg.stopStream = socket.subscribe(
            { proposal_open_contract: 1, contract_id: leg.contractId },
            (msg, error) => {
                if (error) { log(`Leg ${leg.type}: ${error.message}`, 'error'); return; }
                const c = msg?.proposal_open_contract;
                if (!c) return;

                if (Number.isFinite(Number(c.bid_price))) leg.bid = Number(c.bid_price);
                const entry = c.entry_spot ?? c.entry_tick;
                if (Number.isFinite(Number(entry))) leg.entrySpot = Number(entry);

                const done = c.is_sold === 1 || c.is_expired === 1
                    || ['won', 'lost', 'sold'].includes(c.status);
                // The stream repeats its final frame, so settlement is latched.
                if (done && !leg.settled) {
                    leg.settled = true;
                    leg.profit = Number(c.profit) || 0;
                    leg.contract = c;
                    if (leg.stopStream) { leg.stopStream(); leg.stopStream = null; }
                }
            },
        );
    }

    /** One leg opened and the other did not — unwind rather than run unhedged. */
    async function abortCycle() {
        for (const leg of Object.values(cycle?.legs || {})) {
            if (leg.contractId && !leg.sold && !leg.settled) {
                try { await TradeEngine.bridge.socket.sell(leg.contractId); } catch { /* rides to expiry */ }
            }
        }
        // The legs keep their streams so they still settle and book normally.
        cycle = null;
        scheduleNextCycle();
    }

    // =======================================================================
    // The exit decision
    // =======================================================================

    function evaluateCycle(now) {
        const { up, down } = cycle.legs;
        if (!up || !down) return;                    // still staggering
        if (cycle.cutDir || cycle.booked) return;    // already cut

        const spot = TradeEngine.bridge.spot;
        if (!Number.isFinite(spot)) return;

        const elapsed = (now - up.entryAt) / 1000;

        // Only meaningful while the pair is genuinely EXITABLE. Once a leg
        // expires its value jumps to the full payout while the other still has
        // time value, and an ungated reading sails past 140% at a moment when
        // nothing could have been sold.
        const exitable = !up.settled && !down.settled && elapsed <= cfg.sellDeadline;

        if (exitable && Number.isFinite(up.bid) && Number.isFinite(down.bid)) {
            pairPeak = Math.max(pairPeak, (up.bid + down.bid) / (2 * cfg.stake));
        }

        const upExt = extensionPips(up, spot);
        const dnExt = extensionPips(down, spot);
        const strong = upExt >= dnExt ? up : down;
        const weak = strong === up ? down : up;

        cycle.strongDir = strong.dir;
        cycle.extension = Math.max(upExt, dnExt);

        if (!exitable) return;

        // Two conditions, and the max-loss cap is the one that runs continuously.
        // A large extension is exactly when the weak leg is already deep under
        // water, so in practice the cap almost always fires first — which is the
        // point of having it.
        const loss = Number.isFinite(weak.bid) ? cfg.stake - weak.bid : null;

        if (loss !== null && loss >= cfg.maxLoss) {
            cutLeg(weak, 'max-loss');
        } else if (elapsed >= cfg.decideAt) {
            cutLeg(weak, 'decision');
        }
    }

    async function cutLeg(leg, reason) {
        if (leg.selling || leg.sold || leg.settled) return;
        // A refused sell is retried, but not at the 4Hz the decision loop runs
        // at — Deriv withholds resale for seconds at a time during a fast move,
        // and hammering it would be a request storm for no benefit.
        if (leg.retryAfter && Date.now() < leg.retryAfter) return;
        leg.selling = true;

        cycle.cutDir = leg.dir;
        cycle.cutReason = reason;
        cycle.cutExtension = cycle.extension;

        try {
            // Floor of 0: at market. The position has to go regardless of price,
            // and a rejected sell here would leave it running unhedged.
            const result = await TradeEngine.bridge.socket.sell(leg.contractId, { minPrice: 0 });
            leg.sold = true;
            log(
                `Cycle ${cycle.index}: cut ${leg.type} at ${result.soldFor.toFixed(2)} ` +
                `(loss ${(cfg.stake - result.soldFor).toFixed(2)}, ${reason}).`,
                'ok',
            );
        } catch (error) {
            // Resale refused. The leg is untouched and settles on its own — the
            // cycle is still valid, just unhedged from here.
            cycle.cutReason = 'refused';
            cycle.cutDir = null;                     // let the rule try again
            leg.retryAfter = Date.now() + SELL_RETRY_MS;
            log(`Cycle ${cycle.index}: could not cut ${leg.type} — ${error.message}`, 'error');
        } finally {
            leg.selling = false;
        }
    }

    // =======================================================================
    // Booking
    // =======================================================================

    /**
     * Post each settled leg into the page's session totals and history.
     *
     * Per leg, not per cycle: these are two real contracts on the account and
     * they belong in the table the same way a manual buy does.
     */
    function bookSettledLegs() {
        for (const leg of Object.values(cycle.legs)) {
            if (!leg.settled || leg.booked) continue;
            leg.booked = true;
            TradeEngine.bridge.recordTrade(leg.contract, leg.profit, leg.profit > 0);
        }
    }

    function closeCycle() {
        cycle.booked = true;
        cyclesBooked++;
        for (const leg of Object.values(cycle.legs)) {
            if (leg.stopStream) { leg.stopStream(); leg.stopStream = null; }
        }
        cycle = null;
        scheduleNextCycle();   // straight back round. Only Stop ends this.
    }

    // =======================================================================
    // Main loop
    // =======================================================================

    function loop() {
        // Stopped, and the last cycle has finished settling — stand the loop down
        // rather than leaving an interval running for the life of the page.
        if (!armed && !cycle) {
            clearInterval(loopTimer);
            loopTimer = null;
            setStatus('Stopped.');
            return;
        }
        const now = Date.now();

        if (!cycle) {
            if (nextCycleAt && now >= nextCycleAt) { nextCycleAt = null; openCycle(); }
            renderMonitor(now);
            return;
        }

        evaluateCycle(now);
        bookSettledLegs();

        const legs = Object.values(cycle.legs);
        if (legs.length === 2 && legs.every((leg) => leg.settled)) closeCycle();

        renderMonitor(now);
    }

    // =======================================================================
    // Arm / disarm
    // =======================================================================

    function arm() {
        try {
            cfg = readConfig();
        } catch (error) {
            log(error.message, 'error');
            return;
        }

        if (!TradeEngine.bridge.socket?.isOpen) { log('Not connected yet.', 'error'); return; }
        if (!TradeEngine.bridge.isAuthed) {
            log('This places real orders, so it needs a token. Preview mode cannot buy.', 'error');
            return;
        }

        armed = true;
        dom.start.disabled = true;
        dom.stop.disabled = false;
        setConfigDisabled(true);
        clearInterval(loopTimer);
        loopTimer = setInterval(loop, FRAME_MS);
        scheduleNextCycle();

        log(
            `Hedge cycle armed — ${cfg.stake} per leg, ${cfg.durationSec}s contracts every ` +
            `${cfg.tfMs / 60000}m, decision at ${cfg.decideAt}s, max loss ${cfg.maxLossPct}% ` +
            `(${cfg.maxLoss.toFixed(2)}). Real orders. It will not stop on its own.`,
            'ok',
        );
    }

    function disarm() {
        armed = false;
        nextCycleAt = null;
        dom.start.disabled = false;
        dom.stop.disabled = true;
        setConfigDisabled(false);

        // A cycle in flight keeps its contracts — they are real money and killing
        // the loop would not close them. Let it finish, book, then stand down.
        if (cycle && !cycle.booked) {
            setStatus('Stopped. The open cycle will finish and book, then nothing further.');
        } else {
            clearInterval(loopTimer);
            loopTimer = null;
            setStatus('Stopped.');
        }
    }

    // =======================================================================
    // Rendering
    // =======================================================================

    const plain = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');

    function setStatus(text) { dom.status.textContent = text; }

    function log(message, kind = 'info') {
        setStatus(message);
        TradeEngine.bridge.notify(message, kind);
    }

    function setConfigDisabled(disabled) {
        for (const key of ['stake', 'duration', 'timeframe', 'stagger', 'decideAt', 'maxLoss']) {
            dom[key].disabled = disabled;
        }
    }

    function renderMonitor(now) {
        if (!cycle) {
            dom.phase.textContent = armed && nextCycleAt
                ? `Waiting — ${Math.max(0, Math.ceil((nextCycleAt - now) / 1000))}s to next candle`
                : 'Idle';
            dom.clock.textContent = '—';
            for (const k of ['upEntry', 'upBid', 'dnEntry', 'dnBid', 'strong', 'ext']) dom[k].textContent = '—';
            dom.cycles.textContent = cyclesBooked;
            return;
        }

        const { up, down } = cycle.legs;
        const elapsed = up ? (now - up.entryAt) / 1000 : 0;

        dom.phase.textContent = `Cycle ${cycle.index}`
            + (cycle.cutDir ? ` — cut ${cycle.cutDir === 'up' ? 'CALL' : 'PUT'} (${cycle.cutReason})` : ' — both open');
        dom.clock.textContent = `${elapsed.toFixed(1)}s / ${cfg.durationSec}s`;
        dom.upEntry.textContent = up ? TradeEngine.bridge.fmt(up.entrySpot) : '—';
        dom.upBid.textContent = up ? plain(up.bid) : '—';
        dom.dnEntry.textContent = down ? TradeEngine.bridge.fmt(down.entrySpot) : '—';
        dom.dnBid.textContent = down ? plain(down.bid) : '—';
        dom.strong.textContent = cycle.strongDir ? (cycle.strongDir === 'up' ? 'CALL' : 'PUT') : '—';
        dom.ext.textContent = Number.isFinite(cycle.extension) ? `${cycle.extension.toFixed(1)} pips` : '—';
        dom.cycles.textContent = cyclesBooked;

        const sum = (up?.bid ?? NaN) + (down?.bid ?? NaN);
        dom.bidsum.textContent = Number.isFinite(sum)
            ? `${sum.toFixed(2)} / ${(2 * cfg.stake).toFixed(2)}  (${(100 * sum / (2 * cfg.stake)).toFixed(1)}%)`
            : '—';
        dom.peak.textContent = pairPeak ? `peak ${(100 * pairPeak).toFixed(1)}%` : '';
    }

    // =======================================================================
    // Wiring
    // =======================================================================

    function init() {
        const el = (id) => document.getElementById(id);
        Object.assign(dom, {
            stake: el('hc-stake'), duration: el('hc-duration'), timeframe: el('hc-timeframe'),
            stagger: el('hc-stagger'), decideAt: el('hc-decide-at'), maxLoss: el('hc-maxloss'),
            start: el('hc-start'), stop: el('hc-stop'), status: el('hc-status'),
            phase: el('hc-phase'), clock: el('hc-clock'), cycles: el('hc-cycles'),
            upEntry: el('hc-up-entry'), upBid: el('hc-up-bid'),
            dnEntry: el('hc-dn-entry'), dnBid: el('hc-dn-bid'),
            strong: el('hc-strong'), ext: el('hc-ext'),
            bidsum: el('hc-bidsum'), peak: el('hc-peak'),
        });

        dom.start.addEventListener('click', arm);
        dom.stop.addEventListener('click', disarm);

        // Buying needs a token, so the control stays out of reach until the page
        // has an authenticated session.
        TradeEngine.bridge.onSession(({ mode }) => {
            dom.start.disabled = mode !== 'authed';
            setStatus(mode === 'authed'
                ? 'Ready. Arming places real orders on the connected account.'
                : 'Connect with a token — this bot places real orders and cannot run in preview.');
        });
    }

    global.HedgeCycle = {
        init,
        get cycle() { return cycle; },
        get cyclesBooked() { return cyclesBooked; },
        get pairPeak() { return pairPeak; },
    };
}(window));
