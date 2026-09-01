## 2026-08-31 — CI claims no browser coverage, and a heading scan is not a content scan

Eighth Codex pass on PR #529. Two P2 findings, both verified, both mine.

### 1. This PR introduced a documentation lie while fixing documentation lies

The rewritten CI section of `DEPLOYMENT.md` told the reader that `ci.yml` runs "an E2E smoke run".
It does not. `e2e-smoke` is pinned `if: false` in `.github/workflows/ci.yml`, so it is **skipped on
every pull request and every push**. The job's own comment carries the checklist for re-enabling it,
ending in "change `if: false` back to `if: github.event_name == 'push'`", and records the blocker:
the E2E suite still points at production endpoints and the safety guard in
`tests/e2e/utils/safety-guards.ts` refuses to run against them.

The original text in this file was wrong by being stale — it described a `test.yml` that never
existed. The replacement was wrong by being confidently specific, listing a job that exists in the
YAML but never executes, which is the harder kind to catch. A release reviewer reading it would take
a green CI as evidence a UI flow was exercised.

`DEPLOYMENT.md` now states that `e2e-smoke` is disabled, that **CI currently provides no browser
coverage**, and what the blocker is.

### 2. The archive scan matched headings, not content

`docs/handoffs/2026-07-18-gauntlet-2-6-leftover.md` is headed "completed/superseded" and was
archived. It carries unfinished UX follow-ups H3, H4 and H5, and H5 is verifiable in current source:
`src/components/integrity/IntegrityCleanupPanel.tsx` renders the "Create draft invoice" button
unconditionally for every unbilled row, so an admin backfilling an invoice on a split-billing order
still receives a raw `ORDER_NEEDS_SPLIT_BILLING` error. Neither that code nor
`ORDER_RESTORE_NOT_SUPPORTED` appears in `TODO.md` or `docs/manual/KNOWN_ISSUES.md`.

It is restored to `docs/handoffs/`. The archived set is 22; the kept-in-place set is 8.

The scan run after the previous round's finding matched **section headings** — `## Still open`,
`## Remaining` and similar. This file's open items are bullets under a closure narrative, so the
scan passed it. Calling that pass "systematic" was overstated: it closed the shape of the previous
failure, not the failure itself, which is that a document's own summary line is not evidence about
its contents.

The file does label H3/H4/H5 "UX polish, not required for the fix", which is a real mitigation and
the reason this is a P2 rather than worse. It is still unfinished work with a user-visible raw error
behind it, and the archive is defined for work that is fully shipped or fully dispositioned.

### Proof observed

- `if: false` read at its line in `ci.yml`, together with the re-enable checklist comment.
- The unconditional `Create draft invoice` button read in `IntegrityCleanupPanel.tsx`.
- `grep` for `ORDER_NEEDS_SPLIT_BILLING` and `ORDER_RESTORE_NOT_SUPPORTED` across `TODO.md` and
  `KNOWN_ISSUES.md` returns nothing.
- `npm run check:docs` passes.
