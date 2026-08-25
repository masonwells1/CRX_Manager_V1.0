# Product Data Model — Build Plan and Handoff Contract

**Date:** 2026-08-19 · **Revision 2** (folds in the Fable adversarial review, 26 findings, and
two owner decisions taken 2026-08-19)
**Branch:** `claude/product-data-storage-58ba26` — local commits only, nothing pushed
**Intended executor:** Codex **`sol`** (`gpt-5.6-sol`, high reasoning effort)
**Reviewer of record:** Claude **Opus 5** — per-package gate plus a final coverage audit
**Design source of truth:** `docs/plans/2026-08-18-product-data-model-MASTER-RECORD.md`
(43 issues, every decision, and why) and `…-PRD.md` (numbered requirements + acceptance)

This file is the **executable** layer. The master record says *what is wrong and why*; this
says *what gets built, in what order, by whom, and what proof ends each step.* Where the two
disagree, the master record wins on reasoning and this file wins on sequencing.

> **Revision 2 changelog.** Two claims in revision 1 were **wrong** and are corrected below:
> (a) the "no feature-flag system exists" finding was false — see §0; (b) R-3 asserted
> `docs/reference/gotchas.md` was stale, but the `public.products` column-carve entry was
> already added on 2026-08-18 (`gotchas.md:264-273`). Also added: a backup gate, a live-data
> proof protocol, the scale-weight surface, negative-path acceptances, WP-4's storage columns,
> the receiving escape hatch, the chemistry role model, and §8 orchestration.

---

## 0. Eleven decisions closed, plus one corrected finding

The master record left nine questions open that a builder cannot proceed past without
inventing an answer, and the Fable review surfaced two more that are Mason's to make. All are
now decided.

### CORRECTED FINDING — this repo *does* have a feature-flag precedent

Revision 1 claimed `feature_flag`, `featureFlag`, `FEATURE_FLAG` and `rollout` appear zero
times in `src/` and `supabase/migrations/`. **That was false.**
`supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql` is a rollout gate, and
`supplier_cost_basis_enabled` is an `app_settings` switch referenced in eight places across
`20260722015019_supplier_cost_basis_phase2.sql`.

The conclusion still stands — `app_settings` plus a typed parse helper is the right pattern,
and `src/lib/labelGuardrailSetting.ts` is the right shape (safe default, never invent the
dangerous value). But the missed precedent is **richer than the one adopted**: the Wells gate
supports a **per-product** rollout table, not just a global on/off. **Phase 2 must evaluate
per-product cutover** (pilot set first, then widen) before it is detailed — see D-F.

### The eleven decisions

| # | Question | Decision | Closes |
|---|---|---|---|
| **D-A** | `ae_fraction` cannot express fertilizer oxide→elemental (PRD 1.10b) | **Generalize to `canonical_fraction` + `fraction_basis`** (`acid_equivalent` \| `elemental`). Glyphosate IPA salt → parent acid, 0.741, basis `acid_equivalent`. P₂O₅ → parent P, 0.436, basis `elemental`. **Three rules govern its use, and Sol must implement all three:** (1) the fraction applies **only** when the concentration's own `basis` is the form's basis (`active_ingredient` or `oxide`) — never when the concentration is **already** stated as `acid_equivalent` or `elemental`; (2) **one canonical shape**: a concentration always attaches to the **specific form row**, never to the parent; (3) `canonical_fraction` is **nullable**, and NULL means *search-merge only, no numeric conversion — refuse the calculation*. Rule 3 is what makes the isomer case representable (`Gen Dual R Moc` racemic vs `Gen Dual S Moc` S-metolachlor share a search parent and have **no** valid fraction) | B-24, PRD 1.10b |
| **D-B** | Specific gravity: normalize on write or convert on read? | **Normalize to `lb_per_gal` on write**, retaining the entered value and unit for audit. **The constant is pinned to a single named export: `WATER_LB_PER_GAL = 8.345404`.** Builder and verifier must use the same one, and the WP-2 proof states its tolerance explicitly | PRD 1.20 |
| **D-C** | Do the workbook's rate columns ship writable? | **Read-only from the start.** The workbook never becomes a fourth write path Phase 2 must unwind | C-32, open 13 |
| **D-D** | Absent workbook row = delete or ignore? | **Ignore.** Deletion requires an explicit `__delete` marker column set `true` on the row being removed | Open 8 |
| **D-E** | The child tables have no concurrency token | **New `products.product_data_version`**, bumped by every ingredient / density / brand write, and revoked from direct app write. Not `pricing_version` — bumping that from a chemistry edit fires false conflicts in the pricing workbook. **Honest scope (Fable F-9): a bump-only counter does not by itself prevent a lost update.** The WP-1 RPCs therefore accept **`p_expected_data_version`** and reject a stale one, so the guard is compare-and-set, not advisory | Open 8 |
| **D-F** | Phase 2 rollback (C-38) | **`app_settings` key `product_rate_source_mode`**, values `legacy` (default) \| `rates_table`, parse helper mirroring `labelGuardrailSetting.ts`. **Honest scope (Fable F-2) — this is a read-path switch, not a rollback:** it changes which mechanism supplies a rate. It does **not** undo a wrong re-derived value (correct the `product_rates` row — fast, but a different action), the revoked write grants, or the deleted unit aliases. **Phase 2 must state what `legacy` mode reads once the T-11 mirror exists**, since the mirror projects the same re-derived row. **Phase 2 must also evaluate the per-product Wells rollout pattern** for a pilot-first cutover | C-38, open 10 |
| **D-G** | Seed-treatment rate basis (C-40) | **Add `per_cwt_seed` and `per_seed_unit` to the `product_rates.basis` CHECK on day one.** `per_unit` keeps its narrow meaning: *per each* | C-40, open 9 |
| **D-H** | How much brand back-fill is mechanical? | **Human-reviewed always.** A parenthetical parser may *propose* into the D-I queue; nothing it produces is written unreviewed. "(Full pallets)" and "(New Formulation of Resicore XL)" are in that 129 and are not brands | Open 14 |
| **D-I** | Where does machine-sourced data land first? | **The `product_label_drafts` propose-review-commit shape** — status, confidence, `reviewed_by`, `run_idempotency_key`. EPA seeding, parsed brand proposals, and crew-entered new brands (D-K) all use it | T-18, open 14 |
| **D-J** *(Mason, 2026-08-19)* | Who may edit chemistry, concentrations and density? | **Admins only.** Everyone reads; only admin accounts write. Density drives scale weights and ingredients drive comparisons — a wrong value reaches a real mixer. Every change is audited regardless. Sol implements this as the RLS policy on all three new tables and on the density columns; it does **not** invent a policy | Fable F-24 |
| **D-K** *(Mason, 2026-08-19)* | A load arrives with a brand not on the product's list — what can the crew do? | **Type it in free-hand and finish receiving.** The typed name is captured on the receipt immediately and lands in the D-I review queue as a **proposed** brand. It is **never** written to the permanent brand list unreviewed, and receiving is **never** blocked. This replaces revision 1's hard requirement, which could strand a truck at the dock | Fable F-7 |

### Eleven more owner decisions, taken 2026-08-19 so Sol never has to ask

| # | Question | Decision |
|---|---|---|
| **D-L** | Typed ingredient data vs a later EPA lookup that disagrees | **Mason's typed value wins and stays live.** The EPA version is stored beside it and **flagged as a difference** for review. A lookup never silently overwrites hand-entered data |
| **D-M** | Density differs between label, SDS and supplier | **Trust order: safety data sheet → label → supplier.** The SDS is the regulated document where density is a required precise figure; labels round it and suppliers quote nominal specs. A `measured` value Mason recorded himself still outranks all three (it is the most specific evidence for his actual drums) |
| **D-N** | How is the ingredient/density entry screen built, given 33–56 hours of owner typing | **Built for speed.** Keyboard-driven: tab between fields, **save-and-advance to the next product without the mouse**, recent values suggested. This is a scope addition to WP-1 and is deliberate — it buys back hours of Mason's own time |
| **D-O** | What actually differs between `Gen Liberty` and `Gen Liberty: Higher Quality` | **Mason's words:** *"same chemistry better manufacturer and usually higher surfactant loads, AI ingredient same but everything else is higher quality, it also costs more."* **Consequence: the tiers are NOT clean substitutes.** The active ingredients match, but the inerts genuinely differ — the premium version carries more built-in surfactant. Any grouping, family match or comparison must show the tier and must never present them as interchangeable on the strength of matching actives alone |
| **D-P** | How the comparison tool handles adjuvant, given D-O | **Show it as a note; do not price it.** Mason's earlier exclusion of adjuvant cost stands, but wherever a total appears the tool states when one product carries built-in surfactant and the other would need it added. **The stated bias runs against the premium product** — this must be visible, not buried |
| **D-Q** | When WP-3's receiving change goes live | **As soon as it is proven** — no staged rollout, no waiting for a quiet day. The D-K escape hatch is what makes this safe: the crew is never blocked, so an unfamiliar step cannot stop a truck |
| **D-R** | The 13 blank SKUs | **Mason assigns them.** WP-0 presents the 13 with names and vendors; he types the real part numbers. **No auto-generated placeholders** — a generated SKU is a number no supplier can look up |
| **D-S** | Who approves a crew-proposed brand into the permanent list | **Admins only**, matching D-J. A brand carries an EPA number that reaches customer paperwork |
| **D-T** | A product's EPA registration is reported **cancelled** | **Warn loudly, keep selling.** A clear banner on the product and a warning when it is added to a quote — but nothing is blocked. Cancelled registrations commonly allow existing stock to be sold through, and blocking would strand inventory Mason can legally move |
| **D-U** | A package is proven and waiting on Mason's apply approval while he is unreachable | **Prepare the next package; apply nothing.** The build keeps writing and reviewing ahead so progress does not stall on his availability, but **every live database change still waits for his yes.** This is not hands-free mode and autopilot is not armed |
| **D-V** | Is the comparison tool's ~2026-09-18 target real | **Yes.** Phases sequence to hit it. **If it comes under pressure, protect the quality of the Phase 2 rate review — 573 owner-reviewed values, no bulk auto-rewrite — and raise the slip with Mason.** Never rush the one phase that can put wrong quantities on customer paperwork |
| **D-W** | Sol asked whether a cancelled EPA registration should refuse the sale when sell-through authorization cannot be confirmed (review finding 26) | **No — D-T stands unchanged. Mason, 2026-08-19: "Don't worry about it, let it be sold."** Warn loudly, never block. Sol's point that sell-through depends on the specific cancellation order was put to Mason and he accepted it as his call. **Do not add a sale-blocking gate, and do not re-open this.** |
| **D-X** | Sol asked for the quality tier to move onto the sellable product with database-enforced cross-tier exclusion (review finding 19) | **No structural change. Mason, 2026-08-19: it only affects glufosinate and mesotrione — not worth the work for that edge case.** The safety property is kept at the display layer, where **D-O and D-P already carry it**: the tier is always shown, the tiers are never presented as interchangeable on matching actives alone, and the adjuvant bias against the premium product is stated on screen. That costs nothing extra and is the whole protection. **A builder must not add `sourcing_tier` to `products` or build cross-tier substitution rules.** |

**Proof accounts (Mason, 2026-08-19; corrected after Sol's findings 4 and 31; non-admin path
resolved 2026-08-20).** Acceptance proofs run under **Mason's own account** — he declined to
create a *new* non-admin test user, and revision 3 left the non-admin proofs with no way to run.

**No new account is needed: one already exists *(established reviewing PR #435 against live,
read-only)*.** The live `profiles` table already holds a **test-named `sales_rep` account** that
has been signed into before and whose email is confirmed. It is simply **deactivated**
(`is_active = false`). This is the account R-2, R-11, WP-1 and WP-2's non-admin refusal proofs run
under. It is not named here — this is a public repository, and the account is identified by role
and test-name in the live table, not by address in a plan document.

**Provisioning it is a BLOCKING PREREQUISITE of WP-1, not an optional convenience.** Two owner
actions, both Mason's alone, because both touch a live credential:

1. **Reactivate** the account (`is_active = true`) in user management — a live permissions change.
2. **Set its password** via the app's password-reset path, and store it in CI as
   `E2E_SALESREP_EMAIL` / `E2E_SALESREP_PASSWORD`. **Never in the repository, never in a plan
   document, never in a commit message.**

Until both are done, `E2E_SALESREP_EMAIL` / `E2E_SALESREP_PASSWORD` are unset and CI carries admin
credentials only, so **every non-admin refusal proof is unexecutable and must be reported as such
rather than silently passed under an admin session.** An admin session cannot demonstrate a
D-J-restricted refusal — see directly below. **Deactivate the account again when Phase 1 closes**;
a standing extra live login is the cost of this, and it should not outlive the proofs that need
it.

**Correcting revision 2's claim:** it said an admin session "cannot reveal a missing column
grant." That is **false for direct writes.** Admin and non-admin app users both act through the
single database role `authenticated`, and the product screen writes directly
(`src/pages/ProductDetail.tsx:436`), so a missing grant fails for Mason too. What an admin
session *does* mask is **application-level authorization** — a profile admin cannot show that a
non-admin is correctly refused by a D-J-restricted `SECURITY DEFINER` RPC. Keep the two proofs
separate and do not conflate them.

**Every migration package ships an expected-privilege matrix, not a bare check *(finding 4 —
this was a blocker)*.** Recording `has_column_privilege(...)` for each new column proves nothing
on its own: it never states which columns are *supposed* to be writable, and a single accidental
table-level grant makes every column check pass while quietly letting any authenticated user
edit chemistry. Each package therefore records, per new column, **the expected `INSERT` and
`UPDATE` result — true or false — and asserts table-level `INSERT`/`UPDATE` on `products` remain
false.** A result that differs from the expectation fails the package, in either direction.
Alongside it, prove the behavior four ways: **direct write denied, RPC denied to the wrong role,
RPC allowed to the right role, and the value read back.**

---

## 1. Readiness verdict

**The design is ready to build once revision 2's changes are in. The handoff is blocked on
things that are not technical.**

| Blocker | State | Who clears it |
|---|---|---|
| **Codex credits are at zero** | Sol cannot execute, and the `gpt-5.6-sol` adversarial gate cannot run | **Mason** |
| **Supabase connector scope in the Codex app** | `.codex/config.toml` targets `rhyzpcqhnizqbxphqdkr` with `read_only=false`; the OAuth grant was recorded dead (`invalid_grant`) 2026-08-14 | **Mason** |
| **The database backup is 10 days old** | `backups/LATEST-OK.json` = `2026-08-09`, 156 tables, 9,927 rows. Prior cadence was 4–6 days, so the schedule has degraded. **The Supabase org is on the free plan — there is no point-in-time recovery, so this file is the only restore path.** WP-0 mutates live rows | **Prerequisite** — see §7 |
| **The parked-migration scan is fail-closed** | `scripts/fleet-status.mjs` reports `PARKED STATE UNKNOWN`. This build adds three migrations to a queue that cannot currently be counted | **Prerequisite** — see §7 |
| **The plan documents exist only as unpushed local commits** | Sol starting from `origin/main` cannot read them | **Prerequisite** — see §7 |

### One consequence of Sol executing, stated plainly

`AGENTS.md` requires a fresh, separate, exact-SHA adversarial proof pinned to `gpt-5.6-sol` at
high effort for risky diffs. If Sol also **writes** the diff, that gate is the same model
reviewing its own work in a new session — the letter of the contract, not its intent. The
2026-07-30 decision accepted that tradeoff deliberately (independence comes from a separate
ephemeral read-only process plus SHA binding). **Mason's requested Opus review is an
additional layer on top, not a replacement.** Both run.

---

## 2. Standing rules for this build

| # | Rule | Why |
|---|---|---|
| **R-1** | **No migration package ships without the screen surface that proves it.** A migration whose only proof is a test is not accepted | `products` is column-carved. A missing `GRANT` renders a field that silently fails to save, and **service-role testing cannot see it** |
| **R-2** | **Every acceptance runs in the running app as a normal authenticated user** — never service role, never "the tests pass". **The account is a named non-admin test user; for D-J-restricted writes, a named admin test user.** Acceptable evidence is a screenshot **plus** the console state **plus** a read-back `SELECT`. Authenticated REST calls are *not* a substitute for the app | C-25; Verification Standard |
| **R-3** | **Every new `products` column ships `GRANT INSERT(col), UPDATE(col)` in the same migration** — *for columns intended for direct app writes only* (see R-10). **Verify** the `gotchas.md` `public.products` entry is current; do not assume it is stale — it was corrected 2026-08-18 | C-25 |
| **R-4** | **Search merges forms; math never does.** Searching and grouping go through `canonical_ingredient_id`; every calculation uses the **specific** ingredient row. **A concentration is never stored on a canonical parent** — see WP-4 | B-8, C-33 |
| **R-4a** | **One conversion function, and it can refuse.** *(Sol finding 6 — was a blocker.)* "`canonical_fraction` is NULL means refuse to calculate" was prose with nothing enforcing it. Every conversion goes through **one function whose return type is either a validated number or a refusal reason** — never a bare nullable number a caller can coalesce. Every comparison and scale-weight consumer calls it. **`?? 1`, `COALESCE(fraction, 1)`, and omitting the multiplication are defects**, and a mutation test must prove NULL cannot surface as `1.0` or as any displayed quantity. The racemic-vs-S-metolachlor pair is the case to test: same search parent, no valid numeric conversion between them | D-A |
| **R-5** | **Existing code is not evidence of an existing workflow. Count the rows first.** | C-29 — the lot/tote chain is fully built and holds zero rows |
| **R-6** | **Warn on entry, refuse on use.** An unusual density warns and saves. A scale weight with no density **refuses** — never water, never a default | D-5 |
| **R-7** | **Never hard-delete a business entity** — products, brands, or any record with foreign-key history. Deactivate or re-identify. *Child chemistry rows may be removed* (WP-1's remove action, D-D's `__delete` marker); the audit trail captures the removal | T-17; scoped per Fable F-22 |
| **R-8** | **One package, one pull request.** | Keeps each approval gate readable |
| **R-9** | **Proofs never damage live business data.** Acceptance runs use designated test rows — the deactivated `1A TEST PRODUCT` or `[E2E]`-prefixed products and POs. Receiving proofs use `[E2E]` POs and are voided and cleaned afterwards. Any value written to a real product during a proof is reverted, and the revert is shown | Fable F-5. `receive_po_items` moves real inventory |
| **R-10** | **Every migration package's definition of done includes:** `src/types/index.ts` updated, `.claude/schema-registry.json` refreshed from live introspection, and `npm run typecheck && npm run lint && npm run build && npm run test` green | Fable F-20. The registry powers the hooks guarding the *next* migration |
| **R-11** | **Every enforcement claim needs a negative proof.** Not just "it saves" — also "the wrong role **cannot** save", "an idempotency-key replay does **not** double-write", "the `lb_per_lb` CHECK **rejects**", "a second quoting default is **rejected**" | Fable F-17 |
| **R-12** | **A fresh verified backup precedes every live write** — WP-0's first row edit and every migration apply. No PITR exists | Fable F-6 |

---

## 3. Work packages — Phase 0 and Phase 1

Strictly ordered. A builder who starts on screens builds them against tables that then change
shape.

---

### WP-0 · Data hygiene — **no migration**

**Builds:** re-SKU one `9768NR` row (both stay active and orderable); resolve 13 blank SKUs; 3
duplicate name groups; deactivate `1A TEST PRODUCT`; trim 13 whitespace-only
`epa_registration` values **to NULL** (not empty string — empty still counts as non-NULL and
recreates B-22's miscount); classify 11 blank `product_form` rows.

**Order that matters:** for the 11 blank forms, check each row's units **first** —
`validate_product_units` case-sensitively matches against `unit_conversions` and will reject a
form that disagrees.

**Before any write:** a proposal file listing every affected row, its current value, intended
value, and foreign-key references, for Mason's per-class sign-off. **Fresh backup first
(R-12).**

**Proof:** every SKU identifies exactly one sellable; nothing hard-deleted; every historical
reference still resolves (before/after `SELECT`s attached to the PR).

**Closes:** A-5, C-26 (Phase 0 half), T-16, T-17, PRD 0.1–0.3a.
**Gates:** Mason approves **each class**. No migration, but **Opus checkpoint 1 still applies**
— it reviews the proposal file and the before/after evidence. This is the only package that
edits live rows on day one, so it is not the one to leave unreviewed *(Fable F-15)*.

---

### WP-1 · Ingredient core + editor — **migration**

**Tables:** `active_ingredients` (name, CAS, EPA code, `canonical_ingredient_id` self-FK,
`canonical_fraction` **nullable**, `fraction_basis`); `product_active_ingredients`
(`product_id`, **`ingredient_id`**, nullable `concentration_value`, `concentration_unit`,
`basis`, `source`, `verified_by`, `verified_at`); `ingredient_moa_codes` (`ingredient_id`,
`scheme` required, `code`).

**These column names are exact, not prose *(caught reviewing PR #435)*.** The foreign key is
**`ingredient_id`** — the same name WP-4's acceptance query reads back. Use it identically in the
migration, the payload, the generated types in `src/types/index.ts`, and every proof query. A
proof that queries a differently-named column either errors out or silently proves the wrong
field, which is exactly the failure WP-4's 35% concentration bug depends on being caught.

**Columns added to `products` — including WP-4's storage, which revision 1 omitted entirely
*(Fable F-1)*:** `label_url`, `label_accepted_date`, `epa_product_status`,
`epa_is_cancelled`, `product_data_version`. WP-4 writes into these; it must not add columns
inside a no-migration package.

**WP-1 also carries the `product_label_drafts` queue extension, because WP-3 needs it and WP-4 is
too late *(blocker found by the exact-snapshot Codex review of PR #435)*.** WP-3's **D-K escape
hatch** — the crew types an unlisted brand free-hand, finishes receiving, and the typed name lands
in the review queue as a *proposed* brand — requires `proposed_brand_name` and a payload the queue
can actually hold. Those were specified in **WP-4**, which the apply order runs **after** WP-3.
A builder following the order literally would have had four bad options at WP-3: drop the brand,
smuggle it through an untyped text field, write an unreviewed permanent brand row, or block
receiving — and blocking receiving is precisely the truck-at-the-dock failure D-K exists to
prevent. **So the queue's schema prerequisite moves here:** WP-1's migration adds the typed
versioned payload column and the `purpose` discriminator to `product_label_drafts`, and
`proposed_brand_name` within that payload. **WP-3 consumes it; WP-4 adds only the EPA-specific
RPC on top.** Neither WP-3 nor WP-4 may alter the queue's shape again.

**Constraints:** `concentration_unit` ∈ `lb_per_gal`, `percent_w_w`, `cfu_per_ml`, `cfu_per_g`
— **`lb_per_lb` rejected**. `basis` ∈ `acid_equivalent`, `active_ingredient`, `oxide`,
`elemental`. Nullable concentration means *present, amount unknown*.

**Also in this migration:** RLS + policies implementing **D-J (admins write, all read)**;
`updated_at` + trigger on every new table; `p_idempotency_key` **and
`p_expected_data_version`** on every mutating RPC (D-E); the audit trail following the
`cost_history` precedent; `product_data_version` revoked from direct app write.

**Also builds:** the ingredient section on `ProductDetail` (add, edit, remove; unit and basis
pickers; herbicide MOA numeric global code only), and a **coverage banner** on the ingredient
search surface — "N of 604 products have ingredient data" — so that during the fill window a
partial result never reads as a complete one *(Fable F-25)*.

**Fast-entry mode (D-N).** The editor is keyboard-driven: tab between fields, **save-and-advance
to the next product without touching the mouse**, and suggest recently-used ingredients and
units. This is deliberate added scope — Mason personally faces 33–56 hours of entry, and the
screen is the lever on that number.

**Seed as the proof case:** glyphosate parent acid plus three salt forms. Fractions
**IPA 0.741, potassium 0.816, DMA 0.789** (revision 1 said 0.78 — wrong). Each seeded row
records its `source`, and Mason confirms them against a real label before they are trusted for
math.

**Proof (R-2, R-9, R-11):** as a **normal user**, open an `[E2E]` product, add three
ingredients with different bases, save, reload — all three persist. Change a concentration;
see the prior value and its author. Search "glyphosate" → **every** salt form.
**Negative:** a non-admin user's chemistry write is **refused** (D-J); an idempotency-key
replay does **not** double-write; `lb_per_lb` is **rejected**; a stale
`p_expected_data_version` is **rejected**.

**Every mathematical branch this package claims closed needs its own positive and negative case
*(finding 27)*.** Revision 2's proof exercised generic entry, search, and one invalid basis, then
claimed the whole conversion surface. Add, each proved rather than asserted: a **salt form**
converting through its fraction; an **already-acid-equivalent** value passing through
untouched, not multiplied twice; **P₂O₅ → elemental P** (get this wrong and the displayed
elemental quantity is ~2.29× too high); the **NULL-fraction isomer** case refusing under R-4a and
producing no number at all; a **percentage outside 0–100** rejected; and a **biological unit
(CFU)** refused rather than silently treated as a weight.

**Shared-ingredient edits must invalidate every product that depends on them *(finding 17)*.**
`canonical_fraction` lives on a shared ingredient row while `product_data_version` is
product-scoped, so editing a fraction leaves every linked product's version untouched and a
stale workbook saves cleanly against new chemistry. Either bump and audit **all** linked products
atomically when a shared mathematical field changes, or include an ingredient-version hash in the
compare-and-set. Prove it: edit a fraction with a stale product page open, and show the save
**refused**.

**Closes:** A-1, B-8 (mechanism), B-9, B-23, B-24, C-37, T-2 (as amended by D-A), T-3, T-9,
T-10, D-17, PRD 1.1, 1.1a, 1.2, 1.5, 1.6, 1.7, **1.10, 1.10c** *(nutrient rows and total-N,
unowned in revision 1 — Fable F-11)*, 1.12, 1.14, 1.16.
**Gates:** RLS review + migration-drift review · exact-SHA `gpt-5.6-sol` proof · Opus
checkpoint 1 · **Mason's in-chat OK to apply live** · R-10 · R-12.

---

### WP-2 · Density, net weight, and the scale-weight surface — **migration**

**Adds to `products` (R-3 grants where directly written):** `density_value`, `density_unit`,
`density_source`, `density_entered_value`, `density_entered_unit` (D-B audit), dry **net weight
per purchase unit**, `formulation_type`, `safener`, `nickname`.

**Write mechanism, previously unstated *(Fable F-10)*:** density is **RPC-only** — no direct
column `GRANT`. The RPC bumps `product_data_version` and writes the audit row. A direct column
grant would let any `.update()` bypass both. R-3 therefore applies to columns intended for
direct writes; density is not one.

**Builds the surface WP-2's own proof requires *(Fable F-4)* —** revision 1 asked Sol to
"request a scale weight" with nothing in the app that produces one. WP-2 ships a
**scale-weight readout** on the product screen: enter a volume, get the weight, see **which
density was used**, or see an explicit refusal naming the product whose density is missing.
(`blendMathValidator.ts` remains out of scope — it is warning-text only and tracked
separately.)

**Rules:** warn band ≈ 6.5–14 lb/gal, **warn never reject** (crop oils and MSOs run 7.6–7.8, so
an 8–12 floor is a defect); specific gravity normalizes on write against
`WATER_LB_PER_GAL = 8.345404`; the **density precedence function** always displays which density
it used.

**Hard domain first, soft warning second *(finding 8 — this was a blocker)*.** "Warn, never
reject" governs values that are *implausible*, not values that are *impossible*. Density,
concentration, `canonical_fraction`, net weight and allocation quantities are each **rejected
outright by the database unless finite and strictly positive**, and `canonical_fraction` must
additionally fall in a valid range. Revision 2 had `-8`, `0`, `NaN` and infinity all sailing
through as "unusual — warn the user", which turns a 100-gallon load into a negative, zero, or
non-numeric scale weight. Hard validation runs first; the plausibility warning only applies to
values that already passed it.

**NULL is not an impossible value — it is a designed one.** *(Caught by CodeRabbit on PR #435;
this correction supersedes any stricter reading above.)* "Finite and strictly positive" governs
the value **when a value is present**. `canonical_fraction` is deliberately nullable per D-A rule
3, where NULL carries meaning: *search-merge only, refuse the calculation* — the racemic
vs S-metolachlor case has no valid fraction and must still be storable. Write the predicate
**explicitly** as `canonical_fraction IS NULL OR (canonical_fraction > 0 AND ...)`.

*Be precise about why, because the obvious reasoning is wrong in a way that matters.* A bare
`CHECK (canonical_fraction > 0)` does **not** reject NULL rows: in PostgreSQL the comparison
evaluates to `NULL` (unknown), and a CHECK constraint is violated only by an explicit `FALSE`, so
unknown **passes** and the isomer row stores fine. The reason to spell out `IS NULL OR (...)` is
therefore **not** that the bare form breaks — it is that the bare form makes nullability an
accident of three-valued logic instead of a stated design decision, and the next person to add
`NOT NULL` "for safety" silently destroys the D-A rule-3 case with nothing in the constraint to
warn them. State the intent in the predicate. The refusal that protects the
math lives in R-4a's conversion function, **not** in a NOT NULL constraint. Any column whose
NULL state is load-bearing gets the same treatment, and the WP-1 proof stores a NULL-fraction
isomer row successfully and then shows the conversion function refusing it.

**Each field's hard domain ships in the migration that CREATES that field, not here.** Stating
the rule in WP-2 while WP-1 creates, seeds, edits and does arithmetic with `concentration_value`
and `canonical_fraction` leaves a live window in which impossible values can be written — and a
constraint added later cannot be applied at all if WP-1 already admitted a row that violates it.
So WP-1's migration carries the finite/strictly-positive CHECK for every numeric column it
creates, WP-2's carries them for density and net weight, WP-3's for allocation quantities. This
section defines the *rule*; the package that creates the column *enforces* it. Caught reviewing
PR #435.

**The brand slot is deferred to WP-3, not stubbed here *(finding 2 — this was a blocker)*.**
Revision 2 said this function "ships now with the brand slot WP-3 populates", but
`product_brands` is created in **WP-3** — the migration would reference a relation that does not
exist. WP-2 therefore ships the precedence function over **spec and measured density only**.
**WP-3 owns replacing it** with the brand-aware version, in a named migration, and **re-running
this package's density proof afterwards.** Without that explicit obligation a stub silently
survives and spec density quietly outranks the brand density it was supposed to lose to.

**Precedence is enforced on write, not only on read *(finding 14)*.** A read-time precedence
function does not stop a lower-trust supplier import from overwriting the one stored current
density. Source candidates are stored with their provenance and the commit RPC enforces the D-M
ranking: a lower-ranked candidate stays a **proposal** unless Mason explicitly approves it over
the higher-ranked value. Otherwise a measured 10.2 lb/gal is quietly replaced by a supplier's
8.34 and a 100-gallon scale ticket drops from 1,020 lb to 834 lb.

**Dry products need a normalized package weight, not a bare number *(finding 25)*.** Define the
field explicitly: normalized net weight **per purchase unit**, its unit, the package count and
basis, and its provenance. A case of four 10-lb bags must not be readable as a 10-lb package.
A missing net weight **refuses** a scale weight under R-6, exactly as a missing density does.

**Proof (R-2, R-9, R-11):** on `[E2E]` rows — enter 7.7 lb/gal on a crop-oil product, it saves
with a warning. Enter a specific gravity and the equivalent lb/gal on two products → identical
weight **within a stated tolerance**. Request a weight with no density → **refusal**, no number
produced. A `% w/w` product converts to lb/gal via its density (this proves B-11, which
revision 1 claimed without testing). A dry product's net weight per purchase unit produces a
correct weight. Formulation type and safener are visible on the product screen (C-33).
**Negative:** a non-admin density write is refused; a direct `.update()` on `density_value`
fails.

**Closes:** B-10, B-11, C-25 (first live exercise), C-27, C-33 (capture half), T-5, T-8, D-5,
PRD 1.3, 1.3a, 1.11, 1.18, 1.19, 1.20.
**Gates:** as WP-1. **Safety-critical — review at the money tier.**

---

## Settled owner decisions — the three conflicts PR #435 surfaced, all closed 2026-08-20

*Raised reviewing PR #435 on 2026-08-20 as genuine conflicts between two things the plan corpus
already said — a builder could satisfy one document only by violating the other. **All three were
put to Mason the same day and all three are now settled.** The resolutions below are binding on
every package; the sections that follow have been rewritten to match. Do not re-open these from
the review document.*

1. **The application workflow is not currently in use — brand capture follows the delivery path.**
   *(Mason, 2026-08-20.)* Asked directly whether applications are live, he answered no. The live
   numbers agree: `application_record_lots` holds **0 rows**, `application_records` holds **1**,
   `delivery_items` holds **400**. **Resolution:** `delivery_items` carries the brand snapshot.
   `application_records` carries it **inside each `product_data` array element**, so the capture
   exists whenever applications are adopted, without inventing a new relation. **The lot/tote
   chain stays untouched** — PRD 1.9a-iv holds, and nothing in this plan revives it. WP-3's proof
   runs on the **delivery** path; the application path ships the column shape and is not exercised.

2. **WP-5's copy RPC does not enforce tier — D-X stands unchanged.** *(Mason, 2026-08-20.)*
   Asked whether to drop the database restriction or reopen D-X, he chose to **drop the
   restriction.** Tier protection stays exactly where D-X put it: the display layer. **The copy
   RPC must not read, compare, or refuse on `sourcing_tier`, and must not add it to `products`.**
   The eligibility the RPC *does* enforce is formulation and safener — those are chemistry, not
   commercial tier. A cross-tier copy is **permitted** and the tier remains visible on screen.

3. **WP-4 gains a `manual` purpose with a backward-compatible default.** *(Mason, 2026-08-20 —
   "sounds good".)* `handleCreateSampleDraft` (`src/pages/LabelReview.tsx:370-382`) calls
   `create_label_draft` today with **no purpose argument**, so a discriminator constrained to
   `epa_label_seed` would break that live caller during the apply-before-merge window, or
   silently route manual drafts through the EPA commit path. **Resolution:** `purpose` accepts
   `manual` and `epa_label_seed`, and **defaults to `manual`** when the argument is absent, which
   is exactly what today's callers mean. See the WP-4 payload contract.

---

### WP-3 · Brand layer, receiving capture, split loads — **migration**

**Full schema surface, enumerated before handoff *(Fable F-14 — revision 1 named one table for
work that touches five)*:**
- **`product_brands`** — `brand_name`, its own `epa_registration`, manufacturer, `label_url`,
  `density_value` (the WP-2 override), `is_currently_sourced`, `sourcing_tier` (C-43).
- **`receiving_records`** — `brand_id`, plus snapshot `brand_name_snapshot` /
  `brand_epa_snapshot`, plus `proposed_brand_name` for D-K.
- **TWO allocation children, not one — they answer different questions *(corrected again reviewing
  PR #435; both earlier drafts of this list were wrong, in opposite directions)*.** The first draft
  keyed allocations to the delivery line only, which cannot work because that line does not exist
  when the truck is unloaded. The second keyed them to the receipt only, which cannot work either:
  **what arrived is not what shipped.** Receipt allocations record *provenance*; they cannot
  establish which brand went out on a later delivery, because stock pools. **PRD 1.9a-ii is
  explicit** — *"allow more than one brand, each with a quantity, per delivery/application line,
  keyed to the line itself"* (Mason, 2026-08-18). Both relations are required:
  - **`receiving_record_brand_allocations`** — keyed to **`receiving_record_id`**, holding
    `product_id`, `brand_id`, `quantity`, `unit`. `receive_po_items` writes it, and reversal
    identifies these rows by this key. This is the 30/15 split **as it came off the truck**.
  - **`delivery_item_brand_allocations`** — keyed to **`delivery_item_id`**, holding `brand_id`,
    `quantity`, `unit`. This is the 30/15 split **as it shipped**, and it is what regulatory
    paperwork and brand-specific scale weights read. **The operator selects it** when a line draws
    on more than one brand — it is not inferred from receipts, because pooled inventory makes that
    inference wrong. A single scalar `brand_name_snapshot` pair on `delivery_items` cannot hold
    two brands and must not be relied on for split lines.

  **An allocation's brand must belong to the parent line's product — enforced in the database
  *(blocker 4, third pass)*.** Both children carry an independent `brand_id`, and quantity
  conservation says nothing about *which* brand. Nothing so far stops a delivery line for
  Product X being allocated to a brand of Product Y that happens to have stock: the sums balance,
  the available-quantity check passes, and the paperwork prints another product's EPA number and
  another product's density. So each allocation table carries the parent's `product_id` as a
  stored column, with a **composite foreign key** binding `(product_id, brand_id)` to
  `product_brands(product_id, id)` — a unique constraint on that pair exists for the purpose — and
  a trigger keeping the stored `product_id` equal to the parent line's. **Scalar and allocation
  forms are mutually exclusive, also in the database:** where any allocation row exists for a
  line, the scalar `brand_name_snapshot` / `brand_epa_snapshot` pair on that line must be NULL, so
  a reader cannot find two disagreeing answers. **Proof:** allocate a delivery line for Product X
  to a Product Y brand and show the insert is **refused**; then set a scalar snapshot on a line
  that already has allocations and show that is refused too.

  **Both** carry `brand_name_snapshot` / `brand_epa_snapshot` **on the allocation row itself**
  (PRD 1.9a-iii: snapshot at write time, never dereference `product_brands` later — otherwise
  correcting one brand's EPA number silently rewrites historical spray records). Both ship RLS in
  the same migration and take `p_idempotency_key`. Both enforce **quantity conservation**: the
  allocations on a line sum to that line's quantity, checked in the database, not in React.
- **The relations carrying snapshot columns, enumerated and verified against the migrations that
  create them *(finding 28, closed reviewing PR #435)*.** "Application-record tables" was not an
  enumeration — but neither is a list that assumes a product reference the table does not have.
  A brand snapshot is only meaningful at **product-line cardinality**:
  - **`delivery_items`** — has `product_id`
    (`20260206172436_create_full_schema_v2.sql:326-334`). Takes `brand_name_snapshot` /
    `brand_epa_snapshot` directly **for the single-brand case, which is the common one**. When a
    line draws on more than one brand, the scalar pair **cannot represent it** — the authority is
    `delivery_item_brand_allocations` above, and readers must prefer the allocation rows whenever
    any exist for that line. Do not let the scalar pair silently answer for a split.
  - **NOT `application_record_lots` — settled, do not build against it.** Structurally it looks
    ideal: it has `product_id` **and** `source_receiving_record_id`
    (`20260622170000_application_record_lots.sql:36-48`). **But it holds 0 rows on live** (counted
    read-only 2026-08-20), and PRD 1.9a-iv rules the lot/tote chain *existing but dormant — leave
    it alone*. An earlier revision of this list routed application brand snapshots here and was
    **wrong**: it would have attached brand to a table nothing writes, so application paperwork
    would carry no brand at all. **Mason settled on 2026-08-20 that the application workflow is
    not currently in use and the lot chain stays untouched.** Leave this table entirely alone.
  - **`application_records`** — has **no singular product reference.** Products live in a
    `product_data` **jsonb array** (`20260214220000_application_records_table.sql:28-30`), each
    element already carrying `product_id`, `product_name` and `epa_registration`. The brand
    snapshot therefore goes **inside each array element**, beside the existing per-product fields.
    A single snapshot pair on the header is ambiguous the moment an application covers two
    products, and silently overwritten on the second. **And within each element it is an
    allocation *array*, not one scalar pair *(P2, second pass)*:** moving the snapshot into the
    element fixes the product association but a singular snapshot still cannot express PRD
    1.9a-ii — an application drawing 30 gallons of one brand and 15 of another has two brands and
    two quantities for **one** product. So each `product_data` element carries
    `brand_allocations[]`, each entry holding `brand_name_snapshot`, `brand_epa_snapshot` and a
    quantity, summing to that element's quantity. Shipping the singular form because the workflow
    is dormant does not avoid the defect; it postpones it to adoption day and guarantees a
    migration of historical rows that never captured the second brand. **This ships the shape, not a live path** —
    applications are not currently in use (1 row), so the capture is there for whenever they are
    adopted. **WP-3's behavioral proof runs on the delivery path**, which is the one that carries
    real volume; the application path is not exercised and must not be claimed as proved.
  - **Not `application_record_fields`** — it is a record↔field join carrying only
    `application_record_id`, `field_id` and `acres`
    (`20260430150000_field_app_workflow_phase2.sql:36-43`). It has no product, so a brand snapshot
    on it means nothing.
  - **Not `application_services`** — it is the service *catalog* (name, rates, vehicle)
    (`20260405000000_application_services.sql:11-22`), not an application record.

  **The builder re-derives this list from the live schema before starting WP-3** rather than
  trusting it — a relation missed here is a brand that reads correctly today and blank on next
  season's reprint, and a relation wrongly included is a column nobody ever populates.
- **`receive_po_items`** — **the public signature does NOT change.** See below.
- **`_section9_receive_po_items_serialized`** — the internal function the public wrapper
  delegates to (`supabase/migrations/20260726190515_section9_po_ap_high_remediation.sql`).
  Revision 2 omitted it. Change the wrapper without it and brand data is accepted by the UI and
  **dropped before inventory is written** *(finding 28)*.
- **Existing call sites — all five, and all must keep working.** Revision 3 listed three and was
  wrong; the omission was caught reviewing PR #435 and confirmed by grepping `src/` for
  `receive_po_items`:
  `src/components/receiving/QuickReceivePanel.tsx:325`,
  `src/components/receiving/ReceivingHubPanel.tsx:185` (the F5 inline receive),
  `src/pages/InventoryPage.tsx:579`,
  `src/pages/PurchaseOrderDetail.tsx:291`,
  and the offline replay path in `src/lib/offlineSync.ts:414`.
  **The builder re-runs that grep before starting WP-3** rather than trusting this list — a missed
  caller is brand data silently dropped with a truck at the dock.
- **Generated RPC types** in `src/types/index.ts`, plus the schema-registry fixture (R-10).

**The receiving RPC keeps its current signature *(finding 3 — this was a blocker)*:** revision 2
called for a `receive_po_items` signature change. PostgreSQL cannot replace a function's input
signature in place, so that migration must drop the old signature or create an overload — and
because **this plan applies migrations before the PR merges**, there is a window where the live
database no longer offers the signature the deployed app and any queued offline action still
call. The result is a failed receive with a truck at the dock. **Instead: keep the existing
four-argument signature and carry brand data inside the existing `p_items` payload.** That is
purely additive and safe to apply ahead of the merge. If a future package genuinely needs the
signature changed, it reverses the order — compatible code merges first, migration second,
cleanup third — and says so explicitly.

**Brand allocations must conserve quantity *(finding 7 — this was a blocker)*:** splitting a
line across brands is written by **one atomic RPC** that locks the parent line, converts every
allocation to a single unit, and requires the allocations to be positive, finite, and to sum
**exactly** to the parent line quantity. It accepts and enforces `p_idempotency_key`. Without
this, a 45-gallon delivery split 30/10 leaves the invoice saying 45 while the scale ticket and
regulatory paperwork say 40, and a replay silently doubles both allocations.

**Conservation checked only inside the allocation RPC is not conservation *(blocker S-03,
exact-snapshot Codex review of PR #435, second pass)*.** The allocation RPC owns the *child*
write, but nothing stops the *parent* moving underneath it afterwards. Deliveries are already
created, edited and voided by four other RPCs, every one of which can change or remove a line
quantity without ever calling the allocation RPC — verified by grepping `src/` on 2026-08-20:

| RPC | Call site | What it does to the parent |
|---|---|---|
| `create_delivery_with_items` | `src/pages/NewDelivery.tsx:418` | creates lines |
| `create_quick_delivery` | `src/components/deliveries/QuickDeliveryModal.tsx:377` | creates lines |
| `edit_delivery` | `src/pages/DeliveryDetail.tsx:543` | **changes or replaces line quantities** |
| `void_delivery` | `src/pages/DeliveryDetail.tsx:611` | reverses the whole delivery |

Edit a 45-gallon line already split 30/15 down to 20 gallons and the allocations still say 45.
The invoice, the inventory draw and the regulatory paperwork then disagree, and the EPA snapshot
on the paperwork names brands in quantities that were never shipped. **So conservation is
enforced on the parent side too, in PostgreSQL:** a constraint trigger on `delivery_items` (and
on `receiving_records`) re-checks the allocation sum on **every** parent insert, update and
delete, so a lifecycle RPC that moves a quantity either fixes the allocations in the same
transaction or fails. Direct client writes to both allocation tables are **revoked** — they are
reachable only through actor-bound, idempotent RPCs. **The builder re-runs that grep before
starting WP-3**; a lifecycle path missed here is a silent provenance defect, not a crash.

**Proof (negative cases, R-11):** with a line split 30/15, call `edit_delivery` to change the
line to 20 and show the transaction **fails** rather than leaving a 45-gallon allocation on a
20-gallon line; then void the delivery and show the allocations reverse with it; then replay the
allocation RPC with the same idempotency key and show the quantities do not double.

**Shipped allocations are bounded by what was actually received *(P1, second pass)*.** Summing
to the delivery line is necessary but not sufficient: with 10 gallons of Brand A and 90 of Brand
B in stock, a 20-gallon delivery allocated entirely to Brand A sums correctly and is still
impossible. It prints the wrong EPA number on regulatory paperwork and, via the brand density
override above, the wrong scale weight. **Brand-level available quantity is therefore tracked
across receipt, delivery and reversal**, and an allocation that exceeds the brand's available
quantity is refused in the database.

**That balance is shared, so the lock must be on the balance, not on the line *(finding 2, fourth
pass)*.** The allocation RPC locks the **parent delivery line**, which serializes two writers on
the *same* line and does nothing about two writers on *different* lines drawing the same brand.
Two 6-gallon deliveries against 10 available gallons of Brand A both read 10, both pass, and both
commit — a 12-gallon draw on 10 gallons of stock, with regulatory paperwork naming a brand that
was not there. This is the classic check-then-act race and it is invisible in single-user testing.
**So the RPC takes a row lock on the brand-inventory balance row itself** (`SELECT … FOR UPDATE`
on the `(product_id, brand_id)` balance, acquired **before** the availability check and held to
commit), and the balance carries a non-negative CHECK as the backstop for any path that misses the
lock. Lock ordering: parent line first, then balance rows in a deterministic order — ascending
`brand_id` — so two concurrent split allocations cannot deadlock each other.

**Proof:** receive 10 A / 90 B, attempt a 20-gallon all-Brand-A delivery, show it is refused;
allocate 10 A / 10 B, show it succeeds; void it and show Brand A's available quantity returns
to 10. **Concurrency case, required:** run two allocations against the same brand balance
simultaneously from two sessions and show exactly one commits and the other is refused or blocks
— never both. A sequential proof cannot detect this defect.

**A brand's density may only override a spec density when the record says which brand shipped
*(finding 15)*.** Receiving Brand A does not establish that a later delivery drawn from pooled
inventory used Brand A. Brand density therefore applies **only** where the delivery or
application line carries an explicit brand or receipt allocation. **Never infer the brand from
the most recent receipt** — with 100 gal of Brand A at 8.3 lb/gal and 100 of Brand B at 10.2 in
stock, guessing prints a 100-gallon load as 830 lb when it is really 1,020. With no explicit
allocation, fall back to spec density and say so on screen.

**Behavior:** brand selection is **required once a spec has brand rows** *except* via **D-K**:
the crew may type an unlisted brand free-hand, receiving completes immediately, and the typed
name enters the D-I review queue as a proposed brand. It is never written to the permanent
brand list unreviewed. A spec with no brand rows does not block receiving.

**Snapshots:** records store brand name and EPA number **at write time** and never dereference
the brand row later, so correcting a typo cannot rewrite history.

**Hands off:** `receiving_records.lot_number`, `delivery_items.tote_number`,
`invoice_items.tote_number`, `blend_ticket_products`, `application_record_lots`,
`blend_tickets` — not extended, not deleted, never a condition of brand behavior (R-5).

**Proof (R-2, R-9, R-11):** on `[E2E]` POs, voided and cleaned afterwards — receive with **no
lot and no tote** → brand recorded, reaches paperwork. Split 30/15 across two brands → both
brands, both EPA numbers, both quantities, still no lot or tote. Change a brand's EPA
afterwards → the existing record still shows the old one. **Type an unlisted brand → receiving
completes and a proposal appears in the queue** (D-K). **The brand-density override actually
runs *(Fable F-3)* — and the proof must select the shipped brand first *(P1, second pass)*:**
an earlier revision requested the scale weight immediately after receiving, which contradicts the
rule three paragraphs above — a receipt does not establish which brand later shipped. That proof
could only pass by inferring the brand from the most recent receipt, the exact 830-vs-1,020 lb
defect the rule forbids. **So the proof runs on a delivery line carrying an explicit brand
allocation:** receive a brand with a density override, **create a delivery line and allocate it
to that brand**, then request a scale weight and observe **the brand's** density used and
displayed; remove the override and observe fallback to spec density. **Then run the negative
case:** a delivery line with **no** allocation must fall back to spec density and say so on
screen — never silently borrow the receipt's brand.

**Additional proofs added after Sol's review:** the **old four-argument call still succeeds**
against the migrated database, and a **queued offline receive replays successfully** — both run
against the applied migration *before* the code merges, because that is the window the
apply-before-merge order creates *(finding 3)*. **Inventory is genuinely reversed, not merely
hidden** *(finding 13)*: after voiding the `[E2E]` PO, show the inventory **balance**, the
**summed net movement**, the receipt state and the brand allocations all back to their starting
values — voiding a PO does not by itself reverse the movements `receive_po_items` created, so a
proof that only checks the PO disappeared from the screen leaves real stock inflated.

**Verify reversal by net movement, never by transaction count *(caught reviewing PR #435)*.**
`inventory_transactions` is an **immutable append-only ledger**, and the canonical
`reverse_receiving_record` reverses by *inserting a compensating negative row* — literally
`-1 * v_rec.quantity_received`
(`supabase/migrations/20260611211058_idempotency_operation_scope_sweep.sql:1776-1782`). A
successful receive-and-reverse therefore **necessarily increases** the row count. An acceptance
demanding the count return to its starting value can only be satisfied by deleting audit history,
which is forbidden. Expect **both** the original and the reversal row to remain, and assert that
their quantities sum to zero.

**Negative:** a non-admin cannot create a permanent brand row. Allocations that sum to **less
than** the line quantity are rejected; allocations that sum to **more** are rejected; a
**unit-mismatched** allocation is rejected; a **replayed** allocation with the same idempotency
key does not double-write *(finding 7)*.

**Closes:** B-16 (brand half — see §6), B-17, C-28, C-29, C-43 (capture half), D-13, D-14,
D-15, T-6, T-7, PRD 1.9, 1.9a, 1.9a-i, 1.9a-ii, 1.9a-iii, 1.9a-iv, 1.9b.
**Gates:** as WP-1. **This changes the crew's daily routine** — the D-K escape hatch is what
keeps a truck from stranding at the dock.

---

### WP-4 · EPA auto-seed through propose-review-commit — **migration**

> **Revision 3 — this package was rewritten after Sol's review (findings 1, 5, 12).** Revision 2
> said "no migration" and told the builder to map EPA ingredients "to canonical acids." Both were
> wrong. The text below replaces them; do not restore the earlier wording.

**Builds:** the EPA lookup persists what it currently fetches and discards — ingredient rows,
label URL, accepted date, `productStatus`, `isCancelled` — **into the columns WP-1 created**.
Everything lands as **proposed** in the D-I shape; nothing writes to live ingredient tables
until Mason approves.

**Where a concentration attaches — the rule that makes this package safe (R-4, D-A):** an EPA
label states a concentration for a **specific chemical form** — "5.4 lb glyphosate IPA salt per
gallon", not "5.4 lb glyphosate". The importer therefore **resolves or creates the specific form
row and attaches the concentration there.** `canonical_ingredient_id` is used **only** to group
and find that row; it never receives a concentration.

**Why this is the single most dangerous line in the whole build:** attach 5.4 to the canonical
acid and every downstream calculation reads it as acid equivalent. The true figure is
`5.4 × 0.741 = 4.0014`. The system then believes each gallon carries ~35% more active than it
does and quotes roughly 26 gallons too few on a 100-gallon job — silently, with nothing on
screen looking wrong. **A proof that does not show the stored foreign key pointing at the
specific form row has not proved this package.**

**Why this needs a migration *(finding 1)*:** the existing `product_label_drafts` queue and its
`create_label_draft` / `commit_label_draft` functions carry fixed arguments for signal word, REI,
PHI, EPA number and label rate. They have **nowhere to put** ingredient rows, specific-form ids,
concentration basis, brand proposals, label URL/date, cancellation state, or a typed-versus-EPA
conflict. A builder handed "no migration" either silently drops those fields or bypasses review
and writes straight to live chemistry.

**But WP-4 does NOT own the queue schema — WP-1 does *(blocker S-02, exact-snapshot Codex review
of PR #435, second pass)*.** An earlier revision said "this package extends the queue and its RPC
contract", contradicting WP-1 above, which moved the queue extension forward precisely because
**WP-3 needs it and the apply order runs WP-4 after WP-3.** Two execution documents disagreeing
about who owns a schema change is how the change gets built twice or not at all. The split is
exactly this, and nothing in a later section may restate it differently:

- **WP-1's migration** adds the typed versioned payload column, the `purpose` discriminator, and
  `proposed_brand_name` to `product_label_drafts`. WP-1 owns the queue's *shape*.
- **WP-4's migration** adds **only** the EPA-specific RPC, `create_label_draft_proposal`, on top
  of that shape. It adds no queue columns.
- **`create_label_draft` is never modified — by any package.** It is an eleven-parameter
  signature (`20260629210000_product_label_drafts.sql:122-132`) with a deployed caller; PostgreSQL
  cannot add a parameter in place, so touching it either drops the live signature or creates an
  overload. Both break `handleCreateSampleDraft` while the old frontend is still deployed.
- **Therefore every new payload column is NULLABLE or DEFAULTED, and its NOT-NULL force comes
  from a *purpose-conditional* CHECK, never a column constraint *(blocker 1, third pass)*.**
  This is the direct consequence of the two rules above and an earlier revision missed it: the
  payload table below marks `payload_version`, `purpose`, `source_product_data_version`,
  `ingredients[]`, `conflicts[]` and `epa_is_cancelled` as *not null*, while
  `create_label_draft`'s existing `INSERT`
  (`20260629210000_product_label_drafts.sql:181`) supplies **none** of them and cannot be changed
  to. Column-level NOT NULL would make WP-1's migration break every manual draft the moment it
  applies — and it applies **before** the PR merges, so the live app would start failing with no
  deploy to blame. The constraint is written as
  `CHECK (purpose <> 'epa_label_seed' OR (payload_version IS NOT NULL AND ...))`: strict for the
  purposes the new RPCs create, permissive for `manual` rows the legacy path still writes.

**WP-1's proof must exercise the legacy path, not just the new one *(blocker 1, third pass)*.**
Proving `create_label_draft_proposal` creates a row proves nothing about the caller that is
already deployed. After WP-1's migration applies: call **`create_label_draft` with exactly
today's five named arguments** and show it still succeeds with `purpose = 'manual'`; then
**commit that draft through `commit_label_draft`** and show the existing manual review flow
completes unchanged. A create-only proof would have shipped a migration that breaks commit.

WP-4 proves every planned field survives propose → review → commit intact.

**The payload contract, stated exactly — "typed, versioned payload" is not a contract *(closed
reviewing PR #435)*.** Prose a builder cannot fail is prose that lets data vanish between propose
and commit while the implementation still "matches the plan". The queue extension carries:

| Field | Type | Null? | Notes |
|---|---|---|---|
| `payload_version` | `int` | no | Starts at `1`. Validated by a **CHECK constraint in WP-1's migration** and re-checked by `create_label_draft_proposal`, which **rejects** an unknown version rather than coercing it. **Not** by `create_label_draft`, which is never modified |
| `purpose` | `text` | no | Discriminator, CHECK-constrained to `manual`, `epa_label_seed` or `brand_proposal`. **Defaults to `manual`** — see the compatibility note below. A new purpose is a new CHECK member in a later migration, never free text |
| `source_product_data_version` | `int` | no | The product's `product_data_version` **at proposal time**. `commit_label_draft` refuses the commit if the product has moved on since — see below |
| `ingredients[]` | `jsonb` array | no (may be empty) | Each element carries `concentration_value` `numeric`, `concentration_unit`, `basis`, `source`, and **exactly one** of: `ingredient_id` — an existing specific chemical-form row, **never the canonical parent** — or `proposed_form` (see below) |
| `proposed_form` | `jsonb` | yes | Only on elements with no `ingredient_id`. Carries the form's `name`, `cas` if the label states one, and `canonical_ingredient_id` — the parent it groups under. **This is a proposal, not a row** |
| `label_url` | `text` | yes | |
| `label_accepted_date` | `date` | yes | |
| `epa_product_status` | `text` | yes | |
| `epa_is_cancelled` | `boolean` | no | Defaults `false`, never NULL — a NULL here reads as "not cancelled" on screen |
| `proposed_brand_name` | `text` | yes | D-K |
| `conflicts[]` | `jsonb` array | no (may be empty) | Each element names the field, Mason's live value and the EPA value. **Populating this never overwrites the live value** (D-L) |

Nullable means *the label genuinely may not state it*. It never means "the importer may drop it."

**`brand_proposal` is a third purpose, and it exists because D-K needs one *(blocker S-02,
second pass)*.** WP-3's escape hatch drops a crew-typed brand name into this same queue, but an
earlier revision offered only `manual` and `epa_label_seed`. Neither fits: `manual` routes the
row through the legacy hand-entered **label** path — which commits signal word, REI, PHI and
chemistry that a brand proposal does not carry — and `epa_label_seed` asserts an EPA lookup that
never happened. A crew-typed brand would have had no unambiguous commit route at all. So:

- A `brand_proposal` row carries `proposed_brand_name` plus, optionally, an EPA number read off
  the jug; its `ingredients[]` array is **empty** and stays empty.
- It is reviewed in the same D-I queue and shown as a *proposed brand*, never as a label draft.
- Committing it writes **one `product_brands` row and nothing else** — no chemistry, no label
  fields — through the brand-commit path, **not** `commit_label_draft`. Rejecting it writes
  nothing and leaves the receiving record's snapshot untouched, because the snapshot already
  carries the typed name (PRD 1.9a-iii).
- **"The brand-commit path" is not a specification — here is the RPC *(finding 6, fourth pass)*.**
  Naming an undefined path is how a builder invents an unguarded one, and this call writes an EPA
  number that reaches customer paperwork. **`commit_brand_proposal` is owned by WP-1**, alongside
  the queue schema it resolves, because **WP-3 writes these proposals and applies before WP-4** —
  the same reason the queue shape moved to WP-1. It is `SECURITY DEFINER` with
  `SET search_path = public, pg_temp`; it resolves the actor from `auth.uid()` inside the function,
  never from an argument; it is **admin-only per D-S**; and it accepts and enforces
  `p_idempotency_key`. In **one transaction** it locks the proposal row `FOR UPDATE`, refuses if
  the row is not still `pending` (so a double-approve cannot create a second brand), inserts the
  `product_brands` row, writes an actor-bound audit row, and sets the queue row to `approved` with
  the resulting `brand_id`. Rejection is the same RPC's refuse path: status `rejected`, audit row
  written, no brand created. `EXECUTE` to `authenticated` only, never `anon`.
  **Proof:** approve a proposal and show one brand row, one audit row and a resolved queue row;
  **replay the same key** and show no second brand; **approve it again with a new key** and show
  it is refused because the row is no longer pending; **call it as a non-admin** and show it is
  refused with nothing written.
- **WP-1's CHECK must include `brand_proposal` from the start.** WP-3 writes these rows, and
  WP-3 applies before WP-4; a CHECK that gains the third member only in WP-4 makes every D-K
  receive fail with a truck at the dock.

**`purpose` must not break the manual draft path that is already live *(Mason, 2026-08-20)*.**
`handleCreateSampleDraft` (`src/pages/LabelReview.tsx:370-382`) calls `create_label_draft` today
with `p_product_id`, `p_source_note`, `p_confidence`, `p_status` and `p_idempotency_key` — and
**no purpose**. Because this plan applies migrations *before* the PR merges, there is a window
where the new function is live and the old caller is still deployed. A required
`epa_label_seed`-only discriminator therefore breaks that caller outright, and defaulting it to
`epa_label_seed` is worse — it silently relabels hand-entered drafts as EPA proposals and routes
them through the EPA commit path. **So `purpose` defaults to `manual`**, which is precisely what
an argument-less legacy call means.

**Two corrections here, both mine, both caught by review rather than by me.**

*First:* "optional and additive" is **wrong in PostgreSQL.** A function's identity **includes its
full parameter list**, so `CREATE OR REPLACE FUNCTION` **cannot** add a parameter — not even one
with a `DEFAULT`. It creates a **second overload**, precisely the accidental-dual-overload class
this repository's migration-drift gate exists to catch, or it requires dropping the live signature
mid-window and breaking the deployed caller — the same trap WP-3 already refuses for
`receive_po_items`.

*Second:* **`create_label_draft` is not a five-argument function.** It is an **eleven-parameter**
signature — `p_product_id`, `p_signal_word`, `p_rei_hours`, `p_phi_days`, `p_epa_registration`,
`p_max_label_rate`, `p_max_label_rate_unit`, `p_source_note`, `p_confidence`, `p_status`,
`p_idempotency_key` (`20260629210000_product_label_drafts.sql:122-132`). `handleCreateSampleDraft`
merely passes **five of them by name** and lets the other six take their defaults. Reading arity
off a call site is how that error happened; **named arguments hide arity completely.**

**Resolution — do not touch `create_label_draft` at all.** Its exact eleven-parameter signature
stays byte-identical, so the deployed caller keeps working through the apply-before-merge window
and no overload is created. The EPA path gets a **new, distinctly named public RPC** —
`create_label_draft_proposal` — carrying the typed payload and `purpose`. Per CRX canon it is
`SECURITY DEFINER` with `SET search_path = public, pg_temp`, enforces the actor and admin check
rather than trusting a passed-in id, takes `p_idempotency_key text DEFAULT NULL`, and ships narrow
grants in the same migration. **The internal helper it delegates to is not the public surface:**
`REVOKE ALL ... FROM PUBLIC, anon` and grant EXECUTE only to the roles that need it, so exposing a
`SECURITY DEFINER` helper never becomes the privilege boundary.

**Proof:** the unchanged eleven-parameter call succeeds against the applied migration *before* the
code merges, and `pg_proc` holds **exactly one** `create_label_draft` and **exactly one**
`create_label_draft_proposal` afterwards — asserted by query, not by reading the migration.

**A stale proposal is refused at commit, not merged blindly *(caught reviewing PR #435)*.** The
gap: if an admin edits a product's chemistry after an EPA proposal is created but before Mason
approves it, the draft's `conflicts[]` describes a product state that no longer exists — so
committing it can overwrite newer typed chemistry with older EPA values, defeating both **D-E**'s
compare-and-set rule and **D-L**'s typed-value precedence. Storing
`source_product_data_version` at proposal time closes it: **`commit_label_draft` compares it to
the product's current `product_data_version` and refuses the commit if it has moved**, sending the
proposal back to be re-derived against current chemistry rather than silently winning. Prove it:
create a proposal, edit the product's chemistry, then attempt the commit and show it **refused**
with the live typed value intact.

**An unknown chemical form is staged, not created on sight, and not refused *(corrected reviewing
PR #435)*.** An earlier draft of this contract stored only an existing `ingredient_id`, which left
the importer two bad options for a form `active_ingredients` does not yet hold: create the row
immediately — a write to live chemistry *before* Mason approves, breaking the proposal-only
boundary this whole package rests on — or refuse it, which would mean WP-4 can only auto-seed
products whose forms someone typed by hand in WP-1, gutting the ~287-product scope. Neither is
acceptable. So the draft **carries the proposed form's identity and its canonical mapping** in
`proposed_form`, and **the form row and its concentration are created together, atomically, during
the approved commit.** The refusal that still stands is the one that matters: an unknown form is
never **guessed into the canonical parent** — it is staged as its own proposal, or nothing.

**`commit_label_draft` reads every field above by name and writes each to its mapped column** —
`ingredients[]` into `product_active_ingredients` keyed on `ingredient_id`, resolving each
`proposed_form` into a new `active_ingredients` row **in the same transaction** first; the label
and status fields into the `products` columns WP-1 created. **A field present in the payload with
no mapped destination is a hard error, not a silent skip.** A commit that creates a form row but
fails to attach its concentration must roll back both.

**Round-trip assertion, required (R-9):** propose a draft populating **every** field above
including both array fields, read it back after review, commit it, and assert field-by-field
equality across all three reads. Assert arrays **by element, not by length** — a length check
passes while `ingredient_id` points at the canonical parent, which is the exact 35% failure this
package exists to prevent.

**Conflict rule (D-L):** where a lookup disagrees with a value Mason typed, **his value stays
live** and the EPA version is stored beside it, flagged as a difference. A lookup never
overwrites hand-entered data.

**"Stored beside it" needs a database invariant, not just prose — and this belongs in WP-4, not
Phase 2 *(blocker found by the exact-snapshot Codex review of PR #435)*.** The gap: WP-4 says
every `ingredients[]` element is committed into `product_active_ingredients`, **and** that a
conflicting typed value "stays live" with the EPA value beside it. Those two sentences together
permit **two rows for the same chemistry with no rule about which one counts.** A consumer can
then sum both concentrations or pick one nondeterministically — and summing two concentrations for
one active is the same class of error as the ~35% one this package exists to prevent. The ledger
deferred this to Phase 2 as review finding 16, but **WP-4 performs the live write in Phase 1**, so
Phase 2 is too late.

**The invariant:** exactly **one effective row per `(product_id, ingredient_id)` — `basis` is
NOT part of the key *(blocker S-01, exact-snapshot Codex review of PR #435, second pass)*.**
An earlier revision keyed the index `(product_id, ingredient_id, basis)`, which reopens the very
defect it was written to close: a typed **4.0 lb acid-equivalent/gal** row and an EPA **5.4 lb
salt (active-ingredient)/gal** row have *different* bases, so both stay effective and a consumer
can sum them to 9.4 — nonsense chemistry, and the same silent ~35% class of error as D-A. Acid
equivalent, active ingredient, oxide and elemental are **alternate representations of one
concentration, never additive quantities.** The index is therefore partial-unique on the
effective rows over `(product_id, ingredient_id)` alone, and the chosen basis is an attribute of
that single row. Enforced by the index — not by convention. Every
`product_active_ingredients` row therefore carries an explicit **effective / proposed** state;
there is no implicit "the newest one wins" and no nullable third state. `commit_label_draft`
**never** creates a second effective row: where an effective row already exists for that key, the
EPA value is retained as **proposed/audit data only** unless a single atomic commit both retires
the prior effective row and promotes the new one. Mason's typed value stays effective by default
(D-L); the EPA figure is visible beside it as a flagged difference and is **not** readable as
chemistry until he approves the swap.

**A partial unique index gives *at most* one, not *exactly* one — and proposed rows must not be
readable as chemistry *(finding 1, fourth pass)*.** Two gaps remain once the index is in place.
First, the index permits **zero** effective rows: a state where an ingredient has only proposed
rows reads as "this product contains no measured amount of this active", which a rate calculation
will happily treat as nothing rather than as unknown. Second, `product_active_ingredients` is
readable in full, so any consumer that forgets a `state = 'effective'` predicate silently reads
proposed EPA chemistry as live — the same failure the invariant exists to prevent, arriving
through a missing WHERE clause instead of a duplicate row. So:

- **Reads go through an effective-only view or RPC**, and **direct SELECT on the base table is
  revoked** for application roles. A consumer cannot forget a predicate it never writes.
- **Every ingredient that has any row has exactly one effective row.** Promotion and retirement
  happen in **one transaction** — the prior effective row is retired and the new one promoted
  together, never as two statements — so no window exists in which the count is zero.
- A proposal for an ingredient with **no** existing effective row is committed by promoting it
  directly; it is never left proposed-only.

**Proof:** commit a proposal that conflicts with a typed value, then query the **effective-only
view** for that product and show **exactly one** row, still carrying Mason's number, with the EPA
row present in the base table and marked proposed. Then approve the swap and show the count is
**still exactly one**, now carrying the EPA number. **Run the same proof a second time with the
two rows on *different* bases** — typed `acid_equivalent`, EPA `active_ingredient` — and show the
index still refuses the second effective row. A proof that only exercises a same-basis conflict
has not tested the failure this invariant exists to prevent. **Negative cases:** attempt a direct
`SELECT` on `product_active_ingredients` as the application role and show it is **refused**; and
attempt to retire the effective row without promoting a replacement in the same transaction and
show the count never reaches zero.

**Cancelled registrations (D-T, reaffirmed as D-W):** a cancelled registration produces a **loud
banner on the product and a warning when it is added to a quote** — but nothing is blocked.
Sol's finding 26 argued this should fail closed when sell-through authorization cannot be
confirmed; **Mason declined it on 2026-08-19 (D-W) and it is settled.** Do not add a
sale-blocking gate and do not re-open this from the review document.

**Scope, honestly:** fills roughly **287** products. **317 have no usable EPA number, and ~123
of those are real pesticides** that cannot auto-seed until someone types the number in first.

**Deliberate pull-forward:** PRD 4.1 moves from Phase 4 to here — same fetch, splitting it
would run the lookup twice.

**Proof (R-2, R-9, R-11) — rewritten after finding 12, which had this package approving EPA data
onto a *real* catalog product with no negative case:** run the lookup on an **`[E2E]` clone
carrying a real EPA number**, never a live product. Approve the proposal, then **read back the
stored row and show `ingredient_id` pointing at the specific chemical-form row, not the canonical
parent** — this is the acceptance that closes the 35% failure above. Show the committed
concentration and its basis. A cancelled registration is visible in the app without re-running
the lookup. Revert the clone and show the revert.

**Negative cases, all required:** a typed value that conflicts with the lookup **keeps Mason's
value live** (D-L) and does not overwrite; a lower-priority source does not displace a
higher-priority one; an unknown chemical form is **staged as a `proposed_form` rather than guessed
into the canonical parent** — and the proof shows the form row and its concentration appearing
together only at commit, with nothing in `active_ingredients` beforehand; a malformed or
non-finite concentration is refused; nothing at all is written to live chemistry before approval.

**Closes:** B-8 (seeding half), B-22 (surfaced), D-23, T-18, PRD 1.4, 1.13, 4.1.
**Gates:** schema change → full migration review (RLS + drift) · **Mason's in-chat OK to apply
live** · R-12.

**Both bulk steps are live writes and each needs its own approval *(caught reviewing PR #435)*.**
Revision 3 gated only the commit. But **creating** roughly 287 proposal rows in
`product_label_drafts` is itself a bulk mutation of the production database — the rows are
`proposed` rather than authoritative, which governs how they are *read*, not whether writing them
touched live data. `AGENTS.md` requires explicit in-conversation approval before changing live
data, with no exemption for rows marked pending. So: **Mason approves the bulk proposal creation
before it runs, and approves the bulk commit separately before proposals become authoritative
chemistry.** Two gates, not one. R-12 (fresh backup) applies to both.

---

### WP-5 · Copy-from-sibling and searchable nickname — **migration**

**Builds:** copy ingredients / density / brands from a packaging sibling in one action; nickname
searchable on Products and in the QuoteBuilder picker.

**Eligibility is enforced, not assumed *(finding 18, narrowed by Mason's 2026-08-20 decision)*.**
"Copy from a packaging sibling" must define what a sibling *is* in the database: **same
formulation, same safener, same manufacturer.** Copying across any of those erases a real chemical
difference.

**Quality tier is deliberately NOT in that list *(Mason, 2026-08-20)*.** Revision 3 required the
RPC to refuse cross-tier copies, which directly contradicted **D-X** — his settled 2026-08-19
decision that tier protection stays at the display layer and that *"a builder must not add
`sourcing_tier` to `products` or build cross-tier substitution rules."* Asked to choose, he
**dropped the database restriction and left D-X standing.** So: **the copy RPC must not read,
compare, or refuse on `sourcing_tier`.** A `Gen Liberty` → `Gen Liberty: Higher Quality` copy is
**permitted**. The protection that matters is unchanged and lives where D-O and D-P already put
it — the tier is always shown, the two are never presented as interchangeable on matching actives
alone, and the adjuvant bias is stated on screen. Copying chemistry between tiers does not assert
they are equivalent; presenting them as substitutes would, and nothing here does that.

The copy runs in **one
transaction with an expected version for both source and target**, so a source edited mid-copy
aborts instead of blending two states.

**That transaction is why this package carries a migration *(caught reviewing PR #435 — revision 3
said "no migration" and was wrong)*.** Copying ingredients, density and brands atomically while
comparing expected versions for **both** products cannot be built as a sequence of
browser/PostgREST writes: each write is its own transaction, so a failed child write leaves the
target holding partial chemistry, and a concurrent source edit blends two states — exactly what
the expected-version guard exists to prevent. A repository-wide search finds **no existing
sibling-copy RPC**, so one must be created. Per CRX canon it is a mutating RPC and therefore
accepts and actually enforces `p_idempotency_key text DEFAULT NULL`, ships its RLS and grants in
the same migration, and sets `SET search_path = public, pg_temp`. Under a literal "no migration"
gate the builder's only options were to abandon the atomicity guarantee or to bypass the gate;
neither is acceptable.

**Its authorization boundary must be explicit — idempotency, grants and `search_path` are not an
auth model *(blocker 5, third pass)*.** This RPC overwrites a product's authoritative chemistry
and density in one call, which makes it one of the most destructive write paths in the package,
and an earlier revision never said who may run it. Stated now: it is **`SECURITY DEFINER` with
`SET search_path = public, pg_temp`**, it **resolves the actor from `auth.uid()` inside the
function** and never from a caller-supplied argument (actor forgery is the B7/B8/B9 class), it
**refuses any caller who is not an admin** — matching **D-J** and **D-S**, since a copy can
rewrite the EPA data that reaches customer paperwork — and it **writes an actor-bound audit row**
naming source product, target product, both expected versions and the fields copied. `EXECUTE` is
granted to `authenticated` only, never to `anon`, and revoked on any internal helper so a helper
never becomes the privilege boundary. **Negative proof, required:** call it as a **non-admin** and
show it is refused with nothing written — the target's `product_data_version` unchanged. A proof
that only exercises Mason's admin session cannot detect a missing check, which is exactly why the
proof-accounts protocol above exists.

**What a NULL key means here must be stated, not left to the signature default *(caught reviewing
PR #435)*.** `DEFAULT NULL` is the CRX signature convention; it is not a behavior spec, and
"idempotent" is not proved by a signature. This RPC is **not** naturally state-idempotent — a
second run re-copies chemistry and bumps `product_data_version` again, so a retried request
without a key is a second real write. Therefore: **a key is required for this RPC.** A call
arriving with `p_idempotency_key IS NULL` is **refused**, rather than silently executing an
unreplayable copy. Prove all three: **same key replayed** returns the first result and writes
nothing further and does not bump the version again; **missing key** is refused; **different key
on an unchanged source** is the ordinary second copy and is allowed.

**Proof (R-2, R-11):** type "Generic Callisto" → found. Copy from a sibling → the Bulk row
carries the same chemistry, and editing one afterwards does not change the other.
**Negative:** a cross-formulation copy is **refused**; a cross-safener copy is **refused**; a
**cross-tier copy succeeds** and the tier stays visible and distinct on both products afterwards
*(this is the D-X behavior, proved positively — an earlier revision required a refusal here)*;
a copy
against a stale source version is **refused**.

**Closes:** B-18 (entry half), PRD 1.8, 1.9c, 1.15.
**Gates:** schema change → RLS review + migration-drift review · exact-SHA `gpt-5.6-sol` proof ·
**Mason's in-chat OK to apply live** · R-10 · R-12.

---

## 4. The rest of the sequence — planned, not yet handed off

| Phase | Package | Already decided |
|---|---|---|
| **1b** | Product Data Workbook | Extend existing machinery. Separate `Ingredients` / `Crop Uses` tabs, never delimited strings. Rate columns read-only (D-C). Absent row = ignore (D-D). Concurrency via `product_data_version` compare-and-set (D-E) |
| **2** | Rate correction + unit standardization | **Highest risk.** `product_rates` child table with low/high/recommended, one per-acre quoting default enforced by the database. Old columns become a trigger-synced read-only mirror with app writes revoked (T-11, C-42). All **three** write paths updated together (C-31). Blank-unit rejection as a database CHECK with the hardcoded `'oz'` removed (`FieldAppChemicalEntry.tsx:305`). Remap spellings **first**, delete aliases second, change no conversion factor in the same change. All 37 per-100-gallon rows reviewed. Seed bases from day one (D-G). Behind `product_rate_source_mode` — **and evaluate the per-product Wells rollout gate for a pilot-first cutover** (D-F). **573 re-derived values reviewed by Mason, never bulk-rewritten.** Must state what `legacy` mode reads once the mirror exists |
| **3** | Comparison tool *(target ≈ 2026-09-18)* | Search through the canonical id (R-4); Halex GT at 4 pt must reproduce the sheet exactly — 33.44 oz / 3.34 oz / 1.09 pt; coverage gaps surfaced loudly; cost **and** customer price with selectable tier; adjuvant-exclusion note wherever a total appears; money parses to whole cents; RUP never shown as verified (B-21); `ingredient_map` retirement also touches the RLS contract fixture, generated types and the schema registry (C-36) |
| **4** | Adjuvants, crop/timing, note boxes | Crop **and** timing as pairs. Required-vs-recommended adjuvant. **Filling `quoting_notes` changes what 444 products auto-fill onto new quotes** — preview before/after first (B-19) |
| **5** | Families and packaging variants | Derived and **proposed**, never typed. Exclude zero-ingredient products. **Respect the sourcing tier** (C-43). Family-drift check. Match on the **specific** ingredient row (R-4) |
| **7** | Retire `unit_size` | Late for **breadth, not money** (C-41): 50+ files, a workbook column, function bodies to re-emit. `inventory_unit` becomes required in the same migration |
| **8** | Product images | Copied into CRX storage, not linked |
| **Parked** | Label rate / REI / PHI · required fields on create · RUP correction · density backfill · per-crop rates | Mason's calls, on record |
| **Tracked outside** | `blendMathValidator.ts` sums gallons and pounds (C-39) | Becomes **fixable** once WP-2 lands. Raise as its own ticket |

---

## 5. The Opus review gate

### Checkpoint 1 — every package, before it lands

Opus reads the diff and the proof evidence, and answers:

1. Does every issue this package claims to close actually get closed? **Reconcile the closes
   list against the proof list** — revision 1 had packages claiming closures their proofs never
   demonstrated *(Fable F-18)*.
2. Does the proof show behavior **running as a normal user**, or a test?
3. Are the CRX hard rules satisfied — RLS in the same migration, idempotency enforced,
   `SET search_path`, column grants, no floating-point money, `assertRpcResult` /
   `checkMutationResult`, `ConfirmModal` not `confirm()`, **plus R-10 (types, registry,
   typecheck, build)**?
4. Does the diff touch anything outside its package (R-8)?

**Opus does not only read the evidence — it independently re-runs at least one positive and one
negative read-only check per package** *(Fable F-16)*. Reading an attachment cannot catch
overstated evidence, and that is a known failure class in this project.

**Applies to every package including WP-0**, migration or not.
**Verdict:** `PASS` / `PASS WITH FINDINGS` / `BLOCK`. A `BLOCK` becomes the next Sol fix-spec
verbatim — capped at 3 rounds; only a finding surviving 3 rounds reaches Mason, with both
positions.

This is **in addition to** the `gpt-5.6-sol` exact-SHA gate.

### Checkpoint 2 — end of Phase 1

Full coverage audit at **xhigh** against §6, plus the PRD-requirement cross-check (the matrix is
issue-keyed, so PRD-only requirements like 1.10 are otherwise invisible — *Fable F-11*).

### Checkpoint 3 — end of project

The same audit across all phases, plus the eight end-to-end tests run live and observed.

### The scoresheet

`docs/plans/2026-08-19-product-data-model-COVERAGE.md`. **Sol fills evidence; Opus sets
verdicts; Sol never grades its own work.**

**Enforcement honesty:** the Sol proof is HARD (the `migration-apply-guard` hook physically
requires it). The Opus checkpoint is currently **process, not enforced** — acceptable while
every apply is interactive and Mason sees the verdict first; it would need hardening before any
hands-free run. See §8.

---

## 6. Coverage matrix — all 43 issues

`WP-n` = a package in §3. `Ph-n` = a later phase. Full evidence tracking lives in COVERAGE.md.

| Issue | Severity | Closed by | Proof |
|---|---|---|---|
| A-1 Ingredients not stored | BLOCKER | **WP-1** | Three ingredients persist, as a normal user |
| A-2 Family/variant/return unwritable | HIGH | **Ph-5** · return deferred | Families written for the first time |
| A-3 `unit_size` duplicates `inventory_unit` | MEDIUM | **Ph-7** | 50+ files migrated |
| A-4 Unit spellings inconsistent | MEDIUM | **Ph-2** | Quote total identical before/after the remap |
| A-5 Duplicates, blanks, a test row | MEDIUM | **WP-0** | One SKU = one sellable; all FKs resolve |
| A-6 Label rate / REI / PHI empty | HIGH | **PARKED** | — |
| A-7 No required fields on create | MEDIUM | **PARKED** | — |
| B-8 Same name, different substance | BLOCKER | **WP-1** + WP-4 + Ph-3 + Ph-5 | One search returns every salt form |
| B-9 Acid equivalent vs salt weight | BLOCKER | **WP-1** (D-A, three rules) | 5.4# and 5.5# compare on one basis |
| B-10 Density does not exist | BLOCKER | **WP-2** | Saved, re-read; missing density refuses |
| B-11 Liquid and dry chains disconnected | BLOCKER | **WP-2** | A `% w/w` product converts via its density |
| B-12 "Each" stored as an ounce | MEDIUM | **Ph-2** | The 8 affected products identified first |
| B-13 Rates from ranges, no rule | HIGH | **Ph-2** | 573 reviewed by Mason, none auto-rewritten |
| B-14 Two kinds of rate, one field | HIGH | **Ph-2** | MSO XL stores both rates |
| B-15 Blank rate unit → ounces | HIGH | **Ph-2** | CHECK rejects through all three write paths |
| B-16 Name carrying five facts | HIGH | **WP-3 + WP-1 — mechanism half only** | Brand list lives in rows. **The name strings still carry all five facts; name↔row drift is unaddressed and needs its own check** *(Fable F-18)* |
| B-17 No per-brand EPA number | HIGH | **WP-3** | Two brands, one spec, separate numbers |
| B-18 Siblings typed twice | HIGH | **WP-5** + Ph-5 | Bulk inherits in one action |
| B-19 Note box empty | MEDIUM | **Ph-4** | Before/after previewed before mass-fill |
| B-20 Spreadsheet has no math | HIGH | **Ph-3** | Halex GT: 33.44 / 3.34 / 1.09 |
| B-21 RUP count wrong | HIGH | **PARKED**; Ph-3 shows unverified | Never rendered as fact |
| B-22 A third can't auto-seed | HIGH | **WP-4** | The ~123 are listed |
| B-23 Biologicals fit neither unit | MEDIUM | **WP-1** | All 9 store a real CFU figure |
| B-24 Oxide vs elemental | MEDIUM | **WP-1** (D-A) | P₂O₅ and P distinguishable and convertible |
| C-25 `products` permission-carved | BLOCKER | **R-3**, first exercised WP-2 | A new column edits through the app as a normal user |
| C-26 Unit-cleanup order | BLOCKER | **WP-0** + Ph-2 | Every affected product still saves |
| C-27 Density in two places | BLOCKER | **WP-2** + **WP-3 proof** | Each weight shows which density it used — **both branches exercised** |
| C-28 Brands vs families | HIGH | **WP-3** + Ph-5 | Both ship; overlap flagged |
| C-29 Lot/tote chain unused | BLOCKER | **WP-3** (R-5) | Receiving with no lot and no tote works |
| C-30 Rate field in 83 files | HIGH | **Ph-2** (T-11) | Every reader still renders a rate |
| C-31 Three write paths | HIGH | **Ph-2** | All three write through the RPC |
| C-32 Workbook/rate collision | HIGH | **D-C** → Ph-1b | Rate columns ship read-only |
| C-33 Same ingredients ≠ interchangeable | HIGH | **WP-2** + Ph-3/Ph-5 | Safened and unsafened visibly differ |
| C-34 Return risk backwards | HIGH | **DEFERRED** | — |
| C-35 Return guard behind delegation | MEDIUM | `gotchas.md` (WP-2 PR) | A builder grepping public functions isn't misled |
| C-36 `ingredient_map` footprint | MEDIUM | **Ph-3** | Fixture, types, registry updated |
| C-37 No audit trail | HIGH | **WP-1** | Prior value and author shown |
| C-38 No rollback story | MEDIUM | **D-F** → Ph-2 | Honest scope stated; not a data rollback |
| C-39 Blend math adds gallons to pounds | MEDIUM | **Tracked outside** | Own ticket |
| C-40 Seed treatments, no basis | MEDIUM | **D-G** → Ph-2 | Enum carries both seed bases |
| C-41 `unit_size` overstated | — | **Ph-7** | Rationale corrected |
| C-42 Governance stronger than claimed | — | Reused in D-E, D-F, Ph-2 | Direct writes fail; RPC is the only path |
| C-43 Same ingredients, different products | HIGH | **WP-3** + Ph-5 + Ph-3 | `Gen Liberty` and `Gen Liberty: Higher Quality` never merge |

---

## 7. Prerequisites and approval gates

### Before anything starts

| # | Prerequisite | Who |
|---|---|---|
| 1 | **Restore Codex credits** | Mason |
| 2 | **Confirm the Codex-app Supabase connector** scope | Mason |
| 3 | **Fresh verified backup** — `/backup-db`, confirm `backups/LATEST-OK.json` re-stamps. No PITR exists | Prerequisite |
| 4 | **Repair the parked-migration scan** until `fleet-status.mjs` stops reporting `PARKED STATE UNKNOWN` | Prerequisite |
| 5 | **Land the plan documents** — push this branch, PR, merge (docs-only, standing policy) so every session and worktree shares the contract, then cut the build worktree from `main` | Prerequisite, needs Mason's OK to push |
| 6 | **Write the mission doc and ledger** (§8) | Prerequisite |

### Handoff mechanics *(Fable F-13)*

Sol works **in the build worktree cut from `main` after prerequisite 5**. Until that lands, the
plan documents exist only as unpushed local commits and a session starting from `origin/main`
cannot read them.

### Standing gates

Sol stops and gets Mason's explicit OK **in that session** before: applying any live migration ·
any bulk write to live product rows (WP-0, WP-4's commit) · pushing, opening a PR, merging, or
deploying · deleting anything.

`main` is protected: branch → PR → checks green (Vercel required) → resolve CodeRabbit → merge.
A merge to `main` deploys production.

---

## 8. Orchestration

**Full design: `2026-08-19-product-data-model-ORCHESTRATION.md`** — session topology, the
fifteen-step gate chain for WP-1, the apply-before-merge ordering decision, the collision
preflight, and the must-build list. Operational summary:

**Topology.** One Claude orchestrator session in a dedicated worktree, running packages
serially, started each sitting with `/run-loop docs/loops/product-data-model-loop-2026-08.md`.
Sol builds per-package as a headless ephemeral process via
`node scripts/codex-build.mjs <spec> --model gpt-5.6-sol --effort high`, which pins model and
effort and **strips Sol's Supabase, GitHub and Vercel tools** — so the builder physically cannot
reach live systems. Every consequential action (commit, PR, apply) stays on the hook-guarded
orchestrator side. **Exactly one session owns database writes.**

**Per-package chain — a summary of the numbered table in
`docs/plans/2026-08-19-product-data-model-ORCHESTRATION.md`, which is AUTHORITATIVE where the two
differ *(blocker 6, third pass)*.** An earlier revision of this paragraph collapsed **three
different proofs into one** — it named `write-apply-proofs.mjs` as an "exact-SHA proof" and placed
it before commit and PR. An executor following this summary would mint the *apply* proof before
there was a commit to bind it to, then push an unreviewed head, or reach the apply with a proof
already past its 30-minute life. The three are distinct and none substitutes for another:

- **Step 9 — the adversarial verdict.** A separate ephemeral `gpt-5.6-sol` high-effort review of
  the diff. Not hash-bound, not a proof file.
- **Step 10a — the exact-HEAD push proof.** Minted on the final commit, *after* docs + commit and
  *before* the first push, or the push guard blocks it. Re-minted at **13b** on the post-apply
  head, because the 10a proof is bound to the old SHA and is void there.
- **Step 12a — the apply proof** (`scripts/write-apply-proofs.mjs`, hash-bound, 30-minute
  expiry, hand-writing blocked by `review-proof-guard.mjs`). Minted **after Mason's human gate at
  step 12**, immediately before the apply — never at step 9 *(finding 11)*.

So: ground → spec → Sol builds → deterministic floor (typecheck/lint/build/test) → reviewer
fan-out (`rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`,
`compliance-reviewer`) → behavioral proof as a normal user → **Opus checkpoint 1** → **Codex
adversarial verdict** → docs + commit → **exact-HEAD push proof** → PR → Vercel + CodeRabbit →
**Mason's apply OK** → **mint the apply proof** → apply → smoke → registry refresh → commit,
re-mint, push (13a–13c) → merge → verify live.

**Must build before starting:** `docs/loops/product-data-model-loop-2026-08.md` (the mission
doc — `scripts/validate-mission-doc.mjs` refuses to launch without its five slots) and
`docs/loops/product-data-model-ledger.md` (the per-cycle status board, modeled on
`structure-wave-2-ledger.md`). COVERAGE.md tracks *issues*; the ledger tracks *cycles*. Both are
needed and they reference each other.

**Nice to have later:** a hard Opus-checkpoint proof wired into `migration-apply-guard.mjs`; a
COVERAGE-drift check in `npm run check:docs`; a scripted non-admin authenticated smoke so R-2
proofs are repeatable rather than manual.

---

**Nothing in this plan is built until Mason says go.**
