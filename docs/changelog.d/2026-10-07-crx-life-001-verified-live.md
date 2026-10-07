## 2026-10-07 - CRX-LIFE-001 verified live: order invoices can no longer be field-application invoices

`20261006200000_refuse_field_invoice_through_order_rpcs` applied live at 2026-10-07 11:45:56 UTC from
PR #885's frozen head `0149b2b15` (ledger version `20261007114554`; the name keeps the authored
basename, so no B7 rename), after CodeRabbit APPROVED that head, an exact-SHA `gpt-6-sol` review of it
returned CLEAN, every check was green, and both `rls-security-reviewer` / `migration-drift-reviewer`
apply proofs were CLEAN. PR #885 then merged as `342135561`; the production deployment of that commit
is READY and croprxsolutions.app answers 200.

**Read-only post-apply check (live):** one `create_invoice_from_order(uuid,uuid,text,text)` overload,
md5(prosrc) `a1a91643bd8866823ae359f7e0ec290e`, SECURITY DEFINER, `search_path=public, pg_temp`, owner
`postgres`, ACL `{postgres,authenticated,service_role}` (anon cannot execute);
`invoices_field_application_has_no_order` present and validated with the exact pinned definition;
`invoices` unchanged (13 rows, 0 order-backed `field_application`); the split wrapper and the three
private implementations unchanged. Ledger: 1019 rows / 1012 names, high-water `20261006200000`.

**Post-apply invariant sweeps:** run started 2026-10-07 ~11:47 UTC; result recorded in a follow-up
commit on this branch.

**Not run on live:** the registered smoke chains. Each consumes customer-visible invoice numbers on live,
and running them needs Mason's REAL-DATA-OK, which was not given. The container prover
(`npm run proof:order-invoice-type-gate`) is the behavioral proof: bug reproduced before, refused after,
both layers mutation-tested, all covering chains passing.

**Process notes:** the overnight autopilot arming expired while the dependency fix (#884) waited on its
review, which parked the apply as designed until Mason re-armed it in chat. Vercel never built a preview
for #885's final merge-from-main commit, so the required `Vercel` status was missing; a preview build of
that exact commit was requested through the Vercel API (no code change), after which the PR read CLEAN.

Docs: `KNOWN_ISSUES.md` moves CRX-LIFE-001 to the archive as FIXED (verified live); migration-history
row 937 and the boundary capture, and `CURRENT_STATE.md`, record the apply. The schema registry was not
regenerated: the migration adds a CHECK constraint (no status enum, generated column or table), so
ship.md does not require it; the next registry refresh will pick it up.
