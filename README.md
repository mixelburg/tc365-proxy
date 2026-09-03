# tc365-proxy → tc365-bot

A zero-runtime-dependency TypeScript **Telegram bot** for [TimeClock 365](https://live.timeclock365.com) auto-punching.
Users register their own TC365 account once (email + password / 2FA code) — the bot then punches them
in/out on a **per-user daily schedule**, skips Israeli holidays, and pings each user on every punch.

One process = **Telegram bot (registration & commands) + HTTP proxy API + per-user scheduler**
(replaces the old two-process layout: single-user `tc365-proxy` + `tc365-scheduler`).

## How it works

TimeClock 365's web app talks to a GraphQL endpoint (`https://live.timeclock365.com/graphql/`) with an
`access-token` header. This bot speaks that language: it mints tokens from the user's creds
(`POST /api/auth/login` → `/api/auth/check`), auto-refreshes them, and punches via the
`makePunchByDashboard` GraphQL mutation. Credentials are stored **AES-256-GCM encrypted** (key from
`TC_ENC_KEY`); access tokens are short-lived (~10 min) and refresh tokens rotate — a dead refresh
token heals itself with a silent re-login (password-auth users) or pings the user to `/reauth` (2FA users).

## Setup

```bash
cd ~/tc365-proxy
npm install          # dev deps only: typescript + @types/node
npm run build        # tsc -> dist/
cp .env.example .env # fill in TC_BOT_TOKEN + TC_ENC_KEY (see below)
pm2 start ecosystem.config.cjs   # starts tc365-bot
```

### Required env (`.env`, gitignored)

| Var | What |
|---|---|
| `TC_BOT_TOKEN` | **Dedicated** bot token from [@BotFather](https://t.me/BotFather). Must not be polled by anything else (e.g. a Hermes gateway) or you get 409 conflicts. |
| `TC_ENC_KEY` | ≥16 chars, used to encrypt stored credentials. Generate: `npm run keygen` |

Optional: `TC_ADMIN_CHAT` (chat allowed to run `/users` & `/remove`; defaults to the migrated legacy
account's chat), `TC_PROXY_KEY` (HTTP API key), scheduling defaults (`TC_SCHED_*` below), file paths.

### v2 → v3 migration (automatic)

On first boot with an empty `users.json`, the process migrates the old single-user layout:
legacy account (`state.json`) → primary user attached to its ping chat; legacy daily plans
(`scheduler-state.json`) are preserved so an in-flight day keeps its punch-out. Old files are left
in place (back them up / delete when happy).

## Telegram commands

| Command | What |
|---|---|
| `/register` | Sign in with your TC365 email → password (→ 2FA code if enabled). Stores your account and turns on auto-punch. |
| `/status` | Am I punched in? Today's plan + inline Punch in/out buttons. |
| `/punch [in\|out]` | Manual punch (default: toggle). |
| `/schedule` | Per-weekday location editor (tap a day to cycle 🏢 OFFICE → 🏠 HOME → 🛠️ FIELD → ✈️ ABROAD → ⛔ off). |
| `/hour 9` | Set planned punch-in hour (punch-in = `HH:00` ± jitter). |
| `/holidays` | Toggle Israeli-holiday skipping (Hebcal: yomtov + Yom Ha'Atzma'ut + Sigd). |
| `/reauth` | Reconnect when a session expired (2FA users after a long downtime). |
| `/logout yes` | Remove your account — auto-punch stops. |
| `/users`, `/remove <chatId\|email>` | Admin only. |

Defaults on registration: punch-in ~`09:00` ±30m, shift `8–10h`, work days
`mon:OFFICE tue:OFFICE wed:HOME thu:OFFICE sun:HOME` (fri/sat off). Every punch sends the user a
Telegram ping (`⏱ punched in …`, `🏁 punched out …`), misses get a warning.

## Scheduler behaviour

- Per-user plans are rolled once per day (persisted in `scheduler-state.json` — restarts don't
  re-roll or double-punch) and executed by a 30s tick inside the bot process.
- Guards: never punches in twice, never punches out without a punch-in, marks a day *missed* if the
  punch-in window (90 min) passes, deletes a leftover plan on holidays.
- Holiday list fetched once per Gregorian year from Hebcal; on fetch failure the day is treated as a
  work day (never blocks a punch).

## HTTP API (kept for scripting)

Runs on `127.0.0.1:8787` by default. Selects a user via the `x-api-user` header (chat id or email);
without the header it uses the **primary** (legacy/admin) account, so old curls keep working.

| Route | Method | Body | What |
|---|---|---|---|
| `/health` | GET | — | service status, user count, bot state |
| `/users` | GET | — | registered accounts (no secrets) |
| `/auth/login` | POST | `{username, password, chatId?}` | register/replace a user's creds (chatId defaults to primary) |
| `/auth/login` | POST | `{authToken, authCode\|emailCode}` | 2FA continuation |
| `/auth/refresh` | POST | — | force token refresh |
| `/auth/logout` | POST | — | remove the resolved user |
| `/status` | GET | — | punched in? session, lunch, location types, IP |
| `/punch` `/punch/in` `/punch/out` | POST | `{locationType?, taskId?}` | toggle / force punch |
| `/me` | GET | — | user/company context |

`locationType` is `OFFICE | HOME | FIELD | ABROAD`; when omitted the account's current location type
is reused.

## Security notes

- Credentials & tokens are AES-256-GCM encrypted at rest with `TC_ENC_KEY` (users.json is chmod 0600).
- Defaults to `127.0.0.1`; to expose the API set `HOST=0.0.0.0` **and** `TC_PROXY_KEY`.
- Anyone who can message the bot can register *their own* TC365 account — that's by design.
- TimeClock 365's audit log records every punch with source `WEB` and the punching IP.

## Troubleshooting

- **409 conflict in logs** — the bot token is being polled somewhere else (check Hermes gateways).
  Create a fresh bot in BotFather and update `TC_BOT_TOKEN`.
- **`🔐 … send /reauth`** — the user's tokens died (e.g. process was down longer than the refresh
  token lifetime and the account uses 2FA). The user sends `/reauth` and their code once.
- **Bot doesn't reply to `/start`** — confirm the process log shows `long-polling started`.
