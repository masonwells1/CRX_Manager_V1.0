## 2026-08-27 - product data model amendment Revisions 12-13: ingredient identity settled as owner decision D-AA, bound restamp fingerprint

PR #498 merged the workbook-first amendment at Revision 11 while the fixes for the third
hard-merge-gate proof run were still in their commit gate, so its two HIGH findings landed on
`main` known-but-unfixed. This change is the immediate follow-up carrying Revision 12, and then
Revision 13 which withdraws half of it:

- **Cross-product ingredient-identity race: finding on record, identity model SETTLED as owner
  decision D-AA, mechanism assigned to WP-1's build cycle.** Revision 12 prescribed a database
  identity constraint and a conflict-safe
  resolve-or-create form. A `gpt-5.6-sol` proof run on that small diff plus five independent
  connector findings then converged: the eight findings were not defects in the mechanism but
  symptoms that the identity *model* underneath was never decided — is CAS the global identity,
  does it hold across alternate names, how do CAS-less rows reconcile with later CAS'd ones,
  what happens on a canonical-parent disagreement, and what ordering governs multi-identity
  drafts. Several were Mason's calls about his own catalogue, so the mechanism was **withdrawn,
  not deferred**, and the question went to him. **He settled it the same night (D-AA, Mason,
  2026-08-27):** CAS is the global identity where present, across alternate names and spellings
  (same CAS = same chemical, merged; his per-row review catches a label typo); a CAS-less row and
  a later same-name CAS-bearing proposal never auto-merge and never silently fork — the merge is
  **queued for his explicit approval**, side by side; and a proposal whose name matches an
  existing ingredient but claims a different canonical parent is **refused at import** with a
  named error, corrected in the sheet and re-uploaded. Two sub-answers stand technically: no
  resolve path ever mutates a shared row's display name — the drafted `DO UPDATE SET name` would
  have let one product's approval silently rename a row every other product shares — and
  multi-identity inserts take a deterministic order. **The gate is reworded rather than dropped:
  WP-1's migration implements D-AA as settled, with the concrete constraint and resolve-or-create
  mechanism specified and reviewed inside WP-1's own build cycle under its gates.** Revision 12's
  specific forms stay withdrawn and are not a fallback — the name-based key contradicts the CAS
  ruling, the `DO UPDATE SET name` contradicts the rename ruling. The race itself is **still
  unfixed in code** and is carried as a **known open HIGH until WP-1 implements D-AA**, acceptable
  only because nothing is built yet.
- **Restamp idempotency bound to its complete intent.** `create_workbook_import_proposals`'s
  request fingerprint now binds the operation mode plus every mutation-defining input per mode
  (batch: canonical content identity; restamp: stale draft id, product, domain, replacement
  envelope), so a reused key can no longer replay a different restamp's receipt while the
  intended draft sits stale. Unchanged by Revision 13 — none of the eight findings touched it.

Sequence recorded honestly: both Revision 12 findings came from the third exact-SHA
`gpt-5.6-sol` proof run; #498 merged (Mason's web-UI merge, his call on record) before this fix
landed; a fourth proof run was deliberately not run — Mason's decision after 3 runs / 7 findings
/ 0 repeats made non-termination the working assumption. That assumption held: the review of
Revision 12's own small diff produced an eighth finding cluster, and the response was to stop
patching and route the question to its owner rather than attempt a ninth mechanism. Mason
settled D-AA in chat the same night, before this PR landed, so the model ships decided and only
its implementation is deferred to WP-1's build cycle. The durable
follow-up (splitting the 250KB plan below reviewer size ceilings) is tracked in the wrap-up
notes, not here.
