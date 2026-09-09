// Touch / No Touch — ONETOUCH and NOTOUCH.
//
// The one thing that separates this family from the other two: it is judged at
// EVERY MOMENT, not at expiry. `ONETOUCH` wins the instant price reaches the
// barrier and stays won however far it retraces afterwards. `NOTOUCH` wins only
// if the barrier is never reached across the whole duration, and one tick
// through it ends the contract outright. Higher/Lower ignores everything except
// the final tick.
//
// So the two legs are not a direction. They are opposite bets on the SAME
// barrier, which makes the side its own dial — and makes the two quotes exact
// complements, so the house edge is readable straight off the quote row.
//
// Confirmed against the live gateway on R_100:
//   - 5–10 ticks. The intraday floor is 2 MINUTES, not the 15 seconds the other
//     families accept: 119s is rejected with "Trading is not offered for this
//     duration", 120s quotes.
//   - Payout caps at ~31.25 on tick durations. +3.0, +10.0 and +30.0 all pay
//     31.25, so past roughly +3.0 you buy a far lower probability for zero extra
//     return — a distant barrier is strictly dominated.
//   - Far-barrier NOTOUCH on short durations returns "This contract offers no
//     return": winning is so near-certain there is nothing left after margin.
//     The engine disables that leg rather than let the buy fail.
//   - The measured edge splits sharply by duration. Summed implied
//     probabilities on 2026-08-14: 5t 106.05%, 10t 106.08%, but 2m 102.38%,
//     5m 102.37%, 1h 102.31%. Tick-duration Touch costs about three times the
//     margin of everything else on the surface — hence the gold chip.
//
// Everything shared with the Rise/Fall and Higher/Lower apps lives in
// ../trade-engine.js.

TradeEngine.start({
    label: 'Touch / No Touch',
    up: 'ONETOUCH',
    down: 'NOTOUCH',
    upLabel: 'TOUCH',
    downLabel: 'NO TOUCH',
    upGlyph: '◎',
    downGlyph: '⦸',

    needsBarrier: true,
    sharedBarrier: true,   // both legs quote against one barrier
    pathDependent: true,   // judged continuously; track the closest approach
    touchLeg: 'up',        // reaching the barrier wins ONETOUCH, loses NOTOUCH
    showImplied: true,

    minTicks: 5,
    maxTicks: 10,
    minIntradaySeconds: 120,

    /**
     * Same directional view, two ways to express it.
     *
     *   Touch    — barrier AHEAD of the expected move. Wins if the new leg
     *              carries far enough to reach it at any point. Long odds,
     *              large payout.
     *   No Touch — barrier BEHIND it. Wins if the move never retraces that far.
     *              Short odds, small payout, and one bad tick ends it.
     */
    planTrade(swing) {
        const instrument = document.getElementById('instrument-select').value;
        const ahead = swing === 'up' ? '+' : '-';
        const behind = swing === 'up' ? '-' : '+';
        return instrument === 'touch'
            ? { direction: 'up', side: ahead }
            : { direction: 'down', side: behind };
    },

    durationNote(unit) {
        if (unit === 't') {
            return { text: 'Tick durations carry ~3× the margin of intraday Touch.', warn: true };
        }
        return { text: `Intraday floor is 2 minutes (${unit === 'm' ? '2m' : '120s'}) — not 15s.` };
    },

    instrumentNote(instrument) {
        return instrument === 'touch'
            ? 'Touch: after a confirmed low the barrier goes ABOVE spot, after a confirmed high BELOW it. '
              + 'The bet is that the new leg carries far enough to reach it at any point before expiry — '
              + 'long odds, large payout.'
            : 'No Touch: after a confirmed low the barrier goes BELOW spot, after a confirmed high ABOVE it. '
              + 'The bet is that the pivot holds and price never retraces that far — short odds, small '
              + 'payout, and a single tick through the barrier ends it immediately.';
    },
});
