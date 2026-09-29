import { CONFIG, DOCS, HOME, INBOX } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJunkName, sanitizeFilename, uniqueName, validateDecision } from '../lib/validate.mjs';

mkdirSync(join(DOCS, 'Finances', 'Invoices'), { recursive: true });
mkdirSync(join(DOCS, 'Taxes', '2025'), { recursive: true });
writeFileSync(join(DOCS, 'notafolder.txt'), 'x');
mkdirSync(join(HOME, 'outside'), { recursive: true });
symlinkSync(join(HOME, 'outside'), join(DOCS, 'Escape'));

const ctx = { documents: DOCS, inbox: INBOX, originalName: 'scan0001.pdf', renameAllowed: true, config: CONFIG };
const decision = (destination, extra = {}) => ({
  action: 'file', destination, filename: 'ACME Invoice 1234', confidence: 0.9,
  summary: 's', reason: 'r', new_folder_rationale: null, ...extra,
});

test('path jail rejects every escape attempt', () => {
  const escapes = [
    '../etc', '/etc', '/Users/someone/Documents/Taxes', '~/Documents/Taxes', 'Taxes/../../etc',
    'Taxes/..', './Taxes', 'Inbox', 'Inbox/foo', 'inbox/foo', 'INBOX', '.hidden', 'Taxes/.git/objects',
    'a/b/c/d/e/f/g', 'C:foo', 'Taxes\\2025', 'Taxes//2025', '', '   ', 'Escape', 'Escape/deeper',
    'notafolder.txt', 'notafolder.txt/x', 'Taxes/\u0000', 'Taxes/20\n25',
  ];
  for (const dest of escapes) {
    const v = validateDecision(decision(dest), ctx);
    assert.equal(v.ok, false, `accepted ${JSON.stringify(dest)}`);
    assert.equal(v.action, 'review');
  }
});

test('non-string and missing destinations go to review', () => {
  for (const dest of [null, undefined, 42, ['Taxes'], { a: 1 }]) {
    assert.equal(validateDecision(decision(dest), ctx).ok, false);
  }
});

test('more than two new folders goes to review', () => {
  assert.equal(validateDecision(decision('New/Deeper/Deepest'), ctx).ok, false);
  const fifty = Array.from({ length: 50 }, (_, i) => `f${i}`).join('/');
  assert.equal(validateDecision(decision(fifty), ctx).ok, false);
  const v = validateDecision(decision('Finances/Invoices/ACME/2026'), ctx);
  assert.equal(v.ok, true);
  assert.equal(v.newDirs.length, 2);
});

test('low confidence and review actions go to review', () => {
  assert.equal(validateDecision(decision('Taxes/2025', { confidence: 0.69 }), ctx).ok, false);
  assert.equal(validateDecision(decision('Taxes/2025', { confidence: 'high' }), ctx).ok, false);
  assert.equal(validateDecision(decision('Taxes/2025', { action: 'review' }), ctx).ok, false);
  assert.equal(validateDecision(decision('Taxes/2025', { action: 'delete' }), ctx).ok, false);
  assert.equal(validateDecision(null, ctx).ok, false);
});

test('a good decision files into the real folder, case canonicalized', () => {
  const v = validateDecision(decision('finances/invoices'), ctx);
  assert.equal(v.ok, true);
  assert.ok(v.destDir.endsWith('/Finances/Invoices'), v.destDir);
  assert.equal(v.filename, 'ACME Invoice 1234.pdf');
  assert.equal(v.renamed, true);
  assert.deepEqual(v.newDirs, []);
});

test('rename only when allowed, extension always forced', () => {
  const kept = validateDecision(decision('Taxes/2025'), { ...ctx, originalName: 'ACME W-2.pdf', renameAllowed: false });
  assert.equal(kept.filename, 'ACME W-2.pdf');
  assert.equal(kept.renamed, false);
  const forced = validateDecision(decision('Taxes/2025', { filename: 'evil.sh' }), ctx);
  assert.equal(forced.filename, 'evil.pdf');
  const nullName = validateDecision(decision('Taxes/2025', { filename: null }), ctx);
  assert.equal(nullName.filename, 'scan0001.pdf');
});

test('sanitizeFilename strips separators, control characters and leading dots', () => {
  assert.equal(sanitizeFilename('../../etc/passwd', 'a.pdf'), 'etc-passwd.pdf');
  assert.equal(sanitizeFilename('.hidden', 'a.pdf'), 'hidden.pdf');
  assert.equal(sanitizeFilename('a\u0000b\nc', 'a.pdf'), 'abc.pdf');
  assert.equal(sanitizeFilename('ACME: Invoice/1234', 'a.PDF'), 'ACME- Invoice-1234.PDF');
  assert.equal(sanitizeFilename('   ', 'a.pdf'), null);
  assert.equal(sanitizeFilename('x'.repeat(500), 'a.pdf').length, 124);
  assert.equal(sanitizeFilename(null, 'a.pdf'), null);
});

test('collisions get (2), (3)', () => {
  const dir = join(DOCS, 'Collide');
  mkdirSync(dir);
  assert.equal(uniqueName(dir, 'a.pdf'), 'a.pdf');
  writeFileSync(join(dir, 'a.pdf'), '1');
  assert.equal(uniqueName(dir, 'a.pdf'), 'a (2).pdf');
  writeFileSync(join(dir, 'a (2).pdf'), '2');
  assert.equal(uniqueName(dir, 'a.pdf'), 'a (3).pdf');
});

test('junk-name regex', () => {
  const junk = [
    'scan0001.pdf', 'Scan 2026-09-29 at 10.11.12.pdf', 'IMG_1234.JPG', 'IMG_1234 (2).jpg', 'image0.jpeg',
    'PXL_20260929_101112345.jpg', 'DSC00042.jpg', 'Screenshot 2026-09-29 at 10.11.12 AM.png',
    'document(3).pdf', 'Document.pdf', 'download.pdf', 'download (1).pdf', 'untitled.pdf',
    'Untitled document.pdf', 'attachment.pdf', 'file.pdf', 'Doc1.docx', 'CamScanner 09-29-2026 10.11.pdf',
    '20260929.pdf', '2026-09-29_101112.pdf', 'e3b0c442-98fc-1c14-9afb-f4c8996fb924.pdf',
    '9f86d081884c7d659a2feaa0c55ad015.pdf', 'scan copy.pdf', 'print.pdf',
  ];
  const meaningful = [
    'ACME Invoice 1234.pdf', 'W-2 2025.pdf', 'Coyote lease.pdf', 'Canyon Rim Deed.pdf',
    'invoice.pdf', 'Scanner manual.pdf', 'Documentary notes.docx', 'Image rights release.pdf',
    'Photo release form.pdf', 'download instructions.pdf', 'XLR-8 Insurance Claim.pdf',
  ];
  for (const n of junk) assert.equal(isJunkName(n), true, `expected junk: ${n}`);
  for (const n of meaningful) assert.equal(isJunkName(n), false, `expected meaningful: ${n}`);
});
