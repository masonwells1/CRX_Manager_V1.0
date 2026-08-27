## 2026-08-27 - product data model amendment Revision 12: global form identity, bound restamp fingerprint

PR #498 merged the workbook-first amendment at Revision 11 while the fixes for the third
hard-merge-gate proof run were still in their commit gate, so its two HIGH findings landed on
`main` known-but-unfixed. This change is the immediate follow-up carrying Revision 12:

- **Cross-product ingredient-identity race closed.** `active_ingredients` gains a
  database-enforced canonical identity — UNIQUE over `(lower(btrim(name)), coalesce(cas, ''))`,
  carried by WP-1's migration — and the typed commit's resolve-or-create is mandated as
  `INSERT … ON CONFLICT … DO UPDATE … RETURNING id` (one form; the advisory-lock alternative
  deliberately not adopted; no new lock-order edge). Two products concurrently proposing the
  same new chemical form now yield exactly one identity, proven by a required two-session case.
- **Restamp idempotency bound to its complete intent.** `create_workbook_import_proposals`'s
  request fingerprint now binds the operation mode plus every mutation-defining input per mode
  (batch: canonical content identity; restamp: stale draft id, product, domain, replacement
  envelope), so a reused key can no longer replay a different restamp's receipt while the
  intended draft sits stale.

Sequence recorded honestly: both findings came from the third exact-SHA `gpt-5.6-sol` proof
run; #498 merged (Mason's web-UI merge, his call on record) before this fix landed; a fourth
proof run was deliberately not run — Mason's decision after 3 runs / 7 findings / 0 repeats
made non-termination the working assumption. The durable follow-up (splitting the 250KB plan
below reviewer size ceilings) is tracked in the wrap-up notes, not here.
