Run a quick pre-commit check on the CRX Manager project. This is a fast version of the full audit — just the essentials.

Do these checks in order and report results:

1. `npm run lint` — must have 0 errors
2. `npm run build` — must succeed
3. `npm run test -- --reporter=verbose 2>&1 | tail -15` — must have 0 failures
4. Quick doc drift: compare `grep -c 'lazy(' src/App.tsx` to the page count in CLAUDE.md

Report a one-line pass/fail for each, then a final verdict: "Ready to commit" or "Fix X issues first".

Keep the output short — this is meant to be a quick check, not a full audit.
