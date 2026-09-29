// Moving files: into place, into the review pile, and back out on undo.
// Nothing here ever deletes a document.

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { uniqueName } from './validate.mjs';

/** Move `src` into `dir` as `name` (or `name (2)`...). Returns the final path. */
export function moveInto(src, dir, name) {
  mkdirSync(dir, { recursive: true });
  const finalName = uniqueName(dir, name);
  const dest = join(dir, finalName);
  renameSync(src, dest);
  return dest;
}

/** File a document after validation. `newDirs` are created by the move. */
export function fileDocument(src, validated) {
  const finalPath = moveInto(src, validated.destDir, validated.filename);
  return { finalPath, createdDirs: validated.newDirs.filter((d) => existsSync(d)) };
}

export function toReview(src, reviewDir, name = basename(src)) {
  return moveInto(src, reviewDir, name);
}

/** Remove folders the tool created, deepest first, only while they are empty. */
export function removeEmptyDirs(dirs) {
  const removed = [];
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (existsSync(dir) && readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0) {
        rmdirSync(dir, { recursive: false });
        removed.push(dir);
      }
    } catch { /* not empty, or gone: leave it */ }
  }
  return removed;
}
