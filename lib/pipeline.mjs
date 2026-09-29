// The run: intake -> dedupe -> extract -> classify -> validate -> file -> docket
// -> alert. Also the dry run behind `classify <file>` and `undo`.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PATHS, STATE_FILES } from './app.mjs';
import { loadConfig, loadState, saveState, today } from './config.mjs';
import {
  buildArgs, buildSystemPrompt, buildUserMessage, documentsTree, invokeModel, parseResult, waitForNetwork,
} from './classify.mjs';
import { appendDocket, findLiveFiling, newId, readDocket, recentDecisions } from './docket.mjs';
import { ReviewError, extract } from './extract.mjs';
import { fileDocument, moveInto, removeEmptyDirs, toReview } from './file.mjs';
import { acquireLock, listCandidates, partitionStable, sha256File } from './intake.mjs';
import { log, notify, trimLog } from './notify.mjs';
import { isJunkName, validateDecision } from './validate.mjs';

function readRules(config) {
  try {
    return readFileSync(config.rulesPath, 'utf8');
  } catch {
    throw new Error(`rules file not readable: ${config.rulesPath}`);
  }
}

function relToDocuments(p) {
  return p && p.startsWith(`${PATHS.documents}/`) ? p.slice(PATHS.documents.length + 1) : p;
}

/**
 * Extract, prompt and call the model for one file. Moves nothing.
 * Returns `{ extracted, renameAllowed, decision?, validated?, usage?, error?,
 * transient?, review? , durationMs }`.
 */
export async function decide(path, {
  config, model = config.model, invoke = invokeModel, docket = readDocket(), workDir, dryRun = false,
}) {
  const t0 = Date.now();
  const name = basename(path);
  const out = { name, renameAllowed: isJunkName(name), model: null };
  try {
    out.extracted = await extract(path, { workDir, config, inPlace: !dryRun });
  } catch (e) {
    if (e instanceof ReviewError) return { ...out, review: e.reviewReason, durationMs: Date.now() - t0 };
    throw e;
  }
  const rules = readRules(config);
  const tree = documentsTree(PATHS.documents, {
    depth: config.treeDepth, maxLines: config.treeMaxLines, exclude: [PATHS.inbox],
  });
  const input = buildUserMessage({
    tree,
    recent: recentDecisions(docket, config.historyCount).map((e) => ({ ...e, final_path_rel: relToDocuments(e.final_path) })),
    name,
    extracted: out.extracted,
    renameAllowed: out.renameAllowed,
  });
  const args = buildArgs({ model, systemPrompt: buildSystemPrompt(rules), config });
  out.model = model;
  const raw = await invoke({ args, input, cwd: STATE_FILES.cwd, timeoutMs: config.timeoutMs });
  const parsed = parseResult(raw);
  out.usage = parsed.usage;
  out.durationMs = Date.now() - t0;
  if (parsed.error) return { ...out, error: parsed.error, transient: parsed.transient };
  out.decision = parsed.decision;
  out.validated = validateDecision(parsed.decision, {
    documents: PATHS.documents,
    inbox: PATHS.inbox,
    originalName: name,
    renameAllowed: out.renameAllowed,
    config,
  });
  return out;
}

function docketFields(d) {
  return {
    ocr: d.extracted?.ocr ?? false,
    model: d.model,
    confidence: d.decision?.confidence ?? null,
    reason: d.decision?.reason ?? null,
    summary: d.decision?.summary ?? null,
    tokens_in: d.usage?.tokensIn ?? null,
    tokens_out: d.usage?.tokensOut ?? null,
    duration_ms: d.durationMs ?? null,
  };
}

/** Send a file to the review pile, docket it, alert. */
async function review(path, { id, sha, reason, fields = {}, alertText }) {
  const name = basename(path);
  const finalPath = toReview(path, PATHS.review, name);
  appendDocket({
    id, sha256: sha, source: path, original_name: name, final_path: finalPath, renamed: false,
    created_dirs: [], status: 'review', review_reason: reason, ...fields,
  });
  await notify('Held for review', alertText || `${name}: ${reason}`);
  return finalPath;
}

/**
 * One pass over the Inbox. Options exist for tests: `invoke` replaces the
 * model call, `network` replaces the wake-up network wait.
 */
export async function runInbox({ invoke = invokeModel, network = waitForNetwork } = {}) {
  const config = loadConfig();
  mkdirSync(PATHS.inbox, { recursive: true });
  mkdirSync(PATHS.review, { recursive: true });
  const release = acquireLock(STATE_FILES.lock);
  if (!release) {
    log('run: another run holds the lock; exiting');
    return { skipped: 'locked' };
  }
  const summary = { filed: 0, review: 0, deferred: 0, errors: 0 };
  const state = loadState();
  try {
    if (state.daily.date !== today()) state.daily = { date: today(), count: 0, capAlerted: false };
    let pending = listCandidates(PATHS.inbox);
    if (!pending.length) return summary;

    // Folders: v1 does not descend. Straight to review.
    for (const entry of pending.filter((e) => e.isDir)) {
      await review(entry.path, { id: newId(), sha: null, reason: 'folder dropped (v1 files single documents only)' });
      summary.review++;
    }
    pending = pending.filter((e) => !e.isDir).map((e) => e.path);

    let networkChecked = false;
    for (let round = 0; round < config.stabilityRounds && pending.length; round++) {
      const { stable, unstable } = await partitionStable(pending, config.stabilityDelayMs);
      pending = unstable;
      for (const path of stable) {
        if (!existsSync(path)) continue;
        const name = basename(path);
        if (state.daily.count >= config.dailyCap) {
          summary.deferred++;
          if (!state.daily.capAlerted) {
            state.daily.capAlerted = true;
            await notify('Daily cap reached', `${config.dailyCap} documents filed today; the rest wait until tomorrow.`);
          }
          continue;
        }

        const id = newId();
        const sha = await sha256File(path);
        const docket = readDocket();
        const dup = findLiveFiling(docket, sha);
        if (dup) {
          await review(path, { id, sha, reason: `duplicate of ${dup.final_path}`, alertText: `${name} is a duplicate of ${relToDocuments(dup.final_path)}` });
          summary.review++;
          continue;
        }

        if (!networkChecked) {
          networkChecked = true;
          const up = await network({
            url: config.networkCheckUrl, tries: config.networkWaitTries, delayMs: config.networkWaitDelayMs,
          });
          if (!up) {
            if (state.alerts.transient !== 'offline') {
              state.alerts.transient = 'offline';
              await notify('Waiting for the network', 'Files stay in the Inbox until the next run.');
            }
            summary.deferred += 1;
            return summary;
          }
        }

        const workDir = join(STATE_FILES.work, id);
        let d;
        try {
          d = await decide(path, { config, invoke, docket, workDir });
        } catch (e) {
          log(`run: ${name}: ${e.stack || e.message}`);
          d = { error: e.message, transient: false };
        } finally {
          rmSync(workDir, { recursive: true, force: true });
        }

        if (d.review) {
          await review(path, { id, sha, reason: d.review, fields: docketFields(d) });
          summary.review++;
          continue;
        }

        if (d.error) {
          summary.errors++;
          const f = (state.failures[sha] ||= { count: 0, name });
          f.count++;
          f.last = d.error;
          log(`run: ${name}: ${d.error} (failure ${f.count}/${config.maxFailures})`);
          if (f.count >= config.maxFailures) {
            delete state.failures[sha];
            appendDocket({ id: newId(), sha256: sha, source: path, original_name: name, status: 'error', error: d.error, ...docketFields(d) });
            await review(path, { id, sha, reason: `failed ${config.maxFailures} times: ${d.error}`, fields: docketFields(d) });
            summary.review++;
          } else if (d.transient) {
            if (state.alerts.transient !== 'failing') {
              state.alerts.transient = 'failing';
              await notify('Classifier unavailable', `${d.error.slice(0, 120)}. Retrying on the next run.`);
            }
            break; // likely affects every file; stop until the next run
          } else {
            await notify('Error', `${name}: ${d.error.slice(0, 160)}`);
          }
          continue;
        }

        state.daily.count++;
        if (state.alerts.transient) {
          log(`run: classifier recovered from ${state.alerts.transient}`);
          delete state.alerts.transient;
        }
        delete state.failures[sha];

        const v = d.validated;
        if (!v.ok) {
          await review(path, { id, sha, reason: v.reason, fields: docketFields(d) });
          summary.review++;
          continue;
        }

        const { finalPath, createdDirs } = fileDocument(path, v);
        appendDocket({
          id, sha256: sha, source: path, original_name: name, final_path: finalPath, renamed: v.renamed,
          created_dirs: createdDirs, status: 'filed', ...docketFields(d),
        });
        log(`filed ${name} -> ${relToDocuments(finalPath)} (${d.decision.confidence})`);
        summary.filed++;
        if (createdDirs.length) {
          await notify('New folder', `${relToDocuments(createdDirs[0])} created for ${basename(finalPath)}`);
        }
      }
    }
    if (pending.length) log(`run: ${pending.length} file(s) still arriving; the next run picks them up`);
    return summary;
  } finally {
    saveState(state);
    release();
    trimLog();
  }
}

/** Move a filed document back to the review pile under its original name. */
export async function undo(target = 'last') {
  const entries = readDocket();
  const undone = new Set(entries.filter((e) => e.status === 'undo').map((e) => e.undoes));
  const candidates = entries.filter((e) => e.status === 'filed' && !undone.has(e.id));
  const entry = target === 'last' ? candidates.at(-1) : candidates.find((e) => e.id === target);
  if (!entry) throw new Error(target === 'last' ? 'nothing to undo' : `no undoable filing with id ${target}`);
  if (!existsSync(entry.final_path)) throw new Error(`${entry.final_path} is no longer there; nothing moved`);
  mkdirSync(PATHS.review, { recursive: true });
  const back = moveInto(entry.final_path, PATHS.review, entry.original_name);
  const removed = removeEmptyDirs(entry.created_dirs || []);
  appendDocket({
    id: newId(), undoes: entry.id, sha256: entry.sha256, source: entry.final_path, original_name: entry.original_name,
    final_path: back, removed_dirs: removed, status: 'undo',
  });
  log(`undo ${entry.id}: ${relToDocuments(entry.final_path)} -> ${relToDocuments(back)}`);
  return { entry, back, removed };
}
