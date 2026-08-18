// Token persistence — plain JSON file with 0600 perms so restarts keep the session.

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Credentials } from './tc365.js';

export interface ProxyState {
  credentials?: Credentials | null;
  login?: { username: string; password?: string } | null;
}

// Default state file: <package root>/state.json — works both from src (tsx) and
// from dist (compiled), since dist/ sits one level below the root.
function defaultStatePath(): string {
  const here = fileURLToPath(import.meta.url);
  const isDist = here.includes(`${process.platform === 'win32' ? '\\' : '/'}dist${process.platform === 'win32' ? '\\' : '/'}`);
  const base = isDist ? dirname(dirname(here)) : dirname(here);
  return `${base}/state.json`;
}

const STATE_PATH: string = process.env.TC_STATE_FILE || defaultStatePath();

export function loadState(): ProxyState {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, 'utf8');
      return JSON.parse(raw) as ProxyState;
    }
  } catch (err) {
    console.error('[store] failed to load state:', (err as Error).message);
  }
  return {};
}

export function saveState(state: ProxyState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(STATE_PATH, 0o600);
  } catch (err) {
    console.error('[store] failed to save state:', (err as Error).message);
  }
}

export function clearState(): void {
  try {
    if (existsSync(STATE_PATH)) writeFileSync(STATE_PATH, '{}', { mode: 0o600 });
  } catch (err) {
    console.error('[store] failed to clear state:', (err as Error).message);
  }
}
