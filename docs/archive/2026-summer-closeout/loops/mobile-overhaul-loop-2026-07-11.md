# Mobile Overhaul Loop — 2026-07-11

## Harness slots
- **Driver:** Codex CLI is the primary builder (`codex exec --cd C:/CRX_UIOverhaul -m gpt-5.6-terra|gpt-5.6-sol|gpt-5.6-luna --sandbox workspace-write`). Claude orchestrates, reviews, runs gates, commits. Fallback (Mason-approved): if Codex hits credit/quota failure, Sonnet subagents build under the same contract — do not stop the loop.
- **Granularity:** one unit = one committed, gate-green change set (shell nav, one page family's mobile cards, PWA polish item).
- **Worktree:** C:\CRX_UIOverhaul, branch `feat/mobile-overhaul-2026-07` (from origin/main @e4f125da). No other branch, no other tree.
- **Definition of done (per unit):** typecheck + lint + full vitest + production build all green, PLUS a rendered proof at mobile width (component test at narrow viewport or dev-server screenshot at 375px). Ledger row updated with PROOF line.
- **Delivery gate:** commit each green unit to the branch. NEVER push, deploy, migrate, touch live data, or edit files outside this worktree. Frontend-only — zero files under supabase/migrations/. In the morning Mason says "push it".

## Mission
Make CRX Manager genuinely usable on a phone. Priorities from Mason: **Jobs & Dispatch** and **Inventory & Receiving** get the deep treatment; app shell first; PWA polish last.

## Worklist
### Phase M1 — App shell (gpt-5.6-terra)
- M1.1 Mobile nav: below `md`, hide desktop Sidebar; add a bottom navigation bar (Today, Jobs, Inventory, Field Invoices, More) + slide-out drawer for the full menu (reuse Sidebar items; ARIA + focus trap). Safe-area-inset padding for notched phones.
- M1.2 TopBar compact mode on mobile; shared Tabs component becomes horizontally scrollable with edge-fade at narrow widths; PageHeader stacks actions below title on mobile.

### Phase M2 — Priority screens (gpt-5.6-terra / sol)
- M2.1 Jobs & Dispatch: job list/dispatch tables become stacked tappable cards below `md` (key fields: customer, field, product, status, date); touch targets ≥44px; filters collapse into a sheet.
- M2.2 Inventory & Receiving: inventory position + receiving hub/log tables → mobile cards; Quick Receive form single-column, large inputs, numeric keyboards (`inputMode`).
- M2.3 Today/Office Cockpit + Field Invoices: lighter pass — queues/KPI strip stack cleanly at 375px, no horizontal scroll, tables in overflow containers or card fallback.

### Phase M3 — PWA polish (gpt-5.6-luna)
- M3.1 Modals full-screen below `md`; toasts positioned clear of bottom nav.
- M3.2 Verify manifest/display/theme-color/orientation; make the UpdatePrompt prominent so stale-version confusion can't recur; document install-to-home-screen steps for Mason in the ledger.

## Build rules for Codex prompts
- Tailwind responsive utilities only (mobile-first); no new dependencies; no DB/RPC changes; keep desktop rendering pixel-identical (mobile classes additive).
- Shared primitives live in src/components/ui/; card-list pattern should be one reusable component, not copy-paste.
- Each unit self-reviews (Codex reviews its own diff) before handing to Claude.
- Parallel Codex agents allowed only with strictly disjoint file lists; one combined gate run after they land.
- Codex stall watchdog: no rollout file + ~0.1s CPU + no edits within 4 min → kill and re-dispatch.

## Parked-question policy
Any decision needing Mason: write it in the ledger under "Parked questions", pick the reversible default, keep moving.
