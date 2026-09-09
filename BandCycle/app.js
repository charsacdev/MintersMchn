// Band cycle page — HIGHER / LOWER, manual buttons plus the band-cycle bot.
//
// Same family and the same shared engine as ../HigherLower/, but the page is
// built for the bot rather than the swing engine: there is no signal panel, no
// pivot cooldown and no HH/HL structure gate. The engine's swing bot switches
// itself off when those controls are absent (`hasSwingUI`), exactly as it does
// on the Rise/Fall page.
//
// The buttons above the bot are still live and still buy one leg at a time.
// They are the reference path the bot's own orders travel down, and the quickest
// way to check a barrier quotes at all before arming.
//
// Confirmed against the live gateway on R_100:
//   - `barrier` must be a signed STRING offset ("+0.2"). A number is rejected
//     with "Invalid barrier"; omitting it gives "Single barrier input is
//     expected".
//   - HIGHER/LOWER intraday floor is 15s, so 60s is fine. Touch/No Touch is NOT
//     — its floor is 120s, which is why this bot is not built on that family.
//   - The usable barrier range shrinks with duration. At 5 ticks only ±0.5
//     quotes at all; over 60s a ±0.2 band is comfortably inside the range.
//
// Everything shared with the other family apps lives in ../trade-engine.js.

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
            return { text: 'The bot runs on seconds — tick durations apply to the manual buttons only.' };
        }
        return { text: 'Intraday floor is 15s. The bot defaults to 60s inside a 1m candle.' };
    },
});

// The only bot on this page. It runs a two-leg cycle on the clock rather than a
// single contract on a pivot — see band-cycle.js.
BandCycle.init();
