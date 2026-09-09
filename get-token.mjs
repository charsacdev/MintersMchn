#!/usr/bin/env node
// Obtain a Deriv OAuth2 access token (the `ory_at_...` kind the API wants).
//
// Why this exists: the current Deriv API will not accept the old `a1-...` API
// tokens, and the OAuth token endpoint at auth.deriv.com sends no
// Access-Control-Allow-Origin header — so a browser page physically cannot do
// the code-for-token exchange. It has to happen outside the browser. This
// script is that outside.
//
// Usage:
//   node get-token.mjs <your_app_id>
//
// The redirect URI below must be registered against that app id in the Deriv
// dashboard, character for character.
//
// Requires Node 18+ (uses global fetch). No dependencies.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';

const appId = process.argv[2] || process.env.DERIV_APP_ID;
if (!appId) {
    console.error(`
Missing app id.

  node get-token.mjs <your_app_id>

Register an application in the Deriv dashboard first, and set its redirect URI
to exactly:

  ${REDIRECT_URI}
`);
    process.exit(1);
}

const base64url = (buffer) => buffer.toString('base64url');
const codeVerifier = base64url(randomBytes(32));
const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
const state = base64url(randomBytes(16));

const authorizeUrl = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    scope: 'trade',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
})}`;

function page(title, body, accent = '#3fb950') {
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="background:#0d1117;color:#c9d1d9;font:15px/1.6 system-ui;padding:3rem;max-width:44rem;margin:auto">
<h1 style="color:${accent};font-size:1.3rem">${title}</h1>${body}</body>`;
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
    }

    const send = (code, html) => res.writeHead(code, { 'Content-Type': 'text/html' }).end(html);

    const error = url.searchParams.get('error');
    if (error) {
        const description = url.searchParams.get('error_description') || '';
        send(400, page('Authorisation failed', `<p>${error}</p><p>${description}</p>`, '#f85149'));
        console.error(`\n✖ Deriv returned an error: ${error}\n  ${description}\n`);
        server.close();
        process.exitCode = 1;
        return;
    }

    // Guards against another site tricking your browser into completing this flow.
    if (url.searchParams.get('state') !== state) {
        send(400, page('State mismatch', '<p>Discarding this callback.</p>', '#f85149'));
        console.error('\n✖ State mismatch — ignoring the callback.\n');
        server.close();
        process.exitCode = 1;
        return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
        send(400, page('No code returned', '<p>Deriv did not include an authorisation code.</p>', '#f85149'));
        server.close();
        process.exitCode = 1;
        return;
    }

    try {
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: appId,
                code,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier,
            }),
        });

        const raw = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status} — ${raw}`);

        const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } =
            JSON.parse(raw);
        if (!accessToken) throw new Error(`No access_token in response: ${raw}`);

        send(200, page('Token issued ✔', `
            <p>Copy this into the app's token box, then close this tab.</p>
            <textarea readonly style="width:100%;height:6rem;background:#161b22;color:#58a6ff;
                border:1px solid #30363d;border-radius:8px;padding:.8rem;font:13px ui-monospace,monospace"
                onclick="this.select()">${accessToken}</textarea>`));

        console.log('\n─── Access token ───────────────────────────────────────────\n');
        console.log(accessToken);
        console.log(`\n─── expires in ${expiresIn ?? 'unknown'}s ──────────────────────────────────`);
        if (refreshToken) console.log(`\nRefresh token:\n${refreshToken}`);
        console.log('\nPaste the access token into the app and press Connect.\n');
    } catch (exchangeError) {
        send(500, page('Token exchange failed', `<pre>${exchangeError.message}</pre>`, '#f85149'));
        console.error(`\n✖ Token exchange failed:\n  ${exchangeError.message}\n`);
        process.exitCode = 1;
    } finally {
        server.close();
    }
});

server.listen(PORT, () => {
    console.log(`
Listening on ${REDIRECT_URI}

If your browser does not open, paste this URL into it:

${authorizeUrl}
`);

    // Best-effort browser launch; harmless if it fails.
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', authorizeUrl]]
        : process.platform === 'darwin' ? ['open', [authorizeUrl]]
            : ['xdg-open', [authorizeUrl]];
    try {
        spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    } catch { /* user can copy the URL manually */ }
});
