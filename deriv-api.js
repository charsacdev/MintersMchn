// Shared Deriv API client — targets the CURRENT API (api.derivws.com).
//
// Two ways to connect:
//   DerivAPI.connectPublic()        -> market data only, no token, no account
//   DerivAPI.connectAuthed(token)   -> full trading, needs an `ory_at_...` OAuth token
//
// The authenticated path is a two-step handshake, not an in-band `authorize`
// message like the old v3 API used:
//   1. GET  /trading/v1/options/accounts            -> list of account ids
//   2. POST /trading/v1/options/accounts/{id}/otp   -> a one-shot wss:// URL
//   3. connect to that URL and just start sending
//
// Both REST endpoints send CORS headers that reflect the calling origin, so this
// works from a plain static page with no backend.

const REST_BASE = 'https://api.derivws.com';
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

// Your own application id, from https://home.deriv.com/dashboard/create
//
// This is NOT optional for authenticated calls. A Personal Access Token is only
// accepted alongside an app id registered to the same account — anything else
// comes back as "Invalid application", and omitting the header entirely gives
// "Deriv-App-ID header is required for PAT tokens". Legacy public ids such as
// 1089 do not work here.
//
// Public market data needs no app id at all, so the chart works without one.
//
// localStorage is wrapped because reading it can THROW, not just return null —
// blocked site data, some file:// contexts, certain private modes. This runs at
// module scope, so an unguarded throw here kills the whole file and
// `window.DerivAPI` is never assigned. The only symptom downstream is
// "DerivAPI is not defined", which points nowhere near the real cause.
const safeStore = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* not fatal */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* not fatal */ } },
};

let appId = safeStore.get('deriv_app_id') || '';

const PING_INTERVAL_MS = 30000; // docs: keep the socket alive with a ping every 30s
const REQUEST_TIMEOUT_MS = 20000;

class DerivSocket {
    constructor(url, meta = {}) {
        this.url = url;
        this.meta = meta; // { mode, accountId, accountType, currency }
        this.ws = null;
        this.nextReqId = 1;
        this.pending = new Map();      // req_id -> {resolve, reject, timer}
        this.subscriptions = new Map();  // req_id -> handler
        this.streamIds = new Set();      // server-side subscription ids, for forget()
        this.pingTimer = null;
        this.closedByUs = false;

        this.onOpen = () => {};
        this.onClose = () => {};
        this.onError = () => {};
    }

    get isOpen() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    get mode() {
        return this.meta.mode || 'public';
    }

    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                settled = true;
                this.pingTimer = setInterval(() => {
                    if (this.isOpen) this.ws.send(JSON.stringify({ ping: 1 }));
                }, PING_INTERVAL_MS);
                this.onOpen();
                resolve(this);
            };

            this.ws.onmessage = (event) => this._dispatch(JSON.parse(event.data));

            this.ws.onerror = () => {
                this.onError(new Error('WebSocket transport error'));
                if (!settled) {
                    settled = true;
                    reject(new Error(
                        'Could not open a WebSocket to Deriv. If you opened index.html by ' +
                        'double-clicking it, serve the folder over http:// instead.',
                    ));
                }
            };

            this.ws.onclose = (event) => {
                clearInterval(this.pingTimer);
                this._failAllPending(new Error(`Socket closed (code ${event.code})`));
                this.onClose(event, this.closedByUs);
                if (!settled) {
                    settled = true;
                    reject(new Error(`Socket closed before it opened (code ${event.code})`));
                }
            };
        });
    }

    _dispatch(msg) {
        // Remember stream ids so we can forget() them precisely later.
        const streamId = msg.subscription?.id;
        if (streamId) this.streamIds.add(streamId);

        const sub = this.subscriptions.get(msg.req_id);
        if (sub) {
            sub(msg.error ? null : msg, msg.error || null);
            return;
        }

        const waiter = this.pending.get(msg.req_id);
        if (!waiter) return; // unsolicited (e.g. a ping/pong) — nothing to do
        this.pending.delete(msg.req_id);
        clearTimeout(waiter.timer);

        if (msg.error) waiter.reject(new DerivError(msg.error));
        else waiter.resolve(msg);
    }

    _failAllPending(err) {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pending.clear();
    }

    /** Send a request and resolve with the single response. */
    send(request) {
        return new Promise((resolve, reject) => {
            if (!this.isOpen) return reject(new Error('Socket is not open'));
            const reqId = this.nextReqId++;
            const timer = setTimeout(() => {
                this.pending.delete(reqId);
                reject(new Error(`Timed out waiting for "${Object.keys(request)[0]}"`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(reqId, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ ...request, req_id: reqId }));
        });
    }

    /**
     * Open a stream. `handler(msg, error)` fires for every update.
     * Returns a function that stops the stream.
     */
    subscribe(request, handler) {
        if (!this.isOpen) throw new Error('Socket is not open');
        const reqId = this.nextReqId++;
        let lastStreamId = null;

        this.subscriptions.set(reqId, (msg, error) => {
            if (msg?.subscription?.id) lastStreamId = msg.subscription.id;
            handler(msg, error);
        });
        this.ws.send(JSON.stringify({ ...request, subscribe: 1, req_id: reqId }));

        return () => {
            this.subscriptions.delete(reqId);
            if (lastStreamId && this.isOpen) {
                this.ws.send(JSON.stringify({ forget: lastStreamId }));
                this.streamIds.delete(lastStreamId);
            }
        };
    }

    /**
     * Sell an open contract back to Deriv before it expires.
     *
     * `price` is a FLOOR, not a target: the server rejects the sale if the bid
     * has slipped below it. `0` means "at market, whatever it is worth" — which
     * is what you want when the position must go regardless, and what you must
     * NOT use when a bad fill is worse than no fill.
     *
     * Resale is not always on offer. Deriv withholds it near expiry (the last
     * stretch of a contract is unsellable) and during fast moves, so every
     * caller has to survive this throwing.
     */
    async sell(contractId, { minPrice = 0 } = {}) {
        let response;
        try {
            response = await this.send({ sell: contractId, price: minPrice });
        } catch (error) {
            // These arrive as bare codes; none of them say what to do about it.
            if (error.code === 'ContractAlreadySold') {
                throw new Error(`Contract ${contractId} was already sold or has expired.`);
            }
            if (/not.*(sell|resell|offer)/i.test(error.message || '')) {
                throw new Error(
                    `Deriv is not quoting a resale for contract ${contractId} right now — ` +
                    'either it is too close to expiry or the market is moving too fast. ' +
                    'The position stays open and settles normally.',
                );
            }
            throw error;
        }

        const sold = response?.sell;
        if (!sold) throw new Error(`Sell of ${contractId} returned no confirmation.`);
        return {
            contractId,
            soldFor: Number(sold.sold_for),
            transactionId: sold.transaction_id,
            balanceAfter: Number(sold.balance_after),
        };
    }

    forgetAll(...types) {
        if (this.isOpen) this.ws.send(JSON.stringify({ forget_all: types }));
    }

    close() {
        this.closedByUs = true;
        clearInterval(this.pingTimer);
        if (this.ws) this.ws.close();
    }
}

class DerivError extends Error {
    constructor(apiError) {
        super(apiError.message || 'Deriv API error');
        this.name = 'DerivError';
        this.code = apiError.code;
    }
}

/** REST helper. Surfaces Deriv's `errors[]` envelope as a real Error. */
async function restCall(path, { token, method = 'GET', body } = {}) {
    const headers = {};
    if (appId) headers['Deriv-App-ID'] = appId;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';

    let response;
    try {
        response = await fetch(REST_BASE + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new Error(`Network error calling ${path}. Check your connection.`);
    }

    const raw = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* plain-text error body */ }

    if (!response.ok) {
        // 401s from the gateway come back as bare text, e.g. "Invalid token format".
        const detail = parsed?.errors?.[0]?.message || raw.trim() || response.statusText;

        // This one is worth translating: it means the app id, not the token.
        if (/invalid application/i.test(detail)) {
            throw new Error(
                `"${detail}" — this is about the App ID, not your token. It must be an ` +
                'application registered to the same Deriv account as the token. ' +
                'Create one at https://home.deriv.com/dashboard/create and paste its ' +
                'App ID into the App ID box.',
            );
        }
        if (/Deriv-App-ID header is required/i.test(detail)) {
            throw new Error(
                'An App ID is required for token auth. Create an application at ' +
                'https://home.deriv.com/dashboard/create and paste its App ID above.',
            );
        }
        throw new Error(`${detail} (HTTP ${response.status})`);
    }
    return parsed;
}

/**
 * Catch the one token shape that is known-bad before spending a round trip.
 *
 * Deriv's legacy `a1-...` API tokens are rejected by this API with a bare
 * "Invalid token format", which gives no hint about what went wrong. Tokens
 * issued by the current dashboard are Ory access tokens (`ory_at_...`).
 *
 * Anything else is passed through untouched and left for the server to judge —
 * guessing at the accepted format would risk blocking a token that works.
 */
function assertLooksLikeAccessToken(token) {
    if (!token || !token.trim()) throw new Error('No token supplied.');

    if (/^a1-/.test(token)) {
        throw new Error(
            'That is a legacy Deriv API token ("a1-…"), which this API rejects. ' +
            'Create a Personal Access Token instead at ' +
            'https://home.deriv.com/dashboard/tokens/create with the "trade" scope.',
        );
    }
}

const DerivAPI = {
    PUBLIC_WS,
    restCall,
    DerivError,

    getAppId: () => appId,

    /** Remembered across reloads so you only paste it once. */
    setAppId(id) {
        appId = (id || '').trim();
        if (appId) safeStore.set('deriv_app_id', appId);
        else safeStore.remove('deriv_app_id');
    },

    /** Market data only: ticks, active_symbols, proposal, contracts_for, time. */
    async connectPublic() {
        const socket = new DerivSocket(PUBLIC_WS, { mode: 'public' });
        await socket.connect();
        return socket;
    },

    /** List the Options trading accounts this token can reach. */
    async listAccounts(token) {
        assertLooksLikeAccessToken(token);
        if (!appId) {
            throw new Error(
                'No App ID set. Register an application at ' +
                'https://home.deriv.com/dashboard/create and paste its App ID above — ' +
                'tokens are only accepted alongside your own app id.',
            );
        }
        const result = await restCall('/trading/v1/options/accounts', { token });
        const accounts = result?.data || [];
        if (!accounts.length) {
            throw new Error(
                'This token has no Options trading accounts. Create one first, or ' +
                'check that the token was issued with the "trade" scope.',
            );
        }
        return accounts;
    },

    /**
     * Full trading connection.
     * Prefers a demo account unless you explicitly ask for real.
     */
    async connectAuthed(token, { accountType = 'demo', accountId = null } = {}) {
        const accounts = await DerivAPI.listAccounts(token);

        const account = accountId
            ? accounts.find((a) => a.account_id === accountId)
            : accounts.find((a) => a.account_type === accountType) || accounts[0];

        if (!account) throw new Error(`No ${accountType} account available on this token.`);

        // Exchange the bearer token for a single-use WebSocket URL. The URL is
        // already scoped to this account, so there is no auth step after connect.
        const otp = await restCall(
            `/trading/v1/options/accounts/${account.account_id}/otp`,
            { token, method: 'POST' },
        );
        const url = otp?.data?.url;
        if (!url) throw new Error('The OTP endpoint did not return a WebSocket URL.');

        const socket = new DerivSocket(url, {
            mode: 'authed',
            accountId: account.account_id,
            accountType: account.account_type,
            currency: account.currency,
            balance: account.balance,
        });
        await socket.connect();
        socket.accounts = accounts;
        return socket;
    },
};

window.DerivAPI = DerivAPI;
