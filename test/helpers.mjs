// Point the whole tool at a scratch home before any lib/ module loads.
// Import this first in every test file that touches lib/.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOME = mkdtempSync(join(tmpdir(), 'clrk-test-'));
process.env.CLRK_HOME = HOME;
process.env.CLRK_QUIET = '1';

export const DOCS = join(HOME, 'Documents');
export const INBOX = join(DOCS, 'Inbox');
mkdirSync(INBOX, { recursive: true });
mkdirSync(join(HOME, 'Library', 'Logs'), { recursive: true });

export const RULES = join(HOME, 'Library', 'Application Support', 'clrk', 'rules.md');
mkdirSync(join(RULES, '..'), { recursive: true });
writeFileSync(RULES, '# Rules\n\nInvoices go in Finances/Invoices.\n');

export const CONFIG = {
  confidenceMin: 0.7, maxNewDirs: 2, maxDepth: 6, maxBudgetUsd: 0.5, isolationFlags: ['--restricted'],
};
