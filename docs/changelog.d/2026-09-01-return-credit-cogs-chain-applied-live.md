## 2026-09-01 - Apply the return-credit COGS chain live and repair the migration proof gate

### What shipped

All six return-credit COGS migrations were applied to production
(`rhyzpcqhnizqbxphqdkr`) in order, with Mason's in-chat approval:

| authored name | apply-time `version` |
| --- | --- |
| `20260827041000_align_recognized_invoice_report_statuses` | `20260901163711` |
| `20260827041100_rebuild_return_credit_cogs_reversal` | `20260901182753` |
| `20260827041200_exclude_return_credits_from_delivery_invoice_gate` | `20260901183005` |
| `20260827041300_align_return_credit_delivery_surfaces` | `20260901183549` |
| `20260827041400_align_return_credit_order_invoice_gates` | `20260901183717` |
| `20260827041500_preserve_generated_invoice_lineage_and_finish_cutover` | `20260901184530` |

Live ledger after the chain: 986 rows, `max(version)` `20260901184530`.

### Owner-visible effect

- Return-credit issuance reverses COGS against the correct recognized source lots, including the
  NULL-lineage fallback that previously allowed a second credit against an already-credited line.
- Invoice-basis P&L, monthly COGS, and customer year-end reporting share one recognized
  invoice-status set (`posted`, `overdue`, `paid`); AR stays open-only.
- Both invoice creators stamp the Chicago business date and derive the season from it, so an
  invoice created late in the evening no longer lands in the next UTC day. Mason approved this
  year-end reporting change explicitly.
- `20260827041000` installed a trigger pausing return-credit issuance for the duration of the
  cutover; `20260827041500` removed it. Verified after the final apply: trigger `0`, function `0`.
  Production has never issued a return credit (zero credited returns, zero credit memos), so the
  freeze had no practical customer impact and the repair landed before the defect produced a wrong
  number.

### Verification

Each migration was applied behind a full migration-apply-guard proof — both reviewer charters
returning CLEAN machine verdicts from `gpt-5.6-sol` at high reasoning — and each was verified
afterwards by read-only live query rather than by the apply exit code: ledger row present, expected
function bodies live, new CHECK constraints validated, grants unchanged
(`anon`/`authenticated` cannot execute `_issue_return_credit_impl`; `service_role` can), and the
barrier state at each step.

`20260826220000_quote_version_restore_trust_boundary` was already applied (ledger `version`
`20260827113443`) before the chain, so the documented apply-order dependency was satisfied and
nothing was wedged.

### Gate behavior worth recording

Nine gate refusals occurred across the run. **Every one was a gap in the reviewer evidence bundle,
not a defect in a migration, and no verdict was overridden.** The fixes went into
`scripts/write-apply-proofs.mjs`:

- the reviewer child could not read files at all, so the migration bytes, schema-registry column
  lists, TypeScript declarations, prior function declarations, grants and call sites are now
  embedded;
- function discovery missed **quoted identifiers** (`"public"."void_delivery"`), which silently
  dropped 3 of 4 functions from `20260827041300`'s bundle; argument lists are now read by balanced
  parens instead of a `[^)]*` pattern that truncated on `numeric(10,2)`;
- a `--print-evidence` flag was added that dumps the bundle and exits before any review runs or
  proof is written, so it grants no bypass.

`.claude/schema-registry.json` was refreshed from live introspection mid-chain: migration 2 creates
`return_items.restocked_quantity`, and the pre-existing snapshot predated that apply, so the drift
reviewer correctly refused a column check it could not perform.

### Follow-ups (not done here)

- `orders.status NOT IN ('cancelled','draft')` — `'draft'` is dead and `'voided'` is not excluded.
  Pre-existing, zero impact at current data volumes.
- `inventory_transactions` and `idempotency_keys` have no declaration in `src/types/index.ts`;
  route to `typescript-types-drift-reviewer`.
