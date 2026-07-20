import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPostBaselineMigrations } from './list-post-baseline-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(
  listPostBaselineMigrations(
    [
      '20260719092832_dashboard_summary_rpc.sql',
      '20260720220000_dashboard_summary_rpc.sql',
      '20260720210000_alpha.sql',
      '20260720230000_beta.sql',
    ],
    '20260719092832',
    new Set(['20260719092832_dashboard_summary_rpc', '20260720210000_alpha']),
  ),
  ['20260720220000_dashboard_summary_rpc.sql', '20260720230000_beta.sql'],
  'only an exact timestamped ledger name may hide a migration; reused suffixes stay pending',
);
const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
const files = result.stdout.trim().split(/\r?\n/).filter(Boolean);
assert.deepEqual(files, [...files].sort(), 'post-baseline migrations must be ordered');

for (const captured of [
  '20260719100000_trust_only_post_revoke_split_provenance.sql',
  '20260719100500_revert_quote_status_deadlock_retry.sql',
  '20260719101000_align_finance_charge_preview_month_dedup.sql',
  '20260719102000_allow_governed_split_terminal_lifecycle.sql',
]) {
  assert.equal(
    files.some((file) => file.endsWith(captured)),
    false,
    `${captured} is already represented by a server-assigned baseline ledger row`,
  );
}
assert.equal(
  files.some((file) => file.endsWith('20260720173059_fix_statement_opening_balance.sql')),
  true,
  'a genuinely post-baseline migration must remain pending',
);
console.log(`POST_BASELINE_MIGRATIONS_PASS pending=${files.length}`);
