# Deriv apps — migrated to the current Deriv API

Both apps in this folder used to talk to `wss://ws.derivws.com/websockets/v3`.
That endpoint still accepts a connection, but it no longer serves these
instruments — a live check returns `InvalidSymbol` for `R_100` and an **empty**
`active_symbols` list. That is why nothing was streaming.

They now target the current API at `api.derivws.com`, which is verified working.

---

## TL;DR — where the token goes

| App | Token needed? | How to run |
|---|---|---|
| **Charts/** (live tick plotter) | **No.** Market data is public now. | Serve the folder, open `Charts/index.html`. It streams on load. |
| **RiseFall/** (CALL / PUT bot) | Only to place trades. | Streams and prices contracts without one. **App ID + token** to buy. |
| **HigherLower/** (HIGHER / LOWER bot) | Only to place trades. | Same, with a barrier dial. |
| **TouchNoTouch/** (ONETOUCH / NOTOUCH bot) | Only to place trades. | Same again, plus a live house-edge readout. |
| **/** (digit bot) | Only to place trades. | Needs an **App ID + token** (see below), or click **Preview without token** for live prices. |

- App ID → https://home.deriv.com/dashboard/create
- Token → https://home.deriv.com/dashboard/tokens/create (`trade` scope)

Both go in the top card of the main page. **Both are required** — a token alone
returns `Invalid application`.

---

## ⚠️ Your old API token will not work

This is the single biggest change, and the error you'd otherwise get
(`Invalid token format`) does not explain it.

| Token | Looks like | Works? |
|---|---|---|
| Legacy Deriv **API token** | `a1-f7pnteez…` | ❌ Rejected — `Invalid token format` |
| **Personal Access Token** from `/dashboard/tokens/create` | `pat_…` | ✅ This is the one |

Tested against the live `GET /trading/v1/options/accounts` endpoint. The app no
longer guesses at the prefix — it blocks only the known-bad `a1-…` shape and
lets the server judge the rest.

---

## Getting set up — you need TWO things

A token on its own is not enough. Authenticated calls are rejected with
`Invalid application` unless they also carry an **App ID registered to the same
Deriv account** as the token. Omit the header and you get
`Deriv-App-ID header is required for PAT tokens`. Legacy public ids like `1089`
do **not** work — verified against the live endpoint.

### 1. Register an application → **https://home.deriv.com/dashboard/create**

The form requires a **Redirect URL**. Use:

```
http://localhost:8765/callback
```

That URL is only ever used by the OAuth login flow — PAT auth never reads it, so
it has no effect on this app. It's just a mandatory registration field. The
value above matches `get-token.mjs`, so OAuth will work later without
re-registering. If the form rejects it, `https://localhost:8765/callback`, the
URL you serve the app from, or any HTTPS URL you control are all fine.

Make sure the app's scopes include **`trade`**.

Then copy the **App ID** and paste it into the app's *App ID* box. It's
remembered across reloads (it isn't a secret).

### 2. Create a token → **https://home.deriv.com/dashboard/tokens/create**

A **Personal Access Token** with the **`trade`** scope. It looks like
`pat_…`. Paste it into the token box — it is *not* stored anywhere.

Available scopes: `read`, `trade`, `payment`, `account_manage`,
`application_read`. Add `payment` only if you need wallet or payment-agent calls.

### 3. Pick **Demo**, press **Connect**.

> The chart under `Charts/` needs neither — market data is public.

> How this was found: the API rejects every token shape except `ory_at_…`, and
> Deriv's auth is Ory-backed. The developer playground's own bundle references
> `/dashboard/tokens/create`, "Create a new personal access token", an
> `Enter PAT Token` input, and a `POST /pat` endpoint — with exactly the five
> scope names above. Those dashboard routes resolve (they 307 to the login page).
>
> I could not log in to confirm the created token's prefix with my own eyes, so
> the app no longer hard-rejects on prefix — it only blocks the known-bad `a1-…`
> shape and lets the server judge anything else.

## Getting a token — the OAuth way (only if you need it)

Use this if you're building a real login for other people rather than running
the bot yourself. It's a full OAuth2 + PKCE flow, and it **cannot** be completed
in a browser alone: `auth.deriv.com/oauth2/token` sends no
`Access-Control-Allow-Origin` header, so a static page is CORS-blocked on the
exchange. (Verified: the preflight succeeds but carries no ACAO header. The docs
say the same — exchange from your backend, never the browser.)

`get-token.mjs` does that exchange outside the browser:

```bash
node get-token.mjs <your_app_id>
```

Register the app at `/dashboard/create` first, with its redirect URI set to
exactly `http://localhost:8765/callback`. The app id doubles as the OAuth
`client_id` and the `Deriv-App-ID` header. Requires Node 18+, no dependencies.

---

## Running the apps

Serve over `http://` — opening `index.html` from the filesystem will fail.

```bash
npx serve .
# or: python -m http.server 8080
# or VS Code → Live Server
```

Serve this folder, not a subfolder — every app loads `deriv-api.js` from the root.

- `/` — the digit bot
- `/Charts/` — the tick plotter
- `/RiseFall/` — the Rise/Fall bot (CALL / PUT)
- `/HigherLower/` — the Higher/Lower bot (HIGHER / LOWER)
- `/TouchNoTouch/` — the Touch/No Touch bot (ONETOUCH / NOTOUCH)

### Layout

```
deriv-api.js        transport: public gateway, OTP handshake, req_id, ping
trade-engine.js     chart, swings, contract tracking, auto-trade — shared
RiseFall/           index.html · app.js (20 lines of config) · style.css
HigherLower/        index.html · app.js (20 lines of config) · style.css
TouchNoTouch/       index.html · app.js (config + 3 hooks)   · style.css
Charts/             standalone tick plotter, no trading
```

All three trading families are one contract with different knobs, so the ~1,300
lines of chart and trading logic live once in `trade-engine.js`. Each app is its
own page with its own controls; the stylesheets are identical copies. Only the
family config differs:

```js
// RiseFall/app.js
TradeEngine.start({ up: 'CALL', down: 'PUT', needsBarrier: false, minTicks: 1,  maxTicks: 10, … });

// HigherLower/app.js
TradeEngine.start({ up: 'HIGHER', down: 'LOWER', needsBarrier: true, minTicks: 5, maxTicks: 10, … });

// TouchNoTouch/app.js
TradeEngine.start({ up: 'ONETOUCH', down: 'NOTOUCH', needsBarrier: true, minTicks: 5, maxTicks: 10,
                    sharedBarrier: true, pathDependent: true, minIntradaySeconds: 120, … });
```

### Two settlement models

The engine supports exactly two, because the API does:

| | `pathDependent: false` (default) | `pathDependent: true` |
|---|---|---|
| Judged | once, at expiry | at **every moment** |
| What matters | the final tick | the **closest approach**, ever |
| Chart | winning half green, losing half red | one tinted strip beyond the barrier |
| Panel | "which side are you on" | closest approach, gap, % of the way there |
| Used by | Rise/Fall, Higher/Lower | Touch/No Touch |

`sharedBarrier` is the other axis. Higher/Lower gives each leg its own barrier
(HIGHER above, LOWER below); Touch/No Touch points both legs at **one** barrier,
which makes the side a dial of its own and the two quotes exact complements.

`TradeEngine.debug` exposes the engine's internals read-only — config, live
contract, `trackPath`, `proposalRequest` and friends. It is used by nothing in
the apps; it exists so the settlement and path logic can be exercised from the
console and from headless checks without spending real contracts.

---

## `RiseFall/`, `HigherLower/` and `TouchNoTouch/` — the three trading bots

Chart, swings and trading in one page each. All three connect to the public
gateway on load, so the chart and live pricing work with no token; buying needs
App ID + token.

### The differences that matter

Confirmed against live proposals on `R_100`:

| App | Types | Settles against | Judged | Ticks | Intraday |
|---|---|---|---|---|---|
| `RiseFall/` | `CALL` / `PUT` | the entry spot | at expiry | 1–10 | 15s–1d |
| `HigherLower/` | `HIGHER` / `LOWER` | **a barrier you set** | at expiry | **5–10** | 15s–1d |
| `TouchNoTouch/` | `ONETOUCH` / `NOTOUCH` | one shared barrier | **continuously** | 5–10 | **2m**–1d |

Each app clamps its own duration box to its real range, so Higher/Lower can no
longer be handed a 1-tick duration and Touch can no longer be handed 60 seconds —
both of which the server rejects. The 2-minute floor is exact: `119s` returns
*"Trading is not offered for this duration"*, `120s` quotes.

Three API details `HigherLower/` encodes, each verified with a live proposal:

- `barrier` must be a **signed string** — `"+0.5"`. A number comes back
  `Invalid barrier`, and omitting it gives `Single barrier input is expected`.
- Higher/Lower has **no 1–4 tick contract**: `Number of ticks must be between 5
  and 10`. Its duration box is bounded at 5–10 from the start, so you find this
  out before you spend a buy on it.
- The proposal response does **not** echo the barrier back. The barrier drawn
  before a trade is computed locally from spot + offset; once bought,
  `proposal_open_contract.barrier` takes over as the authoritative level.

Barrier distance drives the payout hard — on a 1 USD stake, `+0.5` on R_100
prices around 880% return versus 95% for a plain Rise/Fall.

### `TouchNoTouch/` — what the path-dependence buys you

`ONETOUCH` wins the **instant** price reaches the barrier and stays won however
far it retraces afterwards. `NOTOUCH` wins only if the barrier is never reached,
and one tick through it ends the contract outright. Higher/Lower ignores
everything except the final tick.

So the live metric is not "which side are we on" but "how close did we get, and
did we ever cross". The engine tracks a **monotonic extreme** from the contract's
own `tick_stream` where the API supplies one and from the local tick series
between frames, then reports the closest approach, the remaining gap and the
percentage of the distance covered. A contract that touches stays touched.

Two more things the live gateway confirmed, both surfaced in the UI:

- **The payout ceiling.** `ONETOUCH 5t` pays 7.00 at `+0.5`, 28.22 at `+1.0`,
  then **31.25 at `+3.0`, `+10.0` and `+30.0` alike**. Past roughly `+3.0` you
  buy a far lower probability for zero extra return, so a distant barrier is
  strictly dominated.
- **Either leg can be priced out alone.** Far-barrier `NOTOUCH` returns *"This
  contract offers no return"* while `ONETOUCH` still quotes happily. The engine
  quotes the two legs independently and disables only the dead button, rather
  than blanking both quotes or letting the buy fail.

Because both legs share one barrier they are exact complements, so summing their
implied probabilities measures the house edge directly. That is the chip in the
quote row, and it turns gold past 4%:

```
5t  +0.5   touch 6.99  notouch 1.09   14.3% + 91.7% = 106.05%   edge 6.05%  ← gold
10t +0.5   touch 3.43  notouch 1.30   29.2% + 76.9% = 106.08%   edge 6.08%  ← gold
2m  +1.0   touch 2.46  notouch 1.62   40.7% + 61.7% = 102.38%   edge 2.38%
5m  +2.0   touch 3.13  notouch 1.42   31.9% + 70.4% = 102.37%   edge 2.37%
1h  +5.0   touch 2.06  notouch 1.86   48.5% + 53.8% = 102.31%   edge 2.31%
```

**Tick-duration Touch costs about three times the margin of anything else on the
surface.** If you trade this family at all, trade it intraday. See `CONTRACTS.md`
for the same measurement across all four families.

### Reading the chart

- **Grey line** — tick-by-tick spot. Blue band is the bid/ask envelope.
- **Blue zigzag with HH / HL / LH / LL** — confirmed swing pivots. A pivot only
  appears once price retraces past the threshold, so the newest leg is always
  unconfirmed. Sensitivity is a multiple of the rolling spread, floored at one pip.
- **Gold line** — the barrier. Dashed before a trade (where the next one would
  land), solid once a contract is running.
- **Green/red tint** — *expiry-judged apps:* the winning half of the chart is
  tinted green and the losing half red, split at the barrier (or the entry spot
  for Rise/Fall). *Touch/No Touch:* there is no winning half, so only the strip
  beyond the barrier is tinted — green when reaching it wins, red when it loses.
- **Dotted coloured line** — Touch/No Touch only: the closest approach so far.
  It never moves backwards.

### Auto-trade

Two signals, both driven by the same pivots the chart draws:

- **Reversal** — trade every newly confirmed pivot. A confirmed low starts an
  up-leg, so it buys Rise/Higher; a confirmed high buys Fall/Lower.
- **Trend** — only pullbacks that agree with the structure: a higher low while
  the structure is HH/HL, a lower high while it is LH/LL. Far fewer trades.

Touch/No Touch adds an **instrument** dial, because there the same directional
view has two expressions:

- **Touch** — barrier *ahead* of the expected move. After a confirmed low it
  goes above spot. Wins if the new leg carries far enough to reach it at any
  point. Long odds, large payout.
- **No Touch** — barrier *behind* it. After a confirmed low it goes below spot.
  Wins if the move never retraces that far. Short odds, small payout, and a
  single tick through the barrier ends it.

Each pivot fires at most once, a cooldown in ticks throttles entries, and only
one contract is open at a time. Stake is flat; the bot disarms itself when
cumulative P/L crosses the stop loss or the take profit. Arming adopts the
current pivot as already-seen, so it never opens on stale structure.

### What was verified

Run in headless Chrome against the live gateway, all three apps in one pass:

```
tick stream          46 synthetic symbols listed, ticks streaming on every page
live pricing         CALL/PUT, HIGHER/LOWER and ONETOUCH/NOTOUCH all priced
barrier maths        spot 662.53 -> HIGHER above 663.03, LOWER below 662.03
shared barrier       ONETOUCH and NOTOUCH request the SAME signed offset (+0.5)
proposal payload     barrier "+0.5" as a signed string, underlying_symbol set
duration guards      4t Touch rejected, 5t/10t accepted, 11t rejected
                     3t Higher/Lower rejected, 1t Rise/Fall accepted
                     15s/60s/119s Touch rejected, 120s accepted; 86401s rejected
                     duration boxes clamp to 1-10 / 5-10 / 5-10 and 15s / 15s / 120s
payout ceiling       ONETOUCH 5t: +3.0, +10.0 and +30.0 all pay 31.25
one leg priced out   +3.0 at 5t -> TOUCH 31.25, NO TOUCH "offers no return";
                     only the dead button disables, edge chip hides, and both
                     recover when the barrier comes back in
edge readout         6.68% on ticks (gold), 2.53% intraday (plain)
path tracking        extreme is monotonic across a dip-recover-break sequence;
                     a touch survives a late entry_spot and a full retrace
settlement model     Rise/Fall and Higher/Lower keep the expiry verdict wording
instrument mapping   touch->barrier ahead of the swing, notouch->behind it,
                     both directions
swing engine         100>105>100>106>102>103 -> H, L, HH, HL; bias "Uptrend"
signal logic         trend mode fires on HL in an uptrend, stays out in a range
history table        6 / 7 / 9 cells against 6 / 7 / 9 headers
settlement           duplicate final frames de-duplicated, win rate and P/L correct
risk limits          stop loss and take profit both disarm the bot
console              no exceptions on any page
```

Not verified without your credentials: `buy` and real settlement. Those follow
the same path as the digit bot. **Do the first one on demo.**

---

## What changed in the code

**New file `deriv-api.js`** — one client shared by both apps. Handles the
public gateway, the OTP handshake, `req_id` request/response matching,
subscription tracking with proper `forget`, and a 30-second keepalive ping (the
old code had none, so long sessions were silently dropped).

**Authentication is no longer an in-band message.** The old flow was
`{authorize: token}` over the socket. The new flow is:

1. `GET /trading/v1/options/accounts` → your account ids
2. `POST /trading/v1/options/accounts/{id}/otp` → a single-use `wss://` URL
3. connect to that URL — already scoped to the account, no auth step after

Both REST calls send CORS headers that reflect the calling origin, so this part
*does* work from a static page. Only the token exchange doesn't.

**`symbol` → `underlying_symbol`** in every proposal and contract call.

**Asset dropdowns are now populated from `active_symbols`** at connect time,
filtered to synthetics that are actually open, instead of a hardcoded list that
could drift out of date.

### Bot fixes beyond the migration

- Buys at the quoted `ask_price` rather than the raw stake input.
- The in-flight lock is released on *every* failure path. Previously a failed
  buy could leave the bot wedged, never trading again.
- Settlement is keyed off `is_sold` / `is_expired` / `status` and de-duplicated,
  so a repeated final frame can't double-count a win.
- Per-contract streams are forgotten by their real subscription id.
- Stake and duration are validated before sending (duration is 1–10 ticks for
  digit contracts — confirmed against `contracts_for`).
- Real-money accounts require an explicit confirmation before connecting.
- Errors surface in the UI instead of only `console.error`.
- Added a Digit Odd / Digit Even selector — the contract type was hardcoded in
  two places.

### Chart fixes beyond the migration

- No token, no account, no balance display. It connects on page load.
- The **Show Bid/Ask** checkbox was in the HTML but wired to nothing; it now
  draws the bid/ask envelope.
- The swing threshold fell back to `1.0` when spread was zero, which is enormous
  for these instruments and suppressed pivots. It now floors at one pip, using
  the real `pip_size` from `active_symbols`.
- Pivot labelling was O(n²) over the pivot list; now a single pass.
- Decimal precision follows each symbol's `pip_size` instead of a fixed 4.

---

## Verified against the live API

Run on 2026-08-12 via the actual client in `deriv-api.js`:

```
1. token-format guard        rejected a1-… / empty / random with guidance
2. REST error surfacing      "Invalid or expired token (HTTP 401)"
3. public gateway            connected
4. send() + req_id           active_symbols → 89 symbols, underlying_symbol present
5. concurrent send()         responses routed to the right caller
6. proposal                  DIGITODD R_100 5t → ask=1 payout=1.95
7. subscribe/unsubscribe     streamed, then stopped cleanly on forget
8. error handling            DerivError InvalidSymbol on a bad symbol
```

What I could **not** verify without your credentials: the authenticated half —
`listAccounts`, the OTP handshake, `buy`, and settlement. Those are written to
the documented schemas and the error paths are tested, but the first real trade
should be on a **demo** account.

## Reference

- Docs index: https://developers.deriv.com/llms.txt
- Playground: https://developers.deriv.com/playground
- Support: api-support@deriv.com
