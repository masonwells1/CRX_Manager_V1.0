# EPA Label-Data Lookup & Backfill — Implementation Plan (v2)

**Author:** Claude (Opus 4.8) · **Date:** 2026-07-10 · **Status:** v2 — reworked after Codex advisory review
(verdict on v1: *rework before loop*). All accepted findings folded in below. Ready for loop-spec confirmation.
**Owner:** Mason (zero coding experience — this doc leads in plain English)

---

## 1. Plain-English summary (read this if nothing else)

None of your ~595 products carry the safety numbers off their chemical labels — signal word
(Caution/Warning/Danger), re-entry interval (REI), pre-harvest interval (PHI), or maximum legal rate. Because
those are blank, three safety features you already built are switched off.

ChemMan lets you browse EPA's product database and pull a product's name + registration number straight in. **We
can do the same — EPA runs a free public data service and I tested it live against your own products.** We route
results into a review screen you already have in production, so a person confirms every value before it touches a
real product.

**A hard review (Claude + Codex) shrank this to what's actually safe to build.** The honest reality after review:

- **EPA gives us:** signal word, manufacturer, active ingredients, restricted-use flag, registration status, and a
  link to the official label PDF. **Not** REI/PHI/max-rate (those live only in the label PDF and change by crop).
- **The single biggest catch:** trying to store *one* "max legal rate" per product is **dangerous** — a product
  can have different limits per crop, so a single number could make the "over the rate" check quietly *pass* an
  illegal spray. That's worse than no check. So the part that reads rates off the label is **demoted to
  information-only** until we can store limits per-crop (a separate, later project).

**What we build now (safe, high-value, low-risk):**
- **Look up a product against EPA** → auto-fill the **signal word** and **verify the registration number**, through
  the review-and-confirm screen you already have.
- **A catalog data-quality report** — which products have a registration number that points at a *different* EPA
  product (I already found one: your "2,4-D Amine" is registered as "ForeFront R&P"), which are **cancelled**, and
  which should be flagged **restricted-use**. This is a *report you act on*, not an automatic change.

**What we explicitly defer** (needs more design before it's safe): reading REI/PHI/max-rate off the label PDF to
switch on the PHI and rate guardrails. We'll scope that separately once the per-crop question is answered.

**Risk:** low. One small new server function, some frontend, and **at most one tiny, additive database change**.
The only steps needing your explicit go-ahead: deploying the server function and running the first real backfill.

---

## 2. What already exists LIVE (verified against the live DB + `origin/main`, 2026-07-10)

I checked the live database and `origin/main` directly — not the docs, not the migration file's comment.

- `product_label_drafts` table — **exists live, 0 rows** (never used → clean slate, *not* "battle-tested").
- `create_label_draft` / `bulk_create_label_drafts` / `commit_label_draft` / `get_label_coverage_report` —
  **all exist live** with the signatures below; static SQL shows admin-gating, admin-only RLS, and
  `REVOKE ... FROM PUBLIC, anon` + `GRANT ... TO authenticated`.
- `LabelReview.tsx` (`/label-review`, admin-only) — **on `origin/main`** (deployed).
- The migration file header says *"LOCAL only — not for production"* — that comment is **stale**; the objects are
  live. **Action before the loop:** run a rolled-back `create_label_draft → commit_label_draft` smoke transaction
  against live to prove the live bodies/grants match the repo (Codex #4). Don't trust the comment either way.

**The real `commit_label_draft` signature (verified):**
`(p_draft_id uuid, p_decision text, p_signal_word text, p_rei_hours int, p_phi_days int, p_epa_registration text,
p_max_label_rate numeric, p_max_label_rate_unit text, p_force_overwrite boolean, p_idempotency_key text)`.
It writes only those product columns, has a **draft-wide** (not per-field) `p_force_overwrite`, and **requires an
existing `p_draft_id`** (you cannot commit straight from a lookup). It does **not** carry `is_rup`, EPA status,
PDF URL, manufacturer, ingredients, or a sync timestamp.

## 3. Codex advisory review — findings & dispositions

| # | Sev | Finding (short) | Disposition |
|---|-----|-----------------|-------------|
| 2 | BLOCKER | Single max-rate/PHI can *falsely clear* an illegal rate / can't express prohibited crops | **Accepted.** Stage 2 demoted to information-only; may NOT activate the rate/PHI guardrails until per-crop modeling exists. Out of this loop. |
| 1 | BLOCKER | Draft pipeline can't carry is_rup/status/PDF/manufacturer/sync | **Accepted.** Those become a **report-only** output; the write-path carries only signal_word + reg-number validation. No bypass of the review pipeline. |
| 3 | BLOCKER | `signal_word` CHECK rejects `"No Signal Word"` / is case-sensitive | **Accepted.** Normalize: exact `Danger/Warning/Caution`; `"No Signal Word"`→NULL; anything else → `needs_manual`, never raw. (§8) |
| 5 | HIGH | commit needs an existing draft; Wave 1.2 skipped `create_label_draft` | **Accepted.** Flow is lookup → `create_label_draft` → review → `commit_label_draft`. (§7 waves) |
| 6 | HIGH | Bulk keys by product_id; one reg# → many products; dup/retry/race gaps | **Accepted.** Fan-out one lookup → all matching product_ids; deterministic keys; dedupe open drafts; chunk; reserve idempotency before insert. (§9) |
| 7 | HIGH | One draft-wide force flag can't do per-field EPA-vs-human conflicts; partial-apply loses evidence | **Accepted.** In this loop, **only fill fields that are currently EMPTY** (no force, no conflicts). Per-field conflict UI is a separate follow-up. (§10) |
| 8 | HIGH | SSRF baseline ok but missing method allow-list, size caps, content-type check, error-leak, server-side rate-limit | **Accepted** in full. (§6) Do NOT copy send-email's raw-error return. |
| 9 | HIGH | Reg-number types: distributor sub-regs, SLN/24(c), Section 18, cancelled≠deactivate | **Accepted.** Classify reg types; status is report-only; distributor name differences are expected (don't false-flag). (§7 classifier) |
| 10 | MED | Lookup can flag a mismatch but can't *find* the correct number (no name search) | **Accepted.** Language is "flags suspected mismatches," never "proposes the corrected number." |
| 11 | MED | OCR review needs source evidence (PDF/date/page/crop/excerpt) on screen | **Accepted** — folded into the deferred Stage 2 design; not built now. |
| 12 | MED | Wave 1.3 too big / not resumable; loop spec had open "Confirm"s | **Accepted.** Split into dry-run manifest → reviewed drafts → gated commit; per-reg outcomes + hashes + resume checkpoints. (§11) |
| 4 | HIGH | "live/battle-tested" not proven | **Partial.** Live existence *was* verified (Codex lacked DB access); "battle-tested" corrected to "live but unused"; live smoke test adopted. (§2) |

## 4. Revised scope

### Stage 1 — SAFE CORE (this loop)
- **1A. Signal-word fill + reg-number validation** through the existing review→commit pipeline, EMPTY-fields-only.
- **1B. Catalog data-quality REPORT** (read-only): name mismatches, cancelled registrations, restricted-use
  disagreements, reg-number classification. You act on it; nothing auto-writes from it.
**Delivers:** signal word filled across reg-numbered products + a cleanup report. **Does not** touch the PHI/rate
guardrails.

### Stage 2 — DEFERRED (separate future scope, NOT this loop)
Reading REI/PHI/max-rate off the EPA label PDF to activate the guardrails. Blocked on: a **per-crop/use rate &
PHI model** (Codex #2), and **source-evidence in the review screen** (Codex #11). Until then, any OCR output is
*informational only* and must not feed `max_label_rate`/`phi_days` in a way the guardrails read as authoritative.

## 5. Proven EPA facts (tested live 2026-07-10)
- Reg lookup: `GET https://ordspub.epa.gov/ords/pesticides/cswu/ppls/{regno}` → JSON. Verified on your `264-849`
  (→ signal word **Caution**, Bayer, active ings, RUP=No, status Active, PDF list) and `62719-524`
  (→ **"FOREFRONT R&P", Danger** — does NOT match your "2,4-D Amine" label = a real data-quality catch).
- Returns: `eparegno, productname, signal_word, product_status, cancel_flag, rup_yn, companyinfo[].name,
  active_ingredients[], pdffiles[]`. **Not** REI/PHI/max-rate.
- Label PDF downloads: `https://www3.epa.gov/pesticides/chem_search/ppls/{pdffile}` → real `application/pdf`.
- **No product-name search** (only reg# + active-ingredient). Public domain, no key, refreshes every 12h.

## 6. `epa-lookup` edge function — hardened spec
Read-only proxy; **no DB writes**; matches `send-email` house style for auth/CORS/Sentry, but fixes its gaps.
- **AuthZ:** JWT → `requireActiveProfile(adminClient, caller.id, ['admin'])`, fail-closed.
- **Method allow-list:** `OPTIONS` (CORS) + `POST` only; everything else → **405** (Codex #8).
- **Input:** `{ regNumber }` (+ optional `{ ingredient }` later). Cap request body size before `JSON.parse`.
- **SSRF:** validate the reg number with the **classifier** (§7) BEFORE building any URL; hardcode the EPA host;
  `redirect: "manual"` (reject cross-host redirects); request **timeout**.
- **Upstream safety:** validate EPA HTTP status + `Content-Type`; **cap response bytes** before buffering/parsing.
- **Errors:** return fixed, client-safe messages — **never** raw exception or upstream body text (don't copy
  send-email's `err.message` return); log detail via `captureEdgeException`.
- **Politeness:** small server-side cache + rate-limit, not just browser throttling.
- **Output (normalized):** `{ found, regType, eparegno, productname, signalWordCanonical, manufacturer, rupYn,
  productStatus, isCancelled, activeIngredients[], latestLabelPdfUrl, labelPdfs[] }`.

## 7. Reg-number classifier (Codex #9, #10) + wave flow
Classify every stored/entered value: **basic Section 3** (`C-P`), **distributor sub-registration** (`C-P-D`,
name legitimately differs — don't flag), **SLN/24(c)** and **Section 18** (non-numeric — mark *unsupported by
lookup*, NOT malformed), **malformed**. Cancelled/transferred/RUP results are **report-only** (existing stock can
still be used). Mismatch = **"suspected mismatch — verify,"** never an auto-proposed corrected number.

**Wave flow (per product):** lookup (edge fn) → `create_label_draft` (signal word canonical + reg validation
note, EMPTY-fields-only) → review in `LabelReview` → `commit_label_draft`.

## 8. Signal-word normalization (Codex #3)
Map EPA → product CHECK exactly: `Caution/Warning/Danger` pass case-normalized; `"No Signal Word"` → **NULL**;
anything unrecognized → draft flagged `needs_manual` (never committed raw). No CHECK change needed unless you want
to record "verified: no signal word" distinctly (optional additive follow-up, not in this loop).

## 9. Bulk identity & idempotency (Codex #6)
One EPA lookup result → fan out to **every product_id** sharing that reg number. Deterministic idempotency key per
`(product_id, source='epa', regNumber, epaResponseHash)`. **Skip products that already have an OPEN draft**
(dedupe). **Chunk** the batch so one bad item doesn't abort the rest. **Reserve** the idempotency record before
insert to close the concurrent-retry race. Record per-registration outcome + the canonical EPA response hash.

## 10. Conflict policy for THIS loop (Codex #7)
**Fill only fields that are currently empty on the product.** No `p_force_overwrite` in the loop. Where EPA
disagrees with an existing non-empty value, we **do not overwrite** — we surface it in the §4/1B report for a
human. (A proper per-field "keep / accept EPA / defer" review UI is a documented follow-up, not this loop.)

## 11. Database changes
- **Stage 1 write-path:** likely **ZERO** new objects (reuses live RPCs; signal_word + epa_registration already
  commit-supported).
- **1B report:** read-only; ideally needs no schema. *Optional additive-nullable* `products.epa_last_synced_at`
  + `products.epa_product_status` if you want a persisted "last synced / EPA status" chip — additive only, five
  migration reviewers + Codex gate + apply-guard proof, one batched apply gate. Decide in §13.
- **Stage 2:** deferred (would need per-crop restriction tables — separate scope).

## 12. Security posture (summary)
Strict classifier before any fetch; hardcoded host; manual redirect; method allow-list; body + response caps;
content-type check; fixed client-safe errors; admin-only; server-side cache/limit. Every write still flows through
the admin-gated, idempotent, empty-fields-only `commit_label_draft`. OCR (deferred) stays advisory until per-crop.

## 13. Revised build-loop spec — HEAVY CODEX / LEAN SONNET (token-conserving, confirmed 2026-07-10)

**Why this shape:** Mason wants to conserve Claude usage for a separate big Fable-model run later. Codex is a
separate tool with its own budget — calling it (`codex exec`) costs zero Claude tokens. So this loop puts nearly
all the work on Codex and keeps Claude's footprint to three small, specific checks, total — not per file. This is
also the same split that already worked on the workflow-waves / structure-fix / U7-splits loops.

- **Session model:** Claude runs on **Sonnet** (switched 2026-07-10), not Opus, for the light gating work it
  still does.
- **Driver:** **Codex writes all the code** for every wave (edge function, migration if any, frontend, tests) AND
  runs its own first-pass review + self-fix before handing a wave back. Claude does **not** write feature code
  and does **not** run a review-subagent fan-out or Workflow-tool orchestration on this loop.
- **Claude's (Sonnet's) spend is limited to three touchpoints, total:**
  1. **Light diff-sanity check per wave** — confirm Codex's diff matches this doc's spec (§6-§12) and scope
     (e.g., Wave 1 didn't sneak in Stage-2 rate-guardrail writes), nothing outside the wave's stated files changed.
  2. **One live rolled-back smoke test** of the label-draft pipeline (create→commit, rolled back) before Wave 1
     starts — actually proves the "LOCAL only" migration comment is stale (§2) rather than trusting it.
  3. **Proof verification at the two hard gates** below — confirm Codex's evidence that a wave actually ran,
     before Mason is asked to approve the gate.
- **Isolation:** own worktree `C:\CRX_EPA`, branch `feat/epa-label-lookup`; any migration PARKED to one batched
  apply gate at the end, same pattern as prior Codex-driven loops.
- **Waves (each PR-sized, resumable, with per-item checkpoints):**
  1. **`epa-lookup` edge function** (hardened, §6) + classifier (§7) + normalizer (§8) + unit tests +
     **live smoke** of the draft pipeline (§2, Claude touchpoint #2). Deploy = **GATE (Mason OK)**.
  2. **Per-product "Look up EPA"** in `ProductDetail` → create_label_draft(signal word, empty-only) → review → commit.
  3. **Bulk dry-run manifest + data-quality report** over the 199 reg numbers (read-only, §9 identity, no writes).
  4. **Reviewed draft generation** from the manifest (still no product writes) → into `LabelReview`.
  5. **Gated commit** of reviewed drafts = **GATE (Mason OK, live backfill)**.
- **Definition of done (per wave):** the actual data appears on a live `[E2E]` product / the report lists the real
  mismatches — not "tests pass." Codex generates the PROOF line; Claude spot-checks it (touchpoint #1), doesn't
  regenerate it.
- **Hard gates (explicit Mason OK in-conversation):** edge-fn **deploy**, any **live backfill**, any **migration apply**.
- **Codex gate:** since Codex is also the builder here, the existing `codex-push-guard` hook (an independent
  `codex exec` verdict recorded this session before a push touching migrations/edge-functions) is still the
  deterministic backstop — Codex reviewing its own diff in a fresh pass satisfies it, but the hook enforces the
  verdict is real and current, not skipped.

## 14. Decisions for Mason
1. **Confirm the narrowed scope:** build Stage 1 (signal word + data-quality report) now; **defer** the
   REI/PHI/rate-guardrail piece (Stage 2) until we design per-crop modeling. *Recommended.*
2. **Report vs. persisted status:** do you want the data-quality findings as a **one-time report** (zero schema),
   or persisted on each product (`epa_last_synced_at` + `epa_product_status`, one tiny additive migration)?
   *Recommendation: start with the report; add the columns later if you find yourself wanting them.*
3. ~~**Loop driver/worktree:**~~ **CONFIRMED 2026-07-10** — heavy-Codex / lean-Sonnet loop (Codex builds +
   self-reviews, Claude/Sonnet limited to 3 touchpoints) in a fresh `C:\CRX_EPA` worktree. See §13.
