## 2026-10-03 — upgrade Tailwind CSS 3.4.19 → 4.3.3 (clears the braces audit block)

**Why.** From 2026-10-03 every PR's "Lint, Type Check, Test, Build" failed `npm audit --audit-level=high`
on `braces` GHSA-vfj7-8cjw-p6xm (stack-exhaustion DoS, range `<= 3.0.3`, no patched version). It
reached the app only through `tailwindcss@3.4.19` → `chokidar` / `micromatch` → `braces`; 3.4.19 is the
last Tailwind 3 release, so the only fix was Tailwind 4. Build-time tooling only — nothing reached the
browser bundle. `npm audit` now reports 0 vulnerabilities.

**What changed.**
- `tailwindcss` 4.3.3 plus `@tailwindcss/vite` (added to `vite.config.ts`); `autoprefixer` and the
  direct `postcss` dependency removed; `tailwind.config.js` and `postcss.config.js` deleted.
- `src/index.css`: `@import 'tailwindcss' source(none)` with `@source` limited to `index.html` and
  `src/` (Tailwind 3's `content`); the old config's brand colours, fonts, card shadows and
  `darkMode: 'class'` moved into `@theme` / `@custom-variant`; and a commented compatibility block that
  pins what Tailwind 4 changed back to the 3.4 rendering:
  - the Tailwind 3 hex palette for every colour family the app uses;
  - the shifted `shadow`/`rounded`/`blur`/`drop-shadow` scale names, and bare `ring` width and colour;
  - `space-x/y-*` and `divide-*` back on Tailwind 3's "every visible child after the first" rule
    (Tailwind 4's "every child before the last" left a 24px hole on the new field-application invoice
    form, whose last child is a `display: contents` fieldset);
  - preflight: gray-200 default borders, gray-400 placeholders, button pointer cursor, hover on touch
    devices, browser-default backgrounds on form fields, corner radius on controls, padding on
    `option` and table cells, and browser-default date/time, search and "Choose file" button styling.
- Class changes Tailwind 4 requires: `flex-shrink-0` → `shrink-0` (162 uses), `bg-black bg-opacity-50`
  → `bg-black/50`; `grid-cols-[1fr,100px,100px]` → `grid-cols-[1fr_100px_100px]` on the purchase-order
  line items (Tailwind 4 passes commas through, producing invalid CSS that collapsed the grid); and
  `hover:file:` → `file:hover:` on three bulk-import file pickers (Tailwind 4 reads stacked variants
  left to right, so the old order turned the button green when any part of the input was hovered).
- `docs/workflows/UI_PATTERNS.md` records where the theme lives, which names keep their Tailwind 3
  meaning, and the arbitrary-value and variant-order rules.

**Proof.**
- *Every class, by computed style.* Headless Chromium applied each of the 874 distinct base utilities
  found in `src/` (1,243 class names with variants) under both builds and compared every computed
  property plus element boxes, normalising colour notation, empty shadow layers and transform notation.
  Remaining differences: `outline-none` differs only in forced-colours mode (see below); `hidden`/`contents` have
  no box; and `border-3` on the Payment Allocation loading spinner, a no-op in 3.x (so the spinner never
  showed), now draws its intended 3px ring.
- *Every HTML tag the app uses* (62 tags and input types, in context: cells in a table, options in a
  select, legend in a fieldset) computes identically.
- *Every page, by pixels.* Both builds were served from disk with an entirely mocked backend (a fake
  signed-in admin, empty data; no request left the machine) and all 94 routes were screenshotted full-page
  at 1440px and 390px. The final sweep result is recorded on the PR. Before the last fixes it surfaced the
  field-invoice gap and the dropdown, table-cell and file-button differences above.
- Keyboard focus on a workspace tab, an input and a button renders the same outline and ring.
- Signed-out screens (`/login`, `/forgot-password`, `/reset-password`) are pixel-identical at 1440,
  820 and 390px.
- A compliance review found the purchase-order grid and file-picker hover regressions; both are fixed.
- Typecheck, lint, the full suite (382 files), build, `verify-deps` and `npm audit --audit-level=high` pass.

**Follow-up (separate PR).** Tailwind 3's `outline-none` hid focus outlines with a transparent outline,
which Windows high-contrast (forced-colours) mode still draws; Tailwind 4's `outline-none` removes it, and
its name for the old behaviour is `outline-hidden`. The 406 uses across 115 files are renamed in a
follow-up PR so this one stays under CodeRabbit's 150-file limit. Until it lands, those elements show
no keyboard-focus indicator in Windows high-contrast mode (that mode hides the `focus:ring-*` box
shadows they rely on otherwise). Normal display is unaffected.

**Known residual.** On a few form pages the text inside `<select>` dropdowns differs at single-pixel
anti-aliasing level, with no difference in any computed style, size or position. It is indistinguishable
at 4x zoom.

**Not verified here.** Rendering on browsers older than Tailwind 4's floor (Safari/iOS 16.4, Chrome 111,
Firefox 128). Pages with real data were not compared; the mocked sweep renders empty states.
