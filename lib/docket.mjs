// The docket: one JSON line per outcome (filed, review, error, undo), appended
// and never rewritten.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { STATE_FILES } from './app.mjs';
import { ensureStateDirs, today } from './config.mjs';

export function newId(d = new Date()) {
  return `${today(d).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
}

export function readDocket(file = STATE_FILES.docket) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function appendDocket(entry, file = STATE_FILES.docket) {
  ensureStateDirs();
  const full = { ts: new Date().toISOString(), ...entry };
  appendFileSync(file, `${JSON.stringify(full)}\n`);
  return full;
}

/** The most recent filing of this content whose file is still where we put it. */
export function findLiveFiling(entries, sha256) {
  const undone = new Set(entries.filter((e) => e.status === 'undo').map((e) => e.undoes));
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.status === 'filed' && e.sha256 === sha256 && !undone.has(e.id) && e.final_path && existsSync(e.final_path)) {
      return e;
    }
  }
  return null;
}

/** Entries that are decisions (filed or review), newest last. */
export function recentDecisions(entries, n) {
  return entries.filter((e) => e.status === 'filed' || e.status === 'review').slice(-n);
}

/** Today's model calls and tokens, from the docket (local calendar day). */
export function todayUsage(entries, day = today()) {
  const mine = entries.filter((e) => e.model && e.ts && today(new Date(e.ts)) === day);
  return {
    calls: mine.length,
    tokensIn: mine.reduce((a, e) => a + (e.tokens_in || 0), 0),
    tokensOut: mine.reduce((a, e) => a + (e.tokens_out || 0), 0),
  };
}
