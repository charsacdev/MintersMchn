// Higher / Lower — HIGHER and LOWER.
//
// Same settlement as Rise/Fall — judged only at expiry — but against a barrier
// you choose instead of the entry spot. That barrier is a probability dial:
// push it away from spot for a bigger payout, or pull it BEHIND spot to win
// more often for less. Rise/Fall cannot express the second one.
//
// The bot on this page is the TICK CYCLE (tick-cycle.js), which replaced the
// swing engine. It buys both legs at once and re-enters every tick, so it reads
// nothing off the chart — the zigzag and structure readout are left running for
// the chart's own sake, not because anything trades on them.
//
// `showImplied` is on because this page's bot lives or dies on one number. The
// implied probability printed beside each payout is stake/payout, so its
// reciprocal is the payout MULTIPLE — and a two-leg cycle only has a winning
// branch when that multiple clears 2.0. At 49.7% implied the multiple is 2.013
// and a winning cycle nets +$0.13 on a $10 leg; at 51.6% it is 1.938 and every
// cycle loses. The quote row is where you check which side of 2.0 you are on
// before arming anything.
//
// Note the edge chip stays hidden while Side is on "auto": auto puts the two
// legs on two DIFFERENT barriers, which are not complements, so summing their
// implied probabilities would not measure a house margin. Pin the side to see it.
//
// Confirmed against the live gateway on R_100:
//   - `barrier` must be a signed STRING offset ("+0.5"). A number is rejected
//     with "Invalid barrier"; omitting it gives "Single barrier input is
//     expected".
//   - Minimum 5 ticks: 4t returns "Number of ticks must be between 5 and 10."
//     Minimum 15s intraday: 10s returns "Trading is not offered for this
//     duration."
//   - HIGHER at barrier "+0" prices identically to CALL (1.95), which is why
//     this app and the Rise/Fall one share ../trade-engine.js.
//   - The usable barrier range shrinks with duration: at 5 ticks only ±0.5
//     quotes at all — ±1.0 already returns "This contract offers no return."
//     At 1 hour, ±10 and beyond are fine.
//   - The proposal response does NOT echo the barrier back, so the projected
//     gold line is computed locally from spot + offset. Once bought,
//     `proposal_open_contract.barrier` takes over as authoritative.

TradeEngine.start({
    label: 'Higher / Lower',
    up: 'HIGHER',
    down: 'LOWER',
    upLabel: 'HIGHER',
    downLabel: 'LOWER',
    needsBarrier: true,
    minTicks: 5,
    maxTicks: 10,
    showImplied: true,

    durationNote(unit) {
        if (unit === 't') {
            return { text: 'The tick-cycle bot runs here — 5–10 ticks, 10 being the ceiling.' };
        }
        return { text: 'Intraday floor is 15s. The tick-cycle bot uses tick durations only.' };
    },
});

// The only bot on this page. Two legs at once, re-entering every tick, with no
// signal at all — see tick-cycle.js.
TickCycle.init();
