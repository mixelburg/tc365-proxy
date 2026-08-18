# tc365-proxy

A tiny zero-dependency-ish Node/TypeScript proxy for [TimeClock 365](https://live.timeclock365.com).
You give it your user creds once, it mints the tokens (and auto-refreshes them),
then you punch in/out by curling your own proxy.

## Why

TimeClock 365's official "Open API" uses API-key auth and its docs live behind a
login. The web app itself, however, talks to a GraphQL endpoint
(`https://live.timeclock365.com/graphql/`) with a simple `access-token` header.
This proxy speaks that language: email+password in, punch routes out.

## Setup

```bash
cd ~/tc365-proxy
npm install          # dev deps only: typescript + @types/node
npm run build        # tsc -> dist/
cp .env.example .env # put your creds in, or login via API
pm2 start ecosystem.config.cjs
```

Runtime dependencies: Node 18+ built-ins only (fetch, http). No production deps.

## Routes

All JSON. Optional `TC_PROXY_KEY` gates everything behind `x-api-key`.

| Route | Method | Body | What it does |
|---|---|---|---|
| `/auth/login` | POST | `{ "username", "password" }` | Mints tokens, stores them |
| `/auth/login` | POST | `{ "authToken", "authCode" }` | 2nd step when 2FA (TOTP) is on |
| `/auth/login` | POST | `{ "authToken", "emailCode" }` | 2nd step when email-code 2FA is on |
| `/auth/refresh` | POST | — | Forces a token refresh |
| `/auth/logout` | POST | — | Clears stored tokens |
| `/status` | GET | — | Am I punched in? session, lunch, location types, IP |
| `/punch` | POST | `{ "locationType"?, "taskId"? }` | Toggle: punches out if in, in if out |
| `/punch/in` | POST | `{ "locationType"?, "taskId"? }` | Punch in |
| `/punch/out` | POST | `{ "locationType"?, "taskId"? }` | Punch out |
| `/me` | GET | — | Current user/company from `currentUserContext` |
| `/health` | GET | — | Proxy alive? token state? |

`locationType` is optional (`OFFICE` | `HOME` | `FIELD` | `ABROAD`); when omitted
the proxy reuses whatever the account's current location type is.

## Examples

```bash
# login once
curl -X POST localhost:8787/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"you@company.com","password":"hunter2"}'

# am I in?
curl -s localhost:8787/status

# punch in (toggle)
curl -s -X POST localhost:8787/punch

# punch in at the office, explicitly
curl -s -X POST localhost:8787/punch/in \
  -H 'Content-Type: application/json' -d '{"locationType":"OFFICE"}'

# punch out
curl -s -X POST localhost:8787/punch/out
```

## How it works

1. `POST /api/auth/login` (REST) with `{username, client_id}` — the same first
   step the web app makes. It returns an `auth_token` plus `auth_data.auth_type`:
   - `password` → the proxy submits the password as `{code}` to
     `POST /api/auth/check` with the `Auth-Token` header → tokens.
   - `code_totp` / `code_email` → the proxy returns a `428` with the `authToken`;
     you submit the code (`{authToken, authCode}` or `{authToken, emailCode}`)
     and the proxy completes the same `/api/auth/check` step.
2. Every punch is a GraphQL mutation on `https://live.timeclock365.com/graphql/`:
   `makePunchByDashboard($punch: InputWebPunch!)` with
   `punchType: PUNCH_IN | PUNCH_OUT`, authenticated with the `access-token` header
   (plus the static `client-id` the web app sends).
3. Status comes from `webPunch()` — returns the current session, so the proxy
   knows whether to toggle in or out, and which `locationType` to reuse.
4. Tokens persist to `state.json` (0600). Access tokens are short-lived
   (~10 min) and refresh tokens rotate (~15 min): the proxy auto-refreshes via
   `POST /api/auth/refresh` before expiry, and if the refresh token has died
   (proxy idle too long), it silently re-logs-in with the stored credentials —
   so you can punch in the morning and out in the evening without touching it.

## Security notes

- Defaults to `127.0.0.1`. To punch from your phone, set `HOST=0.0.0.0`
  **and** set `TC_PROXY_KEY` (then send `x-api-key`).
- The stored `state.json` contains live tokens — it is chmod 0600; don't commit it.
- This proxy punches *your* account, wherever you tell it to. The TimeClock 365
  audit log records every punch with source `WEB` and the punching IP.
