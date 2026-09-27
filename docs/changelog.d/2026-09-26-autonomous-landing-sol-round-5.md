## 2026-09-26 - autonomous landing: fix a syntax error in the CodeRabbit gate's embedded script

**Sol HIGH, round 5 on PR #804.** The `checkSettleAttempts` comment added to
`.github/workflows/coderabbit-final-review.yml` used YAML-style `#` lines inside the `github-script`
JavaScript block. JavaScript rejects them, so the trusted review gate would not have run at all once
on `main` — while the new merge and apply gates require CodeRabbit's approval. The two lines are now
`//` comments.

New test in `.github/scripts/coderabbit-final-review.test.cjs` compiles the workflow's `script: |`
block exactly as `actions/github-script` does (the body of an async function) and refuses `#` lines
inside it. Checked both ways: the committed broken file reports "Invalid or unexpected token", the
fixed file compiles.
