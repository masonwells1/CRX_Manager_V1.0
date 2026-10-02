## 2026-10-01 — dompurify 3.4.13 → 3.4.16 (lockfile only; replaces Dependabot #852)

`dompurify` is a transitive, optional dependency of `jspdf@4.2.1`. jspdf lazily imports it
only inside `jsPDF.html()`, which `src/` never calls, so no app screen runs it today. The bump
clears the low-severity advisory npm reported against dompurify 3.4.13–3.4.15. Only the
`node_modules/dompurify` entry in `package-lock.json` changes (version, resolved URL, integrity).

Delivered on a fresh PR because the CodeRabbit final-review gate refused Dependabot's #852:
its immutable candidate birth record was missing, and the gate's documented remedy is a fresh
delivery PR at the same head. The dependency commit is Dependabot's own, unchanged.

**Proof observed (head bedbd1a51, on main 653addd6b):** `npm ci`, `npm audit --audit-level=high`
(0 vulnerabilities, main reports 1 low), typecheck, lint, build, `npm test` (381 files, 5452
passed, 123 skipped, 0 failed), `npm run test:agent-workflows`, `node scripts/verify-deps.mjs
--force` all pass. `dist/assets/purify.es-*.js` contains 3.4.16. In the local dev server, the
module jspdf imports reported `DOMPurify.version === "3.4.16"`; `sanitize()` stripped an
`onerror` handler, a `<script>` and a `javascript:` href while keeping the text; and
`jsPDF.html()` on that payload produced a one-page PDF without running any of it.

**Not verified:** no production screen exercises DOMPurify, so there is no in-app user flow to
click through; the proof above calls jspdf's `html()` path directly.
