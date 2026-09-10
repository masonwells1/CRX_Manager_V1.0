## 2026-09-10 - the fingerprint generator prints the block; it never writes the guard

Found by the Codex GitHub review on `d1ea521c4`, verified against the real
permission config before being believed, and it is the same bypass as round 4
wearing a different coat.

Round 4 moved the authorised fingerprints out of a writable JSON manifest and
into `.claude/hooks/live-testdata-lib.mjs`, on the reasoning that
`.claude/hooks/**` is approval-gated while `scripts/**` is not. That reasoning
was right, and the implementation quietly undid it: the generator
`write-predicate-fingerprints.mjs` rewrote the guard **itself**.

Read together, `.claude/settings.json` auto-allows `Bash`, `node scripts/...`,
and `execute_sql`, and puts only `Edit`/`Write` on `.claude/hooks/**` behind its
`ask` tier. So the sanctioned command was an allowed command doing a gated
thing, and the whole sequence prompted for nothing:

1. edit a predicate `.sql` into destructive SQL (an ordinary write under `scripts/`);
2. run the documented generator command — the guard's authorised list now
   contains that statement's hash, and the command never named `.claude/hooks`;
3. call `execute_sql` with it. `classifySql` returns `{ block: false,
   kind: "known-sweep-predicate" }` before any DDL/DML or `REAL-DATA-OK` check runs.

**The generator no longer changes the guard.** It computes the block and prints
it; whoever updates the list applies it with an ordinary edit to the hook file,
and that edit is the step the permission tier sees. Exit 0 means the guard
already matches the files; exit 1 prints the replacement block on stdout, or
refuses when the markers are ambiguous. The marker-uniqueness rule survives as a
refusal to guess which list the guard uses.

**Proof.** 15 new assertions (216 → 231). The behavioural one is a real
subprocess run of the generator that leaves the guard byte-for-byte identical.
Beside it sits a static tripwire — every use of the `fs` namespace in the
generator must be a `readFileSync`/`readdirSync` call, with no dynamic import,
`require`, `fs/promises`, `child_process` or `worker_threads` — which catches an
honest regression but is not a sandbox. (Its first version matched `fs.` only
and saw one of the two reads, because the generator puts `fs` and `.readdirSync`
on separate lines; it passed for the wrong reason until it counted every `fs`
token.) And every outcome of the decision is driven through
a new pure `planRegeneration()` (current, CRLF-current, stale, duplicate begin
marker, missing end marker), re-asserting the guard's bytes afterwards. Full
`npm run test:correction-guards` green; the generator reports 29 fingerprints
already current, so no authorised hash moved.

**Scope, stated honestly.** This removes the sanctioned, pre-allowed writer that
this PR itself introduced. It does not make hook files tamper-proof against an
agent that writes and runs its own script, because `Bash` is broadly allowed —
that is a pre-existing, repo-wide property, not something this change created or
can close.

**Docs corrected in the same change**, both flagged by the same review and both
stale from the moment the fingerprint allowance landed:

- `docs/reference/agent-guardrails.md` still told agents these predicates could
  not run verbatim and to ask Mason for a scoped `REAL-DATA-OK` — advice that
  now requests owner authorisation for something already allowed. It states the
  fingerprint allowance, and that the underlying call-detection defect is
  unchanged for every other statement.
- `scripts/db-invariant-sweeps/README.md` told maintainers to add a predicate and
  run it live, with no step authorising its fingerprint — so a new predicate was
  refused despite the documented procedure being followed exactly. The
  authorisation step is now step 5, including the pinned count in the test.
