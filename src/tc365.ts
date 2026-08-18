// TimeClock 365 API client — reverse-engineered from the live web app (Aug 2026).
// Base: https://live.timeclock365.com
//   Auth:   POST /api/auth/login {username, client_id} -> auth_token + auth_type
//           POST /api/auth/check {code} + Auth-Token header -> tokens
//           POST /api/auth/refresh {refresh_token} -> fresh tokens
//   Punch:  GraphQL mutation makePunchByDashboard($punch: InputWebPunch!)
//           InputWebPunch { punchType: PUNCH_IN|PUNCH_OUT, locationType?, taskId? }
//   Status: GraphQL query webPunch() -> { session, lunchSession, locationTypes, locationType, ip }
// Headers: access-token: <access>  +  client-id: <static web client id>

export const API_BASE = 'https://live.timeclock365.com';
export const GRAPHQL_URL = 'https://live.timeclock365.com/graphql/';

// Static client id used by the official web app.
export const WEB_CLIENT_ID: string =
  process.env.TC_CLIENT_ID ||
  'ZWUyYzllNGUzYjlhZDAwNzBiYTgwN2ZjYjU2YWZiNDRhZDhiYTFkNmM5NTkzNzJlNDc1NzRkM2Y5OGFiODc0Nw';

export interface Credentials {
  access: string;
  refresh: string;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  userId: number | null;
}

export type Json = Record<string, any>;

const DEFAULT_HEADERS: Record<string, string> = {
  'client-id': WEB_CLIENT_ID,
  'App-Accept-Language': 'en',
  'Content-Type': 'application/json',
};

/** Unwrap a REST response body: success payload lives in body.data when present. */
function unwrap(body: Json | null): Json | null {
  if (body && typeof body === 'object' && 'data' in body) return body.data as Json;
  return body;
}

/** Extract a readable error message from any upstream error shape. */
export function upstreamError(body: unknown, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 300);
  if (typeof body !== 'object') return fallback;
  const b = body as Json;
  const errors = b.errors;
  if (Array.isArray(errors) && errors.length) {
    const e = errors[0] as Json | null | undefined;
    if (Array.isArray(e)) return e[0]?.message || fallback;
    return e?.message || e?.code || fallback;
  }
  if (b.message) return String(b.message);
  if (b.error) return typeof b.error === 'string' ? b.error : JSON.stringify(b.error);
  return fallback;
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: Json | null;
}

async function httpJson(
  method: string,
  url: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...opts.headers };
  if (opts.token) headers['access-token'] = opts.token;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, body: json };
}

export type AuthType = 'password' | 'code_totp' | 'code_email' | 'url_in_minibrowser';

export interface Step1Result {
  ok: boolean;
  error?: string;
  authToken?: string;
  authType?: AuthType;
  url?: string;
  done?: boolean;
  credentials?: Credentials;
}

export interface Step2Result {
  ok: boolean;
  error?: string;
  credentials?: Credentials;
}

/**
 * Login step 1 — the app POSTs only {username, client_id} to /api/auth/login,
 * gets back an auth_token + auth_data.auth_type telling it what to submit next:
 *   "password"           -> submit the password to /api/auth/check
 *   "code_totp"          -> submit a TOTP code
 *   "code_email"         -> submit a code emailed to the user
 *   "url_in_minibrowser" -> SSO/other; follow the returned url
 */
export async function loginStep1(username: string): Promise<Step1Result> {
  const { status, body } = await httpJson('POST', `${API_BASE}/api/auth/login`, {
    body: { username, client_id: WEB_CLIENT_ID },
  });
  const d = unwrap(body);
  if (status >= 400 || body?.status === 'error') {
    return { ok: false, error: upstreamError(body, `login failed (HTTP ${status})`) };
  }
  if (d?.auth_token && d?.auth_data?.auth_type) {
    return {
      ok: true,
      authToken: String(d.auth_token),
      authType: String(d.auth_data.auth_type) as AuthType,
      url: d.auth_data.url ? String(d.auth_data.url) : undefined,
    };
  }
  if (d?.access_token) {
    // Some companies return full tokens on the first call.
    return { ok: true, done: true, credentials: parseCredentials(d) };
  }
  return { ok: false, error: upstreamError(body, 'login response missing tokens') };
}

/**
 * Step 2 — POST /api/auth/check with { code } and the auth token in the
 * Auth-Token header. `code` is the password (auth_type=password) or the
 * TOTP/email code (auth_type=code_totp / code_email).
 */
export async function loginStep2(authToken: string, code: string): Promise<Step2Result> {
  const { status, body } = await httpJson('POST', `${API_BASE}/api/auth/check`, {
    headers: { 'Auth-Token': authToken },
    body: { code },
  });
  const d = unwrap(body);
  if (status >= 400 || body?.status === 'error') {
    return { ok: false, error: upstreamError(body, `auth check failed (HTTP ${status})`) };
  }
  if (d?.access_token) {
    return { ok: true, credentials: parseCredentials(d) };
  }
  return { ok: false, error: upstreamError(body, 'auth check response missing tokens') };
}

function parseCredentials(d: Json): Credentials {
  return {
    access: String(d.access_token),
    refresh: d.refresh_token ? String(d.refresh_token) : '',
    accessExpiresAt: typeof d.expires_at === 'number' ? d.expires_at : null,
    refreshExpiresAt: typeof d.refresh_expires_at === 'number' ? d.refresh_expires_at : null,
    userId: typeof d.user_id === 'number' ? d.user_id : null,
  };
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  codeRequired?: boolean;
  authToken?: string;
  authType?: AuthType;
  url?: string;
  credentials?: Credentials;
}

/** Full login: step 1 + step 2(password) in one call. */
export async function login(username: string, password: string): Promise<LoginResult> {
  const step1 = await loginStep1(username);
  if (!step1.ok) return step1;
  if (step1.done) return { ok: true, credentials: step1.credentials };
  if (step1.authType !== 'password' || !step1.authToken) {
    return {
      ok: false,
      codeRequired: true,
      authToken: step1.authToken,
      authType: step1.authType,
      url: step1.url,
    };
  }
  return loginStep2(step1.authToken, password);
}

/** Refresh an existing refresh token. */
export async function refreshTokens(refreshToken: string): Promise<Step2Result> {
  const { status, body } = await httpJson('POST', `${API_BASE}/api/auth/refresh`, {
    body: { refresh_token: refreshToken },
  });
  const d = unwrap(body);
  if (status >= 400 || !d?.access_token) {
    return { ok: false, error: upstreamError(body, `refresh failed (HTTP ${status})`) };
  }
  return {
    ok: true,
    credentials: {
      ...parseCredentials(d),
      refresh: d.refresh_token ? String(d.refresh_token) : refreshToken,
    },
  };
}

export interface GraphqlResult {
  ok: boolean;
  status: number;
  errors?: Array<{ message?: string; code?: unknown }>;
  data: Json | null;
}

/** Run a GraphQL operation. Returns { ok, data, errors }. */
export async function graphql(token: string, query: string, variables: Record<string, unknown> = {}): Promise<GraphqlResult> {
  const { status, body } = await httpJson('POST', GRAPHQL_URL, {
    token,
    body: { query, variables },
  });
  if (body?.errors?.length) {
    return { ok: false, status, errors: body.errors, data: body.data ?? null };
  }
  if (status >= 400 || (typeof body?.code === 'number' && body.code >= 400)) {
    return {
      ok: false,
      status,
      errors: [{ message: upstreamError(body, `graphql HTTP ${status}`) }],
      data: null,
    };
  }
  return { ok: true, status, data: (body?.data as Json) ?? body ?? null };
}

export const PUNCH_IN = 'PUNCH_IN';
export const PUNCH_OUT = 'PUNCH_OUT';
export type PunchType = typeof PUNCH_IN | typeof PUNCH_OUT;
export type LocationType = 'OFFICE' | 'HOME' | 'FIELD' | 'ABROAD';

export const QUERY_WEB_PUNCH = `query webPunch {
  webPunch {
    session {
      id
      startDate
      endDate
      startNote
      endNote
      locationType
      manualStartDate
      manualEndDate
    }
    lunchSession {
      id
      startDate
      endDate
    }
    locationTypes
    locationType
    ip
  }
}`;

export const MUTATION_MAKE_PUNCH = `mutation makePunchByDashboard($punch: InputWebPunch!) {
  makePunchByDashboard(punch: $punch) {
    id
    startDate
    endDate
    startDateSourceType
    endDateSourceType
  }
}`;

export const QUERY_CURRENT_USER = `query currentUserContext {
  currentUserContext {
    user {
      id
      fullName
      email
    }
    expectedNumberOfEmployees
    showOnlyHimselfDAR
  }
}`;

/** Fetch punch status for a token. */
export function getWebPunch(token: string): Promise<GraphqlResult> {
  return graphql(token, QUERY_WEB_PUNCH);
}

export interface PunchInput {
  punchType: PunchType;
  locationType?: string;
  taskId?: number;
}

/** Make a punch. locationType/taskId optional. */
export function makePunch(token: string, input: PunchInput): Promise<GraphqlResult> {
  const punch: Record<string, unknown> = { punchType: input.punchType };
  if (input.locationType) punch.locationType = input.locationType;
  if (input.taskId != null) punch.taskId = input.taskId;
  return graphql(token, MUTATION_MAKE_PUNCH, { punch });
}

export function getCurrentUser(token: string): Promise<GraphqlResult> {
  return graphql(token, QUERY_CURRENT_USER);
}
