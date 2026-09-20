## 2026-09-19 — six document-number generators take their year from Chicago, not UTC (PARKED, not applied; issue #617)

**What changed.** New parked migration `supabase/migrations/20260908140000_number_generators_year_chicago.sql`
re-emits `next_application_record_number`, `next_commission_payment_number`,
`next_cycle_count_number`, `next_job_number`, `next_po_number` and `next_return_number` from their
live `pg_proc.prosrc` (read read-only 2026-09-19). One line changes in each: the year comes from
`(now() AT TIME ZONE 'America/Chicago')::date` instead of the UTC `CURRENT_DATE`. Without it, work
done after 6 pm Chicago on 31 December 2026 is numbered with 2027 (`JOB-2027-0001`). It is a
wrong-year label; the year change creates no duplicate. (Pre-existing and unchanged: the job and cycle-count
screens call their generator as a preview before a separate save, so two users can see the same next
number.)

The file pins each live and candidate body md5 (the candidate pins were computed on live), the
zero-argument signature, SECURITY DEFINER, search_path, owner and volatility. Its postflight pins each
function's EXECUTE ACL in both directions. `authenticated` keeps EXECUTE on `next_job_number` and
`next_cycle_count_number`, which the browser calls, and must not hold it on the other four. It has no
GRANT/REVOKE and changes no data.

**Why the stamp is `20260908140000`.** It sorts above the live high-water `20260908130000` and
deliberately below the parked, unapplied `20260914100100`..`20260914100900` cohort. The
pending-migration guard refuses a file stamped above an unapplied tracked migration, and forcing one
through would strand all eight. Stamped below them, it can apply first, ahead of the 31 December
deadline, without touching their order. The first draft was stamped `20260919120000` and claimed it
could apply "before or after" the cohort; the migration-drift review caught that as HIGH.

Also: `.gitattributes` pins the migration and its prover to LF; `docs/manual/KNOWN_ISSUES.md`
records the fix as written but not applied, and corrects the returns prefix to `RMA-`;
`docs/reference/migration-history.md` row 929; the ledger re-read stamps in `CURRENT_STATE.md`,
`KNOWN_ISSUES.md` and the migration-history boundary block.

**Proof observed.** `node scripts/smoke/prove-number-generators-year-chicago.mjs` → 142/142,
`NUMBER_GENERATORS_YEAR_CHICAGO_PROOF_PASS` on a throwaway `postgres:17-alpine` container:
- It derives each live body from the file by reversing its one line, and each hashes to the live pin,
  so the transcription is byte-exact to the recorded live pins (the apply-time preflight re-checks live).
- With the clock pinned to 2029-01-01 02:00 UTC (20:00 Chicago on 31 December 2028), the real live
  bodies mint `-2029-` and the fixed ones `-2028-`. Neither is the year the prover runs in, so a
  missed clock substitution fails instead of passing by coincidence. Outside the window both agree.
- Numbering continues from the year's MAX, a replay is a no-op, and `assertWrappable` accepts the file.
- Mutation tests show each refusal fires: a drifted body, a stripped search_path, SECURITY INVOKER,
  a changed owner, a second overload, a changed signature, a changed volatility, anon direct and
  indirect, a NULL ACL, a third-party grantee, authenticated added or removed, and service_role
  removed.
- Two rounds of both review subagents (rls-security, migration-drift) found no BLOCKER. The
  first-round HIGH (the stamp) is fixed. Second round: one MED, the undocumented apply order below,
  now fixed. Most LOWs are fixed: header wording, a stray grant in the prover, "nothing changed"
  checks on every drift mutation, the untested guards above, and a postflight volatility check.
  Left open and documented: proof step 0 checks the file against the recorded live pins and does
  not re-read live; the preflight re-reads live at apply time.
- **Independent `gpt-5.6-sol` high-effort review (inline diff), verdict CLEAN**, run marker
  `tokens used` present. It was run by hand, not through `write-codex-push-proof.mjs`. That wrapper
  fails before review since the 2026-09-19 Codex update: its elevated Windows sandbox now demands
  `:root` read access. The hand run pasted the diff inline and kept the wrapper's deny-all
  filesystem profile, no network and `project_doc_max_bytes=0`. So it is a real review, but it
  mints NO push proof. Its four MED and four LOW findings are all fixed:
  - the postflight now pins each function's EXACT ACL, which catches grantors, the owner's item and
    WITH GRANT OPTION;
  - a missing `service_role`, or a missing `authenticated` on the browser-called pair, is refused
    rather than skipped;
  - the preflight and postflight pin language, volatility, strictness, parallel safety, leakproof,
    cost and return type. Live values were read read-only 2026-09-19: plpgsql, VOLATILE, not strict,
    parallel unsafe, not leakproof, cost 100, returns text;
  - the "never issued twice" claim is scoped to the year change;
  - the proof image is pinned by digest;
  - proof and cohort wording is corrected.
- **Sol re-review of those fixes: CLEAN** (`tokens used` present). One MED: `prosupport` was
  not pinned, so a planner support function added out of band would be silently dropped. Live
  has none (read 2026-09-19); both flights now pin it, and prover step 5j proves the refusal. One
  LOW: the role-existence checks used OR/AND, whose evaluation order PostgreSQL does not
  guarantee; they are now nested IFs.

**Apply order: this file must go FIRST.** It sorts below every other unapplied migration. That is
the `main` cohort above. It is also, on unmerged branches, #664's `20260911120000` and the
field-app season files `20260908190000`, `20260912165758`, `20260913040359` and `20260913152700`.
The pending guard's own code confirms that, once this merges, it refuses all of those until this
file is applied. If any of them applies live first, this file must be restamped.

A read-only live ledger re-read (1002 rows, `max(version)` `20260915033227`) confirmed that no parked
candidate is applied.

**Not verified / still required.** Not applied live. It still needs an exact-SHA `gpt-5.6-sol`
review and then Mason's attended apply before 31 December 2026. The proof uses a minimal stand-in
schema, not a full restore; the live bodies only touch `auth.uid()`, `profiles` and each generator's
own table.
