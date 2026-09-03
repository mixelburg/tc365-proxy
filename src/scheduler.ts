// src/scheduler.ts — per-user daily punch-in/out planning inside the bot process.
// Every user registered in users.json gets their own daily plan (punch-in
// ~<hour>:00 ± jitter, punch-out +<minHours..maxHours>h), their own weekday
// location map and their own Telegram ping. Israeli holidays are skipped
// (Hebcal), cached once per Gregorian year.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

import type { DbShape, UserRecord } from './db.js';
import type { ClientPool, UserClient } from './tc365-client.js';
import { AuthRequiredError } from './tc365-client.js';
import type { Tg } from './telegram.js';
import { fmtTcIL, fmtIL } from './time.js';

const HERE = fileURLToPath(import.meta.url);
const ROOT = HERE.includes(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}`)
  ? dirname(dirname(HERE))
  : dirname(HERE);

const PLANS_PATH = process.env.TC_SCHED_STATE || join(ROOT, 'scheduler-state.json');
const HOLIDAY_CACHE_PATH = process.env.TC_HOLIDAY_CACHE || join(ROOT, 'holiday-cache.json');
const HEBCAL_BASE =
  'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=on&nx=off&ss=off&mf=off&c=off&o=off&s=off&i=on';
const LOOP_MS = 30_000;
const PUNCH_IN_WINDOW_MIN = 90; // late punch-in grace period after planned time
const HOLIDAY_RETRY_MS = 10 * 60_000;

export interface DayPlan {
  punchInAt: number;
  punchOutAt: number;
  location: string;
  punchedIn: boolean;
  punchedOut: boolean;
  missed: boolean;
  pingedMissed?: boolean;
}

/** plans[chatId][YYYY-MM-DD] -> DayPlan */
export type Plans = Record<string, Record<string, DayPlan>>;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekdayKey(d: Date): string {
  return WEEKDAYS[d.getDay()];
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', { hour12: false });
}

// ---------- plan state persistence ----------

function loadPlans(primaryChat: string): Plans {
  try {
    if (existsSync(PLANS_PATH)) {
      const parsed = JSON.parse(readFileSync(PLANS_PATH, 'utf8'));
      // v2 legacy shape: flat { 'YYYY-MM-DD': plan } — nest under the primary chat.
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        const isLegacy =
          keys.length > 0 &&
          keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) &&
          typeof parsed[keys[0]] === 'object' &&
          parsed[keys[0]] !== null;
        if (isLegacy && primaryChat) {
          const nested: Plans = { [primaryChat]: {} };
          for (const [k, v] of Object.entries(parsed)) {
            nested[primaryChat][k] = v as DayPlan;
          }
          savePlans(nested);
          console.log(`[scheduler] migrated legacy plans (${keys.length} day(s)) under chat ${primaryChat}`);
          return nested;
        }
      }
      return parsed as Plans;
    }
  } catch (err) {
    console.error('[scheduler] failed to load plans:', (err as Error).message);
  }
  return {};
}

function savePlans(plans: Plans): void {
  try {
    mkdirSync(dirname(PLANS_PATH), { recursive: true });
    writeFileSync(PLANS_PATH, JSON.stringify(plans, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[scheduler] failed to save plans:', (err as Error).message);
  }
}

// ---------- Israeli holidays (Hebcal) ----------

interface HolidayCache {
  year: string;
  skip: Record<string, string>;
  fetchedAt: number;
  lastAttempt: number;
}

function loadHolidayCache(): HolidayCache {
  const empty: HolidayCache = { year: '', skip: {}, fetchedAt: 0, lastAttempt: 0 };
  try {
    if (existsSync(HOLIDAY_CACHE_PATH)) {
      const c = JSON.parse(readFileSync(HOLIDAY_CACHE_PATH, 'utf8')) as HolidayCache;
      if (c && typeof c.skip === 'object') return c;
    }
  } catch (err) {
    console.error('[scheduler] failed to load holiday cache:', (err as Error).message);
  }
  return empty;
}

function saveHolidayCache(cache: HolidayCache): void {
  try {
    mkdirSync(dirname(HOLIDAY_CACHE_PATH), { recursive: true });
    writeFileSync(HOLIDAY_CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[scheduler] failed to save holiday cache:', (err as Error).message);
  }
}

const HOLIDAY_EXTRA = (process.env.TC_HOLIDAY_EXTRA || 'Atzma,Sigd')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function fetchHolidayYear(year: number): Promise<Record<string, string>> {
  const url = `${HEBCAL_BASE}&start=${year}-01-01&end=${year}-12-31`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Hebcal HTTP ${res.status}`);
  const data: any = await res.json();
  const skip: Record<string, string> = {};
  for (const it of (data?.items || []) as any[]) {
    if (it?.category !== 'holiday' || !it?.date || !it?.title) continue;
    if (it.yomtov === true) {
      skip[it.date] = it.title;
    } else if (HOLIDAY_EXTRA.some((sub) => it.title.toLowerCase().includes(sub))) {
      skip[it.date] = it.title;
    }
  }
  return skip;
}

const holidayCache: HolidayCache = loadHolidayCache();
const holidayLogged = new Set<string>();

/** True when `d` is an Israeli holiday/day-off (skipped punches). Never throws. */
export async function isHoliday(d: Date): Promise<boolean> {
  const key = localDateKey(d);
  const year = String(d.getFullYear());
  if (holidayCache.year !== year) {
    const backoffOk = Date.now() - (holidayCache.lastAttempt || 0) > HOLIDAY_RETRY_MS;
    if (backoffOk) {
      holidayCache.lastAttempt = Date.now();
      try {
        holidayCache.skip = await fetchHolidayYear(d.getFullYear());
        holidayCache.year = year;
        holidayCache.fetchedAt = Date.now();
        console.log(`[scheduler] holiday cache refreshed for ${year}: ${Object.keys(holidayCache.skip).length} day(s) off`);
      } catch (err) {
        console.error(`[scheduler] holiday fetch failed (treating days as work days): ${(err as Error).message}`);
      }
      saveHolidayCache(holidayCache);
    }
  }
  return key in holidayCache.skip;
}

/** Title of today's holiday (for messages), if any. */
export function todayHolidayTitle(d: Date): string | undefined {
  return holidayCache.skip[localDateKey(d)];
}

// ---------- per-user planning ----------

function planForDay(user: UserRecord, d: Date, plans: Plans): DayPlan | null {
  const key = localDateKey(d);
  const dow = weekdayKey(d);
  const location = user.schedule.daily[dow];
  if (!location) return null; // not a punch day for this user

  const userPlans = plans[user.chatId] ?? (plans[user.chatId] = {});
  let plan = userPlans[key];
  if (!plan) {
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), user.schedule.punchHour, 0, 0, 0).getTime();
    const jitter = randomInt(-user.schedule.jitterMin, user.schedule.jitterMin + 1) * 60_000;
    const punchInAt = target + jitter;
    const hours =
      user.schedule.minHours + Math.random() * (user.schedule.maxHours - user.schedule.minHours);
    const punchOutAt = punchInAt + Math.round(hours * 3_600_000);
    plan = {
      punchInAt,
      punchOutAt,
      location,
      punchedIn: false,
      punchedOut: false,
      missed: false,
    };
    userPlans[key] = plan;
    savePlans(plans);
    console.log(
      `[scheduler] ${user.email} ${key} (${dow}) plan: in ${fmt(punchInAt)} (${location}), out ${fmt(punchOutAt)}`,
    );
  }
  return plan;
}

async function ping(tg: Tg | null, chatId: string, text: string): Promise<void> {
  if (!tg) {
    console.log(`[ping] (no bot token) -> ${chatId}: ${text}`);
    return;
  }
  try {
    await tg.sendMessage(chatId, text);
  } catch (err) {
    console.error(`[ping] telegram send to ${chatId} failed:`, (err as Error).message);
  }
}

async function tickUser(
  db: DbShape,
  client: UserClient,
  plans: Plans,
  tg: Tg | null,
): Promise<void> {
  const user = client.rec;
  const now = Date.now();
  const d = new Date(now);
  const key = localDateKey(d);

  // Holiday skip (per-user toggle).
  if (user.schedule.skipHolidays && (await isHoliday(d))) {
    const existing = plans[user.chatId]?.[key];
    if (existing && !existing.punchedIn) {
      delete plans[user.chatId][key];
      savePlans(plans);
    }
    if (!holidayLogged.has(`${user.chatId}:${key}`)) {
      holidayLogged.add(`${user.chatId}:${key}`);
      const title = todayHolidayTitle(d) || 'holiday';
      console.log(`[scheduler] ${user.email}: ${key} is ${title} — skipping punches`);
    }
    return;
  }

  const plan = planForDay(user, d, plans);
  if (!plan) return;
  if (plan.punchedOut || plan.missed) return;

  const userPlans = plans[user.chatId];
  if (!plan.punchedIn) {
    if (now >= plan.punchInAt && now <= plan.punchInAt + PUNCH_IN_WINDOW_MIN * 60_000) {
      try {
        const r = await client.punch('in', plan.location);
        plan.punchedIn = true;
        savePlans(plans);
        const at = fmtTcIL(r.session?.startDate, fmtIL(new Date(now)));
        console.log(`[scheduler] ${user.email} punched IN at ${at} (${plan.location})`);
        await ping(tg, user.chatId, `⏱ Punched in at ${at} (${plan.location})`);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          await ping(tg, user.chatId, `🔐 Can't punch in automatically — session expired. Send /reauth to reconnect.`);
        }
        console.error(`[scheduler] ${user.email} punch-in failed:`, (err as Error).message);
      }
    } else if (now > plan.punchInAt + PUNCH_IN_WINDOW_MIN * 60_000) {
      plan.missed = true;
      savePlans(plans);
      console.error(`[scheduler] ${user.email} missed punch-in window for ${key}`);
      if (!plan.pingedMissed) {
        plan.pingedMissed = true;
        savePlans(plans);
        await ping(tg, user.chatId, `⚠️ Missed the punch-in window today (planned ~${fmt(plan.punchInAt)}). Punch manually with /punch.`);
      }
    }
    return;
  }

  if (!plan.punchedOut && now >= plan.punchOutAt) {
    try {
      const r = await client.punch('out');
      plan.punchedOut = true;
      savePlans(plans);
      const at = fmtTcIL(r.session?.endDate, fmtIL(new Date(now)));
      const workedMin = Math.round((plan.punchOutAt - plan.punchInAt) / 60_000);
      const workedH = Math.floor(workedMin / 60);
      const workedM = workedMin % 60;
      console.log(`[scheduler] ${user.email} punched OUT at ${at} (worked ${workedH}h ${workedM}m)`);
      await ping(tg, user.chatId, `🏁 Punched out at ${at} — worked ${workedH}h ${workedM}m`);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        await ping(tg, user.chatId, `🔐 Can't punch out automatically — session expired. Send /reauth to reconnect.`);
      }
      console.error(`[scheduler] ${user.email} punch-out failed:`, (err as Error).message);
    }
  }
}

export interface SchedulerHandle {
  plans: Plans;
  stop: () => void;
}

/** Start the per-user scheduler loop (30s tick). Returns the plans store. */
export function startScheduler(db: DbShape, pool: ClientPool, tg: Tg | null): SchedulerHandle {
  const plans = loadPlans(db.meta.primaryChat || '');
  console.log(
    `[scheduler] started (${Object.keys(db.users).length} user(s), tz=${process.env.TZ || 'Asia/Jerusalem'})`,
  );
  if (!tg) console.log('[scheduler] telegram pings disabled (no bot token)');

  const tick = async (): Promise<void> => {
    for (const client of pool.all()) {
      try {
        await tickUser(db, client, plans, tg);
      } catch (err) {
        console.error(`[scheduler] ${client.email} tick error:`, (err as Error).message);
      }
    }
  };

  const iv = setInterval(() => {
    void tick();
  }, LOOP_MS);
  void tick(); // first tick immediately so plans print on boot

  return {
    plans,
    stop: () => clearInterval(iv),
  };
}
