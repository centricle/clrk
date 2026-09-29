import { HOME, INBOX } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, listCandidates, partitionStable, sha256File, skipReason } from '../lib/intake.mjs';

test('skip rules', () => {
  for (const n of ['.DS_Store', '.hidden.pdf', '_review', 'Icon\r', '~$report.docx', 'a.crdownload',
    'a.download', 'a.part', 'a.PARTIAL', 'a.tmp']) {
    assert.ok(skipReason(n), `should skip ${JSON.stringify(n)}`);
  }
  for (const n of ['ACME invoice.pdf', 'scan.jpg', 'part.pdf', 'tmp notes.txt']) assert.equal(skipReason(n), null, n);
});

test('listCandidates lists files and folders, skips the rest', () => {
  const box = join(HOME, 'list-inbox');
  mkdirSync(join(box, '_review'), { recursive: true });
  mkdirSync(join(box, 'Dropped Folder'));
  writeFileSync(join(box, 'b.pdf'), 'x');
  writeFileSync(join(box, 'a.txt'), 'x');
  writeFileSync(join(box, '.DS_Store'), 'x');
  writeFileSync(join(box, 'c.crdownload'), 'x');
  assert.deepEqual(listCandidates(box).map((c) => [c.name, c.isDir]),
    [['a.txt', false], ['b.pdf', false], ['Dropped Folder', true]]);
});

test('stability: a file still growing is unstable, a quiet one is stable', async () => {
  const quiet = join(INBOX, 'quiet.txt');
  const growing = join(INBOX, 'growing.txt');
  writeFileSync(quiet, 'done');
  writeFileSync(growing, 'start');
  const timer = setTimeout(() => appendFileSync(growing, 'more'), 100);
  const { stable, unstable } = await partitionStable([quiet, growing, join(INBOX, 'gone.txt')], 300);
  clearTimeout(timer);
  assert.deepEqual(stable, [quiet]);
  assert.deepEqual(unstable, [growing]);
});

test('lock: held by a live pid blocks, a dead pid is reclaimed', () => {
  const lock = join(HOME, 'lock-test');
  const release = acquireLock(lock);
  assert.ok(release);
  assert.equal(acquireLock(lock), null, 'second acquire while held');
  release();
  assert.equal(existsSync(lock), false);

  // A lock left by a process that has exited.
  const dead = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), dead);
  const reclaimed = acquireLock(lock);
  assert.ok(reclaimed, 'stale lock reclaimed');
  reclaimed();

  // An empty lock is young: leave it. Old: reclaim it.
  mkdirSync(lock);
  assert.equal(acquireLock(lock), null);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const again = acquireLock(lock);
  assert.ok(again);
  again();
});

test('sha256', async () => {
  const f = join(HOME, 'hash.txt');
  writeFileSync(f, 'abc');
  assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
