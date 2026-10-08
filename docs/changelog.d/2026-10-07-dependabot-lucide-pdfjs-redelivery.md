## 2026-10-07 — Library updates: lucide-react and pdfjs-dist (re-delivered from #883)

Dependabot PR #883 bumped two libraries. CodeRabbit will not review it, because Dependabot has no
assigned CodeRabbit review seat ("authored by a bot without an assigned CodeRabbit review seat").
The merge gates require CodeRabbit APPROVED on the exact head, so this PR re-applies the same
versions on top of current `main`. #879 did the same for #863.

| Package | From | To |
| --- | --- | --- |
| `lucide-react` | 1.51.0 | 1.52.0 |
| `pdfjs-dist` | 6.3.289 | 6.4.299 |

- **`lucide-react`**: 1.52.0 changes only the `wifi-cog` icon, which the app does not use.
- **`pdfjs-dist`**: used only by `src/lib/documentOCR.ts`. The bulk customer, order, quote and PO imports call it to turn PDF pages into images before OCR.
- `pdfjs-dist` 6.4 also moves its optional `@napi-rs/canvas` dependency from 1.0.2 to 1.0.10. That package is the Node-only canvas, so the browser never loads it.

The lockfile also gains six bundled sub-entries under `@tailwindcss/oxide-wasm32-wasi`. They are optional and wasm32-only, so they install nothing on Windows, Linux or Vercel.

`package.json` and `package-lock.json` are byte-identical to #883's head merged with current `main`.
#884 had already landed the `source-map-js` 1.2.2 security patch, so `main`'s entry is kept and
this PR does not change it.

**Proof observed** on that merged tree.
- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run test` all passed: 382 files, 5,459 tests.
- `npm run test:agent-workflows`, `node scripts/verify-deps.mjs --force` and `npm audit --audit-level=high` passed, with 0 vulnerabilities.
- The built `pdf.worker.min-*.mjs` reports `pdfjsVersion = 6.4.299`.
- In a real browser on the local dev server, `pdfjs-dist` was loaded the way `documentOCR.ts` loads it, with the same import and bundled worker URL. It then ran the steps of `pdfToImages()` on a 3-page PDF made with jsPDF: `getDocument`, a 2× viewport, canvas render and JPEG export.
  - All 3 pages rendered at 1190×1683 with drawn content.
  - Text extraction returned every line exactly.
  - The worker loaded from the bundled same-origin file, with no fake-worker fallback.
- Eight lucide icons rendered as SVGs.
- A Codex (`gpt-6-luna`, xhigh) advisory review of the dependency diff returned CLEAN.

**Not verified here.** The full OCR round trip was not run. It needs a signed-in session, and it calls the `process-document` Edge Function and Google Vision, which this update does not change.
