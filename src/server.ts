// src/server.ts — HTTP proxy routes, now multi-user.
// User selection: `x-api-user` header (chat id or email); when absent the
// primary (legacy/admin) account is used, so old single-user curls keep working.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { DbShape } from './db.js';
import { saveDb, encryptSecret, type UserRecord } from './db.js';
import { authStep1, authStep2, AuthRequiredError, ClientPool } from './tc365-client.js';
import { PUNCH_IN, PUNCH_OUT, type PunchType } from './tc365.js';

const PORT: number = Number(process.env.PORT || 8787);
const HOST: string = process.env.HOST || '127.0.0.1';
const PROXY_KEY: string = process.env.TC_PROXY_KEY || '';

export function startServer(db: DbShape, pool: ClientPool): void {
  // ---------- plumbing ----------

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
    if (req.headers['x-api-key'] === PROXY_KEY) return true;
    send(res, 403, { ok: false, error: 'forbidden' });
    return false;
  }

  function resolveUser(req: IncomingMessage): UserRecord | null {
    const wanted = String(req.headers['x-api-user'] || '').trim().toLowerCase();
    if (wanted) {
      const byChat = db.users[wanted];
      if (byChat) return byChat;
      const byEmail = Object.values(db.users).find((u) => u.email.toLowerCase() === wanted);
      if (byEmail) return byEmail;
      return null;
    }
    const primary = db.meta.primaryChat ? db.users[db.meta.primaryChat] : null;
    if (primary) return primary;
    const all = Object.values(db.users);
    return all.length === 1 ? all[0] : null;
  }

  function authError(res: ServerResponse, e: unknown): void {
    const err = e as Error & { authToken?: string; authType?: string };
    if (err instanceof AuthRequiredError) {
      if (err.message.startsWith('mfa_relogin_required')) {
        return send(res, 428, {
          ok: false,
          codeRequired: true,
          authType: err.authType ?? 'code_totp',
          authToken: err.authToken,
          message: '2FA code required — POST /auth/login with { authToken, authCode }',
        });
      }
      return send(res, 401, { ok: false, error: err.message, reauthRequired: true });
    }
    return send(res, 401, { ok: false, error: err.message });
  }

  function userOut(rec: UserRecord): Record<string, unknown> {
    return {
      chatId: rec.chatId,
      email: rec.email,
      name: rec.name ?? null,
      schedule: rec.schedule,
      createdAt: rec.createdAt,
    };
  }

  // ---------- route handlers ----------

  async function routeAuthLogin(req: IncomingMessage, res: ServerResponse, body: Record<string, any>): Promise<void> {
    const { username, password, chatId, authToken, authCode, emailCode } = body;

    // MFA continuation: { authToken, authCode | emailCode }
    if (authToken && (authCode || emailCode)) {
      const r = await authStep2(String(authToken), String(authCode || emailCode));
      if (!r.ok || !r.creds) return send(res, 401, { ok: false, error: r.error });
      const target = chatId ? db.users[String(chatId)] : resolveUser(req);
      if (!target) return send(res, 404, { ok: false, error: 'no such user — pass chatId' });
      target.secret = encryptSecret({ creds: r.creds });
      saveDb(db);
      pool.invalidate(target.chatId);
      return send(res, 200, { ok: true, message: 'authenticated', userId: r.creds.userId });
    }

    if (!username || !password) {
      return send(res, 400, { ok: false, error: 'username and password are required' });
    }

    // Register-or-replace a user for a given chat (or the primary chat).
    const targetChat = chatId ? String(chatId) : db.meta.primaryChat;
    if (!targetChat) {
      return send(res, 400, { ok: false, error: 'no primary user yet — pass chatId to register one' });
    }

    const step1 = await authStep1(String(username));
    if (step1.codeRequired) {
      return send(res, 428, {
        ok: false,
        codeRequired: true,
        authType: step1.authType,
        authToken: step1.authToken,
        url: null,
        message: '2FA code required — POST again with { authToken, authCode }',
      });
    }
    if (!step1.ok || !step1.authToken) {
      return send(res, 401, { ok: false, error: step1.error || 'login failed' });
    }
    const r = await authStep2(step1.authToken, String(password));
    if (!r.ok || !r.creds) return send(res, 401, { ok: false, error: r.error });

    const existing = db.users[targetChat];
    const rec: UserRecord = {
      chatId: targetChat,
      email: String(username),
      name: existing?.name,
      secret: encryptSecret({ password: String(password), creds: r.creds }),
      schedule: existing?.schedule ?? {
        punchHour: Number(process.env.TC_SCHED_PUNCH_HOUR || 9),
        jitterMin: Number(process.env.TC_SCHED_JITTER_MIN || 30),
        minHours: Number(process.env.TC_SCHED_MIN_HOURS || 8),
        maxHours: Number(process.env.TC_SCHED_MAX_HOURS || 10),
        daily: {},
        skipHolidays: true,
      },
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    for (const part of (process.env.TC_SCHED_DAILY || 'mon:OFFICE,tue:OFFICE,wed:HOME,thu:OFFICE,sun:HOME').split(',')) {
      const [dow, loc] = part.trim().split(':');
      if (dow) rec.schedule.daily[dow.toLowerCase()] = (loc || 'HOME').toUpperCase();
    }
    db.users[targetChat] = rec;
    if (!db.meta.primaryChat) db.meta.primaryChat = targetChat;
    saveDb(db);
    pool.invalidate(targetChat);
    return send(res, 200, { ok: true, message: 'authenticated', userId: r.creds.userId, chatId: targetChat });
  }

  async function withClient(
    req: IncomingMessage,
    res: ServerResponse,
    fn: (client: import('./tc365-client.js').UserClient) => Promise<void>,
  ): Promise<void> {
    const rec = resolveUser(req);
    if (!rec) {
      return send(res, 401, { ok: false, error: 'not_authenticated — no user matches (register first or pass x-api-user)' });
    }
    const client = pool.get(rec.chatId);
    if (!client) return send(res, 401, { ok: false, error: 'not_authenticated' });
    try {
      await fn(client);
    } catch (e) {
      authError(res, e);
    }
  }

  async function routeStatus(_req: IncomingMessage, res: ServerResponse, client: import('./tc365-client.js').UserClient): Promise<void> {
    const st = await client.status();
    return send(res, 200, {
      ok: true,
      email: client.email,
      punchedIn: st.punchedIn,
      punchedOut: st.punchedOut,
      session: st.session,
      lunchSession: st.lunchSession,
      locationTypes: st.locationTypes,
      locationType: st.locationType,
      ip: st.ip,
    });
  }

  async function routePunch(_req: IncomingMessage, res: ServerResponse, client: import('./tc365-client.js').UserClient, body: Record<string, any>, force: 'in' | 'out' | 'toggle'): Promise<void> {
    const locationType: string | undefined = body.locationType ? String(body.locationType) : undefined;
    const taskId: number | undefined = body.taskId != null ? Number(body.taskId) : undefined;
    // taskId isn't part of the UserClient API surface used by the bot; the
    // GraphQL call supports it, so punch directly when provided.
    if (taskId != null) {
      const token = await client.ensureToken().catch((e) => {
        throw e;
      });
      const st = force === 'toggle' ? await client.status().catch(() => null) : null;
      const punchType: PunchType = force === 'in' ? PUNCH_IN : force === 'out' ? PUNCH_OUT : st?.punchedIn ? PUNCH_OUT : PUNCH_IN;
      const { makePunch } = await import('./tc365.js');
      const r = await makePunch(token, { punchType, locationType, taskId });
      if (!r.ok) return send(res, 502, { ok: false, error: r.errors?.[0]?.message || 'punch failed', punchType });
      return send(res, 200, { ok: true, punchType, locationType: locationType ?? null, session: (r.data?.makePunchByDashboard as Record<string, any>) ?? {} });
    }
    const r = await client.punch(force, locationType);
    return send(res, 200, { ok: true, punchType: r.punchType, locationType: r.locationType, session: r.session, email: client.email });
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
        const users = Object.values(db.users);
        return send(res, 200, {
          ok: true,
          service: 'tc365-bot',
          users: users.length,
          primary: db.meta.primaryChat ? db.users[db.meta.primaryChat]?.email ?? null : null,
          interactiveBot: !!process.env.TC_BOT_TOKEN,
          tz: process.env.TZ || 'Asia/Jerusalem',
        });
      }

      // GET /users — registered accounts (no secrets)
      if (method === 'GET' && path === '/users') {
        return send(res, 200, { ok: true, users: Object.values(db.users).map(userOut) });
      }

      // POST /auth/login  (register or update creds; MFA continuation)
      if (method === 'POST' && path === '/auth/login') {
        const body = await readBody(req);
        return await routeAuthLogin(req, res, body);
      }

      // POST /auth/refresh — force token refresh for the resolved user
      if (method === 'POST' && path === '/auth/refresh') {
        return await withClient(req, res, async (client) => {
          await client.ensureToken();
          return send(res, 200, { ok: true, message: 'token refreshed', email: client.email });
        });
      }

      // POST /auth/logout — remove the resolved user
      if (method === 'POST' && path === '/auth/logout') {
        const rec = resolveUser(req);
        if (!rec) return send(res, 401, { ok: false, error: 'not_authenticated' });
        pool.invalidate(rec.chatId);
        delete db.users[rec.chatId];
        if (db.meta.primaryChat === rec.chatId) delete db.meta.primaryChat;
        saveDb(db);
        return send(res, 200, { ok: true, message: 'logged out' });
      }

      // GET /status
      if (method === 'GET' && path === '/status') {
        return await withClient(req, res, (c) => routeStatus(req, res, c));
      }

      // POST /punch, /punch/in, /punch/out
      if (method === 'POST' && (path === '/punch' || path === '/punch/in' || path === '/punch/out')) {
        const body = await readBody(req);
        const force: 'in' | 'out' | 'toggle' =
          path === '/punch/in' ? 'in' : path === '/punch/out' ? 'out' : 'toggle';
        return await withClient(req, res, (c) => routePunch(req, res, c, body, force));
      }

      // GET /me
      if (method === 'GET' && path === '/me') {
        return await withClient(req, res, async (client) => {
          const token = await client.ensureToken();
          const { getCurrentUser } = await import('./tc365.js');
          const r = await getCurrentUser(token);
          if (!r.ok) return send(res, 502, { ok: false, error: r.errors?.[0]?.message || 'query failed' });
          return send(res, 200, { ok: true, email: client.email, ...((r.data?.currentUserContext as Record<string, any>) ?? {}) });
        });
      }

      return send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      if ((err as Error).message === 'invalid JSON body') return send(res, 400, { ok: false, error: 'invalid JSON body' });
      console.error('[server]', err);
      return send(res, 500, { ok: false, error: (err as Error).message || 'internal error' });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`tc365 http server listening on http://${HOST}:${PORT} (${Object.keys(db.users).length} user(s))`);
  });
}
