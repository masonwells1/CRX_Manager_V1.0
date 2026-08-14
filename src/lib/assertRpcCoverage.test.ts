import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !entry.includes('node_modules') && !entry.includes('.test')) {
      results.push(...findSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Any `= await supabase.rpc('rpc_name')` — caller has captured the response,
// either via destructure (`const { data, error } =`, `const { data: alias } =`)
// or plain assignment (`const result = await supabase.rpc(...)`). Either
// pattern needs assertRpcResult(...) to enforce the contract.
//
// Fire-and-forget calls (`await supabase.rpc(...)` with no `=`) do NOT need
// wrapping and are excluded by the leading `=`. The `\s*\.\s*rpc` allows the
// call to span lines (`await supabase\n  .rpc(...)`) — common Prettier shape.
//
// `supabaseUntyped` is an alias for `supabase` used when a table/RPC is not yet
// in the generated TypeScript types (new tables before type regen). Both aliases
// must satisfy the same assertRpcResult contract.
const RPC_CAPTURE_PATTERN = /=\s*await\s+supabase(?:Untyped)?\s*\.\s*rpc\s*\(\s*['"]([^'"]+)['"]/g;

// Wrapped capture: `= await someRunner((reason) => supabase.rpc('name', ...))`.
// Introduced by the below-cost approval flow (2026-08-13):
// `runWithBelowCostApproval((reason) => supabase.rpc(...))` and the offlineSync
// `execute((reason) => supabase.rpc(...))` alias. The runner resolves to the
// rpc response, so the caller HAS captured it and the assertRpcResult contract
// applies exactly as for the direct form. The runner name is deliberately
// generic (`\w+`): any single-arg arrow returning a literal-named supabase.rpc
// call is a real capture, and matching more call sites only tightens the guard.
const RPC_WRAPPED_CAPTURE_PATTERN =
  /=\s*await\s+\w+\s*\(\s*(?:async\s*)?\(?\s*\w+\s*\)?\s*=>\s*supabase(?:Untyped)?\s*\.\s*rpc\s*\(\s*['"]([^'"]+)['"]/g;

// `assertRpcResult(...)` invocations. The optional `<...>` group handles
// generic-type uses like `assertRpcResult<{ id: string }>(data, 'rpc_name')`,
// which the previous regex silently missed.
const ASSERT_PATTERN = /\bassertRpcResult\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/g;

// Don't count the function definition itself (db.ts contains `export function
// assertRpcResult<T>(...)` — that's a definition, not a call site).
const ASSERT_DEFINITION_PATTERN = /\bfunction\s+assertRpcResult\b/;

interface FileViolation {
  file: string;
  rpcCount: number;
  assertCount: number;
  rpcNames: string[];
  direction: 'missing-assert' | 'orphan-assert';
}

// PR-19 (2026-05-10) baseline.
//
// The previous version of this test was a per-file boolean check ("does
// `assertRpcResult` appear at least once?") which was satisfied as long as
// any one of the file's RPC calls was wrapped. The tightened version below
// counts captures and assertions per file and demands a 1:1 match.
//
// Tightening surfaced 32 files of pre-existing debt. The ratchet baseline
// reached ZERO on 2026-05-11. Any new code that fails this test must be
// fixed — the baseline is no longer a defense against legacy debt.
//
// If you ever need to increase this baseline (you almost never should):
//   1. Document why in this comment with the date and PR.
//   2. Get explicit sign-off from Mason — adding new debt is a regression.
//
// Conventions established during the cleanup that should keep this at 0:
//
// • For RPCs that return data: `const { data, error } = await supabase.rpc('name', ...);
//   if (error) throw error; assertRpcResult<T>(data, 'name');`
//
// • For RPCs that RETURNS void: `await supabase.rpc('name', ...).throwOnError();`
//   The regex skips fire-and-forget (no `=` capture), and .throwOnError()
//   converts postgrest errors to thrown exceptions so existing try/catch
//   blocks keep working. New convention — first introduced in the 2026-05-11
//   void-RPC sweep.
//
// • Avoid `supabase.rpc(rpcName, ...)` with a dynamic variable — the regex
//   only matches string literals. Use a switch/if with per-branch literal
//   names instead. (See LogbookReport.tsx for the canonical example.)
//
// • Avoid `supabase.rpc(...)` inside Promise.all — the regex requires `=`
//   immediately before `await`. Pull the rpc out into its own
//   `const { data } = await supabase.rpc(...)`. (See CustomerContextCard.tsx
//   for the canonical example.)
//
// History: 32 (2026-05-10, PR-19) → 21 → 18 → 3 → 0 (2026-05-11).
const BASELINE_VIOLATION_COUNT = 0;

describe('assertRpcResult coverage', () => {
  it(
    `every supabase.rpc() capture must call assertRpcResult (current debt: <=${BASELINE_VIOLATION_COUNT} files)`,
    () => {
      const srcDir = join(__dirname, '..');
      const files = findSourceFiles(srcDir);
      const violations: FileViolation[] = [];

      for (const file of files) {
        const content = readFileSync(file, 'utf-8');

        const rpcMatches = [
          ...content.matchAll(RPC_CAPTURE_PATTERN),
          ...content.matchAll(RPC_WRAPPED_CAPTURE_PATTERN),
        ];
        const rpcNames = rpcMatches.map((m) => m[1]);

        const assertMatches = Array.from(content.matchAll(ASSERT_PATTERN));
        let assertCount = assertMatches.length;
        if (ASSERT_DEFINITION_PATTERN.test(content)) assertCount -= 1;

        if (rpcNames.length !== assertCount) {
          violations.push({
            file: file.replace(srcDir, 'src'),
            rpcCount: rpcNames.length,
            assertCount,
            rpcNames,
            direction: rpcNames.length > assertCount ? 'missing-assert' : 'orphan-assert',
          });
        }
      }

      if (violations.length > BASELINE_VIOLATION_COUNT) {
        const missing = violations.filter((v) => v.direction === 'missing-assert');
        const orphan = violations.filter((v) => v.direction === 'orphan-assert');

        const summary = (label: string, list: FileViolation[]) =>
          list.length === 0
            ? ''
            : `\n[${label}]\n` +
              list
                .map(
                  (v) =>
                    `  ${v.file}\n` +
                    `    captures: ${v.rpcCount} (${v.rpcNames.join(', ') || '—'})\n` +
                    `    asserts:  ${v.assertCount}`,
                )
                .join('\n');

        throw new Error(
          `assertRpcResult coverage REGRESSED: ${violations.length} files have a count mismatch ` +
            `(baseline allows <=${BASELINE_VIOLATION_COUNT}).\n` +
            summary('missing-assert (RPC captured but not wrapped)', missing) +
            summary('orphan-assert  (assert call without matching RPC capture in same file)', orphan) +
            `\n\nIf this is legitimate progress (count <= baseline), update ` +
            `BASELINE_VIOLATION_COUNT to match. If it's regression, add ` +
            `\`assertRpcResult<T>(data, 'rpc_name')\` to the missing call sites.`,
        );
      }

      // Snapshot the current shape so subsequent PRs see the report even on
      // pass. `expect` with a custom message produces a minimal log line.
      expect(
        violations.length,
        `Coverage debt sits at ${violations.length} files (baseline allows ${BASELINE_VIOLATION_COUNT}). ` +
          `Aim to reduce.`,
      ).toBeLessThanOrEqual(BASELINE_VIOLATION_COUNT);
    },
  );

  it('regex sanity: rpc capture matches all common shapes', () => {
    const samples: { code: string; expectedMatches: string[]; label: string }[] = [
      {
        label: 'destructure data + error',
        code: "const { data, error } = await supabase.rpc('post_invoice', {});",
        expectedMatches: ['post_invoice'],
      },
      {
        label: 'destructure data only',
        code: "const { data } = await supabase.rpc('save_quote', { p_idempotency_key: key });",
        expectedMatches: ['save_quote'],
      },
      {
        label: 'multi-line destructure',
        code: `const {
          data,
          error,
        } = await supabase.rpc('record_invoice_payment', payload);`,
        expectedMatches: ['record_invoice_payment'],
      },
      {
        label: 'renamed destructure (data: alias)',
        code: "const { data: result, error } = await supabase.rpc('duplicate_quote', payload);",
        expectedMatches: ['duplicate_quote'],
      },
      {
        label: 'whole-response capture',
        code: "const result = await supabase.rpc('batch_approve_blend_tickets', payload);",
        expectedMatches: ['batch_approve_blend_tickets'],
      },
      {
        label: 'multi-line .rpc on its own line (Prettier shape)',
        code: `const { data, error } = await supabase
          .rpc('generate_ticket_number', payload);`,
        expectedMatches: ['generate_ticket_number'],
      },
      {
        label: 'fire-and-forget (no =) — must NOT match',
        code: "await supabase.rpc('log_event', payload);",
        expectedMatches: [],
      },
    ];

    for (const sample of samples) {
      const matches = Array.from(sample.code.matchAll(RPC_CAPTURE_PATTERN));
      const found = matches.map((m) => m[1]);
      expect(found, `[${sample.label}] regex failed on:\n${sample.code}`).toEqual(
        sample.expectedMatches,
      );
    }
  });

  it('regex sanity: assertRpcResult matches generic-type and plain calls', () => {
    const samples: { code: string; expectedCount: number; label: string }[] = [
      { label: 'plain call', code: "assertRpcResult(data, 'name');", expectedCount: 1 },
      { label: 'simple generic', code: "assertRpcResult<string>(data, 'name');", expectedCount: 1 },
      {
        label: 'object generic',
        code: "assertRpcResult<{ id: string; quote_number: string }>(result, 'duplicate_quote');",
        expectedCount: 1,
      },
      {
        label: 'nested generic',
        code: "assertRpcResult<Array<{ id: string }>>(data, 'list_thing');",
        expectedCount: 1,
      },
      {
        label: 'comment mentioning the name — must NOT match',
        code: "// assertRpcResult is the helper for unwrapping rpc data",
        expectedCount: 0,
      },
      {
        label: 'multiple calls in one block',
        code:
          "const a = assertRpcResult<A>(d1, 'a');\n" +
          "const b = assertRpcResult<B>(d2, 'b');",
        expectedCount: 2,
      },
    ];

    for (const sample of samples) {
      const matches = Array.from(sample.code.matchAll(ASSERT_PATTERN));
      expect(matches.length, `[${sample.label}] regex failed on:\n${sample.code}`).toBe(
        sample.expectedCount,
      );
    }
  });
});
