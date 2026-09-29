// Intake: which Inbox entries are candidates, whether a file has finished
// arriving, the single-run lock, and content hashing.

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PARTIAL = /\.(crdownload|download|part|partial|tmp)$/i;

/** Why an Inbox entry is ignored, or null when it is a candidate. */
export function skipReason(name) {
  if (name.startsWith('.')) return 'hidden';
  if (name === '_review') return 'review pile';
  if (name === 'Icon\r') return 'folder icon';
  if (name.startsWith('~$')) return 'office lock file';
  if (PARTIAL.test(name)) return 'partial download';
  return null;
}

/**
 * Candidate entries in the Inbox: `{ name, path, isDir }`. v1 does not descend
 * into a dropped folder; the caller sends it to the review pile.
 */
export function listCandidates(inbox) {
  return readdirSync(inbox, { withFileTypes: true })
    .filter((d) => !skipReason(d.name))
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => ({ name: d.name, path: join(inbox, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fingerprint(path) {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Split paths into those that show the same size and mtime on two checks
 * `delayMs` apart, and those that are still changing (or vanished).
 */
export async function partitionStable(paths, delayMs) {
  const first = new Map(paths.map((p) => [p, fingerprint(p)]));
  await sleep(delayMs);
  const stable = [];
  const unstable = [];
  for (const p of paths) {
    const now = fingerprint(p);
    if (now !== null && now === first.get(p)) stable.push(p);
    else if (now !== null) unstable.push(p);
  }
  return { stable, unstable };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * mkdir lock holding a pid file. A lock whose pid is dead is reclaimed.
 * Returns a release function, or null when another live run holds the lock.
 */
export function acquireLock(lockDir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim()); } catch { /* no pid yet */ }
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return null;
      // A holder that died before writing its pid leaves an empty lock; give a
      // just-started run a moment to write it before calling the lock stale.
      if (!Number.isInteger(pid) || pid <= 0) {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs < 5000) return null;
        } catch { /* vanished: retry */ }
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return null;
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
