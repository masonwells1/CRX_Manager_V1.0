## 2026-09-02 - Bump `fast-uri` past the HIGH advisory that turned every PR red

`npm audit --audit-level=high` became a hard CI gate on 2026-09-02 (#557). Later the same day
four advisories published against `fast-uri` `3.0.0 - 3.1.5` (GHSA-5jgf-p345-68v8,
GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp — host confusion and SSRF via
IDN/IPv6/percent-decoding normalization). `main` had already gone green at 15:40 UTC; the first
run to fail was a PR at 16:28 UTC.

This is not a PR-specific failure. `main`'s own checkout fails the same audit — verified by
running `npm audit --audit-level=high` against `main` at `91353629f`, which reports the same
HIGH. Every open pull request that merges current `main` inherits it, and the failure lands on
the `Check for vulnerable dependencies` step, which runs BEFORE lint/typecheck/test/build — so
an affected PR shows a red `Lint, Type Check, Test, Build` row while none of those four actually
ran.

The path is `vite-plugin-pwa -> workbox-build -> ajv@8.18.0 -> fast-uri`. `ajv` asks for
`^3.0.1` and the patched `3.1.7` sits inside that range, so this is a lockfile-only bump with no
manifest change and no resolution change anywhere else: three lines, version/resolved/integrity.
`npm audit fix --package-lock-only` produces exactly this and then reports `found 0
vulnerabilities`.

`--package-lock-only` is deliberate. A plain `npm audit fix` reinstalls into `node_modules`, and
in this repo the per-worktree `node_modules` is a junction to the root install — an install
through it severs the junction.
