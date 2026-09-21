## 2026-09-21 — second Sol pass: the Sol-gated category list had dropped "auth"

Continues `2026-09-21-review-tier-sol-gate-fixes.md`. The second `gpt-5.6-sol`/high pass returned
`CODEX_PROOF_VERDICT: BLOCKERS` with one HIGH finding in two halves.

### Fixed — the part this change introduced

`AGENTS.md` names **auth** (and Edge Functions and "other business-critical") in the set that
requires the one Sol pass, but the new operational docs restated a narrower list. An agent following
`codex-review` Step 3B, the gate table, `codex-cross-review`, the `ship` Codex-worthy check, or the
decision-log entry could therefore treat an auth-only change as ordinary and skip Sol. All five now
state the full `AGENTS.md` set, and Step 3B / `ship` say explicitly that the decision comes from what
the diff does — not from whether the push guard flagged it.

### Deliberately NOT fixed here — recorded as an open gap

The push guard's deterministic risky detector (the risky-path and content patterns in the shared
push-guard library) does not recognize general auth surfaces: a login-redirect edit in
`src/pages/Login.tsx` matches neither pattern set, so the push goes through without demanding the
Sol proof. This is **pre-existing** — this change does not touch the detector — and closing it is a
guard-code change with its own review, which Mason kept out of scope for this PR (and his 2026-09-10
standing preference is no new guards unless the risk is irreversible). The docs above now make the
limitation explicit so the gap cannot be read as "Sol not required". Owner: Mason's call on whether
to widen the detector.
