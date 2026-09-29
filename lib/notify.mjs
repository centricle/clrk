// Alerts: a macOS notification, and a line in the log. Nothing about a
// document leaves the machine except the classify call.

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { APP_NAME, APP_TITLE, PATHS } from './app.mjs';

const QUIET_ENV = `${APP_NAME.toUpperCase()}_QUIET`;

export function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { appendFileSync(PATHS.log, line); } catch { /* log dir missing: best effort */ }
  if (process.stderr.isTTY) process.stderr.write(line);
}

/** Keep the log to its last `max` lines, in place. Never renamed, so tails keep working. */
export function trimLog(max = 1000) {
  if (!existsSync(PATHS.log)) return;
  const lines = readFileSync(PATHS.log, 'utf8').split('\n');
  if (lines.length <= max + 1) return;
  writeFileSync(PATHS.log, lines.slice(-(max + 1)).join('\n'));
}

/**
 * Best effort: a notification that cannot be delivered never fails a run.
 */
export function notify(subtitle, text) {
  log(`ALERT ${subtitle}: ${text}`);
  if (process.env[QUIET_ENV]) return Promise.resolve();
  const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(APP_TITLE)}`
    + ` subtitle ${JSON.stringify(subtitle)}`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 10_000 }, () => resolve());
  });
}
