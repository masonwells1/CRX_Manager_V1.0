## 2026-09-01 - Harden the migration-proof evidence bundle after an exact-head Codex review

The exact-head `gpt-5.6-sol` review of PR #544 returned BLOCKERS on the same-PR changes to
`scripts/write-apply-proofs.mjs`. All three findings were real and are fixed here.

### HIGH - incomplete security evidence could produce a false clean review

The bundle embedded only the grants **declared in the migration under review**, and silently
stopped after two call-site files, while the reviewer charter forbids looking anywhere else.
A reviewer therefore saw a partial caller list presented as if complete, so an
anon-executable `SECURITY DEFINER` helper or an unsafe third caller could be misclassified as
private and pass the RLS / actor-forgery / idempotency gate.

- The two-file call-site cap is removed. Silent truncation is the defect: it reads to the
  reviewer as "these are all the callers".
- The grants section now states plainly that it shows the migration's own DDL and **not** the
  effective live ACL, that earlier migrations may have granted or revoked EXECUTE, and that a
  check turning on the effective grant must report BLOCKERS rather than infer the live posture.

### HIGH - review evidence was untrusted, mutable, and unbound to the proof

Only the migration itself was labelled untrusted, while the registry, ledger,
migration-history rows, prior declarations, TypeScript declarations and call-site excerpts
were injected as ordinary prompt text. All of those are candidate-controlled repository
content and can contain sentences addressed to the model. Separately, the bundle was rebuilt
for each reviewer and only the migration hash was re-checked afterwards, so two charters
could judge different inputs.

- Every embedded section is now explicitly marked untrusted, with instructions never to
  follow directives found inside any of them.
- The bundle is built **once**, hashed with SHA-256, and the identical string is passed to
  every reviewer.
- After the last review the bundle is rebuilt and compared; a mismatch mints nothing and says
  which sources moved.
- `evidenceHash` is recorded in both proof files, binding each proof to the inputs the
  verdicts actually rested on rather than to the migration alone.

### MEDIUM - the refreshed registry contradicted the live-apply record

`.claude/schema-registry.json` was regenerated mid-chain to unblock the final migration's
review, so it stopped at `20260901183717` and omitted `20260827041500` - while
`docs/manual/CURRENT_STATE.md` claimed it recorded `20260901184530`. That claim was false.
The registry has been regenerated from live after the chain closed: high-water
`20260901184530`, migration 6 present, 979 distinct applied names. `CURRENT_STATE.md` now
records what actually happened, including the stale window.

### Note

These defects were introduced by the same session that applied the migration chain, in the
tooling it repaired mid-run. The independent exact-head review is what caught them; nothing
here was self-diagnosed.
