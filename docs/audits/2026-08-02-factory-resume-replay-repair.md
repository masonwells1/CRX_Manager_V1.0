# Factory Resume Replay Repair — 2026-08-02

## Owner-facing verdict

The emergency hold during the vacation verification job was not proof that
`npm run typecheck` edited the application or factory. The owner prompt was
forwarded with `claude --resume` into a transcript that still contained an
unfinished evidence tool call. Resuming that transcript replayed the pending
call. Two same-job evidence commands then overlapped, and one command observed
the other command's legitimate permit/artifact activity as protected-state
mutation.

The result was fail-closed—nothing shipped—but the Factory Board's blocker was
misleading and one unattached typecheck artifact remained in the private shared
evidence directory. That orphan is preserved as incident evidence; it is not
shown as attached proof and is not deleted or promoted.

## Repair

- Pause/resume state evaluation and its conditional append share one ledger
  lock. Repeated controls append no event when their state is already active,
  while a newer opposite control cannot be lost behind a stale no-op check.
- A per-job single-flight lock refuses a second evidence command before its
  harness executes.
- The harness mutation fingerprint excludes only mutable coordination records:
  the protected single-flight lock, append-only event file, its short lock,
  emergency hold, one-time permits, owner receipts, intent latches, and recovery
  records. The owner-receipt authentication key, immutable tickets, evidence
  artifacts, and unknown state paths remain covered.
- A raw-byte-identical content-addressed artifact write is idempotent. If a process
  stops after writing evidence but before ledger attachment, that orphan remains
  unattached and cannot validate proof. A normal retry records a new capture
  timestamp and produces fresh evidence rather than promoting the orphan.
- The broker reloads shared state after the harness finishes. A pause that
  arrives during execution prevents the resulting receipt from attaching and
  the newly created unattached artifact is removed. Emergency-pause persistence
  and conditional evidence attachment share a dedicated hold fence. Persistence
  normally also serializes through the ledger lock and falls back to a direct
  fail-safe marker, still inside the hold fence, if that lock times out. The
  final running-state check plus receipt append stay atomic under the ledger
  lock, eliminating the check-to-append interval.
- The original lane session may replace a parked job's plain-English behavior
  summary and nonempty blocker while remaining parked. No other session can do
  so, and this path cannot reopen or advance the job.

## Acceptance proof

Focused executable checks cover:

1. serialized pause/resume controls, including a replayed no-op with an
   unchanged terminal hash and a newer opposite control that takes effect;
2. two real concurrent same-job CLI evidence processes, exactly one attached
   receipt, and no emergency hold;
3. raw-byte-identical content-addressed write idempotence and identity binding;
4. refusal and cleanup when an emergency pause arrives during a harness, plus
   atomic held-state refusal, shared hold-fence ordering, and fail-safe
   persistence during ledger-lock contention;
5. early metadata refusal before harness execution, validation of hold/resume
   receipts, and continued detection of unexpected state writes including
   replacement of the owner-receipt authentication key;
6. parked-to-parked summary/blocker refresh, cross-session refusal, empty-field
   refusal, and unchanged parked stage.

The complete repository pipeline and fresh exact-SHA Sol/high review are still
required before this repair may be published. The shared Board metadata must not
be refreshed until the parser supporting the new legal parked event is on
`main`; otherwise older code would correctly reject that event during replay.

## Authority boundary

This repair changes only local factory coordination. It grants no authority to
push, merge, deploy, apply a migration, alter live data, change permissions, or
delete the preserved orphan artifact.
