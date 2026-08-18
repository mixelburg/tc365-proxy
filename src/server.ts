// tc365-proxy — HTTP proxy for TimeClock 365 punching (TypeScript).
// You hand it your creds once (env or POST /auth/login), it mints tokens,
// auto-refreshes them, and exposes punch routes you can curl.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadState, saveState, clearState, type ProxyState } from './store.js';
import {
  login,
  loginStep2,
  refreshTokens,
  getWebPunch,
  makePunch,
  getCurrentUser,
  PUNCH_IN,
  PUNCH_OUT,
  upstreamError,
  type Credentials,
  type PunchType,
} from './tc365.js';

const PORT: number = Number(process.env.PORT || 8787);
const HOST: string = process.env.HOST || '127.0.0.1';
const PROXY_KEY: string = process.env.TC_PROXY_KEY || ''; // optional: require x-api-key on every route

const state: ProxyState = loadState(); // { credentials, login }

// ---------- credential plumbing ----------

function hasToken(): boolean {
  return !!(state.credentials && state.credentials.access);
}

function accessExpired(): boolean {
  const c = state.credentials;
  if (!c || !c.accessExpiresAt) return false;
  return Date.now() / 1000 >= c.accessExpiresAt - 60; // 60s buffer
}

function setCredentials(creds: Credentials): void {
  state.credentials = creds;
  saveState(state);
}

// Credentials come from env (TC_USERNAME/TC_PASSWORD) or were passed via POST /auth/login.
// If we have a username, keep it (with an optional password) so a dead refresh
// token can be healed by re-logging-in silently.
function storeLoginSource(loginInfo: { username: string; password?: string }): void {
  if (!loginInfo.username) return;
  state.login = { username: loginInfo.username };
  if (loginInfo.password) state.login.password = loginInfo.password;
  saveState(state);
}

async function loginWithSource(username: string, password: string): Promise<string> {
  const r = await login(username, password);
  if (!r.ok) {
    if (r.codeRequired) {
      // 2FA account: without an interactive code we cannot re-login silently.
      const e = new Error('mfa_relogin_required') as Error & { status?: number; authToken?: string; authType?: string };
      e.status = 428;
      e.authToken = r.authToken;
      e.authType = r.authType;
      throw e;
    }
    const e = new Error(`re-login failed: ${r.error}`) as Error & { status?: number };
    e.status = 401;
    throw e;
  }
  if (!r.credentials) throw new Error('re-login returned no credentials');
  setCredentials(r.credentials);
  return r.credentials.access;
}

function loginSource(): { username?: string; password?: string } {
  return state.login ?? {};
}

let refreshMutex: Promise<string> = Promise.resolve('');
async function ensureToken(): Promise<string> {
  if (!hasToken()) {
    // Heal path: creds available but no live session (e.g. after restart).
    const src = loginSource();
    if (src.username && src.password) {
      return loginWithSource(src.username, src.password);
    }
    const e = new Error('not_authenticated') as Error & { status?: number };
    e.status = 401;
    throw e;
  }
  if (!accessExpired()) return state.credentials!.access;

  // Refresh under a mutex so concurrent punches don't double-refresh.
  refreshMutex = refreshMutex.then(async () => {
    if (!accessExpired()) return state.credentials!.access; // someone else refreshed
    const src = loginSource();
    const res = await refreshTokens(state.credentials!.refresh);
    if (!res.ok || !res.credentials) {
      // Refresh token dead -> try a silent re-login with stored creds.
      if (src.username && src.password) {
        return loginWithSource(src.username, src.password);
      }
      clearState();
      state.credentials = undefined;
      const e = new Error('session_expired') as Error & { status?: number };
      e.status = 401;
      throw e;
    }
    state.credentials = res.credentials;
    saveState(state);
    return res.credentials.access;
  });
  return refreshMutex;
}

// ---------- HTTP plumbing ----------

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requireKey(req: IncomingMessage, res: ServerResponse): boolean {
  if (!PROXY_KEY) return true;
  const got = req.headers['x-api-key'];
  if (got === PROXY_KEY) return true;
  send(res, 403, { ok: false, error: 'forbidden' });
  return false;
}

function authError(res: ServerResponse, e: unknown): void {
  const err = e as Error & { status?: number; authToken?: string; authType?: string };
  if (err.message === 'mfa_relogin_required') {
    return send(res, 428, {
      ok: false,
      codeRequired: true,
      authType: err.authType ?? 'code_totp',
      authToken: err.authToken,
      message: '2FA code required — POST /auth/login with { authToken, authCode }',
    });
  }
  return send(res, err.status || 401, { ok: false, error: err.message });
}

// ---------- routes ----------

async function routeAuthLogin(res: ServerResponse, body: Record<string, any>): Promise<void> {
  const { username, password, authToken, authCode, emailCode } = body;

  // MFA continuation: { authToken, authCode | emailCode }
  if (authToken && (authCode || emailCode)) {
    const r = await loginStep2(String(authToken), String(authCode || emailCode));
    if (!r.ok || !r.credentials) return send(res, 401, { ok: false, error: r.error });
    setCredentials(r.credentials);
    return send(res, 200, { ok: true, message: 'authenticated', userId: r.credentials.userId });
  }

  if (!username || !password) {
    return send(res, 400, { ok: false, error: 'username and password are required' });
  }

  const r = await login(String(username), String(password));
  if (r.codeRequired) {
    return send(res, 428, {
      ok: false,
      codeRequired: true,
      authType: r.authType, // code_totp | code_email | url_in_minibrowser
      authToken: r.authToken,
      url: r.url ?? undefined,
      message:
        r.authType === 'code_totp'
          ? '2FA code required — POST again with { authToken, authCode }'
          : r.authType === 'code_email'
            ? 'Email code required — POST again with { authToken, emailCode }'
            : 'Additional auth step required',
    });
  }
  if (!r.ok || !r.credentials) return send(res, 401, { ok: false, error: r.error });

  setCredentials(r.credentials);
  storeLoginSource({ username: String(username), password: String(password) });
  return send(res, 200, { ok: true, message: 'authenticated', userId: r.credentials.userId });
}

async function routeStatus(res: ServerResponse): Promise<void> {
  let token: string;
  try {
    token = await ensureToken();
  } catch (e) {
    return authError(res, e);
  }
  const r = await getWebPunch(token);
  if (!r.ok) {
    const msg = r.errors?.[0]?.message || 'status query failed';
    return send(res, /not authenticated|access/i.test(msg) ? 401 : 502, { ok: false, error: msg });
  }
  const wp = (r.data?.webPunch as Record<string, any>) ?? {};
  const session = wp.session ?? null;
  const punchedIn = !!session && !!session.startDate && !session.endDate;
  const punchedOut = !!session && !!session.endDate;
  return send(res, 200, {
    ok: true,
    punchedIn,
    punchedOut,
    session,
    lunchSession: wp.lunchSession ?? null,
    locationTypes: wp.locationTypes ?? [],
    locationType: wp.locationType ?? null,
    ip: wp.ip ?? null,
  });
}

async function routePunch(res: ServerResponse, body: Record<string, any>, force: 'in' | 'out' | 'toggle'): Promise<void> {
  let token: string;
  try {
    token = await ensureToken();
  } catch (e) {
    return authError(res, e);
  }

  // Resolve locationType default from current status when not provided.
  let locationType: string | undefined = body.locationType ? String(body.locationType) : undefined;
  if (!locationType) {
    const st = await getWebPunch(token);
    if (st.ok) locationType = (st.data?.webPunch as Record<string, any>)?.locationType ?? undefined;
  }
  const taskId: number | undefined = body.taskId != null ? Number(body.taskId) : undefined;

  let punchType: PunchType;
  if (force === 'in') punchType = PUNCH_IN;
  else if (force === 'out') punchType = PUNCH_OUT;
  else {
    // toggle: detect current state
    const st = await getWebPunch(token);
    if (!st.ok) {
      return send(res, 502, { ok: false, error: st.errors?.[0]?.message || 'status query failed' });
    }
    const wp = (st.data?.webPunch as Record<string, any>) ?? {};
    const session = wp.session;
    const punchedIn = !!session && !!session.startDate && !session.endDate;
    punchType = punchedIn ? PUNCH_OUT : PUNCH_IN;
  }

  const r = await makePunch(token, { punchType, locationType, taskId });
  if (!r.ok) {
    const msg = r.errors?.[0]?.message || 'punch failed';
    return send(res, 502, { ok: false, error: msg, punchType });
  }
  const log = (r.data?.makePunchByDashboard as Record<string, any>) ?? {};
  return send(res, 200, { ok: true, punchType, locationType: locationType ?? null, session: log });
}

async function routeMe(res: ServerResponse): Promise<void> {
  let token: string;
  try {
    token = await ensureToken();
  } catch (e) {
    return authError(res, e);
  }
  const r = await getCurrentUser(token);
  if (!r.ok) return send(res, 502, { ok: false, error: r.errors?.[0]?.message || 'query failed' });
  return send(res, 200, { ok: true, ...((r.data?.currentUserContext as Record<string, any>) ?? {}) });
}

async function routeRefresh(res: ServerResponse): Promise<void> {
  try {
    await ensureToken();
    const c = state.credentials;
    return send(res, 200, {
      ok: true,
      message: 'token refreshed',
      userId: c?.userId ?? null,
      accessExpiresAt: c?.accessExpiresAt ?? null,
    });
  } catch (e) {
    return authError(res, e);
  }
}

// ---------- server ----------

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    if (!requireKey(req, res)) return;

    // GET /health
    if (method === 'GET' && path === '/health') {
      const c = state.credentials;
      return send(res, 200, {
        ok: true,
        service: 'tc365-proxy',
        authenticated: hasToken(),
        credsStored: !!(state.login?.username && state.login?.password),
        user: state.login?.username ?? null,
        tokenInfo: c
          ? {
              userId: c.userId ?? null,
              accessExpiresAt: c.accessExpiresAt ?? null,
              refreshExpiresAt: c.refreshExpiresAt ?? null,
            }
          : null,
      });
    }

    // POST /auth/login  (creds -> tokens; or MFA continuation)
    if (method === 'POST' && path === '/auth/login') {
      const body = await readBody(req);
      return await routeAuthLogin(res, body);
    }

    // POST /auth/refresh — force a token refresh
    if (method === 'POST' && path === '/auth/refresh') {
      return await routeRefresh(res);
    }

    // POST /auth/logout
    if (method === 'POST' && path === '/auth/logout') {
      clearState();
      state.credentials = undefined;
      state.login = undefined;
      return send(res, 200, { ok: true, message: 'logged out' });
    }

    // GET /status
    if (method === 'GET' && path === '/status') {
      return await routeStatus(res);
    }

    // POST /punch, /punch/in, /punch/out
    if (method === 'POST' && (path === '/punch' || path === '/punch/in' || path === '/punch/out')) {
      const body = await readBody(req);
      const force: 'in' | 'out' | 'toggle' =
        path === '/punch/in' ? 'in' : path === '/punch/out' ? 'out' : 'toggle';
      return await routePunch(res, body, force);
    }

    // GET /me
    if (method === 'GET' && path === '/me') {
      return await routeMe(res);
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    if ((err as Error).message === 'invalid JSON body') return send(res, 400, { ok: false, error: 'invalid JSON body' });
    console.error('[server]', err);
    return send(res, 500, { ok: false, error: (err as Error).message || 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`tc365-proxy listening on http://${HOST}:${PORT}`);
  if (hasToken()) {
    console.log('  token present:', state.credentials?.userId ? `user ${state.credentials.userId}` : '(no user id)');
  } else if (process.env.TC_USERNAME && process.env.TC_PASSWORD) {
    console.log('  env creds configured — tokens mint on first request (auto-relogin enabled)');
    state.login = { username: process.env.TC_USERNAME, password: process.env.TC_PASSWORD };
    saveState(state);
  } else if (state.login?.username) {
    console.log('  stored creds for', state.login.username, '— tokens mint on first request (auto-relogin enabled)');
  } else {
    console.log('  no creds yet — POST /auth/login with { username, password }');
  }
});
