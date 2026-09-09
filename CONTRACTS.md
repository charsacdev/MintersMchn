# Deriv contract families — mechanics and measured economics

Rise/Fall, Higher/Lower, Touch/No Touch, Accumulator.

Everything here was measured live against `wss://api.derivws.com/trading/v1/options/ws/public`
on **2026-08-13**, symbol `R_100` (spot ≈ 643) unless stated. Payouts move with
volatility; the *structure* doesn't.

---

## 1. The one thing to understand first

Three of the four are the same contract with a different knob. Priced live:

```
CALL   5 ticks               payout 1.95
HIGHER 5 ticks barrier +0    payout 1.95     ← identical
```

**Rise/Fall is Higher/Lower with the barrier pinned to zero.** Higher/Lower just
exposes the barrier as a dial. Touch/No Touch changes *when* the contract is
judged (any moment vs only at expiry). Accumulator is the genuine outlier.

| Family | Judged | Barrier | Duration |
|---|---|---|---|
| Rise/Fall | at expiry | fixed at entry spot | 1–10t · 15s–1d · 1–365d |
| Higher/Lower | at expiry | **you choose** | 5–10t · 15s–1d · 1–365d |
| Touch/No Touch | **any moment** | you choose | 5–10t · **2m**–1d · 1–365d |
| Accumulator | every tick | ± band from **previous** tick | **no expiry**, tick cap |

---

## 2. House edge across the whole surface

Both sides of the same event, implied probabilities summed. Anything over 100%
is the margin.

| Contract | Payouts | Implied sum | Edge |
|---|---|---|---|
| Rise/Fall 1h | 1.96 / 1.95 | 102.30% | **2.30%** ← cheapest |
| Rise/Fall 5t | 1.95 / 1.95 | 102.56% | 2.56% |
| Higher/Lower 1h ±0.5 | 2.08 / 1.84 | 102.42% | 2.42% |
| Higher/Lower 1h ±3.0 | 2.93 / 1.46 | 102.62% | 2.62% |
| Higher/Lower 5t ±0.5 | 10.43 / 1.07 | 103.05% | 3.05% |
| Higher/Lower 1h ±10.0 | 11.65 / 1.06 | 102.92% | 2.92% |
| Touch/No Touch 1h ±5.0 | 2.12 / 1.81 | 102.42% | 2.42% |
| Touch/No Touch 1h ±15.0 | 23.96 / 1.01 | 103.18% | 3.18% |
| **Touch/No Touch 10t ±0.5** | 3.59 / 1.27 | **106.60%** | **6.60%** ← avoid |

**The surface is flat at 2.3–3.2% with one exception.** There is no cheap corner
to exploit — but there is an expensive one. Tick-duration Touch costs roughly
**three times** the margin of anything else. If you trade Touch at all, trade it
intraday.

Cheapest access to the market is at-the-money Rise/Fall or near-the-money
Higher/Lower on longer durations.

---

## 3. Rise/Fall — `CALL` / `PUT`

Exit spot vs entry spot. No barrier, no bid/ask.

| | |
|---|---|
| Durations | 1–10 ticks · 15s–1d · 1–365d (10s rejected: *"Trading is not offered for this duration"*) |
| Payout | **flat 1.95 at every duration** |
| Breakeven | **51.28%** |
| Stake / max payout | min 0.35 / max 1000 |

**Ties lose.** The longcode reads *"strictly higher than entry spot"*.

**Duration is free.** 1 tick and 1 hour pay identically, so duration is purely a
statement about where you think your signal lives. There is no term premium.

> Measured: the "wait for candle-open ±N spread, hold 5 ticks" rule was tested
> across ~45 cells of real tick data (V25 / V90 / V90-1s). Every cell landed on
> the null. Best cell 50.63%, CI upper bound 51.60% — grazing the 51.28%
> breakeven without clearing it. See `risefall-5tick-trigger-measured-null`.

---

## 4. Higher/Lower — `HIGHER` / `LOWER`

Same settlement as Rise/Fall, but against a barrier you set. **The barrier is a
probability dial.** Negative barriers for `HIGHER` make winning *easier* and pay
*less* — something Rise/Fall cannot express.

Full curve, 1 hour on R_100:

| barrier | HIGHER payout | implied P | LOWER payout | implied P |
|---|---|---|---|---|
| −3.0 | 1.47 | 68.03% | 2.90 | 34.48% |
| −1.0 | 1.76 | 56.82% | 2.19 | 45.66% |
| −0.5 | 1.86 | 53.76% | 2.06 | 48.54% |
| **+0** | **1.96** | **51.02%** | **1.95** | **51.28%** |
| +0.5 | 2.08 | 48.08% | 1.84 | 54.35% |
| +1.0 | 2.21 | 45.25% | 1.75 | 57.14% |
| +3.0 | 2.93 | 34.13% | 1.46 | 68.49% |
| +10.0 | 11.65 | 8.58% | 1.06 | 94.34% |

You can dial anywhere from a ~94% shot paying 6% to a ~4% shot paying 1000%+,
and the margin stays ~2.3–3.1% the whole way.

### Usable barrier range shrinks with duration

Less time means less range, so distant barriers stop being quotable:

| duration | usable barriers |
|---|---|
| 5 ticks | ±0.5 only — ±1.0 already returns *"This contract offers no return"* |
| 10 ticks | ±1.0 |
| 60 seconds | ±1.0 |
| 1 hour | ±10.0 and beyond |

### Constraints

- **Minimum 5 ticks.** `4t` → *"Number of ticks must be between 5 and 10."*
- **Minimum 15 seconds.** `10s` → *"Trading is not offered for this duration."*
- `barrier` must be a **signed string**: `"+0.5"`. A number gives `Invalid
  barrier`; omitting it gives `Single barrier input is expected`.
- The proposal response does **not** echo the barrier. Compute it locally from
  spot + offset before the trade; after buying, `proposal_open_contract.barrier`
  is authoritative.

---

## 5. Touch / No Touch — `ONETOUCH` / `NOTOUCH`

**Path-dependent — this is the whole point.** `ONETOUCH` wins the *instant* price
touches the barrier, even if it immediately retraces. `NOTOUCH` wins only if the
barrier is never touched across the entire duration. Higher/Lower, by contrast,
ignores everything except the final tick.

| | |
|---|---|
| Durations | 5–10 ticks · **2 minutes**–1d · 1–365d |
| Barrier | required, signed string |

Note the intraday floor is **2 minutes**, not 15 seconds like the other two.

### The payout ceiling

```
ONETOUCH 5t  +0.5   payout  7.50
ONETOUCH 5t  +1.0   payout 28.93
ONETOUCH 5t  +3.0   payout 31.25
ONETOUCH 5t +10.0   payout 31.25   ← identical
```

Payout caps at ~31.25. Past roughly +3.0 you accept a far lower probability for
**zero additional return** — a +10 barrier is strictly dominated by +3. Never
reach for distance expecting more payout.

At the other end, far-barrier `NOTOUCH` on short durations returns
`ContractBuyValidationError: This contract offers no return` — winning is so
near-certain there is nothing left after margin.

---

## 6. Accumulator — `ACCU`

Structurally unlike the rest: **no duration, no expiry.** Stake grows by
`growth_rate` on every tick that stays inside a band; the moment it breaches you
lose the entire stake. Sellable at any time.

**The band re-centres on the previous tick, not on entry.** So this is not "stay
in a channel" — it is "never make one large single-tick move".

| growth | band (R_100) | max ticks | max multiple |
|---|---|---|---|
| 1% | ±0.06126% | 250 | 12.0× |
| 2% | ±0.05725% | 125 | 11.9× |
| 3% | ±0.05369% | 85 | 12.3× |
| 4% | ±0.05109% | 65 | 12.8× |
| 5% | ±0.04863% | 50 | 11.5× |

**Every growth rate caps at ~12×.** Tick limits are set so `(1+g)^maxTicks ≈ 12`.
Growth rate is a *volatility* dial, not a return dial — higher growth reaches the
same ceiling faster through a tighter band.

Stake 1–200 · max payout 3000 · take-profit 0.01–2999 via
`limit_order: { take_profit: N }`.

### The API ships its own history

Every ACCU proposal includes `ticks_stayed_in` — the **last 100 run lengths**.
Free empirical data. Modelling survival as geometric (`p = mean/(mean+1)`) and
comparing against breakeven `p = 1/(1+g)`, with a 20k-resample bootstrap CI:

```
R_100    g=0.01  edge -0.41%/tick  CI [-0.75%, -0.15%]  house
         g=0.02  edge +0.06%/tick  CI [-0.44%, +0.43%]  indistinguishable from 0
         g=0.03  edge +0.31%/tick  CI [-0.26%, +0.74%]  indistinguishable from 0
         g=0.05  edge +0.46%/tick  CI [-0.47%, +1.18%]  indistinguishable from 0
R_10     g=0.03  edge -0.76%/tick  CI [-1.62%, -0.12%]  house
         g=0.05  edge -1.31%/tick  CI [-2.74%, -0.22%]  house
1HZ100V  g=0.01  edge -0.57%/tick  CI [-0.87%, -0.34%]  house
```

The R_100 positives are **not** an edge. 100 samples cannot resolve a 0.3%
effect, and every one of those intervals contains zero. R_10 is cleanly negative
throughout.

### Why tiny numbers matter enormously

The edge compounds on every tick:

| edge/tick | over 85 ticks | over 250 ticks |
|---|---|---|
| −1.0% | 0.426 | 0.081 |
| −0.5% | 0.653 | 0.286 |
| −0.2% | 0.844 | 0.606 |
| +0.5% | 1.528 | 3.479 |

A −0.5%/tick drift — small enough to hide inside those confidence intervals —
costs **35% over a single 85-tick run**.

### The win-rate trap in its purest form

Per-tick survival is 95–99%. Riding all the way to the cap:

```
g=0.03   P(survive 85 ticks) = 10.6%   observed 11/100   payoff 12.3×
```

10.6% × 12.3 = 1.30 looks superb, but it rests on the same noisy `p`, and the
other 89% lose everything. This is the shape that makes a high hit rate feel like
an edge while the aggregate bleeds. **Per-tick win rate is meaningless here.
Only compounded EV counts.** See `two-trade-cycle-winrate-illusion`.

---

## 7. Coding reference

| | |
|---|---|
| Symbol field | `underlying_symbol`, never `symbol` |
| `barrier` | signed **string** — `"+0.5"` |
| ACCU request | `growth_rate`, and **no** `duration` / `duration_unit` |
| ACCU proposal | `payout` returns **0** — it is dynamic; read `contract_details` |
| Buy price | use `proposal.ask_price`, not your raw stake |
| Higher/Lower ticks | 5–10 (not 1–10) |
| Touch intraday floor | 2 minutes |
| All intraday floors | 15 seconds |
| Optional TP/SL | `limit_order: { take_profit, stop_loss }` on ACCU and multipliers |

Discover rather than assume: `contracts_for` per symbol returns every category
with its real duration and barrier limits.

---

## 8. What is measured, and what isn't

**Measured and settled:** the pricing surface above; the Rise/Fall 5-tick trigger
rule (null across ~45 cells of real tick data); the two-trade-cycle win-rate
illusion (71.9% from a 50% coin flip).

**Measured but under-powered:** the Accumulator per-tick edge. 100 runs per cell
rules out a large edge, not a small one either way. `ticks_stayed_in` refreshes
on every proposal, so polling for a few hours would give thousands of runs.

**Not measured at all:** the non-GBM generators — Crash/Boom (Poisson spikes),
Step Index (fixed ±0.1), Jump indices. Their tick files are already in
`Ideas-Goals/DataTest/`. Step Index in particular has a fixed increment, which
makes the Accumulator band question concrete rather than statistical.
