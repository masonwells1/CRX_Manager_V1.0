## 2026-10-07 — dependency: `source-map-js` 1.2.1 → 1.2.2 (GHSA-68fv-2mgg-jv7q)

**Changed**

- `package-lock.json`: `source-map-js`, a build-time dependency (`dev: true`, reached through the CSS/build tooling), moves to the patched 1.2.2. The advisory is a high-severity denial of service when parsing a crafted source map. CI's `npm audit --audit-level=high` step failed on every branch once it was published.
- Only that one version line changes. `npm audit fix --package-lock-only` also re-added optional `@tailwindcss/oxide-wasm32-wasi` sub-entries; those were left out.

**Proof observed**

- On a clean worktree of `origin/main` (6d9e744aa) with only this change: `npm ci` succeeded and installed 1.2.2, `npm audit --audit-level=high` reported 0 vulnerabilities, and `npm run build` succeeded.
