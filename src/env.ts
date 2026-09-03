// src/env.ts — side-effect bootstrap: load .env (if present) and pin the timezone.
// Import this FIRST in index.ts so every other module sees env vars at import time.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE.endsWith(`${process.platform === 'win32' ? '\\' : '/'}dist`)
  ? dirname(HERE)
  : HERE;

const ENV_PATH = process.env.TC_ENV_FILE || join(ROOT, '.env');

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  try {
    const raw = readFileSync(ENV_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Real env wins over .env (PM2 ecosystem overrides file).
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.error('[env] failed to load .env:', (err as Error).message);
  }
}

loadDotEnv();

// Scheduling timezone — must be fixed before any Date logic runs.
process.env.TZ = process.env.TZ || process.env.TC_TZ || 'Asia/Jerusalem';
