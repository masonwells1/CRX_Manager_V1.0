/**
 * Bug-class regression manifest — 2026-07-10 → 2026-07-20 window.
 *
 * Every entry below is a REAL bug that cost a paid review round (split-billing
 * Codex rounds 2–12, Fable adversarial round, gauntlet sections 2–6, statement
 * opening balance, supplier-pricing 1a/1b). Each fix left a guard artifact:
 * an error token in a SQL function, a source pattern in the frontend, or a
 * fail-first smoke registered in scripts/smoke/smoke-specs.json.
 *
 * THIS TEST pins those artifacts. A future migration that re-emits a function
 * WITHOUT its guard token, a refactor that drops the frontend guard, or a
 * cleanup that deletes/unregisters a smoke fails here — in `npm test`, on
 * every pre-push — instead of waiting for another expensive review loop to
 * rediscover the same class.
 *
 * Follows the latest-definition-wins scan from rpcIdempotencyScope.test.ts.
 * gauntletRemediationGuards.test.ts covers the 2026-07-14 wave; this file
 * covers the 07-17..07-20 wave. Keep entries when features evolve — move an
 * entry only when the guard is intentionally superseded, and say so in the
 * commit message.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');

function latestDiskDefinitions(): Map<string, { file: string; body: string }> {
  const latest = new Map<string, { file: string; body: string }>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  const defRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = defRe.exec(content)) !== null) {
      const fnName = m[1].toLowerCase();
      if (latest.has(fnName)) continue;
      const after = content.slice(m.index);
      const bodyMatch = after.match(/AS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/);
      latest.set(fnName, { file, body: bodyMatch ? bodyMatch[2] : after });
    }
  }
  return latest;
}

/**
 * fn → guard patterns that must appear in that function's LATEST disk body.
 * Each pattern names the bug it locks (round / gauntlet id).
 */
const SQL_FUNCTION_GUARDS: Record<string, { pattern: RegExp; bug: string }[]> = {
  // The public fn is a thin flag-gate wrapper (r2 #B); business guards live in the impl.
  save_field_app_split_invoice: [
    { pattern: /per_line_split_billing_enabled/, bug: 'r2 #B — wrapper callable via direct PostgREST during the flag-off window' },
  ],
  _save_field_app_split_invoice_impl: [
    { pattern: /SPLIT_CHEMICAL_PRICE_UNRESOLVED/, bug: 'r11 — $0 unresolved chemical price minted postable children consuming inventory with no receivable' },
    { pattern: /SPLIT_JOB_IMMUTABLE/, bug: 'r3 P1 — re-save could consume a SECOND source job' },
    { pattern: /SPLIT_DUPLICATE_PRODUCT/, bug: 'r7 — duplicate product lines under-reported RUP quantities' },
    { pattern: /SPLIT_FIELD_NOT_ON_JOB/, bug: 'r4 — billing fields not on the source job' },
    { pattern: /SPLIT_SERVICE_ACRES_NONPOSITIVE/, bug: 'Fable adversarial — service acres ≤ 0 minted negative/credit invoices' },
  ],
  resolve_line_split_vector: [
    { pattern: /RESOLVER_NOT_AUTHORIZED/, bug: 'r12 — SECDEF resolver let a sales_rep read other customers’ ownership splits via arbitrary UUIDs' },
  ],
  restore_cancelled_order: [
    { pattern: /ORDER_RESTORE_NOT_SUPPORTED/, bug: 'gauntlet H4 — restore flipped cancelled→confirmed without re-applying reservations/commissions' },
  ],
  generate_finance_charges: [
    { pattern: /date_trunc\('month'/, bug: 'gauntlet H2 — same-month runs on different as-of dates double-charged interest' },
  ],
  // 2026-07-20 renamed the H3-guarded body to _void_invoice_group_guard_impl_20260720
  // and made void_invoice a governed-split wrapper that PERFORMs it — the manifest
  // follows one level of PERFORM delegation (including RENAME TO chains) below.
  void_invoice: [
    { pattern: /SPLIT_INVOICE_GROUP_VOID_REQUIRED/, bug: 'go-live — voiding one governed split member must go through void_invoice_group' },
    { pattern: /paid_amount_cents/, bug: 'gauntlet H3 — voiding a paid invoice stranded applied cash without re-banking' },
  ],
  apply_prepay_to_invoice: [
    { pattern: /IS\s+NULL\s+OR\s+\w*role\w*\s+NOT\s+IN/i, bug: 'gauntlet H1 — NULL role fails open (deactivated user moved money)' },
  ],
  // Retired 2026-07-18 to a hard-refuse stub (stronger than the H1 role gate):
  // legacy path had no compatible reversal; allocate_payment is the only cash entry.
  record_invoice_payment: [
    { pattern: /LEGACY_PAYMENT_PATH_DISABLED/, bug: 'gauntlet H1 successor — legacy payment writer must stay retired (no reversible void path)' },
  ],
  create_invoice_for_unbilled_delivery: [
    { pattern: /needs_split_billing/, bug: 'gauntlet H5 — mono-billed a split-billing order, mis-attributing AR' },
  ],
};

/**
 * Guard tokens raised by TRIGGER functions or governance paths whose owning
 * function name may legitimately change — required to survive in at least one
 * latest-definition body somewhere on disk.
 */
const SQL_ANYWHERE_GUARDS: { pattern: RegExp; bug: string }[] = [
  { pattern: /SPLIT_POST_ITEM_SHARE_MISMATCH/, bug: 'Fable adversarial — admin item-tamper desynced printed/RUP amounts from server allocation' },
  { pattern: /PRODUCT_PRICING_GOVERNED_PATH_REQUIRED/, bug: 'pricing 1a — direct products pricing writes bypassed governance' },
  { pattern: /PRICE_UNIT_MISMATCH/, bug: 'pricing 1b — staged supplier price with mismatched unit accepted' },
  { pattern: /ACTOR_MISMATCH/, bug: 'go-live hardening — actor forgery canonical refusal' },
];

/** Frontend source patterns that fixed UI-layer money bugs. */
const FRONTEND_GUARDS: { file: string; pattern: RegExp; bug: string }[] = [
  {
    file: 'src/pages/FieldAppSplitInvoiceEditor.tsx',
    pattern: /resetPostIdemKey\(\);\s*\},\s*\[invoiceGroupId/,
    bug: 'r10 — retained post idempotency key across drafts; posting draft 2 replayed draft 1’s cached success, leaving draft 2 UNPOSTED',
  },
  {
    file: 'src/pages/FieldAppSplitInvoiceEditor.tsx',
    pattern: /activeLoadSetIdRef/,
    bug: 'Fable adversarial — fast open A-then-B race rendered stale draft (latest-load-wins guard)',
  },
  {
    file: 'src/pages/FieldAppSplitInvoiceEditor.tsx',
    pattern: /pctsToMicro/,
    bug: 'r2 #K / r3 P2 — split vector must come from the shared largest-remainder impl (tested in splitVectorMath.test.ts)',
  },
];

/**
 * Fail-first smokes shipped with the window's fixes: file must exist AND be
 * referenced from smoke-specs.json so run-smoke.mjs --all still executes it.
 */
const REQUIRED_SMOKES = [
  'smoke-prepay-payment-inactive-actor-gate.sql',
  'smoke-revert-quote-escape-hatch.sql',
  'smoke-finance-charge-month-dedup.sql',
  'smoke-void-invoice-blocks-applied-payments.sql',
  'smoke-forbid-restore-cancelled-order.sql',
  'smoke-backfill-refuse-split-billing.sql',
  'smoke-statement-opening-balance.sql',
  'smoke-field-app-split-penny-exact.sql',
];

/**
 * A function's EFFECTIVE body: its latest disk definition plus one level of
 * PERFORM-delegation. When a wrapper PERFORMs a helper with no disk CREATE,
 * resolve `ALTER FUNCTION public.<orig>(...) RENAME TO <helper>` — the helper's
 * source is then <orig>'s latest definition in migrations OLDER than the rename
 * (the repo's wrap-and-rename hardening pattern, e.g. void_invoice 2026-07-20).
 */
function effectiveBody(fn: string, defs: Map<string, { file: string; body: string }>): { files: string[]; body: string } {
  const migFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const files: string[] = [];
  let body = '';
  const visited = new Set<string>();

  /** Latest def of `name` in files strictly older than index `beforeIdx` (or all files). */
  function latestDefBefore(name: string, beforeIdx: number): { file: string; body: string } | null {
    const defRe = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`, 'i');
    for (let i = beforeIdx - 1; i >= 0; i--) {
      const c = readFileSync(join(MIGRATIONS_DIR, migFiles[i]), 'utf8');
      const d = c.match(defRe);
      if (!d || d.index === undefined) continue;
      const after = c.slice(d.index);
      const bodyMatch = after.match(/AS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/);
      return { file: migFiles[i], body: bodyMatch ? bodyMatch[2] : after };
    }
    return null;
  }

  /** Resolve a name that has no disk CREATE via `ALTER FUNCTION <orig> RENAME TO <name>`. */
  function resolveRenamed(name: string): { file: string; body: string } | null {
    for (let i = migFiles.length - 1; i >= 0; i--) {
      const content = readFileSync(join(MIGRATIONS_DIR, migFiles[i]), 'utf8');
      const r = content.match(new RegExp(
        `ALTER\\s+FUNCTION\\s+public\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^)]*\\)\\s*RENAME\\s+TO\\s+${name}\\b`, 'i'
      ));
      if (!r) continue;
      const orig = r[1].toLowerCase();
      const d = latestDefBefore(orig, i);
      if (d) return { file: `${d.file} (as ${orig}, renamed to ${name})`, body: d.body };
      return null;
    }
    return null;
  }

  function expand(name: string, depth: number, resolvedFromRename: boolean): void {
    if (visited.has(name) || depth > 4) return;
    visited.add(name);
    // A rename target's TRUE body is its pre-rename source, never a later
    // same-named CREATE, so skip the defs lookup when following a rename.
    const def = (!resolvedFromRename && defs.get(name)) || resolveRenamed(name);
    if (!def) return;
    files.push(def.file);
    body += '\n' + def.body;
    const performRe = /PERFORM\s+public\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = performRe.exec(def.body)) !== null) {
      const helper = m[1].toLowerCase();
      expand(helper, depth + 1, !defs.has(helper));
    }
  }

  expand(fn, 0, false);
  return { files, body };
}

describe('Bug-class regression guards (2026-07-10..20 window)', () => {
  const defs = latestDiskDefinitions();

  describe('SQL function guards survive in the LATEST definition', () => {
    for (const [fn, guards] of Object.entries(SQL_FUNCTION_GUARDS)) {
      it(`${fn} keeps its guards`, () => {
        const eff = effectiveBody(fn, defs);
        expect(eff.files.length > 0, `${fn} has no on-disk definition — if intentionally dropped, update this manifest`).toBe(true);
        for (const { pattern, bug } of guards) {
          expect(
            pattern.test(eff.body),
            `${fn} (latest defs: ${eff.files.join(', ')}) lost guard ${pattern}.\nBug it prevents: ${bug}\nA newer migration re-emitted the function without it.`
          ).toBe(true);
        }
      });
    }
  });

  it('trigger/governance guard tokens survive somewhere in the latest definitions', () => {
    const allBodies = [...defs.values()].map((d) => d.body).join('\n');
    for (const { pattern, bug } of SQL_ANYWHERE_GUARDS) {
      expect(
        pattern.test(allBodies),
        `Guard token ${pattern} no longer exists in any latest function definition.\nBug it prevents: ${bug}`
      ).toBe(true);
    }
  });

  describe('frontend guards survive', () => {
    for (const { file, pattern, bug } of FRONTEND_GUARDS) {
      it(`${file} keeps ${pattern}`, () => {
        const src = readFileSync(join(ROOT, file), 'utf8');
        expect(pattern.test(src), `${file} lost guard ${pattern}.\nBug it prevents: ${bug}`).toBe(true);
      });
    }
  });

  describe('fail-first smokes stay present and registered', () => {
    const specsRaw = readFileSync(join(ROOT, 'scripts', 'smoke', 'smoke-specs.json'), 'utf8');
    for (const smoke of REQUIRED_SMOKES) {
      it(`${smoke} exists and is registered in smoke-specs.json`, () => {
        expect(existsSync(join(ROOT, 'scripts', 'smoke', smoke)), `${smoke} was deleted`).toBe(true);
        expect(specsRaw.includes(smoke), `${smoke} is not referenced by any spec chain — run-smoke.mjs --all no longer runs it`).toBe(true);
      });
    }
  });
});
