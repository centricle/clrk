// Extract: always text, never pixels.
//
// The classify call has no tools, so whatever it learns about a document comes
// from the text built here. Images are OCR'd locally; an image with no readable
// text never reaches the model.

import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.gif', '.bmp', '.webp']);
const TEXTUTIL = new Set(['.docx', '.doc', '.rtf', '.rtfd', '.html', '.htm', '.odt', '.webarchive', '.wordml']);
const PLAIN = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.log']);

export class ReviewError extends Error {
  constructor(reason) {
    super(reason);
    this.reviewReason = reason;
  }
}

async function run(cmd, args, { timeout = 120_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return execFileP(cmd, args, { timeout, maxBuffer, encoding: 'utf8' });
}

/** Printable characters, a rough measure of whether extraction found text. */
export function meaningfulChars(text) {
  return (text.match(/[\p{L}\p{N}]/gu) || []).length;
}

export async function metadata(path) {
  const st = statSync(path);
  let whereFroms = [];
  try {
    const { stdout } = await run('mdls', ['-raw', '-name', 'kMDItemWhereFroms', path], { timeout: 15_000 });
    if (stdout && stdout.trim() !== '(null)') {
      whereFroms = [...stdout.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).slice(0, 3);
    }
  } catch { /* Spotlight unavailable: metadata is best effort */ }
  return {
    size: st.size,
    created: st.birthtime.toISOString(),
    modified: st.mtime.toISOString(),
    whereFroms,
  };
}

async function pdfText(path, pages) {
  try {
    const { stdout } = await run('pdftotext', ['-l', String(pages), '-layout', path, '-']);
    return stdout;
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/incorrect password|encrypt/i.test(msg)) throw new ReviewError('encrypted PDF');
    throw new ReviewError(`unreadable PDF: ${msg.split('\n')[0].slice(0, 120)}`);
  }
}

async function pdfEncrypted(path) {
  try {
    const { stdout } = await run('pdfinfo', [path], { timeout: 30_000 });
    return /^Encrypted:\s+yes/m.test(stdout);
  } catch (e) {
    return /incorrect password|encrypt/i.test(String(e.stderr || e.message));
  }
}

/**
 * Give a scanned PDF a text layer with ocrmypdf, then swap the result in place
 * of the original. The swap is a rename within one volume, so it is atomic, and
 * the original's timestamps are carried over. A dry run (inPlace false) reads
 * the OCR'd copy in the work dir and leaves the original untouched.
 */
async function ocrPdf(path, workDir, inPlace) {
  const out = join(workDir, 'ocr.pdf');
  await run('ocrmypdf', ['--skip-text', '--quiet', '--output-type', 'pdf', path, out], { timeout: 600_000 });
  if (!inPlace) return out;
  const st = statSync(path);
  const staged = `${path}.ocr-tmp`;
  try {
    renameSync(out, staged);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(out, staged);
  }
  utimesSync(staged, st.atime, st.mtime);
  renameSync(staged, path);
  return path;
}

async function imageText(path, workDir, maxPx) {
  const jpeg = join(workDir, 'page.jpg');
  await run('sips', ['-s', 'format', 'jpeg', '-Z', String(maxPx), path, '--out', jpeg], { timeout: 60_000 });
  const { stdout } = await run('tesseract', [jpeg, 'stdout', '-l', 'eng'], { timeout: 180_000 });
  return stdout;
}

function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodePart(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function splitHeaders(raw) {
  const idx = raw.search(/\r?\n\r?\n/);
  const head = idx === -1 ? raw : raw.slice(0, idx);
  const body = idx === -1 ? '' : raw.slice(idx).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

/** Headers plus the first text/plain part (or stripped text/html) of an email. */
export function emlText(raw) {
  const { headers, body } = splitHeaders(raw);
  const head = ['from', 'to', 'date', 'subject']
    .filter((k) => headers[k]).map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${headers[k]}`).join('\n');

  function findText(h, b, depth = 0) {
    const type = (h['content-type'] || 'text/plain').toLowerCase();
    const boundary = (h['content-type'] || '').match(/boundary="?([^";]+)"?/i);
    if (type.startsWith('multipart/') && boundary && depth < 5) {
      const parts = b.split(`--${boundary[1]}`).slice(1).filter((p) => !p.startsWith('--'));
      let html = null;
      for (const part of parts) {
        const { headers: ph, body: pb } = splitHeaders(part.replace(/^\r?\n/, ''));
        const found = findText(ph, pb, depth + 1);
        if (found?.kind === 'plain') return found;
        if (found && !html) html = found;
      }
      return html;
    }
    if (type.startsWith('text/plain')) return { kind: 'plain', text: decodePart(b, h['content-transfer-encoding']) };
    if (type.startsWith('text/html')) {
      const text = decodePart(b, h['content-transfer-encoding'])
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ');
      return { kind: 'html', text };
    }
    return null;
  }

  const found = findText(headers, body);
  return `${head}\n\n${found ? found.text : ''}`.trim();
}

/**
 * Extract text and metadata. Returns `{ kind, text, ocr, meta, chars }`.
 * Throws ReviewError when the document should go straight to the review pile
 * with no model call.
 */
export async function extract(path, { workDir, config, inPlace = true }) {
  mkdirSync(workDir, { recursive: true });
  const ext = extname(path).toLowerCase();
  const meta = await metadata(path);
  let kind = 'other';
  let text = '';
  let ocr = false;

  try {
    if (ext === '.pdf') {
      kind = 'pdf';
      if (await pdfEncrypted(path)) throw new ReviewError('encrypted PDF');
      text = await pdfText(path, config.pdfPages);
      if (meaningfulChars(text) < config.pdfMinChars) {
        try {
          const ocrd = await ocrPdf(path, workDir, inPlace);
          ocr = true;
          if (inPlace) meta.size = statSync(path).size;
          text = await pdfText(ocrd, config.pdfPages);
        } catch (e) {
          if (e instanceof ReviewError) throw e;
          throw new ReviewError(`OCR failed: ${String(e.stderr || e.message).split('\n')[0].slice(0, 120)}`);
        }
        if (meaningfulChars(text) < config.ocrMinChars) throw new ReviewError('no readable text after OCR');
      }
    } else if (IMAGE.has(ext)) {
      kind = 'image';
      ocr = true;
      try {
        text = await imageText(path, workDir, config.imageMaxPx);
      } catch (e) {
        throw new ReviewError(`OCR failed: ${String(e.stderr || e.message).split('\n')[0].slice(0, 120)}`);
      }
      if (meaningfulChars(text) < config.ocrMinChars) throw new ReviewError('no readable text in image');
    } else if (ext === '.eml') {
      kind = 'email';
      text = emlText(readFileSync(path, 'utf8'));
    } else if (PLAIN.has(ext)) {
      kind = 'text';
      text = readFileSync(path, 'utf8');
    } else if (TEXTUTIL.has(ext)) {
      kind = 'document';
      const { stdout } = await run('textutil', ['-convert', 'txt', '-stdout', path], { timeout: 60_000 });
      text = stdout;
    }
  } finally {
    rmSync(join(workDir, 'page.jpg'), { force: true });
  }

  text = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > config.textCap;
  if (truncated) text = text.slice(0, config.textCap);
  return { kind, text, truncated, ocr, meta, chars: meaningfulChars(text) };
}
