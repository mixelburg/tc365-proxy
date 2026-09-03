// src/index.ts — tc365-bot bootstrap: single process = HTTP proxy + Telegram
// bot (registration & commands) + per-user scheduler. Replaces the old
// two-process layout (tc365-proxy + tc365-scheduler).

import './env.js'; // must be first: loads .env + pins TZ

import { loadDb, migrateLegacy, DB_PATH, type DbShape } from './db.js';
import { ClientPool } from './tc365-client.js';
import { Tg } from './telegram.js';
import { startScheduler } from './scheduler.js';
import { startBot } from './bot.js';
import { startServer } from './server.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './db.js';

// ---------- state ----------

const db: DbShape = loadDb();
const legacyHints = migrateLegacy(db);
const adminChat = process.env.TC_ADMIN_CHAT || legacyHints.adminChat || db.meta.primaryChat || '';

const pool = new ClientPool(db);

// ---------- telegram tokens ----------
// TC_BOT_TOKEN: interactive bot (long-polling). Must be a *dedicated* token —
// never one polled by another process (e.g. a Hermes gateway).
// Pings fall back to TC_TG_BOT_TOKEN / the legacy state.json token when the
// interactive token isn't set yet.

function legacyTokenFallback(): string {
  try {
    const p = process.env.TC_STATE_FILE || join(ROOT, 'state.json');
    if (existsSync(p)) {
      const s = JSON.parse(readFileSync(p, 'utf8'));
      if (s?.telegram?.botToken) return String(s.telegram.botToken);
    }
  } catch {
    /* ignore */
  }
  return '';
}

const interactiveToken = process.env.TC_BOT_TOKEN || '';
const pingToken =
  process.env.TC_BOT_TOKEN ||
  process.env.TC_TG_BOT_TOKEN ||
  legacyTokenFallback() ||
  '';

const pingsTg = pingToken ? new Tg(pingToken) : null;
const botTg = interactiveToken ? (interactiveToken === pingToken ? pingsTg : new Tg(interactiveToken)) : null;

// ---------- start everything ----------

startServer(db, pool);
const { plans } = startScheduler(db, pool, pingsTg);
if (botTg) {
  startBot({ tg: botTg, db, pool, plans, adminChat });
} else {
  console.log(
    '[bot] interactive bot DISABLED — set TC_BOT_TOKEN (dedicated @BotFather token) to enable registration.',
  );
  if (pingsTg) console.log('[bot] pings will keep flowing through the legacy token until then.');
}

console.log(`[boot] db=${DB_PATH} users=${Object.keys(db.users).length} adminChat=${adminChat || '(none)'}`);
console.log('[boot] ready.');
