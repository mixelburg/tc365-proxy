// src/bot.ts — Telegram bot: registration wizard (email → password → 2FA),
// status/punch commands, per-user schedule editor and admin commands.

import type { DbShape, UserRecord } from './db.js';
import { saveDb, encryptSecret, defaultSchedule } from './db.js';
import type { ClientPool, UserClient } from './tc365-client.js';
import { authStep1, authStep2, AuthRequiredError } from './tc365-client.js';
import type { Tg, TgHandlerContext, InlineButton } from './telegram.js';
import { TelegramError } from './telegram.js';
import type { Plans } from './scheduler.js';

const LOC_ICON: Record<string, string> = {
  OFFICE: '🏢',
  HOME: '🏠',
  FIELD: '🛠️',
  ABROAD: '✈️',
};
const LOC_CYCLE = ['OFFICE', 'HOME', 'FIELD', 'ABROAD', 'OFF'];
const WEEKDAY_LABEL: Record<string, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};
const DAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FSM_TTL_MS = 15 * 60_000;

type FsmState =
  | { step: 'email' }
  | { step: 'password'; email: string; intent?: 'register' | 'reauth' }
  | { step: 'mfa'; email: string; authToken: string; authType?: string; intent?: 'register' | 'reauth' }
  | { step: 'reauth_email' };

interface FsmSession {
  state: FsmState;
  lastAt: number;
}

export interface BotOptions {
  tg: Tg;
  db: DbShape;
  pool: ClientPool;
  plans: Plans;
  adminChat?: string;
}

export function startBot(opts: BotOptions): void {
  const { tg, db, pool, plans } = opts;
  const adminChat = opts.adminChat || db.meta.primaryChat || '';
  const fsm = new Map<string, FsmSession>();

  const isAdmin = (chatId: string): boolean => !!adminChat && chatId === adminChat;

  const name = (ctx: TgHandlerContext): string =>
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'friend';

  const emailOf = (rec: UserRecord): string => rec.email;

  // ---------- helpers ----------

  function fmtDT(raw: string | undefined, fallback: string): string {
    if (!raw) return fallback;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleTimeString('en-GB', { hour12: false });
  }

  async function statusCard(client: UserClient): Promise<{ text: string; buttons: InlineButton[][] }> {
    const st = await client.status();
    const rec = client.rec;
    const sched = rec.schedule;

    const loc = st.locationType || (st.punchedIn ? 'OFFICE' : '—');
    const icon = LOC_ICON[loc] || '';
    const head = `👤 ${rec.name || rec.email} ${rec.name ? `<${emailOf(rec)}>` : ''}`;
    const stateLine = st.punchedIn
      ? `🟢 Punched in at ${fmtDT(st.session?.startDate, '?')} ${icon}`
      : st.punchedOut
        ? '⚪ Punched out'
        : '⚪ Not punched in';

    // Today's plan, if any
    const now = new Date();
    const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
    const todayLoc = sched.daily[dow];
    const plan = plans[client.chatId]?.[
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    ];
    let planLine = '';
    if (todayLoc && !plan?.punchedOut) {
      const target = plan
        ? `in ~${fmtDT(new Date(plan.punchInAt).toISOString(), '')}, out ~${fmtDT(new Date(plan.punchOutAt).toISOString(), '')}`
        : `in ~${String(sched.punchHour).padStart(2, '0')}:00±${sched.jitterMin}m`;
      planLine = `\n📅 Today (${WEEKDAY_LABEL[dow]}): ${todayLoc} · ${target}`;
    }

    const buttons: InlineButton[][] = [];
    if (st.punchedIn) buttons.push([{ text: '⏹ Punch out', callback_data: 'punch:out' }]);
    else buttons.push([{ text: '▶️ Punch in', callback_data: 'punch:in' }]);
    buttons.push([{ text: '🔄 Refresh', callback_data: 'punch:refresh' }]);

    return { text: `${head}\n${stateLine}${planLine}`, buttons };
  }

  function scheduleText(rec: UserRecord): string {
    const s = rec.schedule;
    const days = DAY_ORDER.map((d) => {
      const loc = s.daily[d];
      return `${WEEKDAY_LABEL[d]} ${loc ? `${LOC_ICON[loc] || ''}${loc}` : '⛔'}`;
    }).join('  ');
    return (
      `📅 Schedule — ${rec.name || rec.email}\n` +
      `⏰ Punch-in ~${String(s.punchHour).padStart(2, '0')}:00 ±${s.jitterMin}m · shift ${s.minHours}–${s.maxHours}h\n` +
      `${days}\n` +
      `🎗 Holidays: ${s.skipHolidays ? 'skipped (Israel)' : 'punched as usual'}`
    );
  }

  function scheduleButtons(rec: UserRecord): InlineButton[][] {
    const rows: InlineButton[][] = [];
    for (let i = 0; i < DAY_ORDER.length; i += 4) {
      rows.push(
        DAY_ORDER.slice(i, i + 4).map((d) => {
          const loc = rec.schedule.daily[d];
          return {
            text: `${WEEKDAY_LABEL[d]} ${loc ? LOC_ICON[loc] || loc : '⛔'}`,
            callback_data: `sc:${d}`,
          };
        }),
      );
    }
    rows.push([{ text: '✅ Done', callback_data: 'sc:done' }]);
    return rows;
  }

  async function sendError(chatId: string, err: unknown): Promise<void> {
    if (err instanceof AuthRequiredError) {
      await tg.sendMessage(chatId, `🔐 ${err.message}`);
    } else if (err instanceof TelegramError) {
      await tg.sendMessage(chatId, `⚠️ ${err.message}`);
    } else {
      const msg = (err as Error).message || 'something went wrong';
      await tg.sendMessage(chatId, `⚠️ ${msg}`);
    }
  }

  // ---------- registration ----------

  async function completeRegistration(
    chatId: string,
    email: string,
    secret: { password?: string; creds?: any },
    tgName: string,
  ): Promise<void> {
    const existing = db.users[chatId];
    const rec: UserRecord = {
      chatId,
      email,
      name: tgName,
      secret: encryptSecret(secret),
      schedule: existing?.schedule ?? defaultScheduleFor(),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    db.users[chatId] = rec;
    if (!db.meta.primaryChat) db.meta.primaryChat = chatId;
    saveDb(db);
    pool.invalidate(chatId);
    const client = pool.get(chatId)!;
    const prof: { name?: string; email?: string; userId?: number | null } = await client
      .fetchProfile()
      .catch(() => ({}));
    if (prof.name) {
      rec.name = prof.name;
      saveDb(db);
    }
    fsm.delete(chatId);
    await tg.sendMessage(
      chatId,
      `✅ Registered ${rec.email}${prof.name ? ` (${prof.name})` : ''}.\n\n` +
        `Auto-punch is on: ~${String(rec.schedule.punchHour).padStart(2, '0')}:00 ±${rec.schedule.jitterMin}m, ${rec.schedule.minHours}–${rec.schedule.maxHours}h shifts, per-day locations below. You'll get a ping on each punch.\n\n` +
        `Use /status to see today's plan · /schedule to change days/locations · /hour to change the time · /punch to punch manually · /logout to remove your account.`,
    );
    const card = await statusCard(client).catch(() => null);
    if (card) await tg.sendMessage(chatId, card.text, { replyMarkup: { inline_keyboard: card.buttons } });
  }

  function defaultScheduleFor() {
    return defaultSchedule();
  }

  /** Re-attach credentials to an already-registered user (session expired). */
  async function reconnectUser(
    chatId: string,
    email: string,
    secret: { password?: string; creds?: any },
    _tgName: string,
  ): Promise<void> {
    const rec = db.users[chatId];
    if (!rec) {
      await tg.sendMessage(chatId, `Something changed — start over with /register.`);
      return;
    }
    rec.email = email;
    rec.secret = encryptSecret(secret);
    saveDb(db);
    pool.invalidate(chatId);
    fsm.delete(chatId);
    await tg.sendMessage(chatId, `✅ Reconnected as ${email}. Auto-punch is back on.`);
    const client = pool.get(chatId);
    if (client) {
      const card = await statusCard(client).catch(() => null);
      if (card) await tg.sendMessage(chatId, card.text, { replyMarkup: { inline_keyboard: card.buttons } });
    }
  }

  // ---------- command handlers ----------

  async function handleCommand(ctx: TgHandlerContext, cmd: string, arg: string): Promise<void> {
    const chatId = ctx.chatId;
    switch (cmd) {
      case 'start':
      case 'help': {
        const registered = !!db.users[chatId];
        await tg.sendMessage(
          chatId,
          `⏱ <b>TC365 Auto-Punch bot</b>\n` +
            (registered
              ? `Registered as ${db.users[chatId].email}.\n`
              : `Not registered yet — send <b>/register</b> with your TimeClock 365 email & password.\n`) +
            `\n<b>Commands</b>\n` +
            `/register — sign in with your TC365 account\n` +
            `/reauth — reconnect if the session expired\n` +
            `/status — am I punched in? today's plan\n` +
            `/punch — punch in/out manually (toggle)\n` +
            `/schedule — set per-day work location\n` +
            `/hour 9 — set planned punch-in hour (09:00±30m)\n` +
            `/holidays — toggle Israeli-holiday skipping\n` +
            `/logout — remove your account from the bot\n` +
            (isAdmin(chatId) ? `/users — list registered users (admin)\n` : '') +
            `\nAfter registering, punching is fully automatic — you'll get a ping on every punch.`,
          {},
        );
        return;
      }

      case 'register': {
        if (db.users[chatId]) {
          await tg.sendMessage(chatId, `You're already registered as ${db.users[chatId].email}. Send /logout first if you want to switch accounts.`);
          return;
        }
        fsm.set(chatId, { state: { step: 'email' }, lastAt: Date.now() });
        await tg.sendMessage(chatId, `Let's set you up.\n\n1️⃣ Send your <b>TimeClock 365 email</b> (the one you log in to the web app with).\n\nSend /cancel anytime to abort.`);
        return;
      }

      case 'reauth': {
        if (!db.users[chatId]) {
          await tg.sendMessage(chatId, `You're not registered. Send /register first.`);
          return;
        }
        fsm.set(chatId, { state: { step: 'reauth_email' }, lastAt: Date.now() });
        await tg.sendMessage(chatId, `Reconnecting ${db.users[chatId].email}…\nSend your <b>TC365 password</b> (we'll ask for a 2FA code too if your account uses one).\n\nSend /cancel to abort.`);
        return;
      }

      case 'cancel': {
        if (fsm.delete(chatId)) await tg.sendMessage(chatId, 'Cancelled.');
        return;
      }

      case 'logout': {
        if (!db.users[chatId]) {
          await tg.sendMessage(chatId, `You're not registered.`);
          return;
        }
        if (arg !== 'yes') {
          await tg.sendMessage(chatId, `This removes ${db.users[chatId].email} and stops auto-punching.\nConfirm with: <b>/logout yes</b>`);
          return;
        }
        pool.invalidate(chatId);
        delete db.users[chatId];
        if (db.meta.primaryChat === chatId) delete db.meta.primaryChat;
        saveDb(db);
        if (plans[chatId]) {
          delete plans[chatId];
        }
        await tg.sendMessage(chatId, `👋 Account removed. Auto-punch stopped. Goodbye!`);
        return;
      }

      case 'status': {
        const client = pool.get(chatId);
        if (!client) return void (await tg.sendMessage(chatId, `Not registered — send /register first.`));
        try {
          const card = await statusCard(client);
          await tg.sendMessage(chatId, card.text, { replyMarkup: { inline_keyboard: card.buttons } });
        } catch (err) {
          await sendError(chatId, err);
        }
        return;
      }

      case 'punch': {
        const client = pool.get(chatId);
        if (!client) return void (await tg.sendMessage(chatId, `Not registered — send /register first.`));
        const force = arg === 'in' ? 'in' : arg === 'out' ? 'out' : 'toggle';
        try {
          await doPunch(chatId, client, force);
        } catch (err) {
          await sendError(chatId, err);
        }
        return;
      }

      case 'schedule': {
        const rec = db.users[chatId];
        if (!rec) return void (await tg.sendMessage(chatId, `Not registered — send /register first.`));
        await tg.sendMessage(chatId, scheduleText(rec) + `\n\nTap a day to cycle its location (⛔ = day off):`, {
          replyMarkup: { inline_keyboard: scheduleButtons(rec) },
        });
        return;
      }

      case 'hour': {
        const rec = db.users[chatId];
        if (!rec) return void (await tg.sendMessage(chatId, `Not registered — send /register first.`));
        const h = Number(arg);
        if (!/^\d{1,2}$/.test(arg) || h < 0 || h > 23) {
          await tg.sendMessage(chatId, `Usage: /hour <0-23> — e.g. /hour 9 (punch-in ~09:00 ±30m).`);
          return;
        }
        rec.schedule.punchHour = h;
        saveDb(db);
        await tg.sendMessage(chatId, `⏰ Punch-in hour set to ~${String(h).padStart(2, '0')}:00 ±${rec.schedule.jitterMin}m.`);
        return;
      }

      case 'holidays': {
        const rec = db.users[chatId];
        if (!rec) return void (await tg.sendMessage(chatId, `Not registered — send /register first.`));
        rec.schedule.skipHolidays = !rec.schedule.skipHolidays;
        saveDb(db);
        await tg.sendMessage(chatId, `🎗 Holidays: ${rec.schedule.skipHolidays ? 'skipped (Israeli holidays are days off)' : 'punched as usual'}.`);
        return;
      }

      case 'users': {
        if (!isAdmin(chatId)) return void (await tg.sendMessage(chatId, `Admin only.`));
        const lines = Object.values(db.users).map((u) => {
          const days = DAY_ORDER.filter((d) => u.schedule.daily[d]).length;
          return `• ${u.name || '—'} <${emailOf(u)}> · chat ${u.chatId} · ${days} day(s)/wk${u.chatId === adminChat ? ' · admin' : ''}`;
        });
        await tg.sendMessage(chatId, `👥 ${Object.keys(db.users).length} registered user(s):\n` + (lines.join('\n') || '(none)'));
        return;
      }

      case 'remove': {
        if (!isAdmin(chatId)) return void (await tg.sendMessage(chatId, `Admin only.`));
        const who = arg.trim().toLowerCase();
        if (!who) return void (await tg.sendMessage(chatId, `Usage: /remove <chatId or email>`));
        const target = Object.values(db.users).find((u) => u.chatId === who || emailOf(u).toLowerCase() === who);
        if (!target) return void (await tg.sendMessage(chatId, `No user matches "${arg}".`));
        if (target.chatId === adminChat) return void (await tg.sendMessage(chatId, `Can't remove the admin account.`));
        pool.invalidate(target.chatId);
        delete db.users[target.chatId];
        delete plans[target.chatId];
        saveDb(db);
        await tg.sendMessage(chatId, `Removed ${emailOf(target)} (chat ${target.chatId}).`);
        return;
      }

      default:
        await tg.sendMessage(chatId, `Unknown command. Send /help for the list.`);
    }
  }

  async function doPunch(chatId: string, client: UserClient, force: 'in' | 'out' | 'toggle'): Promise<void> {
    const r = await client.punch(force);
    const icon = r.punchType === 'PUNCH_IN' ? '▶️' : '⏹';
    const when = fmtDT(r.session?.startDate || r.session?.endDate, 'now');
    const loc = r.locationType ? ` (${LOC_ICON[r.locationType] || ''}${r.locationType})` : '';
    await tg.sendMessage(chatId, `${icon} Punched ${r.punchType === 'PUNCH_IN' ? 'in' : 'out'} at ${when}${loc}`);
  }

  // ---------- callback handlers ----------

  async function handleCallback(ctx: TgHandlerContext): Promise<void> {
    const chatId = ctx.chatId;
    const cb = ctx.callback!;
    const data = cb.data || '';
    const messageId = ctx.messageId;
    await tg.answerCallbackQuery(cb.id).catch(() => undefined);

    if (data.startsWith('punch:')) {
      const client = pool.get(chatId);
      if (!client) {
        await tg.sendMessage(chatId, `Not registered — send /register first.`);
        return;
      }
      const action = data.slice(6);
      try {
        if (action === 'refresh') {
          const card = await statusCard(client);
          if (messageId) await tg.editMessageText(chatId, messageId, card.text, { replyMarkup: { inline_keyboard: card.buttons } });
          return;
        }
        await doPunch(chatId, client, action as 'in' | 'out');
        const card = await statusCard(client).catch(() => null);
        if (card && messageId) {
          await tg.editMessageText(chatId, messageId, card.text, { replyMarkup: { inline_keyboard: card.buttons } }).catch(() => undefined);
        }
      } catch (err) {
        await sendError(chatId, err);
      }
      return;
    }

    if (data.startsWith('sc:')) {
      const rec = db.users[chatId];
      if (!rec) return;
      const day = data.slice(3);
      if (day === 'done') {
        if (messageId) {
          await tg.editMessageText(chatId, messageId, scheduleText(rec), { replyMarkup: null }).catch(() => undefined);
        }
        return;
      }
      const cur = rec.schedule.daily[day];
      const idx = cur ? LOC_CYCLE.indexOf(cur) : -1;
      const next = LOC_CYCLE[(idx + 1) % LOC_CYCLE.length];
      if (next === 'OFF') delete rec.schedule.daily[day];
      else rec.schedule.daily[day] = next;
      saveDb(db);
      if (messageId) {
        await tg.editMessageText(chatId, messageId, scheduleText(rec) + `\n\nTap a day to cycle its location (⛔ = day off):`, {
          replyMarkup: { inline_keyboard: scheduleButtons(rec) },
        }).catch(() => undefined);
      }
      return;
    }
  }

  // ---------- FSM text handling ----------

  async function handleFsm(chatId: string, text: string, ctx: TgHandlerContext): Promise<boolean> {
    const sess = fsm.get(chatId);
    if (!sess) return false;
    if (Date.now() - sess.lastAt > FSM_TTL_MS) {
      fsm.delete(chatId);
      await tg.sendMessage(chatId, `⏳ That registration session expired — start again with /register.`);
      return true;
    }
    sess.lastAt = Date.now();
    const s = sess.state;

    if (s.step === 'email') {
      const email = text.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await tg.sendMessage(chatId, `That doesn't look like an email. Try again, or /cancel.`);
        return true;
      }
      // Make sure the account exists at TC365 and see which auth step is needed.
      try {
        const r = await authStep1(email);
        if (r.codeRequired) {
          fsm.set(chatId, { state: { step: 'mfa', email, authToken: r.authToken || '', authType: r.authType }, lastAt: Date.now() });
          const hint =
            r.authType === 'code_totp'
              ? `2️⃣ Your account uses an authenticator app — send the <b>6-digit code</b>.`
              : r.authType === 'code_email'
                ? `2️⃣ TC365 emailed you a code — send it here.`
                : `2️⃣ Extra sign-in step required (${r.authType}). Send the code/URL result, or /cancel.`;
          await tg.sendMessage(chatId, hint);
          return true;
        }
        if (r.creds) {
          // Some companies return full tokens on the first call — no password step.
          await completeRegistration(chatId, email, { creds: r.creds }, name(ctx));
          return true;
        }
        if (!r.authToken) {
          await tg.sendMessage(chatId, `⚠️ ${r.error || 'login failed'}`);
          fsm.delete(chatId);
          return true;
        }
        fsm.set(chatId, { state: { step: 'password', email }, lastAt: Date.now() });
        await tg.sendMessage(chatId, `2️⃣ Now send your <b>password</b>.`);
        return true;
      } catch (err) {
        fsm.delete(chatId);
        await sendError(chatId, err);
        return true;
      }
    }

    if (s.step === 'password') {
      const r = await authStep2Password(s.email, text, chatId, s.intent || 'register');
      if (r === 'retry') return true; // error already reported
      if (r) {
        if (s.intent === 'reauth') {
          await reconnectUser(chatId, s.email, { password: text, creds: r }, name(ctx));
        } else {
          await completeRegistration(chatId, s.email, { password: text, creds: r }, name(ctx));
        }
      }
      return true;
    }

    if (s.step === 'mfa') {
      const r = await authStep2(s.authToken, text.trim());
      if (!r.ok || !r.creds) {
        await tg.sendMessage(chatId, `⚠️ ${r.error || 'code rejected'} — try again, or /cancel.`);
        return true;
      }
      if (s.intent === 'reauth') {
        await reconnectUser(chatId, s.email, { creds: r.creds }, name(ctx));
      } else {
        await completeRegistration(chatId, s.email, { creds: r.creds }, name(ctx));
      }
      return true;
    }

    if (s.step === 'reauth_email') {
      // Password (or code) typed for the already-registered account.
      const rec = db.users[chatId];
      if (!rec) {
        fsm.delete(chatId);
        await tg.sendMessage(chatId, `Something changed — start over with /register.`);
        return true;
      }
      const r = await authStep2Password(rec.email, text, chatId, 'reauth');
      if (r === 'retry') return true;
      if (r) {
        await reconnectUser(chatId, rec.email, { password: text, creds: r }, name(ctx));
      }
      return true;
    }
    return true;
  }

  async function authStep2Password(
    email: string,
    code: string,
    chatId: string,
    intent: 'register' | 'reauth' = 'register',
  ): Promise<any | 'retry' | null> {
    try {
      const step1 = await authStep1(email);
      if (step1.codeRequired) {
        // Account flipped to 2FA — hand over to the code flow.
        fsm.set(chatId, {
          state: { step: 'mfa', email, authToken: step1.authToken || '', authType: step1.authType, intent },
          lastAt: Date.now(),
        });
        await tg.sendMessage(chatId, `🔐 This account now needs a 2FA code (${step1.authType}) — send it.`);
        return null;
      }
      if (step1.creds) return step1.creds; // tokens on first call — nothing to verify
      if (!step1.authToken) {
        await tg.sendMessage(chatId, `⚠️ ${step1.error || 'login failed'}`);
        return 'retry';
      }
      const r = await authStep2(step1.authToken, code.trim());
      if (!r.ok || !r.creds) {
        await tg.sendMessage(chatId, `⚠️ ${r.error || 'wrong password'} — try again, or /cancel.`);
        return 'retry';
      }
      return r.creds;
    } catch (err) {
      await sendError(chatId, err);
      return 'retry';
    }
  }

  // ---------- main dispatcher ----------

  tg.startPolling(async (ctx) => {
    if (ctx.callback) {
      await handleCallback(ctx);
      return;
    }
    const text = (ctx.text || '').trim();

    // In a registration flow — non-command text is input.
    if (!text.startsWith('/') && fsm.has(ctx.chatId)) {
      const handled = await handleFsm(ctx.chatId, text, ctx).catch((err) => {
        void sendError(ctx.chatId, err);
        return true;
      });
      if (handled) return;
    }

    if (text.startsWith('/')) {
      const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
      const cmd = cmdRaw.toLowerCase();
      if (cmd === 'start' && !db.users[ctx.chatId]) {
        await handleCommand(ctx, 'start', rest.join(' '));
        return;
      }
      // Commands that must not run mid-registration (except cancel)
      if (fsm.has(ctx.chatId) && cmd !== 'cancel') {
        // plain commands are fine; FSM picks up free text only
      }
      await handleCommand(ctx, cmd, rest.join(' '));
      return;
    }

    // Free text with no FSM
    await tg.sendMessage(ctx.chatId, `Send /help to see what I can do.`);
  });

  console.log(`[bot] online${adminChat ? ` (admin chat ${adminChat})` : ''}`);
}
