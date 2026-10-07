## 2026-10-06 — Library updates: lucide-react, pdfjs-dist, and the source-map-js security patch (#883)

Dependabot's minor-and-patch group (#883), brought up to date with `main`, plus one security patch
that the CI audit now requires:

| Package | From | To |
| --- | --- | --- |
| `lucide-react` | 1.51.0 | 1.52.0 |
| `pdfjs-dist` | 6.3.289 | 6.4.299 |
| `source-map-js` (dev, transitive) | 1.2.1 | 1.2.2 |

- **`lucide-react`**: 1.52.0 changes only the `wifi-cog` icon, which the app does not use.
- **`pdfjs-dist`**: used only by `src/lib/documentOCR.ts`. The bulk customer, order, quote and PO imports call it to turn PDF pages into images before OCR.
- **`source-map-js`**: GHSA-68fv-2mgg-jv7q (high, event-loop denial of service, fixed in 1.2.2). It is build and test tooling only, used through vite/postcss, `@tailwindcss/node`, jsdom and vitest coverage, and never ships to the browser. Without this patch, `npm audit --audit-level=high` fails, so every PR's CI fails. The change is lockfile-only.

The lockfile also gains six bundled sub-entries under `@tailwindcss/oxide-wasm32-wasi`. They are optional and wasm32-only, so they install nothing on Windows, Linux or Vercel.

**Proof observed.**
- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run test` all passed: 382 files, 5,459 tests.
- `npm run test:agent-workflows`, `node scripts/verify-deps.mjs --force` and `npm audit --audit-level=high` passed, with 0 vulnerabilities.
- The built `pdf.worker.min-*.mjs` reports `pdfjsVersion = 6.4.299`.
- In a real browser on the local dev server, `pdfjs-dist` was loaded the way `documentOCR.ts` loads it, with the same import and bundled worker URL. It then ran the steps of `pdfToImages()` on a 3-page PDF made with jsPDF: `getDocument`, a 2× viewport, canvas render and JPEG export.
  - All 3 pages rendered at 1190×1683 with drawn content.
  - Text extraction returned every line exactly.
  - The worker loaded from the bundled same-origin file, with no fake-worker fallback.
- Eight lucide icons rendered as SVGs.

**Not verified here.** The full OCR round trip was not run. It needs a signed-in session, and it calls the `process-document` Edge Function and Google Vision, which this update does not change.
