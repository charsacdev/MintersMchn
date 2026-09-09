// Rise / Fall — CALL and PUT.
//
// The contract settles against the ENTRY SPOT. There is no barrier to choose:
// you are betting purely on direction. "Strictly higher" means a tie is a loss.
//
// Confirmed against the live gateway on R_100:
//   - 1–10 ticks, or 15s–24h intraday. 10s is rejected with "Trading is not
//     offered for this duration".
//   - Payout is a flat 1.95 at EVERY duration — one tick pays the same as one
//     day — so duration carries no term premium and breakeven is always 51.28%.
//   - take_profit / stop_loss are rejected outright: "take_profit is not a
//     valid input for contract type CALL". The stake is the stop.
//
// Everything shared with the Higher/Lower app lives in ../trade-engine.js.

TradeEngine.start({
    label: 'Rise / Fall',
    up: 'CALL',
    down: 'PUT',
    upLabel: 'RISE',
    downLabel: 'FALL',
    needsBarrier: false,
    minTicks: 1,
    maxTicks: 10,
});

// The second bot on this page. It runs a two-leg cycle on the clock rather than
// a single contract on a pivot, so it shares nothing with the swing engine but
// the socket and the tick feed — see hedge-cycle.js.
HedgeCycle.init();
