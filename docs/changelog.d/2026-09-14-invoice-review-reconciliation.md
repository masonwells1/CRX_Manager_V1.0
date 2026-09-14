## 2026-09-14 - Reconcile invoice candidate adversarial review findings

Claude's September 14 exact-head review of `372fe854ce839a67807d1fc07ac6206181d0bacd`
returned NEEDS-WORK; the separate Sol/high review returned CLEAN. Publication remained
blocked by the actionable Claude findings. This correction does not authorize live apply.

- Ship and gauntlet now require fresh MCP packets plus executable parameter/dependency
  contract adjudication, not violation-key subtraction. A workflow regression pins this.
- The first of the four pending invoice migrations now has its canonical LF SHA-256
  bound in migration history. No SQL migration bytes or grants changed.
- Both protected invoice routes use an identity-keyed wrapper, discarding old form
  fields and confirmation dialogs when opening another or a new invoice. Rendered
  tests exercise the production wrapper and pin both routes and unchanged access roles.
- Server season-refusal copy explains another split-group member can conflict even
  when the displayed member's date fits. It does not promise a nonexistent date range.
- Unexpected initial invoice-load rejections return to the list; abandoned requests
  cannot navigate or install another invoice's controls. Rendered regressions cover both.
- The disposable prover pins the fourth migration's selected-ledger order and adds
  a below-cost missing-reason refusal/atomic-rollback control before authorized edits.

Claude HIGH feasibility concern: actual read-only Supabase inspection at
2026-09-14T12:34:52.46773Z found `postgres` non-superuser **with** effective
`pg_read_all_stats` membership, zero other open database transactions and zero
prepared transactions. The required visibility and quiet window were observed.
This is a point-in-time preflight, not future apply clearance. Retain the full barrier;
never bypass it, disable jobs, kill backends or discard valid retry receipts.

Remaining review dispositions (not permission to skip exact-head re-review):

- LOW bounded retry: retain three explicit pre-mutation retries (150/300ms), the same
  request/key and safe manual retry after refusal. Longer automatic retries are not
  required; uncertain transport failures are never automatically replayed.
- LOW future actor-predicate column shape: hypothetical, not a present predicate
  bypass. Current unknown predicates/contracts fail closed. A future predicate needs
  its own explicit reviewed contract semantics; no speculative lexer expansion here.
- LOW purchase-order role helper: fresh live source shows inline active-admin profile
  authorization, not a call to `is_admin()`. Its full function/dependency contract is
  already captured and pinned; no unrelated helper pin or allowance refresh is warranted.
- LOW chemical cost control: current reviewed generic writer recomputes header cost
  for every draft/unposted invoice type. Preserve the correct 5000-cent expectation,
  not the obsolete 77777 sentinel. The new refusal control separately proves the
  missing-reason guard and absence of partial mutations.
- Nonactionable nits: central RPC-code registration, actionable cutover refusal copy,
  strict replay quiet preflight, and defensive diagnostics are intentional. Hypothetical
  future trailing-comment SQL or future predicates are not current defects. Source
  invoice dates may remain unchanged even outside the filed-season range; only an
  actual date/type change is refused. Tests prove that distinction.

Final corrected-commit local checks, full Sol/high proof, Claude CLI clearance,
required/reported CI and actual exact-head CodeRabbit APPROVED remain required.
All four invoice migration files remain **NOT APPLIED**; no business data was written.
