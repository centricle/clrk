// Validate a classify decision before anything moves.
//
// The model's answer is untrusted: the document it read may carry a prompt
// injection. Everything here assumes the decision is hostile. The path jail is
// the security boundary for where a file can land; the model never touches the
// filesystem itself.

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';

const JUNK_PREFIXES = [
  'scan', 'scanned', 'scanned document', 'scan doc', 'img', 'image', 'dsc', 'dscn', 'dscf',
  'pxl', 'photo', 'pic', 'picture', 'mvimg', 'screenshot', 'screen shot', 'document',
  'doc', 'file', 'download', 'attachment', 'untitled', 'untitled document', 'new document',
  'print', 'output', 'export', 'camscanner', 'page', 'pdf', 'temp', 'tmp', 'fullsizerender',
];

/**
 * True when a filename carries no information worth keeping, so the model's
 * suggested name may replace it. Decided by the script, never by the model.
 */
export function isJunkName(name) {
  let stem = basename(name, extname(name)).normalize('NFC').toLowerCase().trim();
  // Browser and Finder copy suffixes: "scan (2)", "scan-1", "scan copy".
  stem = stem.replace(/(\s*\(\d+\)|\s+copy(\s+\d+)?)+$/, '').trim();
  if (stem === '') return true;
  if (/^[\d\s_.,:-]+$/.test(stem)) return true;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(stem)) return true;
  if (/^[0-9a-f]{16,}$/.test(stem)) return true;
  for (const prefix of JUNK_PREFIXES.slice().sort((a, b) => b.length - a.length)) {
    if (!stem.startsWith(prefix)) continue;
    const rest = stem.slice(prefix.length).replace(/\b(at|am|pm)\b/g, '');
    if (/^[\d\s_.,:-]*$/.test(rest)) return true;
  }
  return false;
}

/** Folder names the model may not create or file into. */
function badSegment(seg) {
  return seg === '' || seg === '.' || seg === '..' || seg.startsWith('.')
    || /[\u0000-\u001f\u007f]/.test(seg) || seg.includes('\\') || seg.includes(':')
    || seg.length > 120;
}

/**
 * Sanitize a model-suggested filename and force the original extension.
 * Returns null when nothing usable is left.
 */
export function sanitizeFilename(suggested, originalName) {
  if (typeof suggested !== 'string') return null;
  const ext = extname(originalName);
  let stem = suggested.normalize('NFC');
  // Drop any extension the model added; the original one is forced back on.
  const suggestedExt = extname(stem);
  if (suggestedExt && /^\.[a-z0-9]{1,5}$/i.test(suggestedExt)) stem = stem.slice(0, -suggestedExt.length);
  stem = stem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .trim()
    .slice(0, 120)
    .trim();
  if (!stem) return null;
  return `${stem}${ext}`;
}

/** `name`, or `name (2).ext`, `name (3).ext`... whichever is free in `dir`. */
export function uniqueName(dir, name) {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

function isInside(child, parent) {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const REVIEW = (reason, extra = {}) => ({ ok: false, action: 'review', reason, ...extra });

/**
 * Check a decision against the path jail and the config limits.
 *
 * Returns `{ ok: true, action: 'file', destDir, relDest, filename, renamed,
 * newDirs }` or `{ ok: false, action: 'review', reason }`.
 */
export function validateDecision(decision, { documents, inbox, originalName, renameAllowed, config }) {
  if (!decision || typeof decision !== 'object') return REVIEW('no decision');
  if (decision.action === 'review') return REVIEW(`model: ${decision.reason || 'review requested'}`);
  if (decision.action !== 'file') return REVIEW(`unknown action ${JSON.stringify(decision.action)}`);

  const confidence = Number(decision.confidence);
  if (!Number.isFinite(confidence) || confidence < config.confidenceMin) {
    return REVIEW(`low confidence (${Number.isFinite(confidence) ? confidence : 'none'})`);
  }

  const raw = decision.destination;
  if (typeof raw !== 'string' || raw.trim() === '') return REVIEW('no destination');
  const dest = raw.normalize('NFC').trim();
  if (dest.startsWith('/') || dest.startsWith('~') || /^[a-z]+:/i.test(dest)) {
    return REVIEW(`absolute destination rejected: ${dest}`);
  }
  if (dest.includes('\u0000')) return REVIEW('destination contains NUL');
  const segments = dest.replace(/\/+$/, '').split('/');
  if (segments.some(badSegment)) return REVIEW(`destination has a disallowed segment: ${dest}`);
  if (segments.length > config.maxDepth) return REVIEW(`destination deeper than ${config.maxDepth}: ${dest}`);

  const destDir = join(documents, ...segments);
  if (!isInside(destDir, documents) || destDir.toLowerCase() === documents.toLowerCase()) {
    return REVIEW(`destination outside Documents: ${dest}`);
  }
  if (isInside(destDir, inbox)) return REVIEW(`destination inside Inbox: ${dest}`);

  // Walk down: existing parts must be real directories that resolve inside
  // Documents (a symlinked folder could otherwise lead out of the jail).
  const docsReal = realpathSync(documents);
  const newDirs = [];
  let current = docsReal;
  for (const seg of segments) {
    current = join(current, seg);
    if (newDirs.length === 0 && existsSync(current)) {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        const real = realpathSync(current);
        if (!isInside(real, docsReal)) return REVIEW(`destination escapes Documents via a link: ${dest}`);
        if (!statSync(real).isDirectory()) return REVIEW(`destination is not a folder: ${dest}`);
      } else if (!st.isDirectory()) {
        return REVIEW(`destination is not a folder: ${dest}`);
      }
      // The volume is case-insensitive: "taxes" finds "Taxes". Carry the real
      // spelling forward so the docket records the path as it exists.
      current = realpathSync.native(current);
    } else {
      newDirs.push(current);
    }
  }
  if (!isInside(current, docsReal) || isInside(current, realpathSync.native(inbox))) {
    return REVIEW(`destination resolves outside the jail: ${dest}`);
  }
  if (newDirs.length > config.maxNewDirs) {
    return REVIEW(`would create ${newDirs.length} new folders (limit ${config.maxNewDirs}): ${dest}`);
  }

  let filename = originalName;
  let renamed = false;
  if (renameAllowed) {
    const clean = sanitizeFilename(decision.filename, originalName);
    if (clean && clean !== originalName) {
      filename = clean;
      renamed = true;
    }
  }

  return { ok: true, action: 'file', destDir: current, relDest: current.slice(docsReal.length + 1), filename, renamed, newDirs };
}
