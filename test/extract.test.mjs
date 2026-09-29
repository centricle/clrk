// Extraction against real tools. Skipped where a tool or the fixtures are
// missing; build fixtures with test/fixtures/make.sh.
import { HOME } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/config.mjs';
import { ReviewError, emlText, extract } from '../lib/extract.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'out');
const has = (cmd) => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`]).status === 0;
const ready = existsSync(FIX) && ['pdftotext', 'ocrmypdf', 'tesseract', 'sips', 'textutil'].every(has);
const skip = ready ? false : 'fixtures or OCR tools missing';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function copy(name) {
  const dir = join(HOME, 'extract', String(Math.random()).slice(2));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  copyFileSync(join(FIX, name), p);
  return { path: p, workDir: join(dir, 'work') };
}

test('email: headers and the text/plain part, quoted-printable decoded', () => {
  const raw = [
    'From: ACME <a@acme.example>', 'Subject: Order 5511', 'Content-Type: multipart/alternative; boundary="b"', '',
    '--b', 'Content-Type: text/plain', 'Content-Transfer-Encoding: quoted-printable', '',
    'Shipped: boulders=2C 1 case.=20', 'Just add water.', '--b', 'Content-Type: text/html', '', '<p>ignored</p>', '--b--',
  ].join('\r\n');
  const t = emlText(raw);
  assert.match(t, /^From: ACME/);
  assert.match(t, /Subject: Order 5511/);
  assert.match(t, /Shipped: boulders, 1 case\./);
  assert.doesNotMatch(t, /ignored/);
});

test('text PDF extracts without OCR', { skip }, async () => {
  const { path, workDir } = copy('scan0001.pdf');
  const r = await extract(path, { workDir, config: DEFAULTS });
  assert.equal(r.kind, 'pdf');
  assert.equal(r.ocr, false);
  assert.match(r.text, /INVOICE 2026-0917/);
});

test('scanned PDF gets a text layer, swapped in place', { skip, timeout: 120_000 }, async () => {
  const { path, workDir } = copy('Scan 2026-09-29 at 10.11.12.pdf');
  const before = sha(path);
  const r = await extract(path, { workDir, config: DEFAULTS });
  assert.equal(r.ocr, true);
  assert.match(r.text, /ACME/);
  assert.notEqual(sha(path), before, 'original replaced by the OCR copy');
  assert.match(spawnSync('pdftotext', [path, '-']).stdout.toString(), /ACME/);
});

test('dry run OCR leaves the scanned PDF untouched', { skip, timeout: 120_000 }, async () => {
  const { path, workDir } = copy('Scan 2026-09-29 at 10.11.12.pdf');
  const before = sha(path);
  const r = await extract(path, { workDir, config: DEFAULTS, inPlace: false });
  assert.match(r.text, /ACME/);
  assert.equal(sha(path), before);
});

test('photo of a document is OCRd; the image is unchanged', { skip }, async () => {
  const { path, workDir } = copy('IMG_4242.jpg');
  const before = sha(path);
  const r = await extract(path, { workDir, config: DEFAULTS });
  assert.equal(r.kind, 'image');
  assert.match(r.text, /Bugs Bunny/);
  assert.equal(sha(path), before);
});

test('image with no readable text is a review, not a model call', { skip }, async () => {
  const { path, workDir } = copy('IMG_4243.jpg');
  await assert.rejects(() => extract(path, { workDir, config: DEFAULTS }), (e) => e instanceof ReviewError && /no readable text/.test(e.reviewReason));
});

test('docx and eml', { skip }, async () => {
  const docx = copy('Doc1.docx');
  assert.match((await extract(docx.path, { workDir: docx.workDir, config: DEFAULTS })).text, /MAG-99/);
  const eml = copy('ACME order confirmation.eml');
  const r = await extract(eml.path, { workDir: eml.workDir, config: DEFAULTS });
  assert.equal(r.kind, 'email');
  assert.match(r.text, /Dehydrated boulders/);
});
