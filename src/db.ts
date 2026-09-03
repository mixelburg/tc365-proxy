// src/db.ts — multi-user store (users.json) with AES-256-GCM secrets,
// plus one-shot migration from the old single-user state.json layout.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import type { Credentials } from './tc365.js';

const HERE = fileURLToPath(import.meta.url);
const ROOT = HERE.includes(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}`)
  ? dirname(dirname(HERE))
  : dirname(HERE);

const DB_PATH = process.env.TC_USERS_FILE || join(ROOT, 'users.json');
const LEGACY_STATE_PATH = process.env.TC_STATE_FILE || join(ROOT, 'state.json');
const LEGACY_PLANS_PATH = process.env.TC_SCHED_STATE || join(ROOT, 'scheduler-state.json');

// ---------- schedule defaults ----------

export interface ScheduleCfg {
  punchHour: number; // local hour of the planned punch-in
  jitterMin: number; // +/- random minutes around punchHour
  minHours: number; // shortest shift (random range)
  maxHours: number; // longest shift (random range)
  daily: Record<string, string>; // weekday(lower 3-letter) -> location; absent = day off
  skipHolidays: boolean; // skip punches on Israeli holidays
}

export function defaultSchedule(): ScheduleCfg {
  const daily: Record<string, string> = {};
  for (const part of (process.env.TC_SCHED_DAILY ||
    'mon:OFFICE,tue:OFFICE,wed:HOME,thu:OFFICE,sun:HOME').split(',')) {
    const [dow, loc] = part.trim().split(':');
    if (dow) daily[dow.toLowerCase()] = (loc || 'HOME').toUpperCase();
  }
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    punchHour: num(process.env.TC_SCHED_PUNCH_HOUR, 9),
    jitterMin: num(process.env.TC_SCHED_JITTER_MIN, 30),
    minHours: num(process.env.TC_SCHED_MIN_HOURS, 8),
    maxHours: num(process.env.TC_SCHED_MAX_HOURS, 10),
    daily,
    skipHolidays: String(process.env.TC_SKIP_HOLIDAYS ?? 'true') !== 'false',
  };
}

// ---------- encryption ----------

export interface CipherBlob {
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64 ciphertext
}

function encKey(): Buffer {
  const secret = process.env.TC_ENC_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      'TC_ENC_KEY is required (>=16 chars) — credentials are stored AES-256-GCM encrypted. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return createHash('sha256').update(secret).digest();
}

export interface SecretPayload {
  password?: string; // TC365 password (password-auth users) — allows silent re-login
  creds?: Credentials | null; // live token cache (only path for 2FA users)
}

export function encryptSecret(payload: SecretPayload): CipherBlob {
  const key = encKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecret(blob: CipherBlob): SecretPayload {
  const key = encKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(blob.ct, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8')) as SecretPayload;
}

// ---------- records ----------

export interface UserRecord {
  chatId: string; // telegram chat that owns this account
  email: string; // TC365 login (username)
  name?: string; // display name from TC365 (or telegram first name)
  secret?: CipherBlob; // encrypted SecretPayload
  schedule: ScheduleCfg;
  disabled?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DbShape {
  users: Record<string, UserRecord>; // keyed by chatId
  meta: {
    primaryChat?: string; // legacy/default account chat (HTTP routes without a user header)
    migratedAt?: number;
  };
}

function emptyDb(): DbShape {
  return { users: {}, meta: {} };
}

// ---------- persistence ----------

export function loadDb(): DbShape {
  try {
    if (existsSync(DB_PATH)) {
      const raw = readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(raw) as DbShape;
      if (parsed && typeof parsed.users === 'object') return parsed;
    }
  } catch (err) {
    console.error('[db] failed to load users.json:', (err as Error).message);
  }
  return emptyDb();
}

export function saveDb(db: DbShape): void {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
    chmodSync(DB_PATH, 0o600);
  } catch (err) {
    console.error('[db] failed to save users.json:', (err as Error).message);
  }
}

export function touch(db: DbShape, rec: UserRecord): void {
  rec.updatedAt = Date.now();
  db.users[rec.chatId] = rec;
  saveDb(db);
}

// ---------- legacy (v2 single-user) migration ----------

interface LegacyState {
  credentials?: Credentials | null;
  login?: { username: string; password?: string } | null;
  telegram?: { botToken?: string; chatId?: string | number };
}

interface LegacyPlan {
  punchInAt: number;
  punchOutAt: number;
  location: string;
  punchedIn: boolean;
  punchedOut: boolean;
  missed: boolean;
  pingedMissed?: boolean;
}

function loadLegacyState(): LegacyState {
  try {
    if (existsSync(LEGACY_STATE_PATH)) {
      return JSON.parse(readFileSync(LEGACY_STATE_PATH, 'utf8')) as LegacyState;
    }
  } catch (err) {
    console.error('[db] failed to read legacy state.json:', (err as Error).message);
  }
  return {};
}

function loadLegacyPlans(): Record<string, LegacyPlan> {
  try {
    if (existsSync(LEGACY_PLANS_PATH)) {
      return JSON.parse(readFileSync(LEGACY_PLANS_PATH, 'utf8')) as Record<string, LegacyPlan>;
    }
  } catch (err) {
    console.error('[db] failed to read legacy scheduler-state.json:', (err as Error).message);
  }
  return {};
}

export interface LegacyHints {
  botToken?: string; // legacy ping bot token (state.json telegram.botToken)
  adminChat?: string; // legacy ping chat id
}

/** One-shot migration from the v2 single-user layout into users.json. */
export function migrateLegacy(db: DbShape): LegacyHints {
  const legacy = loadLegacyState();
  const hints: LegacyHints = {};
  if (legacy.telegram?.botToken) hints.botToken = legacy.telegram.botToken;
  if (legacy.telegram?.chatId != null) hints.adminChat = String(legacy.telegram.chatId);

  // Only migrate when the new store is empty and a legacy account exists.
  if (Object.keys(db.users).length > 0 || !legacy.login?.username) return hints;

  const adminChat =
    process.env.TC_ADMIN_CHAT || hints.adminChat || Object.keys(db.users)[0] || '';
  if (!adminChat) {
    console.warn('[db] legacy account found but no chat id to attach it to (set TC_ADMIN_CHAT)');
    return hints;
  }

  const now = Date.now();
  const payload: SecretPayload = {};
  if (legacy.login.password) payload.password = legacy.login.password;
  if (legacy.credentials) payload.creds = legacy.credentials;

  db.users[adminChat] = {
    chatId: adminChat,
    email: legacy.login.username,
    secret: encryptSecret(payload),
    schedule: defaultSchedule(),
    createdAt: now,
    updatedAt: now,
  };
  db.meta.primaryChat = adminChat;
  db.meta.migratedAt = now;
  saveDb(db);
  console.log(
    `[db] migrated legacy account ${legacy.login.username} -> chat ${adminChat} (${Object.keys(db.users).length} user(s))`,
  );
  return hints;
}

// Legacy plan state (scheduler-state.json) is migrated separately by the
// scheduler module so plan keys nest under each user's chat id.
export { LEGACY_PLANS_PATH, DB_PATH, ROOT };
