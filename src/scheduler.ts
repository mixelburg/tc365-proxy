// tc365-proxy scheduler — daily punch-in/out with per-day locations.
//
// Runs as its own PM2 process (tc365-scheduler) and calls the tc365-proxy
// REST API on localhost. Every day it rolls a plan:
//   punch-in  = <TC_SCHED_PUNCH_HOUR>:00 local ± TC_SCHED_JITTER_MIN
//   punch-out = punch-in + random(TC_SCHED_MIN_HOURS .. TC_SCHED_MAX_HOURS)
// then executes it against the proxy and pings Telegram (if configured).
//
// Config (env):
//   TC_TZ               timezone for scheduling (default Asia/Jerusalem)
//   TC_PROXY_BASE       proxy base URL (default http://127.0.0.1:8787)
//   TC_SCHED_PUNCH_HOUR target punch-in hour, local (default 9)
//   TC_SCHED_JITTER_MIN +/- jitter in minutes (default 30)
//   TC_SCHED_MIN_HOURS  min shift length (default 8)
//   TC_SCHED_MAX_HOURS  max shift length (default 10)
//   TC_SCHED_DAILY      per-weekday location map, comma separated. Days not
//                       in the map are skipped (no punch). Default covers the
//                       Israeli work week Sun-Thu:
//                       (default mon:OFFICE,tue:OFFICE,wed:HOME,thu:OFFICE,
//                        sun:HOME — fri/sat are off)
//   TC_SCHED_STATE      plan state file (default <repo root>/scheduler-state.json)
//   TC_SKIP_HOLIDAYS    skip punches on Israeli holidays (default true).
//                       Holidays come from the Hebcal REST API (Israeli
//                       schedule, i=on). A day is skipped when Hebcal marks
//                       it yomtov (religious day off: Rosh Hashana, Yom
//                       Kippur, Sukkot I, Shmini Atzeret, Pesach I/VII,
//                       Shavuot) OR its title contains any of
//                       TC_HOLIDAY_EXTRA (default covers Yom Ha'Atzma'ut
//                       and Sigd — national days off that aren't yomtov).
//                       Chol HaMoed and erev-chag are officially work days
//                       in Israel, so they punch as usual; add "CH''M" to
//                       TC_HOLIDAY_EXTRA if you want them skipped too.
//   TC_HOLIDAY_EXTRA    comma-separated substrings matched (case-insensitive)
//                       against Hebcal holiday titles (default Atzma,Sigd)
//   TC_HOLIDAY_CACHE    holiday cache file (default <repo root>/holiday-cache.json).
//                       Fetched once per Gregorian year; on network failure
//                       the day is treated as a work day (punch as usual)
//                       and retried with a backoff.
//   TC_TG_BOT_TOKEN     Telegram bot token (pings). Falls back to the
//                       `telegram` key in the proxy's state.json.
//   TC_TG_CHAT_ID       Telegram chat id to ping.

// Force scheduling timezone before any Date logic.
process.env.TZ = process.env.TC_TZ || 'Asia/Jerusalem';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const HERE = fileURLToPath(import.meta.url);
const ROOT = HERE.includes(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}`)
  ? dirname(dirname(HERE))
  : dirname(HERE);

const PROXY_BASE = process.env.TC_PROXY_BASE || 'http://127.0.0.1:8787';
const PUNCH_HOUR = Number(process.env.TC_SCHED_PUNCH_HOUR || 9);
const JITTER_MIN = Number(process.env.TC_SCHED_JITTER_MIN || 30);
const MIN_HOURS = Number(process.env.TC_SCHED_MIN_HOURS || 8);
const MAX_HOURS = Number(process.env.TC_SCHED_MAX_HOURS || 10);
const DAILY: Record<string, string> = {};
for (const part of (process.env.TC_SCHED_DAILY ||
  'mon:OFFICE,tue:OFFICE,wed:HOME,thu:OFFICE,sun:HOME').split(',')) {
  const [dow, loc] = part.trim().split(':');
  if (dow) DAILY[dow.toLowerCase()] = (loc || 'HOME').toUpperCase();
}
const STATE_PATH = process.env.TC_SCHED_STATE || join(ROOT, 'scheduler-state.json');
const SKIP_HOLIDAYS = String(process.env.TC_SKIP_HOLIDAYS ?? 'true') !== 'false';
const HOLIDAY_EXTRA = (process.env.TC_HOLIDAY_EXTRA || 'Atzma,Sigd')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const HOLIDAY_CACHE_PATH = process.env.TC_HOLIDAY_CACHE || join(ROOT, 'holiday-cache.json');
const HEBCAL_BASE = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=on&nx=off&ss=off&mf=off&c=off&o=off&s=off&i=on';
const LOOP_MS = 30_000;
const PUNCH_IN_WINDOW_MIN = 90; // late punch-in grace period after planned time

interface DayPlan {
  punchInAt: number;
  punchOutAt: number;
  location: string;
  punchedIn: boolean;
  punchedOut: boolean;
  missed: boolean;
  pingedMissed?: boolean;
}

type PlanState = Record<string, DayPlan>;

function loadState(): PlanState {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PlanState;
  } catch (err) {
    console.error('[scheduler] failed to load plan state:', (err as Error).message);
  }
  return {};
}

function saveState(state: PlanState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[scheduler] failed to save plan state:', (err as Error).message);
  }
}

// ---------- Telegram ping ----------

interface TgConfig { botToken?: string; chatId?: string }

function loadTgConfig(): TgConfig {
  const fromEnv: TgConfig = {};
  if (process.env.TC_TG_BOT_TOKEN) fromEnv.botToken = process.env.TC_TG_BOT_TOKEN;
  if (process.env.TC_TG_CHAT_ID) fromEnv.chatId = process.env.TC_TG_CHAT_ID;
  try {
    const proxyStatePath = process.env.TC_STATE_FILE || join(ROOT, 'state.json');
    if (existsSync(proxyStatePath)) {
      const ps = JSON.parse(readFileSync(proxyStatePath, 'utf8'));
      if (ps?.telegram?.botToken) fromEnv.botToken ||= ps.telegram.botToken;
      if (ps?.telegram?.chatId) fromEnv.chatId ||= String(ps.telegram.chatId);
    }
  } catch {
    /* ignore */
  }
  return fromEnv;
}

async function ping(tg: TgConfig, text: string): Promise<void> {
  if (!tg.botToken || !tg.chatId) {
    console.log(`[ping] (no telegram config) ${text}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(tg.chatId), text }),
    });
    if (!r.ok) console.error('[ping] telegram send failed:', r.status, (await r.text()).slice(0, 200));
  } catch (err) {
    console.error('[ping] telegram error:', (err as Error).message);
  }
}

// ---------- proxy calls ----------

async function proxy(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${PROXY_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function getStatus(): Promise<any> {
  const r = await proxy('GET', '/status');
  return r.json;
}

// ---------- planning ----------

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

function planForDay(d: Date, state: PlanState): DayPlan | null {
  const key = localDateKey(d);
  const dow = weekdayKey(d);
  const location = DAILY[dow];
  if (!location) return null; // not a punch day
  let plan = state[key];
  if (!plan) {
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), PUNCH_HOUR, 0, 0, 0).getTime();
    const jitter = randomInt(-JITTER_MIN, JITTER_MIN + 1) * 60_000;
    const punchInAt = target + jitter;
    const hours = MIN_HOURS + Math.random() * (MAX_HOURS - MIN_HOURS);
    const punchOutAt = punchInAt + Math.round(hours * 3_600_000);
    plan = {
      punchInAt,
      punchOutAt,
      location,
      punchedIn: false,
      punchedOut: false,
      missed: false,
    };
    state[key] = plan;
    saveState(state);
    console.log(
      `[scheduler] ${key} (${dow}) plan: punch-in ${new Date(punchInAt).toLocaleString()} (${location}), ` +
        `punch-out ${new Date(punchOutAt).toLocaleString()}`,
    );
  }
  return plan;
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', { hour12: false });
}

// ---------- Israeli holidays (Hebcal) ----------

interface HolidayCache {
  year: string; // Gregorian year this cache covers ('' if never fetched)
  skip: Record<string, string>; // 'YYYY-MM-DD' -> holiday title
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

const HOLIDAY_RETRY_MS = 10 * 60_000; // backoff before re-fetching after a failure

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

// Returns true when `d` is an Israeli holiday (or national day off) and
// punches should be skipped. Never throws: on any fetch failure the day is
// treated as a normal work day so a Hebcal outage can't cause a missed punch.
async function isHoliday(d: Date): Promise<boolean> {
  if (!SKIP_HOLIDAYS) return false;
  const key = localDateKey(d);
  const year = String(d.getFullYear());
  const cache = loadHolidayCache();
  if (cache.year !== year) {
    const backoffOk = Date.now() - (cache.lastAttempt || 0) > HOLIDAY_RETRY_MS;
    if (backoffOk) {
      cache.lastAttempt = Date.now();
      try {
        cache.skip = await fetchHolidayYear(d.getFullYear());
        cache.year = year;
        cache.fetchedAt = Date.now();
        console.log(`[scheduler] holiday cache refreshed for ${year}: ${Object.keys(cache.skip).length} day(s) off`);
      } catch (err) {
        console.error(`[scheduler] holiday fetch failed (treating days as work days): ${(err as Error).message}`);
      }
      saveHolidayCache(cache);
    }
  }
  return key in cache.skip;
}

// Days already reported as holidays this process run (avoids log spam).
const holidayLogged = new Set<string>();

// ---------- main loop ----------

async function tick(state: PlanState, tg: TgConfig): Promise<void> {
  const now = Date.now();
  const d = new Date(now);
  const key = localDateKey(d);

  // Skip punches entirely on Israeli holidays / national days off.
  if (await isHoliday(d)) {
    // Drop any leftover (pre-fix) plan for today so it can't fire later.
    const existing = state[key];
    if (existing && !existing.punchedIn) {
      delete state[key];
      saveState(state);
    }
    if (!holidayLogged.has(key)) {
      holidayLogged.add(key);
      const title = loadHolidayCache().skip[key] || 'holiday';
      console.log(`[scheduler] ${key} is ${title} — skipping punches`);
    }
    return;
  }

  const plan = planForDay(d, state);
  if (!plan) return;

  if (plan.punchedOut || plan.missed) return;

  if (!plan.punchedIn) {
    if (now >= plan.punchInAt && now <= plan.punchInAt + PUNCH_IN_WINDOW_MIN * 60_000) {
      const r = await proxy('POST', '/punch/in', { locationType: plan.location });
      if (r.status === 200 && r.json?.ok) {
        plan.punchedIn = true;
        saveState(state);
        const at = r.json.session?.startDate || fmt(now);
        console.log(`[scheduler] punched IN at ${at} (${plan.location})`);
        await ping(tg, `⏱ tc365: punched in at ${at} (${plan.location})`);
      } else {
        console.error('[scheduler] punch-in failed:', r.status, JSON.stringify(r.json).slice(0, 300));
      }
    } else if (now > plan.punchInAt + PUNCH_IN_WINDOW_MIN * 60_000) {
      plan.missed = true;
      saveState(state);
      console.error(`[scheduler] missed punch-in window for ${localDateKey(d)}`);
      if (!plan.pingedMissed) {
        plan.pingedMissed = true;
        saveState(state);
        await ping(tg, `⚠️ tc365: missed punch-in window today (planned ~${fmt(plan.punchInAt)})`);
      }
    }
    return;
  }

  if (!plan.punchedOut && now >= plan.punchOutAt) {
    const r = await proxy('POST', '/punch/out');
    if (r.status === 200 && r.json?.ok) {
      plan.punchedOut = true;
      saveState(state);
      const at = r.json.session?.endDate || fmt(now);
      const workedMin = Math.round((plan.punchOutAt - plan.punchInAt) / 60_000);
      const workedH = Math.floor(workedMin / 60);
      const workedM = workedMin % 60;
      console.log(`[scheduler] punched OUT at ${at} (worked ${workedH}h ${workedM}m)`);
      await ping(tg, `🏁 tc365: punched out at ${at} — worked ${workedH}h ${workedM}m`);
    } else {
      console.error('[scheduler] punch-out failed:', r.status, JSON.stringify(r.json).slice(0, 300));
    }
  }
}

async function main(): Promise<void> {
  const state = loadState();
  const tg = loadTgConfig();
  console.log(`[scheduler] started. tz=${process.env.TZ} proxy=${PROXY_BASE} punch=${PUNCH_HOUR}:00±${JITTER_MIN}m ${MIN_HOURS}-${MAX_HOURS}h daily=${JSON.stringify(DAILY)} holidays=${SKIP_HOLIDAYS ? `skip (extra: ${HOLIDAY_EXTRA.join(',') || 'none'})` : 'off'}`);
  if (!tg.botToken) console.log('[scheduler] telegram pings disabled (no bot token configured)');
  // Loop forever; tick() is async and self-contained.
  setInterval(() => {
    tick(state, tg).catch((err) => console.error('[scheduler] tick error:', err));
  }, LOOP_MS);
  // First tick immediately so a plan is printed on boot.
  await tick(state, tg).catch((err) => console.error('[scheduler] tick error:', err));
}

main();
