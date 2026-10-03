## 2026-10-03 — upgrade Tailwind CSS 3.4.19 → 4.3.3 (clears the braces audit block)

**Why.** From 2026-10-03 every PR's "Lint, Type Check, Test, Build" failed `npm audit --audit-level=high`
on `braces` GHSA-vfj7-8cjw-p6xm (stack-exhaustion DoS, range `<= 3.0.3`, no patched version). It
reached the app only through `tailwindcss@3.4.19` → `chokidar` / `micromatch` → `braces`; 3.4.19 is the
last Tailwind 3 release, so the only fix was Tailwind 4. Build-time tooling only — nothing reached the
browser bundle. `npm audit` now reports 0 vulnerabilities.

**What changed.**
- `tailwindcss` 4.3.3 plus `@tailwindcss/vite` (added to `vite.config.ts`); `autoprefixer` and the
  direct `postcss` dependency removed; `tailwind.config.js` and `postcss.config.js` deleted.
- `src/index.css`: `@import 'tailwindcss'`, the old config's brand colours, fonts, card shadows and
  `darkMode: 'class'` moved into `@theme` / `@custom-variant`, and a compatibility block that pins
  everything Tailwind 4 changed back to the 3.4 rendering: the Tailwind 3 hex palette for every family
  the app uses, the shifted `shadow`/`rounded`/`blur`/`drop-shadow` scale names, bare `ring` width and
  colour, gray-200 default border colour, gray-400 placeholders, button pointer cursor, hover on touch
  devices, browser-default backgrounds on form fields, and browser-default date/time, search and
  file-button styling.
- Class renames Tailwind 4 requires, mechanical and render-identical: `flex-shrink-0` → `shrink-0`
  (162 uses), `outline-none` → `outline-hidden` (Tailwind 4's name for the 3.x behaviour), and one
  `bg-black bg-opacity-50` → `bg-black/50`.
- `docs/workflows/UI_PATTERNS.md` records where the theme lives and which names are pinned to their
  Tailwind 3 meaning.

**Proof.** A headless-Chromium comparison built both versions' CSS, applied each of the 875 distinct
base utilities found in `src/` (1,243 class names with variants) to a test element with two children,
and compared every computed property plus the element boxes, after normalising colour notation, empty
shadow layers and transform notation. Every form and text element (23 input types and tags) now
computes identically. Remaining differences, all reviewed: `space-x/y-*` and `divide-*` attach the gap
or rule to the other sibling (same rendered position); `outline-hidden` differs only in forced-colours
mode; `hidden`/`contents` have no box; and `border-3` on the Payment Allocation loading spinner, a
no-op in 3.x (so the spinner never showed), now draws its intended 3px ring. Keyboard focus on a
workspace tab, an input and a button renders the same outline and ring in both. Typecheck, lint, the
full suite (382 files), build, `verify-deps` and `npm audit --audit-level=high` pass.

**Not verified here.** Rendering on browsers older than Tailwind 4's floor (Safari 16.4, Chrome 111,
Firefox 128); an older device would show an unstyled app. Signed-in pages were compared by screenshot
on the PR preview, recorded on the PR.
