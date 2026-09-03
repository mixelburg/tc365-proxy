// src/tc365-client.ts — per-user TimeClock 365 client: token lifecycle
// (refresh / silent re-login / explicit re-auth) + status & punch helpers.
// One UserClient per registered chat; clients are cached in a ClientPool.

import {
  login,
  loginStep1,
  loginStep2,
  refreshTokens,
  getWebPunch,
  makePunch,
  getCurrentUser,
  PUNCH_IN,
  PUNCH_OUT,
  type Credentials,
  type PunchType,
} from './tc365.js';

import {
  decryptSecret,
  encryptSecret,
  saveDb,
  type DbShape,
  type UserRecord,
  type SecretPayload,
} from './db.js';

export class AuthRequiredError extends Error {
  authToken?: string;
  authType?: string;
  constructor(message: string, authToken?: string, authType?: string) {
    super(message);
    this.authToken = authToken;
    this.authType = authType;
  }
}

export interface PunchStatus {
  punchedIn: boolean;
  punchedOut: boolean;
  session: Record<string, any> | null;
  lunchSession: Record<string, any> | null;
  locationTypes: string[];
  locationType: string | null;
  ip: string | null;
}

export class UserClient {
  private payload: SecretPayload;
  private creds: Credentials | null = null;
  private mutex: Promise<string> = Promise.resolve('');
  private sessionExpiredFired = false;

  constructor(
    private db: DbShape,
    public readonly rec: UserRecord,
  ) {
    this.payload = rec.secret ? decryptSecret(rec.secret) : {};
    this.creds = this.payload.creds ?? null;
  }

  get email(): string {
    return this.rec.email;
  }

  get chatId(): string {
    return this.rec.chatId;
  }

  hasPassword(): boolean {
    return !!this.payload.password;
  }

  /** Persist the current token cache back into the encrypted record. */
  private persist(): void {
    this.rec.secret = encryptSecret({
      password: this.payload.password,
      creds: this.creds,
    });
    this.rec.updatedAt = Date.now();
    saveDb(this.db);
  }

  // ---------- token lifecycle ----------

  private hasToken(): boolean {
    return !!(this.creds && this.creds.access);
  }

  private accessExpired(): boolean {
    const c = this.creds;
    if (!c || !c.accessExpiresAt) return false;
    return Date.now() / 1000 >= c.accessExpiresAt - 60; // 60s buffer
  }

  private setCredentials(creds: Credentials): void {
    this.creds = creds;
    this.persist();
  }

  private async reloginWithPassword(): Promise<string> {
    const r = await login(this.rec.email, this.payload.password || '');
    if (!r.ok) {
      if (r.codeRequired) {
        throw new AuthRequiredError(
          `mfa_relogin_required (${r.authType || 'code'})`,
          r.authToken,
          r.authType,
        );
      }
      throw new Error(`re-login failed: ${r.error}`);
    }
    if (!r.credentials) throw new Error('re-login returned no credentials');
    this.setCredentials(r.credentials);
    return r.credentials.access;
  }

  async ensureToken(): Promise<string> {
    if (!this.hasToken()) {
      if (this.payload.password) return this.reloginWithPassword();
      this.sessionExpiredFired = true;
      throw new AuthRequiredError('not_authenticated — send /reauth to sign in again');
    }
    if (!this.accessExpired()) return this.creds!.access;

    this.mutex = this.mutex.then(async () => {
      if (!this.accessExpired()) return this.creds!.access; // someone else refreshed
      const res = await refreshTokens(this.creds!.refresh);
      if (!res.ok || !res.credentials) {
        if (this.payload.password) return this.reloginWithPassword();
        this.sessionExpiredFired = true;
        throw new AuthRequiredError('session_expired — send /reauth to sign in again');
      }
      this.creds = res.credentials;
      this.persist();
      return res.credentials.access;
    });
    return this.mutex;
  }

  /** True once a token failure surfaced that needs an interactive /reauth. */
  consumeSessionExpiredFlag(): boolean {
    const v = this.sessionExpiredFired;
    this.sessionExpiredFired = false;
    return v;
  }

  // ---------- account ops ----------

  async fetchProfile(): Promise<{ name?: string; email?: string; userId?: number | null }> {
    try {
      const token = await this.ensureToken();
      const r = await getCurrentUser(token);
      if (r.ok) {
        const ctx = (r.data?.currentUserContext as Record<string, any>) ?? {};
        const user = (ctx.user as Record<string, any>) ?? {};
        return {
          name: user.fullName ? String(user.fullName) : undefined,
          email: user.email ? String(user.email) : undefined,
          userId: typeof user.id === 'number' ? user.id : undefined,
        };
      }
    } catch {
      /* profile is best-effort */
    }
    return {};
  }

  async status(): Promise<PunchStatus> {
    const token = await this.ensureToken();
    const r = await getWebPunch(token);
    if (!r.ok) {
      throw new Error(r.errors?.[0]?.message || 'status query failed');
    }
    const wp = (r.data?.webPunch as Record<string, any>) ?? {};
    const session = wp.session ?? null;
    return {
      punchedIn: !!session && !!session.startDate && !session.endDate,
      punchedOut: !!session && !!session.endDate,
      session,
      lunchSession: wp.lunchSession ?? null,
      locationTypes: wp.locationTypes ?? [],
      locationType: wp.locationType ?? null,
      ip: wp.ip ?? null,
    };
  }

  async punch(
    force: 'in' | 'out' | 'toggle',
    locationType?: string,
  ): Promise<{ punchType: PunchType; locationType: string | null; session: Record<string, any> }> {
    const token = await this.ensureToken();

    let punchType: PunchType;
    if (force === 'in') punchType = PUNCH_IN;
    else if (force === 'out') punchType = PUNCH_OUT;
    else {
      const st = await this.status();
      punchType = st.punchedIn ? PUNCH_OUT : PUNCH_IN;
    }

    // Resolve a default location from the account's current status when none given.
    let loc: string | undefined = locationType || undefined;
    if (!loc) {
      try {
        const st = await getWebPunch(token);
        if (st.ok) loc = (st.data?.webPunch as Record<string, any>)?.locationType ?? undefined;
      } catch {
        /* keep undefined */
      }
    }

    const r = await makePunch(token, { punchType, locationType: loc });
    if (!r.ok) {
      throw new Error(r.errors?.[0]?.message || 'punch failed');
    }
    const log = (r.data?.makePunchByDashboard as Record<string, any>) ?? {};
    return { punchType, locationType: loc ?? null, session: log };
  }
}

export interface LoginStepOutcome {
  ok: boolean;
  error?: string;
  codeRequired?: boolean;
  authToken?: string;
  authType?: string;
  creds?: Credentials;
}

/** Login step 1 (username only) — used by the bot registration FSM. */
export async function authStep1(email: string): Promise<LoginStepOutcome> {
  const r = await loginStep1(email);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.done && r.credentials) return { ok: true, creds: r.credentials };
  if (r.authType !== 'password' || !r.authToken) {
    return {
      ok: false,
      codeRequired: true,
      authToken: r.authToken,
      authType: r.authType,
      error: `Additional auth step required (${r.authType})`,
    };
  }
  return { ok: true, authToken: r.authToken, authType: r.authType };
}

/** Complete the password (or 2FA code) step and return fresh credentials. */
export async function authStep2(
  authToken: string,
  code: string,
): Promise<{ ok: boolean; error?: string; creds?: Credentials }> {
  const r = await loginStep2(authToken, code);
  if (!r.ok || !r.credentials) return { ok: false, error: r.error };
  return { ok: true, creds: r.credentials };
}

/** Live client cache — invalidate whenever a user's secret changes. */
export class ClientPool {
  private clients = new Map<string, UserClient>();

  constructor(private db: DbShape) {}

  get(chatId: string): UserClient | null {
    const rec = this.db.users[chatId];
    if (!rec) return null;
    let c = this.clients.get(chatId);
    if (!c || c.rec !== rec) {
      c = new UserClient(this.db, rec);
      this.clients.set(chatId, c);
    }
    return c;
  }

  invalidate(chatId: string): void {
    this.clients.delete(chatId);
  }

  all(): UserClient[] {
    return Object.keys(this.db.users)
      .map((id) => this.get(id))
      .filter((c): c is UserClient => !!c);
  }
}
