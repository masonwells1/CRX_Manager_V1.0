## 2026-09-03 — refreshed the schema registry from live introspection

`.claude/schema-registry.json` was two days behind the live database. Four hooks
(`status-enum-check`, `generated-column-check`, `sql-safety`, `session-staleness`) and three
schema-aware reviewer agents read it as their source of truth, so a stale registry silently
degrades every one of them.

Regenerated with the **real** mode — `node scripts/regenerate-schema-registry.mjs
--from-introspection <file>` — from six read-only queries against project `rhyzpcqhnizqbxphqdkr`.
Not the no-args "stamp" mode, which only bumps `generated_at` and leaves the schema data exactly as
stale as before.

**What changed.**

- `migrations_high_water`: `20260901184530` → `20260903025854`.
- `applied_migration_names`: +4 — the `20260831*` group (`harden_receiving_reversal_and_ap_reporting`,
  `require_cumulative_po_bill_confirmation`, `fail_closed_historical_commission_balance`,
  `guard_cycle_count_completion_revision`).
- `financial_audit_log.entity_type`: + `receiving_record`.
- `financial_audit_log.operation_type`: + `receiving_reversed`.
- `cycle_counts` columns: + `item_revision`.
- `skipped_constraints`: +1 — `cycle_counts_item_revision_nonnegative_chk`, a range check the parser
  cannot turn into a value set. Listed loudly rather than silently ignored, per the registry's design.

The two new `financial_audit_log` values matter most: until now the hooks did not know they were
legal, so code writing either one could have been flagged against a value set that was missing them.

**Nothing was removed.** All six deleted lines in the diff are lines that only gained a trailing
comma. `status_enums` did not collapse — the specific failure mode the skill warns about, where a
silently failed script produces a near-empty registry that reads as "the schema changed".

**No stale flag to clear.** A search of the whole `C:/CRX_Manager` tree found zero
`REGISTRY-STALE.flag` files, so no worktree was blocked from migration writes. The staleness was
reported by `session-staleness.mjs`'s name comparison, not by the flag.

**Skill defect found, not fixed here.** `/regen-schema-registry` Step 1.0 documents
`node -e "…writeFileSync('.claude/session-state/registry-refresh-start.txt'…)"` to stamp the cutoff
used when clearing stale flags. That command is denied by the maintenance-producer guard ("one exact
repository-relative node command only"), and writing the same file with the Write tool is denied by
`review-proof-guard` (".claude/session-state … cannot be created … through a file tool"). Both routes
are closed and no repository script writes that stamp — verified by grepping `scripts/` and
`.claude/hooks/`. This refresh was unaffected because the pre-query timestamp was captured in-session
and there was no flag to clear, but a run that *does* need to clear one has no sanctioned path.
Recorded for a follow-up that either adds a small writer script or moves the stamp outside the
guarded directory.
