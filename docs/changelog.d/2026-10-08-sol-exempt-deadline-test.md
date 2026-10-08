## 2026-10-08 - Sol exemption: a time limit reached inside it denies (Luna round 3, test only)

Luna's third review of the documentation-only Sol exemption (see
`2026-10-07-sol-exempt-docs-only.md`) said its two extra GitHub calls could outlive the hook. A hook
killed mid-call says nothing, and saying nothing allows. Refuted by design: both guards make those
calls through their budgeted `gh`. It refuses any call that could end after the deadline, and the
guard then denies for time. The Claude guard also runs under `merge-guard-launcher.mjs`, which
denies a merge if the guard is still running. No code changed.

### Proof observed

- New case in `.codex/hooks/production-action-guard.test.mjs`. A slow comparison uses up the clock
  inside the exemption. The file-kind lookup after it is never started, and the merge is denied
  with the time-limit reason. The suite passes.
