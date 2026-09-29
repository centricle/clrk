// The app's identity, derived from package.json and nothing else.
//
// This is part one of the rename kit: every name the tool goes by (state dir,
// log file, launchd label, bundle id, notification title) is computed here from
// `package.json` `name`. No other file under lib/, bin/ or launcher/ may spell
// the name out; test/rename-kit.test.mjs enforces that.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(REPO_DIR, 'package.json'), 'utf8'));

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;

/** Unscoped package name: `@centricle/foo` -> `foo`. */
export const APP_NAME = pkg.name.replace(/^@[^/]+\//, '');

/** Display form, used for the stub bundle and notification titles. */
export const APP_TITLE = APP_NAME.charAt(0).toUpperCase() + APP_NAME.slice(1);

export const BUNDLE_ID = `com.centricle.${APP_NAME}`;
export const LAUNCHD_LABEL = BUNDLE_ID;

/** Tests point the whole tool at a scratch home through this variable. */
export const HOME_ENV = `${APP_NAME.toUpperCase()}_HOME`;

const HOME = process.env[HOME_ENV] || homedir();

export const PATHS = Object.freeze({
  home: HOME,
  documents: join(HOME, 'Documents'),
  inbox: join(HOME, 'Documents', 'Inbox'),
  review: join(HOME, 'Documents', 'Inbox', '_review'),
  state: join(HOME, 'Library', 'Application Support', APP_NAME),
  log: join(HOME, 'Library', 'Logs', `${APP_NAME}.log`),
  stubApp: join(HOME, 'Applications', `${APP_TITLE}.app`),
  plist: join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
});

export const STATE_FILES = Object.freeze({
  docket: join(PATHS.state, 'docket.jsonl'),
  state: join(PATHS.state, 'state.json'),
  config: join(PATHS.state, 'config.json'),
  lock: join(PATHS.state, 'lock'),
  work: join(PATHS.state, 'work'),
  cwd: join(PATHS.state, 'cwd'),
});
