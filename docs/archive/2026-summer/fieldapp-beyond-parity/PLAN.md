# CRX Field-App — Beyond-Parity Build Loop — Plan (owner-facing)

**Date drafted:** 2026-06-29
**Status:** SCAFFOLDED — not started. **Kicks off only after Mason ships the ChemMan-parity rebuild to the live site.**
**Owner:** Mason (zero coding experience — every status update stays plain-English).
**Source of the ideas:** `C:\Users\mason\Documents\CRX-FieldApp-Beyond-Parity-Opportunity-Map.md` (the ranked opportunity map). This loop builds the **six features Mason chose** from that map.

---

## What this loop builds (the six features Mason picked)

1. **Office Cockpit** — one screen showing the office only what's stuck or wrong (unbilled jobs, ready-to-post invoices, wrong-field flags, weather-blocked jobs, expiring licenses, overdue money). Replaces ChemMan's seven-report ritual.
2. **Auto-Invoice on Completion** — the moment a job is marked done, the bill is auto-*drafted* (split by customer, priced) into a "ready to post" queue. The office reviews and clicks post. **Never auto-posts** — money always needs a human click.
3. **AI Label-Data Backfill** — uses your existing photo/vision AI to draft the safety-label data (re-entry interval, pre-harvest interval, signal word, EPA #, max legal rate) for all ~604 products, for a quick human review-and-approve. This is the *enabler* that unblocks the compliance features.
4. **Wrong-Field / Wrong-Rate / Double-Bill Watchdog** — an always-on check that flags the few records that look wrong before they become a bad bill or a safety problem.
5. **Label-Rate Guardrails** — compares an entered spray rate to the legal label maximum and flags/blocks an over-label rate before the chemical leaves the warehouse; auto-shows re-entry / pre-harvest times.
6. **Grower Portal + "Your Field Was Sprayed" proof notification** — a customer-facing login where a grower sees their fields, applications, bills, and proof; plus an auto-drafted "your field was sprayed" message (map + weather + products + safe-re-entry timing) the office sends with one tap.

---

## The build is broken into 10 stages (sections), in dependency order

Each stage is built by a fresh subagent, **Codex-reviewed before moving on**, and proven to actually run — exactly like the parity loop. Full testable specs live in `BACKLOG.json`.

### Phase 1 — Enablers & safeguards (build first)
- **§1 AI Label-Data Backfill** *(enabler — unblocks §5)* — the tool + the drafted values + a review screen. **Loading values onto your live products is an owner task** you approve at the gate; the loop builds the tool and drafts the values against a throwaway database.
- **§2 Wrong-Field / Wrong-Rate / Double-Bill Watchdog** — the background checks + a standing exceptions list (which feeds the Cockpit).

### Phase 2 — Office command center (your #1 priority)
- **§3 Office Cockpit** — the exception dashboard (pulls in §2's flags).
- **§4 Auto-Invoice on Completion → review/post queue** — **MONEY-sensitive; extra review.** Auto-*draft* only, never auto-post.

### Phase 3 — Compliance guardrail
- **§5 Label-Rate Guardrails** — needs §1's label data to exist first.

### Phase 4 — Customer-facing (sequenced last on purpose)
- **§6 "Your Field Was Sprayed" Proof Notification** — office-approved sends (not silent, while you stay internal-only).
- **§7 Grower Portal — Login & security scoping** — **SECURITY-CRITICAL; the biggest, riskiest piece.** New outside-facing customer logins; each grower locked to only their own data (proven as a grower, with a "grower A can't see grower B" test).
- **§8 Grower Portal — My Fields & application history**
- **§9 Grower Portal — My Invoices & balance**
- **§10 Grower Portal — Self-serve compliance records**

> **Why this order:** §1 must come first because §5 (and several flags) need the label data. The office-time features (§3/§4) come early because that's your stated #1 goal. The grower portal is **last** because it's the largest build, it adds a brand-new outside-facing security surface, and it's far more convincing once the internal proof data is solid — which matches what you said earlier about doing the portal after the internal side.

---

## One open decision you can change before kickoff (no rush)

You earlier wanted the grower portal *after* the internal work, then added it to this batch. The plan's **default** is to still build the four internal features first, then the two customer-facing ones (§6, §7–§10). If you'd rather **drop the portal from this round**, or **do it sooner**, just say so before kickoff and I'll re-order the stages — it's a one-line change to the loop.

---

## How the loop runs (per stage) — fully hands-off until the end

For each stage, on its own, with no need to babysit it:
1. **Build** it on the loop branch.
2. **Prove it actually runs** — open the page / do the action / watch the result (not "tests pass").
3. **Codex reviews it** (your second AI) — *this is the "Codex between each stage" you asked for.* Every High/Medium finding is fixed (max 3 rounds); Low findings are parked in a list you see at the end.
4. **Record** the result and move to the next stage.

It does **not** stop between stages. The money stage (§4) and the portal stages (§7–§10) get **extra review** (a money/security lens + your RLS security reviewer), but still touch nothing live.

## The safety gates (what protects your money & data)
- **Never touches your live site or live database during the run.** All database changes are tested on a **throwaway copy** only.
- **Production happens once, at the very end, only with your explicit go-ahead** — I'll walk you through every database change in plain English first, in timestamp order, before anything is applied.
- **Auto-invoice auto-*drafts* only — never auto-posts.** Money always needs your click.
- **Any money rule I don't know is built OFF by default and left blank** — the loop never invents a billing rule.
- **The grower portal's customer logins are outside-facing** — they get a dedicated security review and your explicit sign-off before going live.
- **Customer emails ("your field was sprayed") are office-approved sends, not silent automation**, while you stay internal-only.
- **Edge-function changes** (e.g. a new email type for the notification) are *prepared* but their deploy is **owner-gated** — needs you.

---

## What kicks it off
1. **You ship the ChemMan-parity rebuild to your live site** (merge `feat/fieldapp-parity` → `main` → live). These six build *on top of* that work.
2. The loop's local throwaway database is refreshed so it includes the parity migrations.
3. **You say "start the beyond-parity loop"** → I create a fresh worktree/branch off the then-current live `main` and run the loop from a CRX session (so your safety hooks + Codex gate fire).

See `KICKOFF.md` for the exact first action and the resume playbook. The machine-readable spec is `BACKLOG.json`; live progress is tracked in `PROGRESS.json` → `LEDGER.md`.
