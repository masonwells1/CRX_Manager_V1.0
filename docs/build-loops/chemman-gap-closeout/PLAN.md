# CRX Field-App — ChemMan Gap-Closeout Build Loop — Plan (owner-facing)

**Date drafted:** 2026-06-30
**Status:** SCAFFOLDED → building. Runs on branch `feat/chemman-gap-closeout` (based on `feat/fieldapp-beyond-parity`).
**Owner:** Mason (zero coding experience — every status update stays plain-English).

---

## Why this loop exists (in plain English)

ChemMan is the competitor field-application software we've been matching feature-for-feature. A careful re-check on 2026-06-30 found that **only two small things** are still missing or half-finished on the field-application invoice. **Everything else** from the ChemMan comparison — mass-editing jobs, a printed/dispatched flag, a fuel surcharge, a consultant field, per-line warehouse + vendor, job batching, a master-mix summary, a per-customer discount, and separate customer-vs-internal notes — **is already built** on this branch. This loop does **not** rebuild any of that. It builds exactly the two remaining gaps, nothing more.

## What this loop builds (the two gaps)

1. **Weather auto-fill on the field-application invoice.**
   Today the invoice has a couple of plain text boxes you type weather into by hand. This adds a **"Get Weather" button** that fills in temperature, wind speed, wind direction, and humidity automatically for the field's location and the application time — capturing both the **start** and **end** conditions of the application. You can always **type over** anything it fills in (and type it all by hand if you're somewhere with no signal). It uses the **free** weather service we already use elsewhere (Open-Meteo) — **no new paid service, no new bill.** Because the weather comes from a model, not a sensor on your truck, the screen shows a clear note: *"weather is modeled, not measured — verify on-site before relying on it for compliance."*

2. **Diluent / carrier-water per acre on the field-application invoice.**
   "Diluent" (or carrier water) is the water you mix the chemical into before spraying. The invoice has no place to record how much water-per-acre was used. This adds a **water-per-acre box** and automatically computes the **total water** (your per-acre rate × the acres on the invoice), saves it, and shows it on the invoice and its **printout**.

Both gaps live on the same screen (the field-application invoice). Both add small, **optional** new database fields — nothing existing is changed or removed.

---

## How the loop runs (per stage) — hands-off until the end

For each of the two stages, on its own, with no need to babysit it:
1. **Build** it on the loop branch (a fresh engineer with clean context builds one stage).
2. **Prove it actually runs** — not "tests pass." Apply the new database field to a **throwaway copy** of the database, run a rolled-back smoke test, and **open the actual invoice screen** and use the new button / box and watch it work.
3. **Codex reviews it** (your second AI). Every High/Medium finding is fixed (max 3 rounds); Low findings are parked in a list you see at the end.
4. **Record** the result and snapshot-commit the tracker, then move to the next stage.

## The safety gates (what protects your money & data)
- **Never touches your live site or live database during the run.** Every database change is tested on a **throwaway copy** only.
- **Additive and optional only** — new fields can be left blank; nothing existing is renamed, removed, or made mandatory. Money stays whole-cent integers.
- **Weather stays on the free Open-Meteo service.** No paid weather provider, ever.
- **Manual entry always works** — the auto-fill is a convenience; you can always type weather in by hand (offline fallback).
- **Production happens once, at the very end, only with your explicit go-ahead.** I'll walk you through every database change in plain English first, in order, before anything is applied.

## ⚠️ One important note about going live
This branch is built on top of **`feat/fieldapp-beyond-parity`** (the six beyond-parity features). Per the records, beyond-parity was **already shipped live on 2026-06-30** — but if for any reason it is **not** on `main` at promotion time, beyond-parity must be promoted **first or together** with this work, because these two gaps sit on top of it. I will flag the exact state at the production gate.

---

## Where the details live
- **Operating spec (how the loop runs + the hard safety rules):** `LOOP.md`
- **Machine-readable spec (the two stages, with testable acceptance criteria):** `BACKLOG.json`
- **Live progress:** `PROGRESS.json` → human-readable `LEDGER.md`
- **First action + resume playbook:** `KICKOFF.md`
- **The prompt each build engineer gets:** `BUILD-SUBAGENT-TEMPLATE.md`
