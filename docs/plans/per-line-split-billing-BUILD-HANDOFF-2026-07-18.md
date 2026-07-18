# Per-Line Split Billing — Morning Handoff (build run 2026-07-18)

Plain-English summary of the overnight autonomous build. **Nothing went live.** Everything below is
committed on the branch `claude/per-line-split-billing-build` and is waiting for you.

---

## The one-paragraph version

The custom split-billing feature is now **fully built and proven in code**, but **turned OFF and not
connected to your live system yet** — on purpose. The "money engine" (the database function that splits a
field-application bill across multiple growers penny-for-penny) was tested against a real copy of your
database and passed every hard case. The screens (a new split-billing editor, plus the $0-invoice
"don't email it" rule and a lock so split lines can't be hand-edited) are built and compile cleanly, but
they stay hidden behind an OFF switch so **your app behaves exactly as it does today**. To actually turn
it on, you do a short sequence (below) — and that's deliberately your call, not something done overnight.

---

## What "done" means here (and what's NOT done)

**DONE and proven:**
- The database changes (3 migration files) are **written and rollback-proven** against your live database
  (created inside a transaction, every rule checked, then rolled back — nothing was saved). Proven cases:
  even 50/50 splits, a 1¢ bill split in half staying 1¢ (not rounding up to 2¢), returns/negatives
  splitting correctly, a $0 grower still getting a recorded-but-not-emailed invoice, posting + the
  freeze-after-post lock, "don't double-charge on a retry," and rejecting the incompatible grower-share
  ("Mode A") fields. **A re-save after a post/unpost cycle was also proven** (a bug found in review and
  fixed).
- The screens are built, **type-check and build cleanly**, and are wired in behind the OFF switch.

**NOT done (on purpose — these are your steps):**
1. **Nothing is applied to the live database.** The 3 migrations are "parked."
2. **Nothing is pushed, merged, or deployed.** It's all local commits on the branch.
3. **The feature flag is OFF.** No screen or behavior changes for anyone yet.
4. **The Codex second-opinion review did NOT run** — the Codex account hit its usage limit (resets
   ~Jul 22). This is a required check before go-live (see below). An in-house adversarial review by a
   second Opus model DID run and passed ("ship to park").

---

## The exact steps to go live (in order, when you're ready)

1. **Run one normal field-application billing cycle first** (the spec requires this baseline before the
   split feature is trusted — prove the existing engine end-to-end on a real bill).
2. **Get the Codex money/RLS review** on the save-RPC migration (credits reset ~Jul 22). Fix anything it
   flags. *This is the one required gate that could not run overnight.* (R8 changed this migration again on
   2026-07-18, so Codex should review the current version.)
3. **~~Do the R8 wiring~~ — DONE 2026-07-18.** The server now resolves chemical prices itself
   (manual → quote → tier) and converts the applied amount from the rate unit to the product's sold unit.
   BUT it needs **one billing-rule decision from you first** — see "⚠️ DECIDE FIRST" just below.
4. **Apply the 3 migrations to the live database, in order:**
   `20260718010000` (tables) → `20260718020000` (calculator) → `20260718030000` (save/post RPC).
   (These need your explicit go-ahead — live DB changes are always your call.)
5. **Add `send_disposition` to the field-invoice list/detail queries** so the "don't email $0 invoices"
   rule actually fires once live (see F2 below) — otherwise the gate is a silent no-op.
6. **Flip the flag ON** (`per_line_split_billing_enabled` = `'true'` in `app_settings`).
7. Try it on a real multi-grower field application and confirm the split invoices look right before
   sending anything.

---

## ⚠️ DECIDE FIRST — how should a split line be priced when co-owners are on different price tiers?

This is the one **money decision** the R8 wiring surfaced. It only matters when the growers who share a
field are on **different price tiers** (tier 1 vs tier 3, etc.). It does **not** affect the penny-exact
math — both options are exact — only **which price** a co-owner is charged. Nothing is live; pick before
you flip the flag on.

**What I built (Option A — "one list price per line"):** the whole chemical line gets ONE price — the tier
price of the field's **majority owner** — and that line is split by ownership %. Anyone who should pay a
different price is adjusted per-person by hand in the draft.

**The alternative (Option B — "each grower keeps their own tier"):** each co-owner's share is priced at
**their own** tier automatically — which is exactly what your **current** (non-split) field-app billing
does today.

**Concrete example** — field 55% owned by grower A (tier 1, product $100/gal) and 45% by grower B (tier 3,
product $130/gal), 2 gallons applied:
- **Today / Option B:** A pays 1.1 gal × $100 = **$110**, B pays 0.9 gal × $130 = **$117** → group **$227**.
- **Option A (what's built):** whole line at A's $100/gal → A **$110**, B **$90** → group **$200**. B is
  charged **$27 less** because their tier-3 price is not used.

**My recommendation: Option B** (each grower keeps their own tier). It matches what your app already does,
so no customer's price silently changes, and the original spec said "don't flatten the existing per-customer
tier pricing." Option A is simpler and fine **if** you actually want one negotiated price per line with
manual per-person tweaks. If you choose B, it's a small, contained follow-up to the chemical code before
go-live (the penny math, conversion, quote/manual paths, and the whole rest of the feature stay exactly as
built and proven). **Tell me A or B and I'll finish it accordingly.**

(Two smaller notes from the same review, both non-blocking: the tier anchor reads the field's *default*
ownership even if this particular line is hand-split differently — a per-person override covers it; and a
chemical *return/credit* (negative quantity) can't go through the split screen yet — flat credits can. Both
are documented and safe to leave for now.)

---

## What was built (for the record)

**Database (parked migrations):**
- `20260718010000` — 4 new tables + 3 additive columns + a freeze-after-post trigger (Phase 2, prior run).
- `20260718020000` — the penny-exact split calculator, 3 pure functions (Phase 3, prior run).
- `20260718030000` — **NEW this run:** the save/post RPC. Resolves who-pays-what (job snapshot → field
  default → owner), builds one draft invoice per grower with the exact split, keeps a compatibility
  summary row for statements, marks $0 invoices "don't send," and copies the split to an append-only
  history when posted. Posting reuses your existing `post_invoice_group` unchanged.

**Screens (all behind the OFF flag):**
- `src/pages/FieldAppSplitInvoiceEditor.tsx` — the new split-billing editor (pick fields/lines, see the
  default split, adjust %/price per grower, Save Draft → see the exact per-grower amounts from the
  server, then Post). Reachable at `/split-billing/new` only when the flag is ON.
- Email rule: a $0 "suppressed" split invoice is never emailed, wired into all 5 places invoices get
  emailed. (A paid-in-full $0 invoice is still emailable — the rule keys on the server's
  `send_disposition`, not on the balance.)
- InvoiceDetail: quantity/price/remove are locked for any line that came from the split engine.
- `src/lib/splitBillingSetting.ts` — the OFF-by-default flag helper.

---

## Reviews run this session

- **RLS/security review:** clean except one MED — the resolver needed an admin/sales-rep guard — **fixed**.
- **Migration-drift review:** clean (never writes the generated balance column; column names/types all match).
- **Types review:** clean (the TypeScript types match the new tables exactly).
- **Opus adversarial review:** verdict **SHIP-TO-PARK**. Found one HIGH (F1, **fixed**) + two go-live notes (F2/F3).
- **Compliance review (frontend):** clean except one HIGH — the editor parsed dollar amounts with `parseFloat`
  instead of the canonical safe parser (would mis-handle scientific notation / negatives) — **fixed** (now
  uses `parseDollarsToCents`).
- **Codex money/RLS review:** **could not run** (account usage limit; resets ~Jul 22). Required before go-live.

**R8 addendum (2026-07-18 build run):** the server-side chemical-pricing change got its own pass —
rls-security review **clean** (confirmed the new internal-only helper has no RLS-bypass surface),
compliance review **clean** (money-as-cents, no float, no generated-column write), migration-drift review,
and an Opus **adversarial** review → **SHIP-TO-PARK** (no math/rounding/unit bug; its one flagged item is the
Option-A-vs-B pricing-rule decision above). Re-proven in the live DB by rollback, **13/13** cases.
Codex still pending (~Jul 22) and should see this newer version.

## Known scope gaps to close before go-live (tracked)

- **R8 — DONE 2026-07-18.** Chemical base price is now resolved **server-side** (manual override → customer
  quote for the field → product tier price) by a new `resolve_field_app_chemical_price()` helper, and the
  applied amount is converted from the rate unit to the product's sold unit via the existing
  `field_app_priced_quantity()` (the same 128× guard your live billing uses). The screen now defaults to
  "price resolved at save" with an optional **Override price** checkbox. Proven end-to-end in the live DB
  (rollback, 13/13 cases incl. tier, quote-beats-tier, oz→gal conversion, unconvertible-unit rejection).
  **Open item = the pricing-rule decision above (Option A vs B).** Also: `resolve_field_app_chemical_price`
  is a deliberate *parallel copy* of the live field-app price precedence (documented in the migration header)
  — if the live precedence ever changes, update both.
- **F2 (adversarial, MED):** the "don't email $0" rule can only fire if the invoice-list/detail queries
  actually SELECT the `send_disposition` column. They don't yet (the column isn't live). Add it to those
  queries at go-live (step 5) or the gate silently does nothing.
- **F3 (adversarial, LOW):** InvoiceDetail still lets you *add* a brand-new manual line to a split invoice
  (the lock only covers editing/removing existing split lines). Close this when the editor is the only way
  split invoices are made, or add an "add line" guard for split invoices.
- **Test-registration cleanup (do at apply-time):** because the editor commits a caller of the two
  not-yet-live RPCs, two guard tests were satisfied by pre-registering `save_field_app_split_invoice` +
  `resolve_line_split_vector` in the `rpcFixtureLiveDiff` live-pg_proc fixture (a documented "+2 parked"
  note). Once migration `20260718030000` is applied live, regenerate that snapshot from the real live DB
  so the fixture reflects reality again (and re-run `npm run test`). Similarly the new page/route are
  registered in `pagePermissions.ts` and the smoke inventory — those stay.

---

## Where the code is

Branch `claude/per-line-split-billing-build` (local, not pushed). Full technical detail:
`docs/plans/per-line-split-billing-RPC-DESIGN-2026-07-17.md`, the spec
`docs/plans/per-line-item-split-billing-spec-2026-07-17.md`, and the readiness report
`docs/plans/per-line-split-billing-READINESS-2026-07-17.md`.
