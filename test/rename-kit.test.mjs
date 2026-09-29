// Rename kit, part one: package.json `name` is the only place the app's name is
// written. Everything under lib/, bin/ and launcher/ derives it. If this fails,
// replace the literal with a value from lib/app.mjs (or, in a shell script, the
// name read from package.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, REPO_DIR, APP_TITLE, BUNDLE_ID, PATHS } from '../lib/app.mjs';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('the app name never appears literally under lib/, bin/ or launcher/', () => {
  const pattern = new RegExp(APP_NAME, 'i');
  const offenders = ['lib', 'bin', 'launcher']
    .flatMap((d) => walk(join(REPO_DIR, d)))
    .filter((f) => pattern.test(readFileSync(f, 'utf8')) || pattern.test(f.slice(REPO_DIR.length)));
  assert.deepEqual(offenders, []);
});

test('names derive from package.json', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.name.endsWith(`/${APP_NAME}`));
  assert.equal(pkg.private, true, 'private: true keeps npm publish from ever running');
  assert.ok(pkg.bin[APP_NAME], 'bin key matches the app name');
  assert.equal(APP_TITLE.toLowerCase(), APP_NAME);
  assert.equal(BUNDLE_ID, `com.centricle.${APP_NAME}`);
  assert.ok(PATHS.log.endsWith(`${APP_NAME}.log`));
});
