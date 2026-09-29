#!/usr/bin/env node
// Command-line entry point. The stub runs this file; so does the ~/.local/bin
// link. Never reach it through `npx`, which resolves an unknown command from
// the npm registry: a stranger's package of the same name would run instead.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

// `open` hands an app a bare system PATH; launchd hands it the plist's. Either
// way the tools this needs live under Homebrew.
const EXTRA_PATH = ['/opt/homebrew/opt/node@22/bin', '/opt/homebrew/bin', '/usr/local/bin'];
const pathParts = (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(delimiter);
process.env.PATH = [...EXTRA_PATH.filter((p) => !pathParts.includes(p)), ...pathParts].join(delimiter);

const { APP_NAME, APP_TITLE, LAUNCHD_LABEL, PATHS, REPO_DIR, STATE_FILES, VERSION } = await import('../lib/app.mjs');
const { loadConfig, loadState, ensureStateDirs } = await import('../lib/config.mjs');
const { readDocket, todayUsage } = await import('../lib/docket.mjs');
const { documentsTree } = await import('../lib/classify.mjs');
const { decide, runInbox, undo } = await import('../lib/pipeline.mjs');
const { log } = await import('../lib/notify.mjs');

const HELP = `${APP_NAME} ${VERSION}: files documents dropped into ~/Documents/Inbox

  ${APP_NAME} run                 one pass over the Inbox (what launchd runs)
  ${APP_NAME} classify <file>     dry run: print the decision, move nothing
      --model <name>           override the configured model
      --json                   machine-readable output
  ${APP_NAME} status              today's count, pending files, job state
  ${APP_NAME} log [n]             the last n docket entries (default 20)
  ${APP_NAME} undo [id|last]      put a filed document back in the review pile
  ${APP_NAME} doctor              check the grant, stub, tools, auth and job
  ${APP_NAME} tree                the ~/Documents folder tree the classifier sees
`;

const rel = (p) => (p && p.startsWith(`${PATHS.documents}/`) ? `~/Documents/${p.slice(PATHS.documents.length + 1)}` : p);

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function bool(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function cmdRun() {
  ensureStateDirs();
  const summary = await runInbox();
  log(`run: ${JSON.stringify(summary)}`);
  if (process.stdout.isTTY) console.log(summary);
}

async function cmdClassify(args) {
  const model = flag(args, '--model');
  const json = bool(args, '--json');
  const file = args[0];
  if (!file) throw new Error('usage: classify <file>');
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  ensureStateDirs();
  const config = loadConfig();
  const workDir = mkdtempSync(join(STATE_FILES.work, 'dry-'));
  let d;
  try {
    d = await decide(path, { config, model: model || config.model, workDir, dryRun: true });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const would = d.review ? `review (no model call): ${d.review}`
    : d.error ? `error${d.transient ? ' (transient)' : ''}: ${d.error}`
      : d.validated.ok ? `file to ${rel(d.validated.destDir)}/${d.validated.filename}${d.validated.newDirs.length ? ` (creates ${d.validated.newDirs.map(rel).join(', ')})` : ''}`
        : `review: ${d.validated.reason}`;
  const out = {
    file: path, model: d.model, rename_allowed: d.renameAllowed,
    extracted: d.extracted ? { kind: d.extracted.kind, chars: d.extracted.chars, ocr: d.extracted.ocr, truncated: d.extracted.truncated } : null,
    decision: d.decision || null, would, usage: d.usage || null, duration_ms: d.durationMs,
  };
  if (json) { console.log(JSON.stringify(out)); return; }
  console.log(`${d.name}\n  would: ${would}`);
  if (d.decision) {
    console.log(`  model: ${d.model}  confidence: ${d.decision.confidence}`);
    console.log(`  summary: ${d.decision.summary}\n  reason: ${d.decision.reason}`);
    if (d.decision.new_folder_rationale) console.log(`  new folder: ${d.decision.new_folder_rationale}`);
  }
  if (d.usage) console.log(`  tokens: ${d.usage.tokensIn} in, ${d.usage.tokensOut} out; ${d.durationMs} ms`);
}

function jobState() {
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { encoding: 'utf8' });
  if (r.status !== 0) return { loaded: false };
  const get = (k) => (r.stdout.match(new RegExp(`^\\s*${k} = (.*)$`, 'm')) || [])[1];
  return { loaded: true, state: get('state'), lastExit: get('last exit code'), runs: get('runs') };
}

function countFiles(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.') && n !== '_review').length;
  } catch {
    return null;
  }
}

function cmdStatus() {
  const config = loadConfig();
  const state = loadState();
  const docket = readDocket();
  const usage = todayUsage(docket);
  const lastFiled = docket.filter((e) => e.status === 'filed').at(-1);
  const job = jobState();
  console.log(`${APP_NAME} ${VERSION}  model ${config.model}`);
  console.log(`today: ${usage.calls} classified (cap ${config.dailyCap}), ${usage.tokensIn} tokens in, ${usage.tokensOut} out`);
  console.log(`Inbox: ${countFiles(PATHS.inbox) ?? '?'} waiting; review pile: ${countFiles(PATHS.review) ?? '?'}`);
  const retrying = Object.values(state.failures);
  if (retrying.length) console.log(`retrying: ${retrying.map((f) => `${f.name} (${f.count})`).join(', ')}`);
  if (state.alerts.transient) console.log(`classifier: ${state.alerts.transient}`);
  if (lastFiled) console.log(`last filed: ${lastFiled.ts} ${lastFiled.original_name} -> ${rel(lastFiled.final_path)}`);
  console.log(`job ${LAUNCHD_LABEL}: ${job.loaded ? `loaded, ${job.state}, last exit ${job.lastExit}, runs ${job.runs}` : 'not loaded'}`);
}

function cmdLog(args) {
  const n = Number(args[0]) || 20;
  for (const e of readDocket().slice(-n)) {
    const where = e.status === 'undo' ? `undo of ${e.undoes} -> ${rel(e.final_path)}` : rel(e.final_path) || '';
    const why = e.review_reason || e.error || e.reason || '';
    console.log(`${e.ts}  ${e.id}  ${e.status.padEnd(6)}  ${e.original_name} -> ${where}${e.confidence != null ? ` (${e.confidence})` : ''}${why ? `  ${why}` : ''}`);
  }
}

async function cmdUndo(args) {
  const { entry, back, removed } = await undo(args[0] || 'last');
  console.log(`undid ${entry.id}: ${rel(entry.final_path)} -> ${rel(back)}`);
  if (removed.length) console.log(`removed empty folders: ${removed.map(rel).join(', ')}`);
}

function cmdTree() {
  const config = loadConfig();
  console.log(documentsTree(PATHS.documents, { depth: config.treeDepth, maxLines: config.treeMaxLines, exclude: [PATHS.inbox] }));
}

/** Run only through the stub by `doctor`: proves the stub's own grant. */
function cmdGrantCheck() {
  const n = readdirSync(PATHS.documents).length;
  console.log(`ok ${n}`);
}

/** Ask the stub (not this process) to read ~/Documents, via LaunchServices. */
function grantViaStub(timeoutMs = 30_000) {
  return new Promise((resolveP) => {
    if (!existsSync(PATHS.stubApp)) { resolveP({ ok: false, detail: `${PATHS.stubApp} missing` }); return; }
    const dir = mkdtempSync(join(tmpdir(), `${APP_NAME}-doctor-`));
    const outFile = join(dir, 'out');
    const child = spawn('open', ['-W', '-g', '-n', '-a', PATHS.stubApp, '--stdout', outFile, '--stderr', outFile, '--args', 'grant-check']);
    const timer = setTimeout(() => {
      child.kill();
      resolveP({ ok: false, detail: `no answer in ${timeoutMs / 1000}s: not granted, or a prompt is waiting` });
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      let out = '';
      try { out = readFileSync(outFile, 'utf8').trim(); } catch { /* none */ }
      rmSync(dir, { recursive: true, force: true });
      resolveP(out.startsWith('ok ') ? { ok: true, detail: `stub lists ~/Documents (${out.slice(3)} entries)` } : { ok: false, detail: out.slice(0, 200) || 'no output' });
    });
  });
}

function which(cmd) {
  for (const dir of process.env.PATH.split(delimiter)) {
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

async function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const grant = await grantViaStub();
  add('Documents grant (via stub)', grant.ok, grant.detail);

  if (existsSync(PATHS.stubApp)) {
    const v = spawnSync('codesign', ['--verify', '--strict', PATHS.stubApp], { encoding: 'utf8' });
    const dv = spawnSync('codesign', ['-dv', '--verbose=4', PATHS.stubApp], { encoding: 'utf8' });
    const info = dv.stderr || '';
    const kind = /Signature=adhoc/.test(info) ? 'ad-hoc'
      : (info.match(/Authority=(Developer ID Application: [^\n]+)/) || [])[1] || 'unknown';
    add('stub signature', v.status === 0, `${v.status === 0 ? 'intact' : (v.stderr || '').trim()}; ${kind}`);
  } else {
    add('stub signature', false, `${PATHS.stubApp} missing`);
  }

  for (const tool of ['pdftotext', 'pdfinfo', 'ocrmypdf', 'tesseract', 'sips', 'textutil', 'mdls', 'claude']) {
    const p = which(tool);
    add(`tool ${tool}`, Boolean(p), p || 'not on PATH');
  }

  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 });
  let authOk = false;
  try { authOk = JSON.parse(auth.stdout).loggedIn === true; } catch { /* not JSON */ }
  add('claude auth status', authOk, authOk ? 'logged in' : (auth.stdout || auth.stderr || '').trim().slice(0, 120));

  const config = loadConfig();
  add('rules file', existsSync(config.rulesPath), config.rulesPath);

  const job = jobState();
  add(`job ${LAUNCHD_LABEL}`, job.loaded, job.loaded ? `${job.state}, last exit ${job.lastExit}` : 'not loaded');

  const onPath = which(APP_NAME);
  const mine = join(REPO_DIR, 'bin', 'cli.mjs');
  let resolved = null;
  try { resolved = onPath && realpathSync(onPath); } catch { /* dangling */ }
  add(`command -v ${APP_NAME}`, resolved === realpathSync(mine), onPath ? `${onPath} -> ${resolved}` : 'not on PATH');

  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} check(s) failed` : `${APP_TITLE} is healthy`);
  if (failed) process.exitCode = 1;
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  run: cmdRun, classify: cmdClassify, status: cmdStatus, log: cmdLog, undo: cmdUndo,
  doctor: cmdDoctor, tree: cmdTree, 'grant-check': cmdGrantCheck,
};

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write(HELP);
} else if (!commands[cmd]) {
  process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
} else {
  try {
    await commands[cmd](args);
  } catch (e) {
    log(`${cmd}: ${e.message}`);
    process.stderr.write(`${APP_NAME} ${cmd}: ${e.message}\n`);
    process.exitCode = 1;
  }
}
