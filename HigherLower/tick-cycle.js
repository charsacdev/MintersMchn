// Tick-cycle bot — two legs, simultaneous entry, re-enter on the next tick.
//
// Replaces the swing engine on this page. That one waited for a confirmed
// zigzag pivot and bought ONE leg with the structure. This one has no signal at
// all: it buys HIGHER at +offset and LOWER at -offset together, holds both to
// expiry, and the moment they settle it re-enters on the next tick. Nothing is
// read off the chart. It is a metronome.
//
//   tick N       buy HIGHER "+0.059" and LOWER "-0.059" together, 10 ticks
//   ...          both ride. Neither leg is sold, cut or hedged.
//   tick N+10    both settle. Book both, count the cycle.
//   tick N+11    straight back in.
//
// Strictly sequential — one cycle at a time, never overlapping, because the
// next entry is triggered BY the settlement of the last one. That is what makes
// "cycles completed" an honest count rather than a count of orders sent.
//
// Every order is a REAL order on the connected account, down the same
// proposal -> buy path as the manual HIGHER / LOWER buttons. There is no
// simulation mode: a demo account trades demo, a real account trades real.
//
// THE THREE OUTCOMES. Both legs settle against their own barrier at expiry:
//
//   exit > entry + offset    HIGHER wins, LOWER loses    net = payout - 2·stake
//   exit < entry - offset    LOWER wins, HIGHER loses    net = payout - 2·stake
//   in between               BOTH lose                   net = -2·stake
//
// Both legs can never win. Whether a winning cycle is positive at all depends
// entirely on whether the payout multiple clears 2.0 — at 2.013× on a $10 stake
// a win nets $0.13, and at 1.938× it nets -$0.74. The panel shows the live
// multiple next to the quote for exactly that reason.
//
// WHAT IS MEASURED, AND WHY. The strategy's throughput assumption is "43,000
// ticks a day, a 10-tick contract, therefore 4,300 cycles". That ignores two
// real costs, so both are counted rather than assumed:
//
//   Latency ticks — a proposal->buy round trip is 200-600ms and there are two
//                   of them. If the fill lands after the next tick has already
//                   arrived, the cycle is longer than 10 ticks. Counted.
//   Rejections    — a refused leg costs the whole cycle, since a single leg is
//                   a naked directional position and gets unwound. Counted.
//
// So the panel reports MEASURED ticks per cycle and projects the daily rate off
// that, instead of off the theoretical 10. The gap between the two is the cost
// of running this against a real gateway.
//
// Confirmed against the live gateway on R_100:
//   - `barrier` must be a signed STRING offset ("+0.059"); a number is rejected
//     with "Invalid barrier".
//   - HIGHER/LOWER tick durations are 5-10. 10 is the ceiling; 11 is rejected.
//   - The usable barrier range shrinks with duration — at 5 ticks only ±0.5
//     quotes and ±1.0 returns "This contract offers no return".
//   - A barrier OFFSET is capped at 2 DECIMAL PLACES: "+0.059" comes back
//     "The barrier offset can not have more than 2 decimal places." The Deriv
//     terminal accepts 0.059 because it sends an ABSOLUTE barrier price, which
//     is validated differently — but this API path sends a relative offset, so
//     the offset is quantised to the pip before it is ever sent, and the
//     effective value is shown in the panel rather than corrected silently.

(function (global) {
    'use strict';

    const FRAME_MS = 250;   // render + settlement cadence
    const MIN_STAKE = 0.35;
    const MIN_TICKS = 5;
    const MAX_TICKS = 10;
    // "The barrier offset can not have more than 2 decimal places." — gateway.
    const MAX_OFFSET_DECIMALS = 2;
    const MAX_CONTRACTS_PER_SIDE = 10;
    // Validation uses the FASTEST tick rate on the platform (the 1s indices) so
    // a stagger that would outlive the contract is rejected on every symbol.
    const FASTEST_TICK_MS = 1000;
    // While structure is being waited on, re-check this often rather than
    // burning a whole gap between looks.
    const STRUCTURE_RECHECK_MS = 1000;
    // Pivots needed before 'range' means anything. Below this the zigzag simply
    // has not seen enough of the market to call a trend either way.
    const MIN_PIVOTS = 2;
    // A cycle is given its expected duration plus this much slack before it is
    // treated as stuck. Settlement normally lands within a tick or two.
    const CYCLE_GRACE_MS = 20000;
    // Inter-tick intervals kept for the live tick-rate estimate. Enough to ride
    // out a couple of gaps without drifting.
    const TICK_SAMPLE = 20;

    let cfg = null;
    let armed = false;
    let loopTimer = null;

    // 'cooling' — armed, waiting out the gap before the next cycle
    // 'opening' — buys in flight
    // 'running' — every contract live
    let phase = 'idle';
    let cycle = null;
    let resumeAt = 0;       // wall clock the next cycle may open at
    // 0 = cycle A as configured, 1 = cycle B with the sides swapped.
    let parity = 0;

    let tickSeq = 0;        // ticks seen since the page connected
    let fireTick = 0;       // tickSeq when the current cycle was triggered

    let cyclesOpened = 0;
    let cyclesCompleted = 0;
    let winCycles = 0;      // exactly one leg won
    let bandCycles = 0;     // both lost
    let bothWon = 0;        // cannot happen at expiry; surfaced if it ever does
    let netProfit = 0;

    // Contracts a cycle gave up waiting on. They are real positions that did
    // settle on Deriv's side — the bot simply never heard. Counted, never faked.
    let unresolved = 0;
    let rescues = 0;
    const tickTimes = [];   // recent tick arrival times, for the rate estimate
    let skipEpisodes = 0;   // times a cycle was held back for lack of structure
    let waitingStructure = false;
    let legsWon = 0;        // individual contracts that settled as a win
    let legsLost = 0;
    let latencyTicks = 0;   // ticks lost between firing and both legs filling
    let rejections = 0;     // legs the gateway refused
    let abortedCycles = 0;  // cycles unwound because a leg was refused

    let firstFireAt = null; // wall clock of the first cycle, for the rate projection
    let lastFireTick = null;
    let tickSpanTotal = 0;  // summed ticks between consecutive cycle starts

    const dom = {};

    // =======================================================================
    // Config
    // =======================================================================

    /**
     * Decimal places a barrier offset may carry.
     *
     * The gateway refuses more than two outright, and the symbol's own pip may
     * be coarser still, so take whichever is stricter.
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

    /**
     * Stake for one contract, in account currency.
     *
     * In percent mode this is recomputed at every cycle open rather than fixed
     * at arm time — that is what makes it progressive: it rises with a growing
     * balance and falls with a shrinking one, without being touched.
     */
    function stakeFor(side) {
        if (!cfg.percentMode) return side === 'up' ? cfg.upStake : cfg.dnStake;
        const balance = TradeEngine.bridge.balance;
        if (!Number.isFinite(balance)) return null;
        return Math.max(1, Math.round((balance * cfg.stakePct) / 100));
    }

    function readConfig() {
        const percentMode = Boolean(dom.percentMode.checked);
        const stakePct = Number(dom.stakePct.value);
        const upStake = Number(dom.upStake.value);
        const upCount = Number(dom.upCount.value);
        const dnStake = Number(dom.dnStake.value);
        const dnCount = Number(dom.dnCount.value);
        const requested = Math.abs(Number(dom.offset.value));
        const ticks = Number(dom.ticks.value);
        const staggerMs = Math.round(Number(dom.stagger.value) * 1000);
        const gapMs = Math.round(Number(dom.gap.value) * 1000);
        const alternate = Boolean(dom.alternate.checked);
        const trendOnly = Boolean(dom.trendOnly.checked);

        if (percentMode) {
            if (!(stakePct > 0 && stakePct <= 100)) {
                throw new Error('Stake percent must be between 0 and 100.');
            }
            const balance = TradeEngine.bridge.balance;
            if (!Number.isFinite(balance)) {
                throw new Error('No balance from the gateway yet — wait for it before arming percent staking.');
            }
            if (Math.round((balance * stakePct) / 100) < 1) {
                throw new Error(
                    `${stakePct}% of ${balance.toFixed(2)} rounds to under 1. ` +
                    'Raise the percent or fund the account.',
                );
            }
        } else {
            for (const [label, v] of [['HIGHER', upStake], ['LOWER', dnStake]]) {
                if (!(v >= MIN_STAKE)) throw new Error(`${label} stake per contract must be at least ${MIN_STAKE}.`);
            }
        }
        for (const [label, n] of [['HIGHER', upCount], ['LOWER', dnCount]]) {
            if (!Number.isInteger(n) || n < 1 || n > MAX_CONTRACTS_PER_SIDE) {
                throw new Error(`${label} contract count must be a whole number from 1 to ${MAX_CONTRACTS_PER_SIDE}.`);
            }
        }
        if (!(requested > 0)) throw new Error('Barrier offset must be greater than zero.');
        if (!Number.isInteger(ticks) || ticks < MIN_TICKS || ticks > MAX_TICKS) {
            throw new Error(`Higher/Lower accepts ${MIN_TICKS}–${MAX_TICKS} ticks. There is no 1–4 tick contract.`);
        }
        if (!(staggerMs >= 0)) throw new Error('Stagger cannot be negative.');
        if (!(gapMs >= 0)) throw new Error('Gap between cycles cannot be negative.');
        if (staggerMs >= ticks * FASTEST_TICK_MS) {
            throw new Error(
                `A ${staggerMs / 1000}s stagger can outlive a ${ticks}-tick contract on a 1s index. Shorten it.`,
            );
        }

        const offset = quantiseOffset(requested);
        if (!(offset > 0)) {
            throw new Error(
                `An offset of ${requested} rounds to zero at ${offsetDecimals()} decimal places. ` +
                `The smallest the gateway accepts here is ${(10 ** -offsetDecimals()).toFixed(offsetDecimals())}.`,
            );
        }

        const total = upStake * upCount + dnStake * dnCount;
        return {
            upStake, upCount, dnStake, dnCount, total,
            percentMode, stakePct,
            offset, requested, ticks, staggerMs, gapMs, alternate, trendOnly,
        };
    }

    // =======================================================================
    // Legs
    // =======================================================================

    /**
     * One contract. A side may carry several — two $10 HIGHER contracts price
     * and settle exactly as one $20 HIGHER contract would, but they are placed
     * and booked separately so the history matches how the position was
     * expressed.
     */
    function makeContract(side, stake, seq) {
        return {
            side,
            seq,
            stake,
            type: side === 'up' ? 'HIGHER' : 'LOWER',
            // HIGHER sits above spot, LOWER below it. The signed string is what
            // the API wants; a number comes back "Invalid barrier".
            barrier: `${side === 'up' ? '+' : '-'}${cfg.offset}`,
            contractId: null,
            payout: null,
            entrySpot: null,
            barrierPrice: null,
            settled: false,
            booked: false,
            won: false,
            profit: 0,
            contract: null,
            stopStream: null,
        };
    }

    /** Same proposal -> buy path the manual HIGHER / LOWER buttons use. */
    async function openContract(leg) {
        const socket = TradeEngine.bridge.socket;
        if (!socket?.isOpen) throw new Error('Not connected.');

        const { proposal } = await socket.send({
            proposal: 1,
            amount: leg.stake,
            basis: 'stake',
            currency: TradeEngine.bridge.currency,
            contract_type: leg.type,
            underlying_symbol: TradeEngine.bridge.symbol,
            duration: cfg.ticks,
            duration_unit: 't',
            barrier: leg.barrier,
        });

        // Pay at most the quoted ask — the server rejects anything cheaper.
        const { buy } = await socket.send({ buy: proposal.id, price: proposal.ask_price });
        leg.contractId = buy.contract_id;
        leg.payout = Number(proposal.payout) || null;

        // Registered with the engine rather than the socket directly: if the
        // connection drops mid-contract, the engine re-attaches this stream to
        // the new socket and the cycle still settles and books.
        leg.stopStream = TradeEngine.bridge.watchContract(
            leg.contractId,
            (msg, error) => {
                if (error) { log(`Leg ${leg.type}: ${error.message}`, 'error'); return; }
                applyContractFrame(leg, msg?.proposal_open_contract);
            },
        );
    }

    /**
     * Fold one proposal_open_contract frame into a contract.
     *
     * Shared by the live stream and the rescue re-query, so a contract
     * recovered after a lost frame books exactly as a streamed one does.
     */
    function applyContractFrame(leg, c) {
        if (!c) return;

        const entry = c.entry_spot ?? c.entry_tick;
        if (Number.isFinite(Number(entry))) leg.entrySpot = Number(entry);
        // The proposal does not echo a barrier back, so the absolute level is
        // only authoritative once the contract stream sends it.
        if (Number.isFinite(Number(c.barrier))) leg.barrierPrice = Number(c.barrier);

        const done = c.is_sold === 1 || c.is_expired === 1
            || ['won', 'lost', 'sold'].includes(c.status);
        // The stream repeats its final frame, so settlement is latched.
        if (done && !leg.settled) {
            leg.settled = true;
            leg.profit = Number(c.profit) || 0;
            leg.won = c.status === 'won';
            leg.contract = c;
            if (leg.stopStream) { leg.stopStream(); leg.stopStream = null; }
        }
    }

    // =======================================================================
    // Cycle
    // =======================================================================

    const contractsOn = (side) => cycle.contracts.filter((c) => c.side === side);

    async function openCycle() {
        cyclesOpened++;
        fireTick = tickSeq;
        if (firstFireAt === null) firstFireAt = Date.now();
        if (lastFireTick !== null) tickSpanTotal += tickSeq - lastFireTick;
        lastFireTick = tickSeq;

        // Cycle A is the panel as configured. Cycle B is the mirror image: the
        // side carrying the doubled contracts swaps, and so does the single
        // larger one. Same money at risk, opposite tilt.
        const mirrored = cfg.alternate && parity === 1;
        // Sized here, not at arm time, so percent staking tracks the balance.
        const upStake = stakeFor(mirrored ? 'down' : 'up');
        const dnStake = stakeFor(mirrored ? 'up' : 'down');
        if (upStake === null || dnStake === null) {
            cyclesOpened--;
            log('No balance from the gateway — holding until it arrives.', 'error');
            beginCooldown();
            return;
        }
        const upSpec = mirrored
            ? { stake: upStake, count: cfg.dnCount }
            : { stake: upStake, count: cfg.upCount };
        const dnSpec = mirrored
            ? { stake: dnStake, count: cfg.upCount }
            : { stake: dnStake, count: cfg.dnCount };

        cycle = {
            index: cyclesOpened,
            label: cfg.alternate ? (mirrored ? 'B' : 'A') : '-',
            contracts: [], opened: [], startedAt: Date.now(),
            // Doubled so a slow feed does not trip it, plus flat slack for the
            // settlement round trip. Past this the cycle is considered stuck.
            deadline: Date.now() + cfg.ticks * avgTickMs() * 2 + CYCLE_GRACE_MS + cfg.staggerMs,
            rescuing: false,
        };
        const wanted = [];
        for (let i = 0; i < upSpec.count; i++) wanted.push(makeContract('up', upSpec.stake, i + 1));
        for (let i = 0; i < dnSpec.count; i++) wanted.push(makeContract('down', dnSpec.stake, i + 1));

        const failures = cfg.staggerMs > 0
            ? await openStaggered(wanted)
            : await openTogether(wanted);

        // Whatever ticks went by while the round trips were in flight are ticks
        // the next cycle will never get back.
        latencyTicks += Math.max(0, tickSeq - fireTick);

        if (!failures.length) {
            phase = 'running';
            return;
        }

        rejections += failures.length;
        abortedCycles++;
        log(`Cycle ${cycle.index}: ${failures.length} contract(s) refused (${failures.join('; ')}). Unwinding.`, 'error');
        await abortCycle();
    }

    /** Every contract priced against the same moment. */
    async function openTogether(wanted) {
        cycle.contracts = wanted;
        const results = await Promise.allSettled(wanted.map((c) => openContract(c)));
        return results
            .filter((r) => r.status === 'rejected')
            .map((r) => r.reason?.message || 'rejected');
    }

    /**
     * The HIGHER side first, the LOWER side after the stagger.
     *
     * The second side enters against whatever the spot has become, so its
     * barrier anchors to a different price than the first side's. That gap is
     * what makes both-sides-win and both-sides-lose reachable, where a
     * simultaneous pair can only ever have one winning side. It does not change
     * any contract's expected value — each is priced at the same margin
     * whenever it is bought.
     */
    async function openStaggered(wanted) {
        const ups = wanted.filter((c) => c.side === 'up');
        const dns = wanted.filter((c) => c.side === 'down');

        cycle.contracts = ups;
        const first = await Promise.allSettled(ups.map((c) => openContract(c)));
        const firstFailed = first.filter((r) => r.status === 'rejected')
            .map((r) => r.reason?.message || 'rejected');
        if (firstFailed.length) return firstFailed;

        await new Promise((resolve) => setTimeout(resolve, cfg.staggerMs));

        cycle.contracts = wanted;
        const second = await Promise.allSettled(dns.map((c) => openContract(c)));
        return second.filter((r) => r.status === 'rejected')
            .map((r) => r.reason?.message || 'rejected');
    }

    /**
     * Recover a cycle that has outlived its deadline.
     *
     * The usual cause is a settlement frame that never arrived — the stream
     * dropped, or the socket was replaced while the contract was expiring. The
     * position itself is fine on Deriv's side; only this bot's view of it is
     * stale. So ASK before giving up: a one-shot proposal_open_contract returns
     * the current state, and anything already settled is booked properly.
     *
     * Whatever is still unresolved after that is counted as unresolved rather
     * than guessed at, and the cycle is released so the bot keeps trading. This
     * is the difference between a stalled bot and a self-healing one.
     */
    async function rescueCycle() {
        if (!cycle || cycle.rescuing) return;
        cycle.rescuing = true;
        rescues++;
        const stuck = cycle.contracts.filter((c) => !c.settled);
        log(`Cycle ${cycle.index}: ${stuck.length} contract(s) overdue — re-querying.`, 'error');

        const socket = TradeEngine.bridge.socket;
        if (socket?.isOpen) {
            await Promise.allSettled(stuck.map(async (c) => {
                if (!c.contractId) return;
                const msg = await socket.send({ proposal_open_contract: 1, contract_id: c.contractId });
                applyContractFrame(c, msg?.proposal_open_contract);
            }));
        }

        if (!cycle) return;   // settled and closed while the queries were in flight

        const stillStuck = cycle.contracts.filter((c) => !c.settled);
        if (!stillStuck.length) {
            log(`Cycle ${cycle.index}: recovered — all contracts accounted for.`, 'ok');
            closeCycle();
            return;
        }

        unresolved += stillStuck.length;
        log(
            `Cycle ${cycle.index}: giving up on ${stillStuck.length} contract(s) ` +
            `(${stillStuck.map((c) => c.contractId || 'no id').join(', ')}). ` +
            'They are real positions — check the account. Continuing.',
            'error',
        );
        for (const c of cycle.contracts) {
            if (c.stopStream) { c.stopStream(); c.stopStream = null; }
        }
        // Book whatever DID settle so the totals stay honest.
        bookSettledLegs();
        cycle = null;
        beginCooldown();
    }

    /** A partially-filled cycle is an unintended position — unwind it. */
    async function abortCycle() {
        for (const c of cycle?.contracts || []) {
            if (c.contractId && !c.settled) {
                try {
                    await TradeEngine.bridge.socket.sell(c.contractId, { minPrice: 0 });
                } catch { /* unsellable — it rides */ }
            }
            if (c.stopStream) { c.stopStream(); c.stopStream = null; }
        }
        cycle = null;
        beginCooldown();
    }

    // =======================================================================
    // Booking
    // =======================================================================

    /**
     * Post each settled leg into the page's session totals and history.
     *
     * Per leg, not per cycle: these are two real contracts on the account and
     * they belong in that table the same way a manual buy does. The cycle
     * counters are separate, and are the ones that describe the strategy.
     */
    /**
     * Post each settled contract into the page's session totals and history.
     *
     * Per contract, not per cycle: each is a real position on the account and
     * belongs in that table the same way a manual buy does. The cycle counters
     * are separate, and are the ones that describe the strategy.
     */
    function bookSettledLegs() {
        for (const c of cycle.contracts) {
            if (!c.settled || c.booked) continue;
            c.booked = true;
            TradeEngine.bridge.recordTrade(c.contract, c.profit, c.won);
        }
    }

    function closeCycle() {
        cyclesCompleted++;
        for (const c of cycle.contracts) {
            if (c.won) legsWon++; else legsLost++;
        }

        // Contracts on the same side share a barrier and an expiry, so they win
        // or lose together; one is enough to read the side's outcome.
        const upWon = contractsOn('up').some((c) => c.won);
        const dnWon = contractsOn('down').some((c) => c.won);

        if (upWon && dnWon) bothWon++;
        else if (upWon || dnWon) winCycles++;
        else bandCycles++;

        netProfit += cycle.contracts.reduce((sum, c) => sum + c.profit, 0);

        for (const c of cycle.contracts) {
            if (c.stopStream) { c.stopStream(); c.stopStream = null; }
        }
        cycle = null;
        // Alternation advances per COMPLETED cycle, so an aborted one does not
        // silently flip the tilt and leave the pattern out of step.
        if (cfg.alternate) parity ^= 1;
        beginCooldown();
    }

    /**
     * True when the trend filter says to sit this one out.
     *
     * Both legs are still bought when it passes — the filter changes WHEN the
     * bot trades, not which way it leans. The reason to want it is that a
     * trending market displaces further from entry, which should make the
     * small-move band less likely. The band-rate readout is where that shows up.
     */
    function structureBlocks() {
        if (!cfg.trendOnly) return false;
        if (TradeEngine.bridge.pivotCount < MIN_PIVOTS) return true;
        return TradeEngine.bridge.structure === 'range';
    }

    /** Hold for the configured gap, then the loop opens the next cycle. */
    function beginCooldown() {
        if (!armed) { phase = 'idle'; return; }
        phase = 'cooling';
        resumeAt = Date.now() + cfg.gapMs;
    }

    // =======================================================================
    // Tick trigger
    // =======================================================================

    /**
     * Ticks are counted, not acted on.
     *
     * Entry used to fire on the next tick after settlement. It is now driven by
     * the configurable gap in the frame loop instead, so the cadence is a wall
     * clock the operator sets rather than whatever the feed happens to do. The
     * count is still needed for the ticks-per-cycle readout.
     */
    function onTick() {
        tickSeq++;
        // The symbol's real cadence, measured rather than assumed: the 1s
        // indices tick every second and R_100 every two, and the stall deadline
        // has to scale with whichever is actually selected.
        tickTimes.push(Date.now());
        if (tickTimes.length > TICK_SAMPLE) tickTimes.shift();
    }

    /** Mean interval between recent ticks, or a safe default. */
    function avgTickMs() {
        if (tickTimes.length < 2) return 2000;
        const span = tickTimes[tickTimes.length - 1] - tickTimes[0];
        return Math.max(250, span / (tickTimes.length - 1));
    }

    // =======================================================================
    // Main loop — settlement and rendering only; entry is tick-driven
    // =======================================================================

    function loop() {
        // Entry point for every cycle: the gap has elapsed and the socket is up.
        // Never fire into a dead socket — the buy would fail, count as a
        // rejection, and could leave a half-open cycle behind.
        if (armed && phase === 'cooling' && Date.now() >= resumeAt
            && TradeEngine.bridge.isConnected && !TradeEngine.bridge.isReconnecting) {
            if (structureBlocks()) {
                // Counted once per episode, not once per re-check, so a long
                // range reads as one skip rather than hundreds.
                if (!waitingStructure) {
                    waitingStructure = true;
                    skipEpisodes++;
                }
                resumeAt = Date.now() + STRUCTURE_RECHECK_MS;
            } else {
                waitingStructure = false;
                phase = 'opening';
                // Fire-and-forget on an async function: without this catch an
                // unexpected throw leaves phase stuck at 'opening' for good.
                openCycle().catch((error) => {
                    log(`Cycle failed to open: ${error.message}. Recovering.`, 'error');
                    cycle = null;
                    beginCooldown();
                });
            }
        }

        if (cycle) {
            // Not gated on phase: during a stagger the cycle is still 'opening'
            // while the first leg is already live and can already settle.
            bookSettledLegs();
            const all = cycle.contracts;
            const bothSides = all.some((c) => c.side === 'up') && all.some((c) => c.side === 'down');
            if (bothSides && all.length && all.every((c) => c.settled)) closeCycle();
            // The stall guard. Without this a single lost settlement frame
            // wedges the bot in 'running' forever and it silently stops trading.
            else if (Date.now() > cycle.deadline && !cycle.rescuing) {
                rescueCycle().catch((error) => {
                    log(`Rescue failed: ${error.message}. Releasing the cycle.`, 'error');
                    cycle = null;
                    beginCooldown();
                });
            }
        }

        if (!armed && phase === 'idle') {
            clearInterval(loopTimer);
            loopTimer = null;
            setStatus('Stopped.');
        }

        renderMonitor();
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
        parity = 0;
        waitingStructure = false;
        phase = 'cooling';
        resumeAt = Date.now();   // first cycle opens on the next frame
        dom.start.disabled = true;
        dom.stop.disabled = false;
        setConfigDisabled(true);
        clearInterval(loopTimer);
        loopTimer = setInterval(loop, FRAME_MS);

        const snapped = cfg.offset !== cfg.requested
            ? ` (${cfg.requested} snapped to ${cfg.offset} — the gateway caps offsets at ${offsetDecimals()} dp)`
            : '';
        log(
            `Tick cycle armed — HIGHER +${cfg.offset} and LOWER -${cfg.offset}${snapped}, ` +
            `${cfg.percentMode
                ? `${cfg.stakePct}% of balance per contract (progressive)`
                : `HIGHER ${cfg.upCount}×${cfg.upStake} and LOWER ${cfg.dnCount}×${cfg.dnStake} `
                  + `(${cfg.total.toFixed(2)} per cycle)`}, ${cfg.ticks} ticks, ` +
            `${cfg.staggerMs ? `${cfg.staggerMs / 1000}s stagger` : 'simultaneous entry'}, ` +
            `${cfg.gapMs / 1000}s between cycles` +
            `${cfg.trendOnly ? ', trend only (sits out a ranging structure)' : ''}` +
            `${cfg.alternate ? ', alternating A/B (sides swap each cycle)' : ''}. ` +
            'Real orders. It will not stop on its own.',
            'ok',
        );
    }

    function disarm() {
        armed = false;
        dom.start.disabled = false;
        dom.stop.disabled = true;
        setConfigDisabled(false);

        // A cycle in flight keeps its contracts — they are real money and killing
        // the loop would not close them. Let it finish, book, then stand down.
        if (cycle) {
            setStatus('Stopped. The open cycle will finish and book, then nothing further.');
        } else {
            phase = 'idle';
            clearInterval(loopTimer);
            loopTimer = null;
            setStatus('Stopped.');
        }
    }

    // =======================================================================
    // Rendering
    // =======================================================================

    const money = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

    function setStatus(text) { dom.status.textContent = text; }

    function log(message, kind = 'info') {
        setStatus(message);
        TradeEngine.bridge.notify(message, kind);
    }

    function setConfigDisabled(disabled) {
        for (const key of ['upStake', 'upCount', 'dnStake', 'dnCount', 'offset', 'ticks',
            'stagger', 'gap', 'alternate', 'percentMode', 'stakePct', 'trendOnly']) {
            dom[key].disabled = disabled;
        }
    }

    function renderMonitor() {
        if (armed && !TradeEngine.bridge.isConnected) {
            dom.phase.textContent = TradeEngine.bridge.isReconnecting ? 'Reconnecting…' : 'Disconnected';
        } else if (phase === 'cooling' && armed && waitingStructure) {
            dom.phase.textContent = TradeEngine.bridge.pivotCount < MIN_PIVOTS
                ? 'Waiting — not enough pivots yet'
                : 'Waiting — structure is ranging';
        } else if (phase === 'cooling' && armed) {
            const left = Math.max(0, resumeAt - Date.now());
            dom.phase.textContent = left > 0
                ? `Next cycle in ${(left / 1000).toFixed(1)}s`
                : 'Opening next cycle';
        } else dom.phase.textContent = {
            idle: 'Idle', cooling: 'Idle', opening: 'Buying contracts', running: 'All contracts open',
        }[phase] || 'Idle';

        if (dom.next) {
            const nextIsB = cfg?.alternate && parity === 1;
            dom.next.textContent = !cfg || !cfg.alternate
                ? 'A only'
                : (cycle
                    ? `running ${cycle.label}`
                    : `${nextIsB ? 'B' : 'A'} \u2014 ${nextIsB
                        ? `LOWER ${cfg.upCount}\u00d7${cfg.upStake}, HIGHER ${cfg.dnCount}\u00d7${cfg.dnStake}`
                        : `HIGHER ${cfg.upCount}\u00d7${cfg.upStake}, LOWER ${cfg.dnCount}\u00d7${cfg.dnStake}`}`);
        }

        dom.cycles.textContent = cyclesCompleted;
        dom.wins.textContent = winCycles + (bothWon ? ` (+${bothWon} both-sides-won?)` : '');
        dom.band.textContent = bandCycles;
        if (dom.legsWon) dom.legsWon.textContent = legsWon;
        if (dom.legsLost) dom.legsLost.textContent = legsLost;
        if (dom.skipped) dom.skipped.textContent = skipEpisodes;
        if (dom.unresolved) {
            dom.unresolved.textContent = unresolved + (rescues ? ` (${rescues} rescue${rescues > 1 ? 's' : ''})` : '');
            dom.unresolved.className = `v sm ${unresolved ? 'dn' : ''}`;
        }
        if (dom.structure) {
            const enough = TradeEngine.bridge.pivotCount >= MIN_PIVOTS;
            const st = TradeEngine.bridge.structure;
            dom.structure.textContent = enough
                ? TradeEngine.bridge.structureLabel
                : `${TradeEngine.bridge.pivotCount} pivot(s) — too few`;
            dom.structure.className = `v sm ${enough && st === 'up' ? 'up' : ''}`
                + `${enough && st === 'down' ? 'dn' : ''}`;
        }

        // What percent staking will actually send on the next cycle. Shown live
        // so the size is never a surprise after a run of wins or losses.
        if (dom.stakePreview) {
            const pct = Number(dom.stakePct.value);
            const bal = TradeEngine.bridge.balance;
            if (!dom.percentMode.checked) {
                dom.stakePreview.textContent = 'fixed stakes';
            } else if (!Number.isFinite(bal)) {
                dom.stakePreview.textContent = 'waiting for balance…';
            } else {
                const each = Math.max(1, Math.round((bal * pct) / 100));
                const legs = (cfg ? cfg.upCount + cfg.dnCount : 2);
                dom.stakePreview.textContent =
                    `${pct}% of ${bal.toFixed(2)} → ${each} per contract (${legs} legs = ${each * legs} at risk)`;
            }
        }

        // What each branch is actually worth, read off the payouts the gateway
        // returned at buy time. With unequal stakes the two branches differ, and
        // a branch is only positive when that side's TOTAL payout exceeds the
        // TOTAL staked across both sides — not just its own stake.
        if (dom.branchUp && dom.branchDn) {
            const priced = cycle && cycle.contracts.length && cycle.contracts.every((c) => c.payout !== null);
            if (!priced) {
                dom.branchUp.textContent = '—';
                dom.branchDn.textContent = '—';
                dom.branchUp.className = 'v sm';
                dom.branchDn.className = 'v sm';
            } else {
                const staked = cycle.contracts.reduce((t, c) => t + c.stake, 0);
                const gross = (side) => contractsOn(side).reduce((t, c) => t + c.payout, 0);
                const ifUp = gross('up') - staked;
                const ifDn = gross('down') - staked;
                dom.branchUp.textContent = money(ifUp);
                dom.branchDn.textContent = money(ifDn);
                dom.branchUp.className = `v sm ${ifUp >= 0 ? 'up' : 'dn'}`;
                dom.branchDn.className = `v sm ${ifDn >= 0 ? 'up' : 'dn'}`;
                if (dom.staked) dom.staked.textContent = staked.toFixed(2);
            }
        }

        // The number that decides the whole strategy — break-even band rate is
        // (payout - 2·stake) / payout, and it is usually well under 1%.
        dom.bandrate.textContent = cyclesCompleted
            ? `${((bandCycles / cyclesCompleted) * 100).toFixed(2)}%  (${bandCycles} of ${cyclesCompleted})`
            : '—';

        dom.net.textContent = cyclesCompleted
            ? `${money(netProfit)}  (${money(netProfit / cyclesCompleted)} per cycle)`
            : '—';
        dom.net.className = `v sm ${netProfit >= 0 ? 'up' : 'dn'}`;

        // Throughput, measured rather than assumed.
        const spans = Math.max(0, cyclesOpened - 1);
        const ticksPerCycle = spans ? tickSpanTotal / spans : null;
        dom.tpc.textContent = ticksPerCycle
            ? `${ticksPerCycle.toFixed(2)} ticks  (theoretical ${cfg ? cfg.ticks : '—'})`
            : '—';

        // Explicit null check, not truthiness — firstFireAt is a timestamp, and
        // a falsy-zero reading would silently blank the rate readout.
        const elapsedSec = firstFireAt !== null ? (Date.now() - firstFireAt) / 1000 : 0;
        const secPerCycle = cyclesCompleted ? elapsedSec / cyclesCompleted : null;
        const perDay = secPerCycle ? Math.round(86400 / secPerCycle) : null;
        dom.rate.textContent = secPerCycle
            ? `${secPerCycle.toFixed(1)}s / cycle → ~${perDay.toLocaleString()} cycles/day`
            : '—';

        dom.projected.textContent = perDay && cyclesCompleted
            ? `${money((netProfit / cyclesCompleted) * perDay)} / day at this rate`
            : '—';
        dom.projected.className = `v sm ${netProfit >= 0 ? 'up' : 'dn'}`;

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

        dom.latency.textContent = `${latencyTicks} tick${latencyTicks === 1 ? '' : 's'}`;
        dom.rejections.textContent = rejections + (abortedCycles ? ` (${abortedCycles} cycles lost)` : '');
    }

    // =======================================================================
    // Wiring
    // =======================================================================

    function init() {
        const el = (id) => document.getElementById(id);
        Object.assign(dom, {
            upStake: el('tc-up-stake'), upCount: el('tc-up-count'),
            dnStake: el('tc-dn-stake'), dnCount: el('tc-dn-count'),
            branchUp: el('tc-branch-up'), branchDn: el('tc-branch-dn'), staked: el('tc-staked'),
            offset: el('tc-offset'), ticks: el('tc-ticks'),
            gap: el('tc-gap'), alternate: el('tc-alternate'), next: el('tc-next'),
            trendOnly: el('tc-trend-only'), structure: el('tc-structure'),
            skipped: el('tc-skipped'), unresolved: el('tc-unresolved'),
            percentMode: el('tc-percent-mode'), stakePct: el('tc-stake-pct'),
            stakePreview: el('tc-stake-preview'),
            legsWon: el('tc-legs-won'), legsLost: el('tc-legs-lost'),
            stagger: el('tc-stagger'), effective: el('tc-effective'),
            start: el('tc-start'), stop: el('tc-stop'), status: el('tc-status'),
            phase: el('tc-phase'), cycles: el('tc-cycles'),
            wins: el('tc-wins'), band: el('tc-band'), bandrate: el('tc-bandrate'),
            net: el('tc-net'), tpc: el('tc-tpc'), rate: el('tc-rate'),
            projected: el('tc-projected'),
            latency: el('tc-latency'), rejections: el('tc-rejections'),
        });

        dom.start.addEventListener('click', arm);
        dom.stop.addEventListener('click', disarm);
        dom.offset.addEventListener('input', renderMonitor);
        dom.stakePct.addEventListener('input', renderMonitor);
        dom.percentMode.addEventListener('change', renderMonitor);

        // Entry is driven by the tick feed, not a wall clock — "the next tick"
        // means the next one the gateway actually sends.
        TradeEngine.bridge.onTick(onTick);

        // Buying needs a token, so the control stays out of reach until the page
        // has an authenticated session.
        TradeEngine.bridge.onSession(({ mode, state }) => {
            if (state === 'down') {
                // Stay armed. The engine is reconnecting, open contracts are
                // still being watched, and the cycle resumes by itself.
                dom.start.disabled = true;
                if (armed) setStatus('Connection lost — holding. Cycles resume automatically.');
                // Do not let the gap expire while the socket is down, or the
                // first frame after reconnecting would fire instantly.
                if (armed && phase === 'cooling') resumeAt = Date.now() + (cfg?.gapMs || 0);
                return;
            }
            dom.start.disabled = mode !== 'authed';
            if (armed) {
                setStatus('Reconnected — cycling again.');
                return;
            }
            setStatus(mode === 'authed'
                ? 'Ready. Arming places real orders on the connected account.'
                : 'Connect with a token — this bot places real orders and cannot run in preview.');
        });

        renderMonitor();
    }

    global.TickCycle = {
        init,
        get phase() { return phase; },
        get cyclesCompleted() { return cyclesCompleted; },
        get tally() {
            return {
                winCycles, bandCycles, bothWon, netProfit,
                legsWon, legsLost, latencyTicks, rejections, cyclesOpened, skipEpisodes,
                unresolved, rescues,
            };
        },
        // Exposed for the headless check.
        _test: { tick: onTick, loop },
    };
}(window));
