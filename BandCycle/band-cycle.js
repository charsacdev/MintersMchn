// Band-cycle bot — both legs at the candle open, both ride to expiry.
//
// The simplest machine in this folder, and deliberately so. There is no signal,
// no structure gate, no cooldown, no early exit. A candle opens; it buys HIGHER
// at +offset and LOWER at -offset in the same instant; both contracts run to
// settlement untouched; the cycle is counted; the next candle opens and it goes
// again.
//
//   T+0         buy HIGHER barrier "+0.2" and LOWER barrier "-0.2", together
//   ...         nothing. Neither leg is sold, watched for a cut, or hedged.
//   T+duration  both settle. Book both, count the cycle.
//   next candle repeat.
//
// A DIFFERENT MACHINE from ../RiseFall/hedge-cycle.js: that one staggers the
// legs and sells whichever is behind. This one does neither. It shares the
// socket, symbol, tick feed and session totals through TradeEngine.bridge the
// same way.
//
// Every order is a REAL order on the connected account, down the same
// proposal -> buy path as the manual HIGHER / LOWER buttons. There is no
// simulation mode: a demo account trades demo, a real account trades real.
//
// What the offset does to the outcome set. Both legs settle against their own
// barrier at expiry, so exactly three things can happen:
//
//   exit > entry + offset    HIGHER wins, LOWER loses
//   exit < entry - offset    LOWER wins, HIGHER loses
//   in between               BOTH lose  <- the band. This is the whole cost.
//
// Both legs can never win. At offset 0 the pair is the plain hedge — one leg
// always wins and the loss is pure spread. Every unit of offset trades some of
// that certainty for a bigger payout on the winner, and the band is what you
// pay for it. So the number that decides whether the offset bought anything is
// the BAND RATE, and it is on the panel for exactly that reason.
//
// WHY CYCLES OVERLAP. At the setting this was built for — a 60s contract on a
// 1m candle — the contract fills the whole candle, so it cannot possibly settle
// before the next candle opens. A loop that waited for settlement before
// rescheduling would land just PAST the boundary every time and skip to the one
// after, quietly trading every OTHER candle at half the cycle count. So the
// clock is decoupled from settlement: the next cycle is scheduled the moment
// the current one opens, and cycles in flight are tracked in a list. Two
// briefly coexist while the older pair settles. Each books independently.
//
// It does not disarm itself. No stop-loss, no take-profit, no streak guard —
// only the Stop button ends it.
//
// Confirmed against the live gateway on R_100:
//   - `barrier` must be a signed STRING offset ("+0.2"); a number is rejected
//     with "Invalid barrier".
//   - HIGHER/LOWER intraday floor is 15s, so a 60s contract inside a 1m candle
//     is legal. Touch/No Touch could NOT do this — its floor is 120s.
//   - Either leg can be priced out on its own ("This contract offers no
//     return") while the other quotes fine, which is why a half-open cycle is
//     unwound rather than left to run naked.

(function (global) {
    'use strict';

    const FRAME_MS = 250;         // panel/settlement cadence, independent of tick arrivals
    const MIN_STAKE = 0.35;
    const MIN_DURATION_SEC = 15;  // HIGHER/LOWER intraday floor
    // "The barrier offset can not have more than 2 decimal places." — gateway.
    const MAX_OFFSET_DECIMALS = 2;

    let cfg = null;
    let armed = false;
    let loopTimer = null;
    let nextCycleAt = null;

    // Cycles in flight. Usually one; briefly two while an expiring pair settles
    // and the next candle has already opened. See the header.
    let active = [];

    let cycleCount = 0;    // cycles opened
    let cyclesBooked = 0;  // cycles fully settled and counted
    let higherWins = 0;
    let lowerWins = 0;
    let bandHits = 0;      // both legs lost — exit finished inside the band
    let bothWon = 0;       // cannot happen at expiry; tracked so it is visible if it ever does
    let cycleNet = 0;      // net across both legs, all booked cycles

    const dom = {};

    // =======================================================================
    // Config
    // =======================================================================

    /**
     * Decimal places a barrier offset may carry.
     *
     * The gateway refuses more than two outright, and the symbol's own pip may
     * be coarser still, so take whichever is stricter. An offset like 0.378 is
     * rejected before the contract is ever priced.
     */
    function offsetDecimals() {
        const pip = TradeEngine.bridge.pipSize || 0.01;
        const fromPip = Math.max(0, Math.round(-Math.log10(pip)));
        return Math.min(fromPip, MAX_OFFSET_DECIMALS);
    }

    /** Snap an offset onto the grid the gateway will actually accept. */
    function quantiseOffset(raw) {
        const d = offsetDecimals();
        const step = 10 ** -d;
        return Number((Math.round(raw / step) * step).toFixed(d));
    }

    function readConfig() {
        const stake = Number(dom.stake.value);
        const requested = Math.abs(Number(dom.offset.value));
        const durationSec = Number(dom.duration.value);
        const tfMin = Number(dom.timeframe.value);

        if (!(stake >= MIN_STAKE)) throw new Error(`Stake per leg must be at least ${MIN_STAKE}.`);
        if (!(requested > 0)) throw new Error('Barrier offset must be greater than zero.');
        if (!(durationSec >= MIN_DURATION_SEC)) {
            throw new Error(`Higher/Lower has a ${MIN_DURATION_SEC}-second intraday floor.`);
        }

        const tfSec = tfMin * 60;
        // At most two cycles may coexist, which is what a contract exactly as
        // long as the candle produces. Longer than the candle would stack three
        // or more and turn the "cycle" into something this panel cannot describe.
        if (durationSec > tfSec) {
            throw new Error(
                `A ${durationSec}s contract is longer than a ${tfMin}m candle (${tfSec}s), which would ` +
                'stack three or more cycles at once. Shorten the duration or widen the timeframe.',
            );
        }

        const offset = quantiseOffset(requested);
        if (!(offset > 0)) {
            throw new Error(
                `An offset of ${requested} rounds to zero at ${offsetDecimals()} decimal places. ` +
                `The smallest the gateway accepts here is ${(10 ** -offsetDecimals()).toFixed(offsetDecimals())}.`,
            );
        }

        return { stake, offset, requested, durationSec, tfMs: tfSec * 1000, tfMin, tfSec };
    }

    // =======================================================================
    // Legs
    // =======================================================================

    function makeLeg(dir) {
        return {
            dir,
            type: dir === 'up' ? 'HIGHER' : 'LOWER',
            // HIGHER sits above spot, LOWER below it. The signed string is what
            // the API wants; a number comes back "Invalid barrier".
            barrier: `${dir === 'up' ? '+' : '-'}${cfg.offset}`,
            contractId: null,
            entrySpot: null,
            barrierPrice: null,
            bid: null,
            settled: false,
            booked: false,
            won: false,
            profit: 0,
            contract: null,
            stopStream: null,
        };
    }

    /** Same proposal -> buy path the manual HIGHER / LOWER buttons use. */
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
            barrier: leg.barrier,
        });

        // Pay at most the quoted ask — the server rejects anything cheaper.
        const { buy } = await socket.send({ buy: proposal.id, price: proposal.ask_price });
        leg.contractId = buy.contract_id;
        leg.payout = Number(proposal.payout) || null;

        leg.stopStream = socket.subscribe(
            { proposal_open_contract: 1, contract_id: leg.contractId },
            (msg, error) => {
                if (error) { log(`Leg ${leg.type}: ${error.message}`, 'error'); return; }
                const c = msg?.proposal_open_contract;
                if (!c) return;

                const entry = c.entry_spot ?? c.entry_tick;
                if (Number.isFinite(Number(entry))) leg.entrySpot = Number(entry);
                // The proposal does not echo a barrier back, so the absolute
                // level is only authoritative once the contract stream sends it.
                if (Number.isFinite(Number(c.barrier))) leg.barrierPrice = Number(c.barrier);
                if (Number.isFinite(Number(c.bid_price))) leg.bid = Number(c.bid_price);

                const done = c.is_sold === 1 || c.is_expired === 1
                    || ['won', 'lost', 'sold'].includes(c.status);
                // The stream repeats its final frame, so settlement is latched.
                if (done && !leg.settled) {
                    leg.settled = true;
                    leg.profit = Number(c.profit) || 0;
                    leg.won = c.status === 'won';
                    leg.contract = c;
                    leg.exitSpot = Number(c.exit_tick ?? c.current_spot);
                    if (leg.stopStream) { leg.stopStream(); leg.stopStream = null; }
                }
            },
        );
    }

    // =======================================================================
    // Cycle
    // =======================================================================

    /**
     * The next candle boundary, strictly in the future.
     *
     * floor + one timeframe rather than ceil: this is called from the instant a
     * cycle opens, which IS a boundary, and ceil would return that same instant
     * and fire again immediately.
     */
    function scheduleNextCycle() {
        if (!armed) { nextCycleAt = null; return; }
        nextCycleAt = Math.floor(Date.now() / cfg.tfMs) * cfg.tfMs + cfg.tfMs;
    }

    async function openCycle() {
        cycleCount++;
        const cycle = {
            index: cycleCount,
            startedAt: Date.now(),
            openSpot: TradeEngine.bridge.spot,
            legs: {},
            booked: false,
            outcome: null,
        };
        active.push(cycle);

        const up = makeLeg('up');
        const down = makeLeg('down');
        cycle.legs.up = up;
        cycle.legs.down = down;

        // Fired together rather than in sequence — the whole point of the
        // structure is that both legs price against the same moment. allSettled
        // so one refusal does not abandon the other leg's buy half-completed.
        const results = await Promise.allSettled([openLeg(up), openLeg(down)]);
        const failed = results.filter((r) => r.status === 'rejected');

        if (failed.length === 0) {
            log(
                `Cycle ${cycle.index}: HIGHER ${up.barrier} + LOWER ${down.barrier}, ` +
                `${cfg.stake} each, ${cfg.durationSec}s.`,
                'ok',
            );
            return;
        }

        // One leg open and the other refused is a naked directional position,
        // which is not this strategy. Close what got through and drop the cycle.
        const why = failed.map((r) => r.reason?.message || 'rejected').join('; ');
        log(`Cycle ${cycle.index}: leg refused (${why}). Unwinding.`, 'error');
        await abortCycle(cycle);
    }

    /** One leg opened and the other did not — unwind rather than run naked. */
    async function abortCycle(cycle) {
        for (const leg of Object.values(cycle.legs)) {
            if (leg.contractId && !leg.settled) {
                // Floor of 0: at market. If resale is refused the leg simply
                // rides to expiry; either way this cycle is not counted.
                try {
                    await TradeEngine.bridge.socket.sell(leg.contractId, { minPrice: 0 });
                } catch { /* unsellable — it rides */ }
            }
            if (leg.stopStream) { leg.stopStream(); leg.stopStream = null; }
        }
        cycle.booked = true;
        drop(cycle);
    }

    function drop(cycle) {
        active = active.filter((c) => c !== cycle);
    }

    // =======================================================================
    // Booking
    // =======================================================================

    /**
     * Post each settled leg into the page's session totals and history.
     *
     * Per leg, not per cycle: these are two real contracts on the account and
     * they belong in that table the same way a manual buy does. The cycle-level
     * counters below are separate, and are the ones that describe the strategy.
     */
    function bookSettledLegs(cycle) {
        for (const leg of Object.values(cycle.legs)) {
            if (!leg.settled || leg.booked) continue;
            leg.booked = true;
            TradeEngine.bridge.recordTrade(leg.contract, leg.profit, leg.won);
        }
    }

    function closeCycle(cycle) {
        const { up, down } = cycle.legs;
        cycle.booked = true;
        cyclesBooked++;

        // Three reachable outcomes. The fourth is a tell that something is not
        // what this bot assumes about settlement — see the header.
        if (up.won && down.won) { bothWon++; cycle.outcome = 'both won'; }
        else if (up.won) { higherWins++; cycle.outcome = 'HIGHER'; }
        else if (down.won) { lowerWins++; cycle.outcome = 'LOWER'; }
        else { bandHits++; cycle.outcome = 'band — both lost'; }

        const net = up.profit + down.profit;
        cycleNet += net;

        log(
            `Cycle ${cycle.index} closed: ${cycle.outcome}, ` +
            `net ${net >= 0 ? '+' : ''}${net.toFixed(2)} ${TradeEngine.bridge.currency}.`,
            net >= 0 ? 'ok' : 'info',
        );

        for (const leg of Object.values(cycle.legs)) {
            if (leg.stopStream) { leg.stopStream(); leg.stopStream = null; }
        }
        drop(cycle);
    }

    // =======================================================================
    // Main loop
    // =======================================================================

    function loop() {
        const now = Date.now();

        // Scheduled BEFORE the buy so a slow proposal round-trip cannot drag the
        // clock: the candle grid is absolute, not relative to how long a fill took.
        if (armed && nextCycleAt !== null && now >= nextCycleAt) {
            scheduleNextCycle();
            openCycle();
        }

        for (const cycle of active) bookSettledLegs(cycle);
        for (const cycle of [...active]) {
            const legs = Object.values(cycle.legs);
            if (legs.length === 2 && legs.every((leg) => leg.settled)) closeCycle(cycle);
        }

        // Stopped, and the last cycle has finished settling — stand the loop
        // down rather than leave an interval running for the life of the page.
        if (!armed && !active.length) {
            clearInterval(loopTimer);
            loopTimer = null;
            setStatus('Stopped.');
        }

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

        const snapped = cfg.offset !== cfg.requested
            ? ` (${cfg.requested} snapped to ${cfg.offset} — the gateway caps offsets at ${offsetDecimals()} dp)`
            : '';
        const overlaps = cfg.durationSec === cfg.tfSec;
        log(
            `Band cycle armed — HIGHER +${cfg.offset} and LOWER -${cfg.offset}${snapped}, ${cfg.stake} per leg, ` +
            `${cfg.durationSec}s contracts every ${cfg.tfMin}m. Both ride to expiry.` +
            (overlaps
                ? ' The contract fills the whole candle, so each pair settles just after the next opens.'
                : '') +
            ' Real orders. It will not stop on its own.',
            'ok',
        );
    }

    function disarm() {
        armed = false;
        nextCycleAt = null;
        dom.start.disabled = false;
        dom.stop.disabled = true;
        setConfigDisabled(false);

        // Cycles in flight keep their contracts — they are real money and killing
        // the loop would not close them. Let them finish, book, then stand down.
        if (active.length) {
            setStatus(`Stopped. ${active.length} open cycle${active.length > 1 ? 's' : ''} ` +
                'will finish and book, then nothing further.');
        } else {
            clearInterval(loopTimer);
            loopTimer = null;
            setStatus('Stopped.');
        }
    }

    // =======================================================================
    // Rendering
    // =======================================================================

    function setStatus(text) { dom.status.textContent = text; }

    function log(message, kind = 'info') {
        setStatus(message);
        TradeEngine.bridge.notify(message, kind);
    }

    function setConfigDisabled(disabled) {
        for (const key of ['stake', 'offset', 'duration', 'timeframe']) dom[key].disabled = disabled;
    }

    function renderMonitor(now) {
        const fmt = TradeEngine.bridge.fmt;

        // Shown whether or not it changed: the value actually sent to the
        // gateway should never have to be inferred from a log line.
        if (dom.effective) {
            const raw = Number(dom.offset.value);
            const eff = Number.isFinite(raw) && raw > 0 ? quantiseOffset(Math.abs(raw)) : null;
            dom.effective.textContent = eff === null
                ? 'Barrier —'
                : `Sends ±${eff.toFixed(offsetDecimals())}` +
                  (eff !== Math.abs(raw) ? `  (${raw} → ${eff}, max ${offsetDecimals()} dp)` : '');
            dom.effective.className = eff !== null && eff !== Math.abs(raw) ? 'muted warn' : 'muted';
        }

        dom.cycles.textContent = cyclesBooked;
        dom.higher.textContent = higherWins;
        dom.lower.textContent = lowerWins;
        dom.band.textContent = bandHits + (bothWon ? ` (+${bothWon} both-won?)` : '');

        // The number the offset lives or dies by, so it is stated as a rate
        // rather than left as a raw count to be divided by eye.
        dom.bandrate.textContent = cyclesBooked
            ? `${((bandHits / cyclesBooked) * 100).toFixed(1)}%  (${bandHits} of ${cyclesBooked})`
            : '—';

        dom.net.textContent = cyclesBooked
            ? `${cycleNet >= 0 ? '+' : ''}${cycleNet.toFixed(2)}  ` +
              `(${cycleNet >= 0 ? '+' : ''}${(cycleNet / cyclesBooked).toFixed(3)} per cycle)`
            : '—';
        dom.net.className = `v sm ${cycleNet >= 0 ? 'up' : 'dn'}`;

        // The newest cycle is the one the leg readouts describe — an older pair
        // sitting in settlement has nothing left to watch.
        const cycle = active[active.length - 1];

        if (!cycle) {
            dom.phase.textContent = armed && nextCycleAt
                ? `Waiting — ${Math.max(0, Math.ceil((nextCycleAt - now) / 1000))}s to next candle`
                : 'Idle';
            dom.clock.textContent = '—';
            for (const k of ['upEntry', 'upBarrier', 'dnEntry', 'dnBarrier']) dom[k].textContent = '—';
            return;
        }

        const { up, down } = cycle.legs;
        const elapsed = (now - cycle.startedAt) / 1000;
        const settledCount = Object.values(cycle.legs).filter((leg) => leg.settled).length;

        dom.phase.textContent = `Cycle ${cycle.index} — `
            + (settledCount === 0 ? 'both open' : `${settledCount} of 2 settled`)
            + (active.length > 1 ? ` · ${active.length - 1} settling` : '');
        dom.clock.textContent = `${elapsed.toFixed(1)}s / ${cfg.durationSec}s`;
        dom.upEntry.textContent = fmt(up?.entrySpot);
        dom.upBarrier.textContent = up?.barrierPrice != null ? fmt(up.barrierPrice) : (up?.barrier || '—');
        dom.dnEntry.textContent = fmt(down?.entrySpot);
        dom.dnBarrier.textContent = down?.barrierPrice != null ? fmt(down.barrierPrice) : (down?.barrier || '—');
    }

    // =======================================================================
    // Wiring
    // =======================================================================

    function init() {
        const el = (id) => document.getElementById(id);
        Object.assign(dom, {
            stake: el('bc-stake'), offset: el('bc-offset'),
            duration: el('bc-duration'), timeframe: el('bc-timeframe'),
            effective: el('bc-effective'),
            start: el('bc-start'), stop: el('bc-stop'), status: el('bc-status'),
            phase: el('bc-phase'), clock: el('bc-clock'), cycles: el('bc-cycles'),
            upEntry: el('bc-up-entry'), upBarrier: el('bc-up-barrier'),
            dnEntry: el('bc-dn-entry'), dnBarrier: el('bc-dn-barrier'),
            higher: el('bc-higher'), lower: el('bc-lower'), band: el('bc-band'),
            bandrate: el('bc-bandrate'), net: el('bc-net'),
        });

        dom.start.addEventListener('click', arm);
        dom.stop.addEventListener('click', disarm);
        dom.offset.addEventListener('input', () => renderMonitor(Date.now()));

        // Buying needs a token, so the control stays out of reach until the page
        // has an authenticated session.
        TradeEngine.bridge.onSession(({ mode }) => {
            dom.start.disabled = mode !== 'authed';
            setStatus(mode === 'authed'
                ? 'Ready. Arming places real orders on the connected account.'
                : 'Connect with a token — this bot places real orders and cannot run in preview.');
        });

        renderMonitor(Date.now());
    }

    global.BandCycle = {
        init,
        get active() { return active; },
        get cyclesBooked() { return cyclesBooked; },
        get tally() { return { higherWins, lowerWins, bandHits, bothWon, cycleNet }; },
        // Exposed for the headless check — the scheduler is the one piece whose
        // bug would be invisible until the cycle count came out half of what it
        // should be.
        _test: {
            setCfg(c) { cfg = c; },
            setArmed(a) { armed = a; },
            get nextCycleAt() { return nextCycleAt; },
            scheduleNextCycle,
        },
    };
}(window));
