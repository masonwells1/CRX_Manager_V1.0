## 2026-08-26 - Preserve main's quote-version trust hardening in the Section 9 branch

- Exact-SHA review found that the Section 9 branch had retained the pre-renumbered quote-version trust migration and thereby omitted `origin/main`'s transactional owner-helper overload and browser-grant checks.
- Restored the current `20260826220000_quote_version_restore_trust_boundary.sql` artifact and all current references without changing its reviewed body, fingerprints, or pending/unapplied status.
- Added a mutation-tested contract requiring both the migration precondition and postcondition to reject a second owner-helper overload or `anon`/`authenticated` execution grant.
- Reconciled the branch documentation with the already-merged renumber/apply-hardening record while preserving the Section 9 additions.
- Restamped the two still-unapplied Section 9 candidates to `20260826221000` and `20260826222000`, immediately after the pending `20260826220000` quote-trust migration. Their SQL bodies are unchanged; an executable ordering contract now prevents these candidates from falling behind that prerequisite again.
