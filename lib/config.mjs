// Runtime configuration and mutable state, both in the state directory.
//
// config.json is written with every default on first run so the knobs are
// discoverable; a key missing from it falls back to the default here. state.json
// holds what the tool must remember between runs: retry counts, alert state and
// the daily count.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, PATHS, STATE_FILES } from './app.mjs';

export const DEFAULTS = Object.freeze({
  // Picked by comparing models on sample documents.
  model: 'sonnet',
  rulesPath: join(PATHS.state, 'rules.md'),
  // Context isolation for the classify call, chosen by measurement:
  // --restricted measured 1,170 input tokens and fired no hooks;
  // --setting-sources project still loaded ~15.6k tokens of user context.
  isolationFlags: ['--restricted'],
  dailyCap: 60,
  confidenceMin: 0.7,
  maxNewDirs: 2,
  maxDepth: 6,
  textCap: 8000,
  pdfPages: 3,
  pdfMinChars: 100,
  ocrMinChars: 40,
  imageMaxPx: 2000,
  stabilityDelayMs: 3000,
  stabilityRounds: 10,
  treeDepth: 4,
  treeMaxLines: 400,
  historyCount: 15,
  maxFailures: 3,
  timeoutMs: 180_000,
  maxBudgetUsd: 0.5,
  // The wake-up wait: any HTTP answer from this URL means the network is back.
  networkCheckUrl: 'https://api.anthropic.com',
  networkWaitTries: 30,
  networkWaitDelayMs: 10_000,
});

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Write via a temp file and rename, so a crash never leaves half a file. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function ensureStateDirs() {
  for (const dir of [PATHS.state, STATE_FILES.work, STATE_FILES.cwd]) mkdirSync(dir, { recursive: true });
}

export function loadConfig() {
  ensureStateDirs();
  if (!existsSync(STATE_FILES.config)) writeJsonAtomic(STATE_FILES.config, DEFAULTS);
  const user = readJson(STATE_FILES.config, {});
  return { ...DEFAULTS, ...user };
}

const EMPTY_STATE = { failures: {}, alerts: {}, daily: { date: null, count: 0 } };

export function loadState() {
  const s = readJson(STATE_FILES.state, {});
  return { ...EMPTY_STATE, ...s, failures: s.failures || {}, alerts: s.alerts || {}, daily: s.daily || EMPTY_STATE.daily };
}

export function saveState(state) {
  ensureStateDirs();
  writeJsonAtomic(STATE_FILES.state, state);
}

/** Local calendar date, YYYY-MM-DD. The daily cap resets at local midnight. */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
