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

## Amendment 2026-08-26 — workbook-first data entry and top-seller priority (Mason, in-chat)

*Two owner decisions taken in chat on 2026-08-26. They change **how the data arrives and in what
order**; they change **no settled decision**. D-A through D-X and the three 2026-08-20 settlements
stand exactly as written. This section governs only the two subjects it names — Phase 1b's position
in the sequence, and the workbook-as-proposal path — and nothing else in this plan.*

> **Revision 13 — identity model SETTLED as D-AA (Mason), mechanism to WP-1's build cycle.**
> **Revision 12's ingredient-identity mechanism is WITHDRAWN.** A `gpt-5.6-sol` proof run on that
> small diff and five independent
> connector findings converged on the same conclusion from different directions: **the eight findings
> were not drafting defects in the mechanism — they were symptoms that the identity MODEL underneath
> it was never decided**, and several of the choices it silently made were **Mason's calls about his
> own catalogue**, not a builder's. Rather than patch a ninth time, the question went to its owner —
> **and Mason settled it in chat the same night (2026-08-27), in plain English after the trade-offs
> were explained.** **D-AA is SETTLED; the SQL that implements it is deliberately not written
> tonight.**
>
> *What revision 13 changes:*
>
> - **R12-1's mechanism is replaced by D-AA, now SETTLED.** The UNIQUE key over
>   `(lower(btrim(name)), coalesce(cas, ''))` and the mandated
>   `INSERT … ON CONFLICT … DO UPDATE SET name = EXCLUDED.name` form are **withdrawn, not deferred** —
>   and they are not a fallback, because **each contradicts a ruling**: the key contradicts D-AA-1/2,
>   the `DO UPDATE SET name` contradicts D-AA-4.
> - **Mason's rulings, in one line:** **CAS is the global identity where present, across alternate
>   names and spellings** (same CAS = same chemical, merged; his per-row review catches a label
>   typo); **a CAS-less row and a later same-name CAS-bearing proposal never auto-merge and never
>   silently fork — the merge is QUEUED for his explicit approval, side by side**; **a proposal whose
>   name matches an existing ingredient but claims a different canonical parent is REFUSED at import
>   with a named error**, corrected in the sheet and re-uploaded, because ambiguous chemistry never
>   enters the system. Plus the two technically-settled sub-answers: **no resolve path ever mutates a
>   shared row's display name**, and **multi-identity inserts take a deterministic order.**
> - **The GATE is reworded, not dropped:** it was *"WP-1 must not be built until D-AA is settled"*; it
>   is now **"WP-1's migration implements D-AA as settled here, and the concrete constraint and
>   resolve-or-create mechanism are specified and reviewed inside WP-1's own build cycle, under its
>   gates."** **A ninth same-night mechanism attempt is exactly what was decided against** — the
>   model needed an owner's answer, it has one, and the SQL is a build-cycle artifact with the
>   acceptance criteria as its proof obligations.
> - **The round-3 FINDING stays fully on record:** the cross-product same-form race is real and
>   **still unfixed in code** — settling the model does not close it, only building the mechanism
>   does. Carried as a **known open HIGH until WP-1 implements D-AA**, acceptable only because
>   nothing is built yet.
> - **R12-2 stands unchanged.** None of the eight findings touched the restamp fingerprint binding.
>
> **Revision 12 — hard merge-gate round three.** The third exact-SHA proof run returned **two HIGH
> findings**, both accepted. **Both are the same shape as R11-1 and worth naming as a pattern:** a
> rule that is correct **within the scope it was written for** and silent one level out. R11-1 was a
> rule scoped to one `purpose`; **R12-1 is a rule scoped to one DRAFT when the invariant it protects
> is GLOBAL**, and **R12-2 is a fingerprint scoped to one MODE of a two-mode RPC.**
>
> *What revision 12 changes, one line per item:*
>
> - **R12-1 (HIGH — global ingredient identity can split):** FOLLOW-UP 2's duplicate-element rule is
>   **per draft**, and commits serialize **per product** — so **two different products** concurrently
>   approving the **same new chemical form** each pass every check and each create their own
>   `active_ingredients` row for **one real-world identity**. Nothing in the plan made them collide.
>   The result is a **permanent silent split**: chemistry matching, MOA rollups and every
>   ingredient-keyed query see two half-populated forms forever after, and no later constraint can
>   safely merge them. *(**Revision 13 supersedes the fix, not the finding:** the constraint and
>   conflict-safe form Revision 12 prescribed are **withdrawn**; the identity model is now **settled
>   as D-AA (Mason, 2026-08-27)** with its mechanism assigned to WP-1's build cycle, and the race is
>   carried as a **known open HIGH until that lands**. Read this bullet for the finding; read D-AA
>   for its status.)*
> - **R12-2 (HIGH — the restamp fingerprint was underspecified):** `create_workbook_import_proposals`
>   serves **two modes** — batch import and by-id restamp — but R11-2 defined its
>   `request_fingerprint` only as *"the batch's canonical content identity"*, which says **nothing
>   about a restamp**. A reused key could therefore replay **another restamp's receipt** instead of
>   superseding the intended draft. **Fixed: the fingerprint binds the operation MODE plus every
>   mutation-defining input for that mode.**
>
> **Revision 11 — hard merge-gate round two.** The second exact-SHA proof run returned **one BLOCKER
> and one HIGH**, both new, both accepted. **Both are the same species of gap: a rule written for
> the case that prompted it rather than for the property it protects.**
>
> *What revision 11 changes, one line per item:*
>
> - **R11-1 (BLOCKER — EPA-state invalidation covered one purpose out of two):** PR-3's commit-time
>   EPA re-check bound **`workbook_import` chemistry only**, while this same section concedes that
>   **no route setting `epa_registration` reliably bumps `product_data_version`**. So an
>   **`epa_label_seed`** draft reviewed against registration **X** could commit after the product
>   moved to **Y**, writing X-derived chemistry the reviewer never saw — through the staleness guard,
>   past the digest (the draft is byte-identical), and past PR-3 (wrong purpose). **Fixed uniformly:
>   every typed CHEMISTRY draft stores the product's then-current `epa_registration` as a
>   draft-level `source_epa_registration` at proposal time, and the commit refuses on ANY difference
>   — both purposes, both directions, absence transitions included.**
> - **R11-2 (HIGH — idempotency receipts bound neither actor nor intent):** the three new mutating
>   RPCs required `p_idempotency_key` but never said what the receipt is bound **to**, so one key
>   could replay a result for **different data or a different caller**. **This repo already settled
>   the pattern** in `20260803010917_bind_idempotency_to_mutation_intent` — server-derived
>   `request_actor_id` and `request_fingerprint` on the receipt, an advisory lock serializing same-key
>   calls before any mutation. **All three contracts now follow it; none of it is invented here.**
>
> **Revision 10 — hard merge-gate round (exact-SHA Sol proof).** The hard merge gate returned **one
> BLOCKER and two follow-ups**, all accepted. **Say what the blocker was, plainly, because it is the
> most useful thing in this block: it was a PROSE-VERSUS-PREDICATE divergence** — Revision 9 wrote
> the rule correctly in English and quoted a `CHECK` that could not enforce it. A quoted predicate
> is **code**; prose agreeing with itself proves nothing about the SQL underneath it.
>
> **And it is the SAME fail-open, in the SAME predicate shape, for the SAME reason, a SECOND time.**
> This document already diagnoses it once, in the very bullet that carries the constraint: *"Revision
> 1 put the citation requirement here, and that **fails open**: `create_label_draft` writes `manual`
> rows and is never modified, so a `manual` row carrying typed elements escaped the citation rule
> entirely."* The citation requirement was moved down to the **element** precisely because a
> `purpose <> 'workbook_import' OR (…)` constraint **cannot reach a `manual` row at all** — and
> Revision 9 then placed a **new** prohibition on `manual` rows back into that identical shape.
> **The durable rule, so there is no third time: a prohibition that must bind `manual` rows may
> NEVER live inside a disjunct that `manual` short-circuits. Anything binding `manual` rows gets its
> own conjunct — or moves to element-level enforcement, which is what the citation rule did.**
>
> **Why it survived to the hard gate — state this accurately rather than kindly: the intervening
> revisions were never automatically reviewed at all.** The file crossed **CodeRabbit's size ceiling
> around Revision 6**, after which its reviews returned **"No files to review"**; Revisions 7, 8 and
> 9 therefore landed with **no automated reader**. The **exact-SHA merge-gate proof was the first
> automated reader of the Revision 9 text, and it caught this on first look.** The lesson is not
> that layered gates find different things — it is that **unreviewed revisions accumulated a real
> spec bug**, and a document that has outgrown its reviewer is a document being changed blind.
>
> *What revision 10 changes, one line per item:*
>
> - **BLOCKER (Sol — the predicate does not implement the prose):** the quoted purpose-conditional
>   `CHECK` began `purpose <> 'workbook_import' OR (…)`, so for a **`manual`** row the first disjunct
>   is **TRUE and PostgreSQL accepts the row without evaluating anything else** — Revision 9's
>   manual-typed-elements prohibition, written immediately below it, was **prose the predicate never
>   enforced**. An admin could create a typed draft as `manual`, or relabel one, and the legacy
>   commit guard — which keys on `purpose` — would accept it, bypassing the digest, version,
>   citation and ingredient protections. **Fixed by making the constraint a CONJUNCTION of two
>   purpose arms**, plus the two negative database proofs that would have caught it.
> - **FOLLOW-UP 1 (adopted in-plan, not deferred — this also closes both round-six connector
>   follow-ups):** the **predicated-`UPDATE` alternative is DROPPED entirely.** The explicit
>   **product-row-`FOR UPDATE`-first** form is **THE** form, mandatory for all three write paths —
>   both commit RPCs and the restamp — one lock order, stated once, referenced everywhere.
> - **FOLLOW-UP 2 (adopted):** **duplicate chemistry elements within one draft are refused** — at
>   import and again at commit — because two elements resolving to one logical ingredient identity
>   made the single-effective-row outcome depend on evaluation order.
> - **ITEM 4 (P1 — a REJECTION must not advance the version):** the one-transaction sequence bumped
>   `product_data_version` before the authoritative writes, but **a `rejected` decision still reached
>   the bump** — and a rejection writes no chemistry and no attributes. **A phantom bump would
>   spuriously stale every sibling draft and every workbook compare-and-set for that product**,
>   manufacturing exactly the staleness storm the version exists to prevent. **Fixed: both commit
>   RPCs branch on the decision FIRST** — the rejection path takes **only the draft lock**, writes
>   only the queue status and its audit row, and **the bump belongs exclusively to the approve
>   path.**
> - **ITEM 5 (P2 — the observed EPA number had nowhere to live):** the plan said a cited label's EPA
>   registration differing from the product's "lands in `conflicts[]`", while R2-5 made `conflicts[]`
>   **commit-computed and importer-forbidden** — so the importer had **no field to record what it
>   read**, and the mismatch was silently discarded. **Fixed: a nullable element-level
>   `observed_epa_registration`** carries the document's statement; the commit RPC computes the
>   difference into `conflicts[]` from it; G-5 renders it; **never auto-resolved in either
>   direction.**
>
> **Revision 9 — PR #498 review round five (two residuals).** A `manual` row carrying typed payload
> elements is now FORBIDDEN by the purpose-conditional CHECK (an earlier clause permitted it, which
> reopened FIX-A through a side door — and a CHECK binds every write path, the admin UPDATE policy
> included); and the restamp path adopts the commit RPCs' lock order — product row first — reading
> the fresh draft's version under that lock so a replacement cannot be born stale against a
> concurrently committing sibling.
>
> **Revision 8 — PR #498 review round four (two residuals).** Two targeted corrections: the
> sequencing summary's "`commit_label_draft` itself stays untouched" leftover — which contradicted
> FIX-A's WP-1 body guard and could have led a builder to omit the one protection against the
> deployed legacy path — now acknowledges the guard; and RR-3's conversion constants move from
> TypeScript named exports (unreachable from a PostgreSQL RPC) into the `net_weight_lb_factor`
> IMMUTABLE SQL function WP-2's migration creates, with exact factors stated and a cross-runtime
> equality proof required for any display-side mirror.
>
> **Revision 7 — PR #498 review round three (two connector P1s).** Revision 4 rewrote this amendment
> after a third
> adversarial `gpt-5.6-sol` round closed every outstanding finding and returned seven more, all
> accepted, and **that round closed the Sol gauntlet** — no adversarial finding stands open against
> it. **Revision 5 folded in PR #498's first review round** — CodeRabbit and the Codex GitHub
> connector, six findings, all accepted. **Revision 6 folded in the second round** — three Codex P1s
> and two CodeRabbit findings, five in all, all accepted. **Revision 7 folds in the third round —
> two Codex connector P1s, both accepted, and one of them says revision 6 asserted something
> FALSE.** Where the text below disagrees with
> revision 1, 2, 3, 4, 5 or 6, it **replaces** them; do not restore the earlier wording. **Revision 4
> was the last word of the adversarial gauntlet, not the last word of this amendment:** the gauntlet
> is closed, and it is the pull-request review, running on different eyes, that has now reopened the
> text three times.
>
> *What revision 7 changes, one line per fix:*
>
> - **FIX-A (blocker — Codex P1; revision 6's "by construction" claim was FALSE and is corrected,
>   not defended):** revision 6 asserted that a typed draft is **structurally unreachable** through
>   legacy `commit_label_draft` and told builders **not to guard it**. **Both halves were wrong.**
>   The deployed `LabelReview` screen loads **every** `product_label_drafts` row
>   (`src/pages/LabelReview.tsx:210-220` — `select('*')`, no `purpose` filter, no status filter) and
>   sends decisions to legacy `commit_label_draft`, whose body checks the admin role, the decision
>   value, idempotency and the draft's **status** — and **never reads `purpose`**
>   (`20260629210000_product_label_drafts.sql:244-284`). A typed draft **is** reachable: it would
>   apply the scalar label fields, **skip the digest, version, citation and ingredient logic
>   entirely**, and **close the queue row**. **Resolution: WP-1's migration re-emits
>   `commit_label_draft`'s body at its unchanged ten-parameter signature, adding EXACTLY ONE thing —
>   a typed-purpose guard that refuses any draft whose `purpose <> 'manual'`.**
> - **FIX-B (blocker — Codex P1):** revision 6's transaction sequences placed the
>   `product_data_version` bump **after** the authoritative writes. Under the **predicated-`UPDATE`**
>   form, combined with RR-4's **return-normally** refusal semantics, a **zero-row bump would commit
>   the writes that already happened** — the compare-and-set defeated by ordering rather than by
>   racing. **Resolution: in both commit RPCs the version compare-and-set executes BEFORE any
>   authoritative mutation**, so a staleness refusal is one **by construction** — this time the
>   phrase is earned.
>
> *What revision 6 changed, one line per fix — unchanged and still in force except where FIX-A and
> FIX-B correct it:*
>
> - **RR-1 (blocker — Codex P1):** provenance gets **a destination per fact, not one column per
>   field** — `<field>_source`, `<field>_source_url` and `<field>_source_note` land on `products` for
>   **every** document-derived attribute, because revision 5's single `*_source` column **discarded
>   the `source_url` and `note` the payload was required to carry**, leaving the round-trip audit
>   unable to prove which document supported the effective value. The attribute side now **mirrors
>   the chemistry triplet PR-4 put on `product_active_ingredients`.**
> - **RR-2 (blocker — Codex P1):** a proposed TEXT value must be **trimmed non-empty** — at import,
>   in the CHECK, and again at commit — because `''` and `'   '` satisfied "present and non-null"
>   and could **replace a live `formulation_type` or `safener` with a blank**; a documented absence
>   is expressible **only** as the explicit cited literal `none`.
> - **RR-3 (blocker — Codex P1):** `net_weight_unit` is **CHECK-constrained to a closed set and
>   normalized at commit**, mirroring density's own contract — free text let a sheet propose a unit
>   nothing could convert — and the **entered unit** is retained beside the normalized figure like
>   every other entered value.
> - **RR-4 (CodeRabbit Minor):** every refuse-path sentence that said a refused commit "writes
>   nothing" is corrected — a **validation refusal writes exactly one refusal audit row**, which is
>   what PR-2's contract already required and what the proofs must assert.
> - **RR-5 (CodeRabbit Major):** the typed commit path this amendment specifies had **no owner** —
>   "WP-4's migration adds only `create_label_draft_proposal`" left nobody assigned to build it, and
>   the live `commit_label_draft` does none of what the amendment requires. **Resolved by the
>   NEW-RPC pattern this plan already set on the create side *(Mason, 2026-08-26)*: WP-4's migration
>   adds a SECOND new function, `commit_label_draft_proposal`**, which is the **only** commit path
>   for typed drafts. **`commit_label_draft`'s SIGNATURE is never modified by anyone** — and, per
>   **FIX-A**, its **body is re-emitted exactly once, by WP-1, to add the typed-purpose guard**;
>   **WP-4 adds nothing to it.**
>   *(This also closes the open item drafting revision 6 raised: the echoed `p_payload_sha256` is a
>   parameter the frozen signature could never have carried, and a new RPC takes it at birth.
>   **Arity note, checked against the installed definition:** the review round called
>   `commit_label_draft` eleven-parameter; that is `create_label_draft`'s arity —
>   `commit_label_draft` takes **ten**, `20260629210000_product_label_drafts.sql:212-224`. The point
>   is now moot, since neither number is being changed.)*
>
> *What revision 5 changed, one line per fix — unchanged and still in force:*
>
> - **PR-1 (blocker — Codex connector P1 and CodeRabbit Major, the same defect from two directions):**
>   the `product_data_version` compare-and-set is made **genuinely atomic** in **both** commit RPCs —
>   the **product** row is locked `FOR UPDATE` before the staleness comparison and held through the
>   write, or the bump is a single predicated `UPDATE` that must affect exactly one row — because the
>   draft-row lock alone cannot stop two drafts for one product committing on the same observed
>   version. *(**Revision 10 removes the second option:** the product-row lock is now the only
>   permitted form — see FOLLOW-UP 1. PR-1's requirement is unchanged; only its menu is.)*
> - **PR-2 (CodeRabbit Major):** a **validation refusal is not a rejection** — a refused commit leaves
>   the draft **`pending`** and writes an audit row describing the refusal; **`rejected`** is reserved
>   for an admin's explicit human rejection and for the restamp supersede, because a refused draft
>   must stay restampable.
> - **PR-3 (CodeRabbit Major):** the typed commit path **re-checks the usable-EPA
>   predicate at commit** for `workbook_import` chemistry *(**widened by R11-1**: that D-Z rule stays
>   workbook-only, but the separate EPA-state-invalidation comparison it inspired binds **every**
>   typed chemistry purpose)*, so a product that gained an EPA number
>   between proposal and approval **refuses** instead of committing workbook chemistry past D-Z's
>   structural split.
> - **PR-4 (CodeRabbit Major):** chemistry provenance is given a **destination** — WP-1's
>   `product_active_ingredients` carries **`source_type`, `source_url` and `note` in place of** the
>   single `source` column its column list names, and this section amends that list.
> - **PR-5 (CodeRabbit Major):** every `product_attributes` per-field provenance object gains
>   **`note`**, so the supplier named-document-reference rule has the same defined home on the
>   attribute side that it already has on chemistry elements.
> - **PR-6 (CodeRabbit Minor):** the D-Z cell's **claim about the worklist band's composition is
>   removed**, and the rule it supported is restated in a **source-independent** form that does not
>   depend on how the band turns out to be composed.
>
> *What revision 4 changed, one line per fix — unchanged and still in force:*
>
> - **R3-1 (blocker):** the approval digest covers a canonical **envelope** — draft id, `product_id`,
>   `purpose`, `payload_version`, `source_product_data_version`, domain **and** payload — never the
>   payload alone, because the live queue's RLS lets an admin move a draft onto another product.
> - **R3-2:** every citation predicate now demands a **trimmed non-empty** value, so a whitespace-only
>   `source_url` or supplier note no longer passes as a citation.
> - **R3-3:** the two-domain sequence — commit chemistry, restamp the now-stale attribute draft,
>   approve it — is written down as the **normal path**, not a recovery.
> - **R3-4:** the importer's write surface is stated **completely** (queue rows, its own audit rows,
>   idempotency bookkeeping), and the safety property is redefined as **no writes to authoritative
>   chemistry, attributes, `products` or `product_brands`**.
> - **R3-5:** the restamp path **locks the stale draft `FOR UPDATE`** and re-verifies it under the
>   lock, so two concurrent restamps produce exactly one fresh draft.
> - **R3-6:** the retained entered net-weight tuple gets **real destination columns** on WP-2's
>   migration, following the `density_entered_value` precedent exactly.
> - **R3-7:** the digest's byte format is **server-defined** — the draft-creating RPCs store it, the
>   review surface echoes it, the commit RPC recomputes it from the stored row; **the client never
>   serializes JSON for hashing.**
>
> *Revision 1's four blockers, kept on the record so they are not reintroduced:* it gave Phase 1b
> **no migration and no named proposal-creation path**; it pointed attribute commits at **"WP-2's
> density/attribute commit RPC"**, a function whose contract is density-only; it permitted **one
> queue row to span two commit RPCs** and therefore two transactions; and it enforced citation **per
> `purpose`**, which fails open through the untouched `manual` path. All four stay closed.
>
> *What revision 3 established and revision 4 keeps in force, named the same way:* **Phase 1b moves
> again, to after WP-4**, because
> WP-4 is where the typed propose/commit machinery it rides on gets built *(R2-1)*; the attribute
> commit RPC gets a **name and an executable contract** — **`commit_product_attribute_proposal`**
> *(R2-2)*; approval is **bound to a content digest of what was rendered**, because the live queue's
> own RLS lets an admin edit a draft between render and click *(R2-3)* — **revision 4 widens that
> digest from the payload to the canonical envelope and moves its computation into the database, so
> read R2-3 only through R3-1 and R3-7**; **blank, omitted and null get
> one defined meaning**, so that an import can propose and replace but **never erase** *(R2-4)*; the
> **outer WP-4 payload fields are forbidden** on an imported row, closing the door on a regulatory
> field riding in beneath a chemistry review *(R2-5)*; revision 2's claim that the importer "holds no
> grant" to write chemistry was **false** — a `SECURITY DEFINER` body is not bound by caller grants —
> and is replaced by the protections that are actually real *(R2-6)*; **restamping is not a new
> function** *(R2-7)*; `per_package` is an **input basis normalized at commit**, not a storage shape
> *(R2-8)*; attribute **provenance gets real destination columns** *(R2-9)*; the queue status
> `proposed` **does not exist on the live table** and is `pending` throughout *(R2-10)*; the
> `source_url` nullability contradiction is resolved *(R2-11)*; **"usable EPA number" is defined
> exactly once**, with its escape hatch *(R2-12)*; the ranking's deliberate double-count is
> **disclosed rather than corrected** *(R2-13)*; **worklist-derived counts are removed** from this
> public repo *(R2-14)*; and the rename-refusal claim is aligned with the mechanism that actually
> refuses *(R2-15)*. Nothing here reopens D-A through D-X.

### The two decisions

| # | Question | Decision |
|---|---|---|
| **D-Y** *(Mason, 2026-08-26)* | D-V holds the comparison tool to ≈2026-09-18, but 604 products cannot be filled by then. Which products must be right first? | **Top products first.** The Sept-18 scope is Mason's **best-selling products**, ranked by real sales usage, not the whole catalogue. A **ranked priority worklist** derived from live orders and deliveries drives the order of data entry; the long tail fills afterwards, on no deadline. **D-V's protection is unchanged** — if the date comes under pressure it is the schedule that slips, never the quality of the Phase 2 rate review |
| **D-Z** *(Mason, 2026-08-26)* | D-N built the entry screen for speed because Mason personally faced 33–56 hours of chemistry and density typing. Must that typing be *his*? | **No — an external AI agent drafts it into an Excel workbook, and the workbook uploads as proposals.** Every filled **element** cites the document it was read from. **Nothing from a workbook writes live chemistry**; every row lands in the D-I propose-review-commit queue and Mason approves it, quickly, because the citation sits beside the value. **The WP-1 keyboard-driven entry screen still ships — D-N is unchanged** — because it is the review/correction surface and the path for one-off edits. **The EPA/workbook split is structural, not a preference:** where a product has a **usable** EPA number the workbook carries **no chemistry for it at all** — that chemistry arrives through **WP-4's auto-seed**, and the import **refuses** a chemistry element for such a product with a named error rather than silently dropping it. The workbook fills **attributes** — density, net weight and its package basis, formulation type, safener — for **any** product, because EPA supplies none of them. **The rule stands on its own shape, not on how the worklist band turns out to be composed *(PR-6)*:** the split is **structural** — usable EPA number → WP-4's auto-seed, otherwise → workbook — and it reads the same whatever the band contains. For planning the Sept-18 scope, **treat the workbook as the primary chemistry source unless the regenerated worklist shows otherwise at build time**; the worklist is a snapshot of a moving number (see D-Y), so it is consulted when the work starts, never quoted here. No statement about the band's composition belongs in this document |

**"Usable EPA number", defined exactly once *(R2-12)*.** A product's `epa_registration` is **usable**
when `epa_registration IS NOT NULL AND btrim(epa_registration) <> ''` — the same predicate **WP-0**
and **B-22** already use, restated here once so the workbook split and the priority worklist cannot
drift apart on it. Every other statement in this amendment defers to this one. **Format validity is
deliberately not part of it:** whether a non-blank number actually resolves is **WP-4's lookup
concern**, and a product whose non-blank number fails that lookup is surfaced by **WP-4**, not by the
importer. **The escape hatch is stated so no product can be stranded with neither source path:** if
Mason then **clears** the bad number, `epa_registration` is blank, the product stops being
EPA-usable, and it becomes **workbook-eligible on the next import**.

### Sequencing change

**Phase 1b (Product Data Workbook, §4) pulls forward to immediately after WP-4** *(blocker, R2-1)*.
The order becomes WP-0 → WP-1 → WP-2 → WP-3 → WP-4 → **Phase 1b** → WP-5. Nothing else moves.

Revision 2 placed Phase 1b directly after WP-2, which put the importer **in front of the machinery it
rides on**. **WP-4 owns the typed propose/commit behaviour** — `create_label_draft_proposal`, and
`commit_label_draft_proposal`'s consumption of the typed `ingredients[]` payload *(RR-5)* — so
an importer applying before WP-4 would emit typed payloads that nothing yet knows how to commit, and
the first upload would queue rows with no approval path. Moving Phase 1b behind WP-4 means its
importer **rides on machinery that already exists when it runs**. **The S-02 bullet's "WP-4's
migration adds only the EPA-specific RPC" is amended by this section *(RR-5)*: WP-4's migration
adds TWO new functions — `create_label_draft_proposal` and `commit_label_draft_proposal`** — see
*The typed commit path is a NEW RPC* below, which states the boundary exactly. **`commit_label_draft`'s
signature stays untouched by everyone; its body changes exactly once — WP-1's typed-purpose guard
(FIX-A below), without which the deployed `LabelReview` flow could close a typed draft through the
legacy scalar-only path — and WP-4 adds nothing to it.**

**WP-2 remains a prerequisite; it is simply no longer the immediate predecessor.** It is still the
migration that creates `density_value`, `density_unit`, net weight per purchase unit,
`formulation_type`, `safener` and `nickname`, and it now also carries
`commit_product_attribute_proposal` (below), **the twelve per-field provenance columns *(RR-1)* and
the four retained-entry net-weight columns *(R3-6, RR-3)* the delta table names** — so every
attribute column and every attribute commit
path a workbook row proposes into exists well before any upload happens. **WP-3 now also lands
first**, which is a second gain rather than a cost: **WP-3's brand-aware density precedence is
already live when the first upload arrives**, so the stub-density window revision 2's ordering would
have opened is closed by the move rather than argued around.

**The resequencing costs no calendar time on the ≈2026-09-18 path** — say this plainly, because the
instinct is to read a later slot as a later finish. The template already exists and **needs no
database at all**, so the AI agent starts **filling** the workbook on **day one**. Only the **upload**
waits for Phase 1b. Filling and building were never serial; the resequencing moves the shorter of the
two.

Phase 1b gains a **bulk proposal import** mode: an uploaded sheet becomes **pending rows in the
existing D-I queue**, reusing the `purpose` discriminator and the typed versioned payload **WP-1
creates**. **A note on one word, because revision 2 got it wrong *(R2-10)*:** the live queue's
`status` CHECK admits exactly `pending`, `accepted`, `edited`, `rejected`, `needs_manual`
(`20260629210000_product_label_drafts.sql:29-31`) — **there is no `proposed` status and none is to be
added.** Where this amendment names a queue **status** it always means **`pending`**; "proposal" and
"proposed" survive only as the **concept** words, and **a "proposed row" is a queue row in status
`pending`** — nothing more. **Two of those statuses gain exact owners in revision 5 *(PR-2)*:** a
draft awaiting review — **and a draft a commit refused** — is **`pending`**, and **`rejected`** is
set only by an admin's explicit human rejection or by the restamp supersede. See *A validation
refusal is not a rejection* below.

**Phase 1b does not redesign the queue schema** — WP-1 owns the queue's shape and is the
only package permitted to change it, the same rule that moved the queue extension out of WP-4 and
into WP-1 (blocker S-02), restated here rather than reopened. **It does, however, carry a migration
of its own, containing exactly one new function** — see *Phase 1b carries its own migration* below.

**What WP-1's migration must therefore carry, named explicitly.** WP-1 is unbuilt and unapplied, so
each item below is a specification change to a migration that does not yet exist — never an edit to
an applied one. **One item — the typed-purpose guard *(FIX-A)* — changes the BODY of a function that
is already live, and that is a different thing from editing an applied migration:** the applied file
`20260629210000_product_label_drafts.sql` is never touched; WP-1's **new** migration issues a
`CREATE OR REPLACE FUNCTION` at the same signature, which is the ordinary CRX way to change a live
function and is exactly what the plan already does elsewhere:

- **`purpose` gains a fourth CHECK member, `workbook_import`, present from WP-1's first migration.**
  Same reasoning as `brand_proposal`: the package that writes these rows applies **after** WP-1, and
  a CHECK that gains its member later makes every import fail on arrival. Members are `manual`,
  `epa_label_seed`, `brand_proposal`, `workbook_import`, and `manual` remains the default (2026-08-20
  settlement 3, unchanged).
- **`source_type` and `source_url` on every payload *element*, not once per draft — and the element,
  not the purpose, is what carries the citation rule *(blocker, finding 4)*.** One workbook row may
  carry an ingredient read off the label beside a density read off the SDS; a draft-level source
  cannot express **D-M**'s trust order per value. The stored domain is `source_type` ∈ `sds`,
  `label`, `supplier`, `measured` — D-M's ranking exactly — but **`measured` is reserved for Mason's
  own in-app entry and is never importable** (G-2). The rule: **in any typed payload, whatever the
  row's `purpose`, every *filled* element carries its `source_type`, and its `source_url` where that
  type requires one**, and the commit RPCs **re-check** it and refuse an uncited element at commit.
  **A citation must be *trimmed non-empty*, never merely non-null *(R3-2)*** — a `source_url` of
  `'   '` is a blank cell wearing a citation's clothes, and it satisfied revision 3's predicate. The
  corrected predicate is quoted **exactly once**, in the payload-contract delta table below; the
  CHECK, this rule, the import RPC's refusal list and the commit re-check all refer to that one
  quotation rather than restating it.
- **`product_attributes` — a payload block for the WP-2 fields the current contract has nowhere to
  put.** The payload contract above carries chemistry, label URL/date and cancellation state only.
  A density, net weight, package count, formulation type, safener or nickname proposal has no home in
  it, and a builder facing that gap invents an untyped text field or writes the value live. The block
  carries `density_value`, `density_unit`, `net_weight_value`, `net_weight_unit`,
  **`net_weight_basis`**, `package_count`, `formulation_type`, `safener`, `nickname`, each with its
  own `source_type`, `source_url` **and `note`** *(PR-5 — the `note` is not optional decoration; it
  is where a `supplier`-sourced attribute puts its named-document reference, exactly as a chemistry
  element does)*. **Each of those three has its own destination column on `products` *(RR-1)*** —
  `<field>_source`, `<field>_source_url`, `<field>_source_note` — because a payload field with no
  mapped destination is a hard error in this plan, and revision 5 supplied one column for three
  facts. **`net_weight_basis` is load-bearing, not decoration
  *(finding 7)*:** WP-2 defines the field as *normalized net weight per purchase unit, its unit, the
  package count **and basis***, and without the basis a case of four 10-lb bags is readable as a
  10-lb package — WP-2's own finding 25, which revision 1 dropped on the way into the payload.
- **`import_batch_id`** — groups the rows of one uploaded sheet. **Grouping is a review-surface
  *filter* and nothing else *(finding 13)*.** Rejecting a bad upload executes **per-row rejections**,
  each writing its own audit row bound to its own actor — **never** one bulk status mutation over the
  batch. A single `UPDATE … WHERE import_batch_id = …` is precisely the unreviewed bulk write G-1 and
  G-4 exist to forbid, arriving through the reject door instead of the approve door. Approval stays
  per row (G-4).
- **A purpose-conditional CHECK — carrying only what is
  genuinely purpose-specific, and NOT "in the same shape as the existing one", which is the wording
  Revision 10 had to remove *(BLOCKER)*.** The WP-4 section above quotes the existing constraint as
  `CHECK (purpose <> 'epa_label_seed' OR (…))` — a **single** guarded disjunct, which is adequate
  only while exactly one purpose has rules to enforce. **Copying that shape is what produced this
  blocker**, so read that quotation as superseded here: the constraint this amendment specifies is
  an **`AND` of per-purpose arms**, and any purpose whose payload shape matters gets its own arm. Revision 1 put the citation requirement here, and that **fails
  open**: `create_label_draft` writes `manual` rows and is never modified, so a `manual` row carrying
  typed elements escaped the citation rule entirely. Citation moved to the element (above), so the
  conditional CHECK keeps only what is genuinely purpose-specific — and it is a **CONJUNCTION of two
  purpose arms, not a single `OR` guard *(blocker, Revision 10; the hard merge gate's finding)*:**
  `CHECK ( (purpose <> 'workbook_import' OR (payload_version IS NOT NULL AND exactly one of
  ingredients[] / product_attributes is populated AND label_url IS NULL AND label_accepted_date IS
  NULL AND epa_product_status IS NULL AND epa_is_cancelled IS NOT DISTINCT FROM false AND
  proposed_brand_name IS NULL AND conflicts[] is empty AND the populated block contains at least one
  field AND no field in it is present-with-null AND every TEXT field present in it satisfies
  NULLIF(btrim(<field>), '') IS NOT NULL AND no two ingredients[] elements resolve to the same
  logical ingredient identity)) AND (purpose <> 'manual' OR (ingredients[] is absent or empty AND
  product_attributes is absent or empty)) )` — the first arm being the workbook strictness this
  bullet already carried, the second arm being **Revision 9's manual prohibition, which until now
  was written in prose only.**

  **Why the old single-arm form could not work, stated so nobody rebuilds it:** the constraint was
  quoted as `CHECK (purpose <> 'workbook_import' OR (…))`. For a row whose `purpose` is **`manual`**,
  the first disjunct evaluates **TRUE**, and PostgreSQL — evaluating a disjunction — **accepts the
  row without ever looking at the parenthesised strictness**. It is not that the rule was written
  loosely; the rule **was never reachable for a `manual` row at all**. **This is the same
  `OR`-shaped trap this plan already documents for bare CHECKs**, where a guard clause silently
  exempts every row it names instead of constraining it, and it is why a purpose-conditional
  constraint that must bind **more than one** purpose has to be an `AND` of per-purpose arms — each
  arm `purpose <> '<that purpose>' OR (<that purpose's rules>)`, so a row satisfies its own arm and
  is trivially true against the others. **Add a purpose whose payload shape matters and you add an
  arm; never widen an existing one.**

  **This is the second time this exact fail-open has been written into this exact bullet, so the
  rule is stated as a rule rather than as a fix *(Revision 10)*.** Read the opening of this bullet:
  Revision 1's citation requirement failed open here for **precisely** this reason, and the remedy
  was to move citation down to the **element**, where `purpose` cannot exempt anything. Revision 9
  then put a **new** `manual`-row prohibition back into the same single-disjunct shape and it failed
  open the same way. **So: a prohibition that must bind `manual` rows may NEVER live inside a
  disjunct that `manual` short-circuits.** It gets **its own conjunct** — as the `purpose <>
  'manual' OR (…)` arm above now does — **or it is enforced at the element**, which is where the
  citation rule already went. Anything else is this bug a third time.

  **Two negative DATABASE proofs are required — against the applied constraint, not against the
  prose *(Revision 10)*:** **(1)** `INSERT` a row with `purpose = 'manual'` carrying a non-empty
  `ingredients[]` (or a non-empty `product_attributes`) and show it **refused by the CHECK**; and
  **(2)** take an existing typed draft and, **as an admin through the row-wide UPDATE policy**,
  `UPDATE` it to `purpose = 'manual'` — and separately `UPDATE` a `manual` row to inject a typed
  payload — and show **both refused**. The second proof is the one that matters most: **the admin
  `UPDATE` policy is row-wide**, so relabelling is a real capability, and a constraint that only
  guarded `INSERT`s would have left the door open on the edit path. **Run both against a build where
  the constraint is the old single-arm form and they must PASS** — a proof that cannot fail on the
  broken shape is proving nothing.

  The element rules bind **every** typed payload element regardless of
  purpose; the legacy path writes **no** typed-payload elements, so `manual` rows are unaffected in
  practice. **And a `manual` row carrying typed elements is not "held to the element rules" — it is
  FORBIDDEN outright *(Revision 9's rule, now actually enforced by Revision 10's predicate)*.** An
  earlier revision permitted the
  combination, which reopened FIX-A through a side door — a typed payload wearing a `manual` purpose
  would have sailed past the purpose-only body guard into the legacy scalar path. Because a CHECK
  constraint binds **every** write path — the admin row-wide UPDATE policy included — the
  combination cannot exist in the queue at all, on insert or by later edit. **Strict for
  the purpose the importer creates, permissive for the legacy shape — and `create_label_draft` is
  still never modified, by this amendment or by any package.**
- **`payload_version` stays the versioning lever.** An import whose payload version is unknown is
  **refused**, never coerced — the rule already stated for `create_label_draft_proposal`. *(Revision
  5 says "refused" where revision 4 said "rejected": no draft exists yet for a refused import, and
  since PR-2 `rejected` names a queue status with two exact owners, the word is no longer free for
  general use.)*
- **A TYPED-PURPOSE GUARD on `commit_label_draft`, re-emitting its body in this same migration
  *(blocker, FIX-A)*.** The moment the `purpose` CHECK above admits `epa_label_seed`,
  `brand_proposal` and `workbook_import`, typed rows become creatable — and the **deployed**
  `LabelReview` screen loads **every** draft row with no `purpose` filter and no status filter
  (`src/pages/LabelReview.tsx:210-220`) and sends its decisions to legacy `commit_label_draft`,
  whose body checks the admin role, the decision value, idempotency and the draft's **status**, and
  **never reads `purpose`** (`20260629210000_product_label_drafts.sql:244-284`). Left alone it would
  happily "approve" a workbook chemistry draft by writing the scalar label fields, **skipping the
  digest, the version compare-and-set, the citation re-checks and the ingredient rows entirely**,
  and then **closing the queue row** so nothing is left to review. So **WP-1's migration re-emits
  `commit_label_draft`'s body via `CREATE OR REPLACE FUNCTION` at its unchanged ten-parameter
  signature, adding EXACTLY ONE thing: a guard at the top of the body that refuses any draft whose
  `purpose <> 'manual'`.** The refusal carries **validation-refusal semantics** *(PR-2, RR-4)* — a
  named error, **no authoritative product, chemistry, attribute, brand, or queue-state mutation,
  exactly one refusal audit row, and the draft left `pending`** — so a misrouted typed draft stays
  exactly where the real review surface will find it. **Every other line of that body is
  byte-identical**; the guard adds no parameter, no column read and no branch beyond its own.
  **The ordering argument is what makes this airtight, and it is why the guard belongs HERE and
  nowhere else:** typed rows **cannot exist** before this migration's CHECK admits their `purpose`,
  and the guard lands in **this same migration**, so **no window ever exists in which a typed row
  and an unguarded legacy RPC coexist** — not for one statement, not for the apply-before-merge
  window, not at all. Putting the guard in WP-4 (or in Phase 1b) would open exactly that window.
  **This is a body re-emission, not a new function:** WP-1's migration still adds the functions it
  already owns and **no additional one**, and `pg_proc` still holds **exactly one**
  `commit_label_draft` afterwards.
- **A draft-level `source_epa_registration text` column, stamped at proposal time on every typed
  CHEMISTRY draft *(blocker, R11-1)*.** It records **the product's `epa_registration` as it stood
  when the proposal was created** — trimmed, and **NULL when the product had none**, which is a
  meaningful value rather than a missing one. It belongs to the queue **shape**, so **WP-1 owns it**,
  exactly as `source_product_data_version` and `payload_envelope_sha256` do; it is written by every
  draft-creating RPC in scope (`create_label_draft_proposal`, `create_workbook_import_proposals`)
  and left **null** on legacy `manual` rows, which carry no typed chemistry to invalidate.
  **`source_product_data_version` cannot stand in for it** — the whole reason this column exists is
  that `epa_registration` moves **without** the version moving, which this section proves two
  paragraphs below.

  **Two EPA fields now exist and a builder MUST NOT conflate them — name them side by side once,
  here *(R11-1 + ITEM 5)*:**
  - **`source_epa_registration`** — **draft-level**, one per draft. **What the PRODUCT's registration
    was when the draft was proposed.** Its job is **invalidation**: if the product's registration has
    moved since, the review the draft rests on is stale and the commit refuses.
  - **`observed_epa_registration`** — **element-level**, one per cited element. **What the DOCUMENT
    says.** Its job is **disagreement reporting**: the commit compares it to the product's current
    value and computes `conflicts[]` for human resolution under D-L.
  - **They are never compared to each other, and neither is ever written to
    `products.epa_registration`.** One is a snapshot of product state used to decide whether a
    review is still valid; the other is a transcription of a document used to surface a
    disagreement. **A single "epa" field doing both would refuse honest disagreements and report
    stale reviews as conflicts.**
- **A stored canonical-envelope digest column, `payload_envelope_sha256 text`, written at
  draft-creation time *(R3-7)*.** The digest's byte format is **server-defined** — see *Approval binds
  to a content digest* below — so the column belongs to the queue **shape**, which **WP-1 owns**, and
  not to any package that later writes rows into it. It is populated by every draft-creating RPC in
  scope (`create_label_draft_proposal`, `create_workbook_import_proposals`); legacy `manual` rows
  written by the unmodified `create_label_draft` carry it **null**, and the typed commit path
  **refuses a null stored digest** with a named error rather than committing an unbound approval.

**The payload-contract delta, stated exactly *(finding 9)*.** WP-4's payload table above is the base
contract; the table below is the delta this amendment adds, in the same format. **The two are read
together** — nothing here restates or overrides a WP-4 row except where the reconciliation line says
so explicitly.

| Field | Type | Null? | Notes |
|---|---|---|---|
| `import_batch_id` | `uuid` | **no** on `workbook_import`; yes elsewhere | Stamped by the import RPC, never supplied by the sheet. A review-surface filter only — it authorizes no bulk operation |
| element `source_type` | `text` | **no** on every *filled* element | CHECK ∈ `sds`, `label`, `supplier`, `measured` (D-M's ranking). **`measured` is refused at import** — reserved for Mason's own in-app entry (G-2). Import-permitted values are `sds`, `label`, `supplier` |
| element `source_url` | `text` | **required — present and *trimmed non-empty* — for `sds` and `label`**; **omittable only for `supplier`** | *(R2-11 — this replaces revision 2's "conditional" wording, which contradicted G-2 elsewhere. R3-2 — non-null is not enough; whitespace is not a citation.)* It may be absent **only** for `source_type = 'supplier'`, and **only** where that element's `note` carries a **trimmed non-empty named supplier-document reference**. **This is the one place the citation predicate is quoted; every other mention in this amendment refers back to it rather than restating it:** `NULLIF(btrim(source_url), '') IS NOT NULL OR (source_type = 'supplier' AND NULLIF(btrim(note), '') IS NOT NULL)`. **RR-2's value rule is a *different* predicate of the same shape, not a second quotation of this one:** `NULLIF(btrim(<field>), '') IS NOT NULL` applied to the proposed **value**, so that a citation and the thing it cites are held to the same standard of "actually there". `measured` is not importable at all (G-2), so it never reaches this rule. "Supplier said so" is not a citation, and neither is a space bar |
| element `note` | `text` | yes — **except** where the pair-rule above requires it, and there it must be **trimmed non-empty** | Carries the named supplier-document reference, the blank-basis explanation (G-3), and any second figure the label prints |
| `product_attributes` | `jsonb` | yes | Populated **exactly when `ingredients[]` is empty** on a `workbook_import` row, and empty when it is not — the single-domain rule below. **When populated it must carry at least one field** (CHECK, R2-4) |
| `product_attributes.density_value` | `numeric` | **absent, or present non-null** — never present-with-null | Finite and strictly positive when present (WP-2's hard domain). **Absent = no proposal, live value untouched** (R2-4) |
| `product_attributes.density_unit` | `text` | **no** when `density_value` present | `lb_per_gal` or `specific_gravity`; specific gravity normalizes on write against `WATER_LB_PER_GAL = 8.345404`. The filler never converts (G-3) |
| `product_attributes.net_weight_value` | `numeric` | **absent, or present non-null** | Finite and strictly positive when present |
| `product_attributes.net_weight_unit` | `text` | **no** when `net_weight_value` present | **CHECK ∈ a closed set — `lb`, `oz`, `kg`, `g` — never free text *(blocker, RR-3)*.** Revision 5 left this field unconstrained, so a sheet could propose `lbs`, `pounds`, `L` or an empty string and the commit RPC would have had to guess a conversion or store a unit nothing downstream could read — the exact failure `density_unit` was constrained to prevent, one row below. **Normalized to `lb` at commit**, mirroring density's normalize-on-write / retain-entered contract (**D-B**): the conversion factors live in the **`net_weight_lb_factor(p_unit)` IMMUTABLE SQL function WP-2's migration creates** — one database-side source queried by the commit RPC **and** by the verifier's proof, never two hand-typed copies (RR-3 as corrected in Revision 8; a TS export cannot reach a PostgreSQL RPC). **An unlisted unit is refused at import and again at commit, with a named error — never guessed, never coerced** |
| `product_attributes.net_weight_basis` | `text` | **no** when `net_weight_value` present | `per_package` — the weight of one individual bag or jug — or `per_purchase_unit` — the weight of the whole thing bought. **An input basis, not a storage shape** *(R2-8)*: `per_package` is converted at commit, see below. This is the field that makes a case of four 10-lb bags unambiguous |
| `product_attributes.package_count` | `int` | **no** when `net_weight_basis = 'per_package'`; **absent** otherwise | Finite and strictly positive. How many of that package are in one purchase unit. Retained beside the normalized figure for audit (D-B pattern), in `net_weight_entered_package_count` *(R3-6)* |
| `product_attributes.formulation_type` | `text` | **absent, or present *trimmed non-empty*** | As the label states it (SC, EC, WG, SL, …). **Blank is not a value *(blocker, RR-2)*:** `''` and `'   '` are refused at import, by the CHECK and again at commit, because revision 5 counted them as "present and non-null" and would have **overwritten a live formulation type with a blank** |
| `product_attributes.safener` | `text` | **absent, or present *trimmed non-empty*** | Absent = no proposal. **A label that names no safener is recorded as the explicit value `none`**, cited like any other value — never as an empty cell *(R2-4)*, and never as whitespace *(RR-2)*: the literal `none` is the **only** way a documented absence is expressible |
| `product_attributes.nickname` | `text` | **never importable** | **Mason-only.** No document states a trade shorthand, so the AI leaves it blank and **an imported `nickname` element is refused** (G-2) |
| per-attribute `source_type` / `source_url` / `note` | as the element rows above | `source_type` **no** on every *filled* attribute; `source_url` and `note` follow the element pair-rule **exactly** | Provenance is **per field**: one draft may legitimately cite the SDS for density and the label for formulation type. **`note` is present for the same reason it is on chemistry elements, and revision 4 omitted it *(PR-5)*:** without it the supplier named-document-reference rule had **no defined home on the attribute side**, so a `supplier`-sourced density for a supplier who publishes no URL had nowhere to put its citation and would have been refused as uncited — or, worse, waved through. Its nullability follows the **same pair-rule**: `note` is **required — trimmed non-empty — when `source_type = 'supplier'` and `source_url` is absent**, which is the predicate quoted once in the `element source_url` row above, applied to an attribute field rather than an ingredient element. `measured` is not importable here either (G-2) |
| `label_url`, `label_accepted_date`, `epa_product_status`, `epa_is_cancelled`, `proposed_brand_name` | as WP-4's table | **must be absent**, or at their WP-4 defaults, on `workbook_import` | **Forbidden to the importer** *(blocker, R2-5)*. These are WP-4's **outer** fields: they sit outside `ingredients[]`, so the element-level citation rule cannot reach them. Enforced in **three** places — the purpose-conditional CHECK, `create_workbook_import_proposals`, and the commit re-check |
| element `observed_epa_registration` | `text` | yes — **absent, or present *trimmed non-empty*** | **The EPA registration as the CITED DOCUMENT states it** *(P2, ITEM 5)*. The importer records what it read; it never normalizes it, reconciles it, or compares it to the product. **This is an observation, not a conflict** — the commit RPC compares it to the product's current `epa_registration` and computes any difference into `conflicts[]`, which stays commit-computed and importer-forbidden *(R2-5 intact)*. Without this field the importer had **nowhere to record the observation**, so a label/product EPA mismatch was silently discarded. Element-level, not draft-level, because one draft may cite two documents and a per-draft field could not say which one disagreed. **Never auto-resolved in either direction** (D-L) |
| `conflicts[]` | `jsonb` array | **must be empty** on `workbook_import` at import time | **Computed at commit time only, never importer-supplied** *(blocker, R2-5)*. A sheet that could write `conflicts[]` could invent a disagreement that does not exist, or suppress one that does. **Its EPA input is each element's `observed_epa_registration`** *(ITEM 5)* — the importer supplies the observation, the RPC computes the disagreement |
| *destination columns* — the provenance **triplet** per document-derived field: `density_source`, `density_source_url`, `density_source_note`; `net_weight_source`, `net_weight_source_url`, `net_weight_source_note`; `formulation_type_source`, `formulation_type_source_url`, `formulation_type_source_note`; `safener_source`, `safener_source_url`, `safener_source_note` | `text` each | on `products`, written by `commit_product_attribute_proposal` **in the same transaction as the value itself**, never as a later backfill | **Not payload — the columns the payload's per-field provenance lands in** *(R2-9)*, **and revision 5 named only one column per field, which discarded two thirds of every citation *(blocker, RR-1)*.** The payload requires `source_type`, `source_url` **and** `note` per attribute *(PR-5)*; a single `*_source` text column could hold **one** of them, so the URL and the supplier note were destined to be **dropped at commit** — and the round-trip audit could then never prove **which document** supported the effective value. **WP-2's migration carries all twelve columns**; `density_source` already exists in WP-2's contract and gains its two siblings here. **This is the attribute side mirroring the chemistry side exactly:** PR-4 gave `product_active_ingredients` the same `source_type` / `source_url` / `note` triplet, and an amendment that fixed provenance storage on one side while leaving it lossy on the other fixed nothing. `<field>_source_url` and `<field>_source_note` follow the **same pair-rule and the same trimmed-non-empty predicate** the payload does, quoted once in the `element source_url` row above. `nickname` is **exempt**: Mason-only, no document states it, nothing to rank |
| *destination columns* — `net_weight_entered_value`, `net_weight_entered_unit`, `net_weight_entered_basis`, `net_weight_entered_package_count` | `numeric`, `text`, `text`, `int` | on `products`, written by the commit RPC | **Not payload — where the retained *entered* net-weight tuple lands** *(R3-6)*. Revision 3 required the tuple to be "retained beside the normalized figure" and named **no columns to retain it in**. **WP-2's migration carries these four**, following the `density_entered_value` / `density_entered_unit` precedent **D-B** already set, exactly — **`net_weight_entered_unit` is the fourth, added because RR-3 makes the commit normalize the unit and a normalize-on-write pattern that does not retain the entered *unit* is only half of D-B.** `net_weight_entered_value` and `net_weight_entered_package_count` carry the **finite and strictly positive** CHECKs this plan's hard-domain rule demands of every numeric column created there; `net_weight_entered_basis` carries the same `per_package` / `per_purchase_unit` CHECK the payload field does, and `net_weight_entered_unit` carries the same closed `lb` / `oz` / `kg` / `g` CHECK the payload's `net_weight_unit` does *(RR-3)* |

**Blank, omitted and null get one meaning, and it is the safe one *(blocker, R2-4; the blank half
corrected by blocker RR-2)*.** Revision 2
used "blank" to mean three different things in three places, and the dangerous reading — that an
emptied cell asks the database to **clear** the live value — was reachable from the text. Revision 5
closed that reading for `null` **and left it open for the empty string**: a workbook cell holding
`''` or `'   '` is "present and non-null", so it passed every rule below and would have **replaced a
live `formulation_type` or `safener` with a blank** — an erasure arriving through the one door this
whole block exists to lock. One rule
set, binding on the sheet, on the CHECK, on `create_workbook_import_proposals` and again on the
commit re-check:

- A field **ABSENT** from a `product_attributes` block is **not a proposal**. The live value is
  **unchanged**. This is **D-D**'s "absent row = ignore" applied one level down, to the field.
- A field **PRESENT with a non-null value** is a proposal to **set** that field — and **for a TEXT
  field, "a value" means a *trimmed non-empty* one *(RR-2)*.**
- A field **present with `null`** is **REFUSED** — at import, and again at commit. **A workbook
  import can never clear or erase a live value.** Clearing a field is an **in-app Mason action
  only**, on the WP-1 entry screen, where he sees what he is removing before he removes it.
- **A TEXT field present with a blank — `''` or whitespace — is REFUSED on exactly the same terms
  *(blocker, RR-2)*.** The predicate is the one already quoted for citations,
  `NULLIF(btrim(<field>), '') IS NOT NULL`, applied to the **value** instead of to its `source_url`:
  enforced at import by `create_workbook_import_proposals`, by the purpose-conditional CHECK, and
  **again at commit** by `commit_product_attribute_proposal`, so a row that reached the queue before
  the CHECK existed still cannot land. **Present-with-blank is present-with-null in a costume, and
  the two are refused by the same rule for the same reason.**
- A populated `product_attributes` block must carry **at least one field**, enforced by the CHECK. An
  empty block proposes nothing and is refused rather than queued for a review with nothing to show.
- **"The label names no safener" is a fact, and it is recorded as one:** `safener` **present** with
  the explicit value **`none`**, cited like any other value. The same convention applies to any field
  where a documented absence is worth recording. An empty cell says *"the agent did not fill this"*;
  `none` says *"the document says there is none"*. Those are different claims, and the review surface
  shows them differently. **Since RR-2, `none` is not merely the preferred way to say it — it is the
  ONLY way**, because the blank that used to be the alternative is now refused.

**The loop is closed, and there is deliberately nothing outside it *(RR-2)*: a field is ABSENT — no
proposal, live value untouched — or PRESENT with a trimmed non-empty value, which for a documented
absence is the cited literal `none`. There is no third state.** Null is refused, blank is refused,
whitespace is refused; each of the three is refused at import, by the CHECK, and again at commit.

**The invariant, in one sentence: an import can propose additions and replacements, never erasures.**

**The outer WP-4 payload fields are forbidden to the importer *(blocker, R2-5)*.** WP-4's base
contract carries `label_url`, `label_accepted_date`, `epa_product_status`, `epa_is_cancelled` and
`proposed_brand_name` **outside** `ingredients[]`, where the element rules above cannot reach them —
they have no `source_type`, no `source_url`, and nothing to render a citation from. `conflicts[]` is
worse than uncited: it is a **computed** field describing what the commit itself found. A
`workbook_import` payload therefore carries **none of them**. They must be **absent or at their WP-4
defaults**, and `conflicts[]` is populated **at commit time only, never by the importer**. Enforced
in **three places** — the purpose-conditional CHECK, the import RPC, and the commit re-check. The
failure this closes is concrete and quiet: a chemistry proposal smuggling an uncited regulatory
status or a cancellation flag past a reviewer whose screen rendered only ingredients.

**`observed_epa_registration` is NOT one of these, and the distinction is the whole reason it works
*(ITEM 5)*.** It is an **element** field, so every element rule reaches it: it sits beside that
element's `source_type`, `source_url` and `note`, it is rendered with them, and it is cited by the
same document the concentration was read from. **It states what a cited label SAYS; it does not set
what the product IS.** The forbidden outer fields are forbidden precisely because they would change
authoritative product state with no citation attached — `observed_epa_registration` changes nothing
at all, and the commit RPC reads it only to compute `conflicts[]`. **It never writes
`products.epa_registration`, under any decision** *(D-L)*.

**`per_package` is an input basis, not a storage shape *(R2-8)*.** WP-2 already rules what the
database stores — **normalized net weight per purchase unit** — and this amendment does not change
it. A `per_package` row is **converted at commit**: `net_weight_value × package_count` gives the
per-purchase-unit figure, and the **entered value, the entered unit, the entered basis and the
package count are retained beside the normalized figure** for audit. That is exactly the **D-B**
normalize-on-write / retain-entered pattern already settled for specific gravity, reused rather than
reinvented. **Those
four retained figures have named destination columns *(R3-6, widened by RR-3)*, because "retained
beside" with no column named is an instruction a builder cannot execute:**
`net_weight_entered_value`, **`net_weight_entered_unit`**,
`net_weight_entered_basis` and `net_weight_entered_package_count` on `products`, **carried by WP-2's
migration** and listed in the delta table above beside the provenance columns — following
`density_entered_value` / `density_entered_unit` exactly, with the finite / strictly-positive CHECKs
the hard-domain rule requires of the two numeric columns and the closed-set CHECKs on the two text
ones.

**The UNIT normalizes on the same write, and it is normalized rather than trusted *(blocker,
RR-3)*.** Revision 5 left `net_weight_unit` as free text, which meant the commit RPC received a
basis it could convert and a **unit it could only hope about** — `lbs`, `pounds`, `L`, `kg` and `''`
were all equally admissible, and the RPC's only options were to guess a factor or store a string
nothing downstream could read. So the unit is **CHECK-constrained to `lb`, `oz`, `kg`, `g`** in the
payload and **normalized to `lb` at commit**, in the same statement that normalizes the basis. **The
conversion factors live in the DATABASE, because the converter does** — a TypeScript named export
cannot be imported by a PostgreSQL RPC. WP-2's migration creates one **IMMUTABLE SQL function,
`net_weight_lb_factor(p_unit text) RETURNS numeric`**, holding the exact factors — `lb` → `1`,
`oz` → `0.0625` (exact), `kg` → `2.20462262185`, `g` → `0.00220462262185` — and refusing any other
unit. `commit_product_attribute_proposal` calls it, and the verification proof queries the **same
function**, so the proof cannot agree with the code by re-typing the same wrong number. Any
TypeScript display-side mirror of these factors must carry a **cross-runtime equality proof**
against the SQL function's returns — the same one-source rule `WATER_LB_PER_GAL` imposes, adapted
to the runtime that actually executes the conversion. **An unlisted unit is REFUSED,
at import and again at commit, with a named error** — the importer never guesses, and neither does
the RPC, which is the identical rule G-3 already imposes on concentration basis. The
filler never converts (G-3); the commit RPC converts once, where it can be proved. **Proof case:** a
case of four 10-lb bags commits as **40 lb per purchase unit**, with **`(10, lb, per_package, 4)`**
retained beside it in those four columns; a **`(4.54, kg, per_package, 4)`** row commits as the
pinned-constant conversion of 18.16 kg to pounds, with `(4.54, kg, per_package, 4)` retained
unchanged; and a row entered as `pounds` is **refused at import**, not silently read as `lb`.

**Reconciliation with WP-4's table, so the two cannot be read as disagreeing:** WP-4's
`ingredients[]` row lists a per-element **`source`** field. It is **superseded by the
`source_type` / `source_url` / `note` triple, for all purposes and all packages.** WP-1 is unbuilt,
so this is a restatement of a contract nobody has emitted yet, not an edit to an applied one.
**Commit logic reads the triple and never a legacy `source` string**, and no migration emits one. A
payload field with no mapped destination remains a hard error, exactly as WP-4 already requires.

**And that supersession must reach the STORAGE, not only the payload *(blocker, PR-4)*.** The
sentence directly above makes a payload field with no mapped destination a hard error — and revision
4 walked into exactly that error without noticing. **WP-1's `product_active_ingredients` column list
at the top of this plan names a single `source` column** (`product_id`, `ingredient_id`,
`concentration_value`, `concentration_unit`, `basis`, **`source`**, `verified_by`, `verified_at`),
so a payload carrying `source_type`, `source_url` and `note` had **nowhere to land**. A builder
meeting that gap does one of two things, and both are silent: he **flattens three cited facts into
one string**, destroying the very per-value trust order D-M exists to rank, or he writes the pair to
a column that cannot hold it and loses the URL. Provenance that survives review and dies on write is
worse than no provenance, because the audit trail claims it is there.

**So WP-1's table is amended here: `product_active_ingredients` carries `source_type`, `source_url`
and `note` IN PLACE OF `source`** — the same domain (`sds`, `label`, `supplier`, `measured`), the
same trimmed-non-empty predicate and the same supplier pair-rule the payload uses, quoted once in
the delta table above. **WP-1 is unbuilt and unapplied, so this is a specification change to a
migration that does not yet exist, never an edit to an applied one** — the identical footing as
every other WP-1 and WP-2 change this amendment makes. **The WP-1 column list at the top of this
plan is therefore amended by this section and must be read together with it**, exactly the way WP-4's
payload table is read together with the delta table above; the change is recorded **here, inside the
amendment**, rather than rewritten in place, so this section stays the single record of what moved.

Three consequences, stated so none of them is left to inference:

- **The commit writes them.** `commit_label_draft_proposal` *(RR-5)* writes each element's `source_type`,
  `source_url` and `note` into those columns on the `product_active_ingredients` row it commits —
  the same write that carries the concentration, not a later backfill. **`commit_product_attribute_proposal`
  does the identical thing on the attribute side *(RR-1)*:** each field's `source_type`,
  `source_url` and `note` land in that field's `<field>_source`, `<field>_source_url` and
  `<field>_source_note` columns on `products`, **in the same transaction as the value**.
- **The generated types carry them.** `src/types/index.ts` declares `source_type`, `source_url` and
  `note` on `product_active_ingredients` and **declares no `source`**, regenerated from the schema
  like every other type in this plan — **and declares the twelve `<field>_source` /
  `<field>_source_url` / `<field>_source_note` columns on `products`, plus
  `net_weight_entered_unit`, on the same regeneration *(RR-1, RR-3)*.** A provenance column absent
  from the generated types is a column the frontend cannot render, which is how a citation survives
  the write and disappears from the screen.
- **The proof asserts them field by field.** Phase 1b's acceptance **round-trip proof** — import,
  approve, read the committed row back — asserts `source_type`, `source_url` **and** `note`
  individually against what the sheet cited, never as one opaque blob, and **must never read or emit
  a legacy `source`**. A proof that selects `source` either errors out or proves the wrong field,
  which is the WP-1 exact-column-names rule *(caught reviewing PR #435)* applied to the column this
  amendment just changed. **The same round-trip runs on the attribute side and asserts the same
  three facts *(RR-1)*:** for **every** document-derived attribute the sheet cited, read
  `<field>_source`, `<field>_source_url` and `<field>_source_note` back and assert each **equal to
  what the payload carried** — the URL and the note by value, not merely non-null. **That assertion
  is the one revision 5 could not have passed**, because there was no column for the URL or the note
  to be read out of.

**Phase 1b carries its own migration, and exactly one new function in it *(blocker, finding 1)*.**
Revision 1 said Phase 1b "builds no commit RPC of its own" — true, and insufficient, because it left
the *proposal-creation* path unnamed. An unnamed write path is how a builder invents an unguarded
one: the identical failure WP-4 already corrected when "the brand-commit path" turned out not to be
a specification (WP-4, finding 6). So Phase 1b's migration adds **`create_workbook_import_proposals`
and no other function** — a statement about *functions*, not about that function's write surface,
which R3-4 states separately below — layered on the queue shape **WP-1 owns**, the same layering WP-4 uses for
`create_label_draft_proposal`, which remains **WP-4's**. **"Phase 1b adds one function" is a claim
about Phase 1b's migration only, and revision 6 does not touch it *(RR-5)*:** WP-4's migration
adds **two** functions — `create_label_draft_proposal` **and `commit_label_draft_proposal`** — and
WP-2's adds `commit_product_attribute_proposal`; none of the three is Phase 1b's.
**Neither of WP-4's two functions is "unchanged by this amendment":** `create_label_draft_proposal`
must store the envelope digest *(R3-7)*, and `commit_label_draft_proposal` is **new in revision 6**,
carrying PR-1, PR-3,
PR-4 and RR-4. Both are specification changes to an **unbuilt** package, never edits to anything
applied.

Its contract, per CRX canon and **D-J** / **D-S**:

- **`SECURITY DEFINER` with `SET search_path = public, pg_temp`.**
- **Resolves the actor from `auth.uid()` inside the function**, never from a caller-supplied
  argument — actor forgery is the B7/B8/B9 class.
- **Admin-only**, the same boundary as `commit_brand_proposal` and the WP-5 copy RPC. **Negative
  proof required:** call it as a non-admin and show it refused with **nothing at all written — no
  mutation and no audit row**, which is the **authorization** refusal of *A validation refusal is
  not a rejection* below *(RR-4)*, not the validation refusal that must leave one.
- **Accepts `p_idempotency_key text DEFAULT NULL` and actually enforces it — and a key is
  *required*.** A call arriving with `p_idempotency_key IS NULL` is **refused**, exactly as WP-5's
  copy RPC is and for exactly the same reason: re-running an import is a second real bulk write, not
  a no-op, so an unreplayable call must not be allowed to start. Prove all three — same key replayed
  creates no second row, missing key is refused, a different key is an ordinary second import.
  **And the receipt is BOUND to actor and intent per *Idempotency receipts bind actor and intent*
  below *(HIGH, R11-2; widened by R12-2)*** — its `request_fingerprint` covers **the operation mode
  and that mode's mutation-defining inputs**: the batch's canonical content identity in **batch**
  mode, and the **stale draft id, product, domain and replacement envelope content** in **restamp**
  mode. So the same key cannot replay one sheet's result for a different sheet, **nor one restamp's
  receipt for a different draft** — which R11-2's batch-only wording would have allowed.
- **Its write surface, stated completely — and the safety property redefined in the same breath
  *(R3-4)*.** Revision 3 said it "touches `product_label_drafts` and nothing else", which is **not
  true and cannot be**: an RPC that wrote no audit row and kept no idempotency record would violate
  two other rules in this same plan. What it actually writes is exactly three things: **(1)
  `product_label_drafts`** — `INSERT`s of `pending` queue rows, plus, on the restamp path only
  (R2-7), **one `UPDATE` of the single stale draft it supersedes, by that draft's own id**, never by
  `import_batch_id`; **(2) its own actor-bound audit rows**, through the plan's established audit
  trail — the **`cost_history`-precedent trail WP-1 carries**, which is this amendment's audit
  destination throughout, here and in every commit RPC below; and **(3) the idempotency
  bookkeeping** the CRX idempotency contract requires of any RPC that actually enforces a key.
  **The invariant is not "nothing else" — it is this: the importer performs NO writes to
  authoritative chemistry, attributes, `products`, or `product_brands`.** That is the property a
  reviewer is asked to check, and it is the property the negative proof asserts. **State the reason
  correctly, because revision 2 did not *(R2-6)*:** this is **not** a grants argument. The function
  is `SECURITY DEFINER`, so it runs as its owner and **caller grants constrain nothing about what its
  body could reach**. What actually proves the property is the **Phase 1b acceptance proof's negative
  before/after assertions** — run a real import, then show **zero rows changed** in
  `active_ingredients`, `product_active_ingredients`, `products` (every chemistry and attribute
  column), and `product_brands`.
- **The supersede path is race-safe, and exactly one restamp wins *(R3-5; lock order corrected in
  Revision 9, closing the round-five P2)*.** On the restamp path the RPC takes **the product row
  first — **THE lock order, mandatory on all three write paths since Revision 10** *(FOLLOW-UP 1)*,
  and the reason the commit RPCs' removed predicated form could have deadlocked against this one —
  and then** the stale draft's **exact id**,
  locking each **`FOR UPDATE`**, and then verifies —
  **under the locks, never before them** — that the row is still **`pending`**, still **stale** (its
  `source_product_data_version` still behind the product's current `product_data_version`), and **not
  already superseded**. **The fresh draft's `source_product_data_version` is read under that product
  lock**, so the replacement cannot be born stale against a sibling draft committing concurrently —
  without the product lock, a restamp could read the version, lose the race to a committing sibling,
  and mint a "fresh" draft that fails its very next approval. If any of the three fails it **refuses with a named error**: **no
  authoritative product, chemistry, attribute, brand, or queue-state mutation — no supersede and no
  fresh draft — exactly one refusal audit row is written, and the stale draft remains `pending`**
  *(RR-4)*. So two reviewers clicking restamp on the same draft at the
  same moment produce **exactly one** fresh draft: the loser gets the named refusal, re-reads the
  queue, and finds the fresh draft already waiting for review. Without the lock the same two clicks
  produce two fresh drafts for one product, which is the five-queue-rows failure finding 10 closes,
  arriving through the restamp door instead of the import door.
- **Stamps `import_batch_id` on every row it creates, and a per-product
  `source_product_data_version` read at proposal time** — per product, never per batch, because the
  staleness refusal the typed commit RPC performs is per product. **On a CHEMISTRY draft it also
  stamps `source_epa_registration` — the product's registration as it stands at that moment,
  trimmed, NULL when the product has none** *(R11-1)*, read from the product in the same statement
  that reads its version so the two snapshots agree. **It also computes and stores each
  row's `payload_envelope_sha256`** at that same write, per R3-7: the digest is the database's to
  produce, never the sheet's and never the browser's.
- **Validates before it writes and refuses with a named error rather than dropping:** an unknown
  `payload_version`; an element claiming `source_type = 'measured'`; a `nickname` element; any filled
  element with no citation — **and a value that fails the trimmed-non-empty predicate quoted once in
  the delta table above *is* no citation, so a whitespace-only `source_url` or `note` is refused
  here, not merely at the CHECK** (R3-2); a `supplier` element with neither a trimmed non-empty
  `source_url` nor a trimmed non-empty named
  supplier-document reference in its `note` (R2-11, R3-2); **a chemistry element for a product with a
  usable EPA number** (D-Z, using the predicate defined once above); a row whose `product_id` is
  unknown, or whose `sku` no longer matches that id; a row populating both domains; **a draft whose
  `ingredients[]` carries TWO elements resolving to the same logical ingredient identity — the same
  `ingredient_id`, or two `proposed_form` elements of the same identity** *(FOLLOW-UP 2, below)*;
  **a `proposed_form` whose name matches an existing ingredient but claims a DIFFERENT
  `canonical_ingredient_id`** *(D-AA-3, Mason 2026-08-27 — refused HERE at import with a named error,
  never queued and never resolved at commit, because ambiguous chemistry must not enter the system;
  the correction is a corrected sheet, re-uploaded)*;
  **any field
  present with `null`**, and a `product_attributes` block with no fields at all (R2-4); **any TEXT
  field present with a blank or whitespace-only value — the same `NULLIF(btrim(x), '') IS NOT NULL`
  predicate, applied to the value itself** *(blocker, RR-2)*; **a `net_weight_unit` outside the
  closed `lb` / `oz` / `kg` / `g` set — refused, never guessed at and never coerced to the nearest
  spelling** *(blocker, RR-3)*; and **any of
  the forbidden outer fields — `label_url`, `label_accepted_date`, `epa_product_status`,
  `epa_is_cancelled`, `proposed_brand_name` or a non-empty `conflicts[]`** (R2-5). Silent dropping is
  the failure mode this whole path exists to prevent — a refused import is a five-minute fix, a
  silently dropped element is a wrong number on spray paperwork.
- **`EXECUTE` to `authenticated` only, never `anon`**, and `REVOKE ALL … FROM PUBLIC, anon` on every
  internal helper, so a `SECURITY DEFINER` helper never becomes the privilege boundary.

**Gates for that migration:** it creates a new `SECURITY DEFINER` RPC, so it takes the full RLS +
migration-drift review, an exact-SHA `gpt-5.6-sol` proof, **Mason's in-chat OK to apply live**, and
R-12 — the same gates WP-1, WP-2 and WP-5 carry. Phase 1b is no longer a screen-only package.

**Idempotency receipts bind actor and intent — stated ONCE here, binding on all three new mutating
RPCs *(HIGH, R11-2)*.** Every contract in this amendment says its RPC "accepts and actually enforces
`p_idempotency_key`", and **none of them said what the receipt is bound TO.** A key alone is a
coincidence of strings: the same key presented with **different data**, or by a **different caller**,
would replay a stored result as if it were the answer to a question nobody asked. On these paths
that is a real hazard — the importer's receipt could return one sheet's outcome for another sheet,
and a commit's receipt could return an approval's result for a **different draft or a different
decision**, with a clean audit trail behind it.

**This repo has already settled the pattern, and this amendment FOLLOWS it rather than inventing
one:** `supabase/migrations/20260803010917_bind_idempotency_to_mutation_intent.sql` adds
**`request_actor_id uuid`** and **`request_fingerprint text`** to `idempotency_keys` and rebuilds its
mutating RPCs around them, specifically so a key cannot replay a result for different data. All
three RPCs here adopt that same shape:

- **`request_actor_id` is server-derived from `auth.uid()` inside the function** — never a
  parameter, never trusted from the caller. Actor forgery is the B7/B8/B9 class, and a
  caller-supplied actor on a *receipt* is the same bug wearing a bookkeeping hat.
- **`request_fingerprint` is a server-computed digest over the exact request intent**, in the
  migration's own form — a `sha256` over a canonical `jsonb` of the actor plus the request's
  identifying content. **What "intent" means per RPC, named exactly:** for
  **`commit_label_draft_proposal`** and **`commit_product_attribute_proposal`**, the **draft id, the
  decision, and the echoed envelope digest `p_payload_sha256`**. The client
  never computes it, exactly as it never computes the envelope digest *(R3-7)*.
- **`create_workbook_import_proposals` has TWO MODES, and its fingerprint binds the MODE plus every
  mutation-defining input of that mode *(HIGH, R12-2)*.** Revision 11 defined it as "the batch's
  canonical content identity", which describes **batch import** and says **nothing about a
  restamp** — even though the restamp path *(R2-7, R3-5)* runs through this same RPC and performs a
  **different mutation**: it supersedes one named draft and mints its replacement. Under the R11-2
  wording two restamps of **different drafts** could produce the **same** fingerprint, so a reused
  key would **replay the first restamp's receipt** and the caller would be told the supersede
  succeeded **while the intended draft sat untouched, still stale, still `pending`** — a silent
  no-op wearing a success receipt. So the fingerprint covers:
  - **The operation mode itself** — `batch_import` or `restamp` — as an explicit bound field, so the
    two mode-spaces can never collide even if their other inputs coincidentally hash alike.
  - **Batch mode:** the **batch's canonical content identity** — unchanged from R11-2.
  - **Restamp mode:** the **exact stale draft id**, the **`product_id`**, the **domain** (chemistry
    or attributes), **and the replacement draft's envelope content**. The stale id is what makes two
    restamps distinguishable; the rest is what makes a *re*-restamp of the same draft against
    *changed* content distinguishable from a true replay.
  - **A same-key call whose mode differs, or whose bound inputs differ in any way, is refused by
    name — `IDEMPOTENCY_INTENT_MISMATCH`, the cited migration's own error — never replayed and never
    re-executed.**
  - **Proofs:** same key + **a different restamp target** → **refused**, with the intended draft
    unchanged and no supersede performed; same key + **the same restamp** → **replays the original
    receipt**, with **no second supersede and no second fresh draft**; and same key across **different
    modes** → refused.
- **A same-key call replays the original result ONLY when the actor AND the fingerprint both
  match.** Any other same-key call is **refused with a named error** — the migration's
  `IDEMPOTENCY_ACTOR_MISMATCH` and `IDEMPOTENCY_INTENT_MISMATCH` shapes — and is **never silently
  replayed and never re-executed.** Those are the only three outcomes: replay, refuse, or a genuine
  first execution.
- **Same-key calls serialize BEFORE any mutation**, via the established shape:
  `pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_idempotency_key, 0))` taken ahead
  of the work, so **two simultaneous same-key calls yield exactly one execution** and the second
  blocks, then replays. **This composes with the mandatory product-then-draft lock order
  *(FOLLOW-UP 1)* rather than competing with it:** the advisory lock is keyed on the idempotency key,
  not on a row, so it introduces no row-lock ordering of its own — take it first, then the product
  row, then the draft row.
- **Where this refusal sits in the three-kinds taxonomy, so a builder does not have to guess
  *(RR-4)*: an idempotency-binding refusal behaves as an AUTHORIZATION-class refusal, not a
  validation one** — it refuses **the call**, not the draft's content, before any draft is examined,
  and it therefore **raises and writes nothing at all, no audit row included.** That is exactly what
  the cited migration does, and it is the only coherent choice: a raised exception rolls its own
  audit row back. **The draft's status is untouched, because the draft was never reached.**

**Proofs, required on each of the three RPCs and all negative-capable:** **(1)** same key, same
intent, same actor → **replays the original result**, with **no second write and no second
`product_data_version` bump**; **(2)** same key, **changed intent** — a different draft id, a
different decision, or a different echoed digest — → **refused**, not replayed and not re-executed;
**(3)** same key, **different actor** → **refused**; **(4)** **two simultaneous same-key calls** from
two sessions → **exactly one executes**, the other replays or blocks-then-replays, and **never two
executions**. Proof (4) is a two-session proof like PR-1's, not a unit test.

**Approval binds to a content digest of a canonical *envelope*, because the row can legitimately move
under the reviewer *(blocker, R2-3; widened by blocker R3-1)*.** G-5 already says approval binds to
what was **rendered**; revision 2 gave that rule **no mechanism**, and revision 3 gave it a mechanism
that hashed **the payload alone**. The second hole is the worse one, because it looks closed. The gap
is not theoretical: the live queue's own RLS **expressly permits an admin to `UPDATE` a draft row** —
policy `admin_update_product_label_drafts` on `product_label_drafts`
(`20260629210000_product_label_drafts.sql:93`) — and that policy is **row-wide**, so the admin may
change **`product_id` itself**, not merely the payload. **A payload-only hash therefore lets content
reviewed for product A commit onto product B:** move the draft, and whenever the two products'
`product_data_version` stamps coincide the bytes still match, the digest still matches, and the write
lands on the wrong product with a clean audit trail behind it. **Binding an approval to the row id
binds it to nothing; binding it to the payload alone binds it to the wrong thing.**

The mechanism, stated so a builder cannot invent a weaker one:

- **The digest covers a canonical *envelope*, not the payload *(R3-1)*:** the **draft id**,
  **`product_id`**, **`purpose`**, **`payload_version`**, **`source_product_data_version`**,
  **`source_epa_registration`** *(R11-1)*, the
  **domain** (chemistry or attributes), **and** the payload. Every one of those is a fact the
  reviewer's decision depended on, and every one is mutable by the same admin `UPDATE` policy.
  **`source_epa_registration` belongs in the envelope for exactly the R3-1 reason and no new one:**
  it is **draft content**, stamped by the creating RPC and editable through the same row-wide admin
  `UPDATE` policy, so leaving it out would let someone edit the snapshot to match the product's new
  registration and walk a stale review straight through the invalidation rule. **Note what the
  digest does and does not do here:** it protects the **snapshot** from being edited; it cannot
  detect that the **product** moved. That is the invalidation rule's job, and the two are
  complementary rather than redundant.
- **The byte format is SERVER-defined, and the client never serializes JSON for hashing — that is the
  whole rule *(R3-7)*.** The **draft-creating RPCs** (`create_label_draft_proposal`,
  `create_workbook_import_proposals`) compute the canonical envelope digest **at write time** and
  **store it on the draft row**, in the `payload_envelope_sha256` column WP-1's migration carries.
  The **review surface displays and echoes that stored digest back** as **`p_payload_sha256`**; it
  computes nothing and serializes nothing. The **commit RPC recomputes the envelope digest over the
  stored row** and compares it to what the surface echoed. Two implementations can never disagree
  about key order, whitespace or number formatting, because only **one** implementation exists and it
  lives in the database.
- **Inside the transaction, and *after* the `FOR UPDATE` locks** — the draft row, and the product row
  under whichever PR-1 form was built — the RPC performs that
  recompute-and-compare and **refuses on mismatch** with a named error: **no authoritative product,
  chemistry, attribute, brand, or queue-state mutation; exactly one refusal audit row is written;
  the draft remains `pending`** *(PR-2, RR-4)*. Recomputing
  before the locks would leave the same race one statement narrower.
- **That is precisely the TOCTOU property wanted, and it needs nothing else built for it:** the
  surface echoed the digest **as of render time**, so **any** later change to the stored row — the
  payload, `product_id`, `purpose`, the version stamp — makes the commit-time recompute differ from
  the echoed value and the commit refuses. No separate change-detection, no row-version compare on
  top, no client-side hash. **The one residual is deliberate and safe-direction:** a row edited
  **out of band** — by raw `UPDATE` through the admin policy, without going through an RPC that
  restores the stored digest — refuses at commit until it is **restamped**, even though the reviewer
  saw current content. A false refusal costs one restamp; the opposite error writes an unreviewed
  value to live chemistry.
- **A row with no stored envelope digest cannot be committed through a digest-bound path:** the typed
  commit path **refuses a null `payload_envelope_sha256`** with a named error. Legacy `manual` rows
  written by the unmodified `create_label_draft` are the only rows in that state, and they carry no
  typed elements, so the refusal is unreachable in practice — it is stated only so a builder meeting
  it does not close the gap with a client-computed hash.
- The reviewer then **re-reads the changed row and approves it again** — which is the correct
  outcome, not a nuisance: he has not yet seen what he would be approving.

**Scope:** this applies to **`commit_label_draft_proposal`** *(RR-5)* and to
**`commit_product_attribute_proposal`**. **`commit_brand_proposal` is unaffected** and stays outside
this amendment's scope. **Two negative proofs are required, not one:** render a draft, **edit its
payload**, attempt the commit with the now-stale digest, and show the **refusal** with **nothing
authoritative written and the refusal audit row present**; **and** render a draft, **change its
`product_id`** to a second product, attempt the commit
with that same stale digest, and show the **refusal** with **nothing authoritative written on
either product, the refusal audit row present, and the draft still `pending`**
*(R3-1; the assertion's wording per RR-4)*.

**The `product_data_version` compare-and-set must be ATOMIC, and the draft-row lock does not make it
so *(blocker, PR-1 — the Codex connector's P1 and CodeRabbit's Major are the same defect seen from
two directions, and both are accepted)*.** Every commit path above locks **the draft row**
`FOR UPDATE` and then compares that draft's `source_product_data_version` against the product's
current `product_data_version`. **That lock protects the draft from a second approval of *itself*;
it protects the *product* from nothing.** Between the comparison and the write, another transaction
holding a **different** draft row for the **same product** is free to bump the version.

The failure is not exotic — it is the ordinary case this amendment already documents. **Two drafts
exist for one product:** the normal chemistry / attribute sibling pair *(R3-3)*, or a chemistry
draft beside a freshly restamped one. Two admins approve them at the same moment. Each transaction
locks a **different** draft row, so neither blocks; **both read the same `product_data_version`**;
**both pass the staleness comparison**; both write. The second write lands on a product whose values
moved under it, and the staleness guard — the one rule standing between a spreadsheet and a wrong
number on spray paperwork — **reports success**. The audit trail shows two clean approvals and no
sign that one silently overwrote the other. **The draft-row lock cannot prevent this, and no
sharpening of it can:** the contended resource is the product, and the product is not what is
locked.

The requirement therefore binds **both** typed commit RPCs' contracts —
**`commit_label_draft_proposal`** *(RR-5)* and **`commit_product_attribute_proposal`** — and either
form below satisfies it, but one of
them must actually be built:

**THE form — there is exactly one, and the alternative is DROPPED *(Revision 10, FOLLOW-UP 1;
this also closes both round-six connector follow-ups, adopted in-plan rather than deferred)*:**

- **Lock the PRODUCT row, first, and hold it.** `SELECT … FROM products WHERE id = <the draft's
  product_id> FOR UPDATE`
  **before** the staleness comparison, and **hold it through the write and the version bump** to the
  end of the transaction. The comparison then reads a value no concurrent transaction can move,
  because any concurrent commit for that product is waiting on the same row.
- **Then lock the draft row.** `FOR UPDATE`, in that order, always. **Product row, then draft row** —
  one lock order for the whole amendment.
- **Then every re-check, then the staleness comparison, then the writes and the version bump** —
  the ordering rule stated below *(FIX-B)*, which is unchanged and now has a **single realization**.

**This order is MANDATORY on all THREE write paths that touch a product and a draft together —
`commit_label_draft_proposal`, `commit_product_attribute_proposal`, and the restamp inside
`create_workbook_import_proposals`.** It is stated here once and referred to everywhere else; no
path may invent a second shape.

**The predicated-`UPDATE` alternative earlier revisions offered — bumping the version as a single
`UPDATE … WHERE product_data_version = <source>` and treating zero rows as the refusal — is
REMOVED, not deprecated *(Revision 10)*.** It worked in isolation and created two problems that only
appear in combination with the rest of this amendment. **First, a deadlock family:** it takes the
product row at the **compare-and-set** rather than at the top, so a commit built that way holds the
**draft** row while reaching for the **product** row, while the restamp path — which takes the
product row first *(Revision 9)* — reaches for them in the opposite order. Two such transactions
deadlock, and the plan's answer was the fragile one: *"both RPCs must build the same form."* A rule
that is only safe while every future builder remembers it is not a guarantee. **Second, it permitted
the EPA-recheck TOCTOU:** with no product lock held from the top, `epa_registration` can move
between the PR-3 re-check and the write, which is exactly the fact PR-3 exists to test and exactly
the gap it cannot see. **One mandatory lock order eliminates the whole family by construction** —
there is no second shape to mix, no order to get backwards, and the product is held from before the
first check until after the last write. **PR-1 adds a lock, it removes none; Revision 10 removes the
option not to take it.**

**And the compare-and-set must execute BEFORE any authoritative write — the order is part of the
guard, not a detail of it *(blocker, FIX-B — Codex connector P1, accepted)*.** Revision 6 wrote both
transaction sequences with the version bump **near the end**, after the value writes. **Under the
now-removed predicated form that silently defeated the compare-and-set:** combined with RR-4's
**return-normally** refusal semantics — which exist so the refusal audit row
survives — the failure was complete: the RPC wrote the chemistry or the attribute values, *then*
ran the predicated bump, got **zero rows**, and **returned a refusal on a transaction that then
COMMITTED the writes it had already made.** A caller sees "refused, nothing written"; the database
holds the opposite. **A guard that runs after the thing it guards is not a guard.**

The requirement, binding on **both** commit RPCs and unchanged by Revision 10: **the version
compare-and-set is the last step
before the first authoritative mutation, and no authoritative mutation precedes it.** **It now has a
single realization *(FOLLOW-UP 1)*:** the product row is taken `FOR UPDATE` **first and held**, so
the comparison reads a value no concurrent transaction can move, and **every authoritative write
happens after it, under that same lock**. Every read-only re-check — the `pending`
check, the digest recompute, the EPA re-check, the citation and basis re-checks, the blank,
unit-domain and duplicate-element re-checks — runs **before** the comparison, so a refusal on any of
them also precedes every write. **RR-4's "no authoritative mutation" clause is then true by
construction rather than by the builder remembering the order.**

**And the ordering question that used to need explaining no longer arises.** Under the removed
predicated form the version advanced at the **top** of the transaction, ahead of the value writes,
which read as wrong and merely wasn't. Under the one mandatory form the sequence is the obvious one
— **lock, check, compare, write, bump** — and it needs no defence: nothing is written before the
comparison, and nothing can move the product between the comparison and the write, because the lock
is held across both.

**Concurrency proof required, and it is a two-session proof, not a unit test *(PR-1)*:** open **two
sessions**, fire **two commits against the same product simultaneously** — the natural case is the
sibling chemistry and attribute drafts, which is also the case a reviewer will hit first — and show
that **exactly one succeeded** while the other **refused on the version predicate**, with **nothing
authoritative written by the loser, its one refusal audit row present, its draft still `pending`**,
and the product's `product_data_version` advanced **exactly once** *(assertion wording per RR-4)*.
**That "nothing authoritative written by the loser" assertion is exactly the one revision 6's
ordering would have FAILED *(FIX-B)*** — the loser would have written its
values and then returned a refusal — so the proof must read the loser's target rows, not merely its
return value. **Under the one mandatory form the loser never reaches a write at all: it blocks on
the product lock, and finds the version already moved when it acquires it *(FOLLOW-UP 1)*.** Run the
same pair against the pre-PR-1 shape and it must be the failing case; a proof that passes both ways
is proving nothing.

**A validation refusal is NOT a rejection, and the two must never share a status *(blocker, PR-2 —
CodeRabbit Major, accepted)*.** Revision 4 routed the commit RPCs' refuse path to **`rejected`**.
That is wrong, and it is wrong in the direction that **strands precisely the drafts the restamp flow
exists to recover.** Every restamp precondition above requires the stale draft to be **still
`pending`** — `create_workbook_import_proposals` locks it `FOR UPDATE` and refuses unless it is
*(R3-5)*. So a draft that a **staleness** refusal set to `rejected` **can never be restamped**, and
the ordinary two-domain sequence *(R3-3)* — whose entire shape is *refuse, restamp, approve* —
dead-ends on its own second step. The recovery path and the thing it recovers were wired to cancel
each other.

The rule, binding on `commit_label_draft_proposal` *(RR-5)* and `commit_product_attribute_proposal`
alike:

- **A VALIDATION refusal leaves the draft in `pending` and writes an audit row describing the
  refusal** — which check declined it, the actor, and the time — on WP-1's `cost_history`-precedent
  trail. **State the outcome in exactly these terms, everywhere in this amendment *(RR-4)*: no
  authoritative product, chemistry, attribute, brand, or queue-state mutation; exactly one refusal
  audit row is written; the draft remains `pending`.** "Writes nothing" is the wrong sentence and
  revision 5 used it in a dozen places: a refusal that wrote nothing at all would leave **no record
  that the machine declined**, which is the opposite of what this bullet requires. This covers
  **every** refusal the contracts name:
  `source_product_data_version` staleness (including PR-1's version-predicate refusal), an
  envelope-digest mismatch, a **null stored digest**, the **EPA-state-invalidation comparison on
  every typed chemistry draft** *(R11-1)*, D-Z's separate **usable-EPA refusal** *(PR-3)*, the element
  citation re-check, a blank chemistry basis (G-3), a forbidden outer field *(R2-5)*, a field present
  with `null` *(R2-4)*, and any other check the commit re-performs. The draft is left unchanged,
  still reviewable, and **still restampable** — which is the whole point.
- **NEITHER act that sets `rejected` may advance `product_data_version` *(ITEM 4)*.** A rejection —
  human or supersede — changes nothing about the product, so bumping the version would **falsely
  stale every sibling draft and every workbook compare-and-set derived from it**. The human
  rejection path takes only the draft lock and stops after the status and its audit row *(the commit
  RPCs' decision branch)*; the restamp supersede already writes no `products` row at all *(R3-4)*.
  **The bump belongs exclusively to an approve path that actually wrote something.**
- **`rejected` is reserved for exactly two deliberate acts, and nothing else may set it.** First, an
  **admin's explicit human rejection** of the proposal on the review surface — a decision, taken per
  row, with its own actor and its own audit row (G-4). Second, the **restamp supersede**, where
  `create_workbook_import_proposals` sets the superseded draft to `rejected` with an audit row
  **naming the superseding draft** *(R2-7, R3-5)* — a rejection that records where the row went.
- **Say the difference out loud, because a builder will not infer it from the word:** `rejected`
  means *a human, or a restamp acting on a human's decision, has finished with this row*. A refusal
  means *the machine declined to act right now* — a statement about the state of the world at that
  instant, not a verdict on the content. Statuses record decisions; audit rows record refusals.
- **A "named error" must not be a `RAISE`, or the audit row it is supposed to leave behind rolls
  back with it *(RR-4, stated because the corrected sentence makes it unavoidable).** PostgreSQL
  gives an RPC one transaction: if the validation refusal raises an exception, **everything the same
  call wrote is discarded — including its refusal audit row** — and the contract above becomes
  unimplementable rather than merely unwritten. So a **validation** refusal **returns a structured
  refusal result carrying the named error code**, having written its one audit row, and the
  transaction **commits**; the frontend renders the named code exactly as it would render a raised
  one. Every "refuses with a named error" in this amendment is to be read that way on the commit
  path. (An **authorization** refusal is the exception below, and it may raise, because it has
  nothing to preserve.)
- **Authorization refusal is a THIRD kind, and it writes nothing at all — that phrase is correct
  there and only there *(RR-4)*.** A non-admin call never reaches validation: the admin check
  refuses at the top of the function, no draft has been examined, no decision has been made about
  any content, and **nothing whatever is written — no mutation and no audit row.** The negative
  proofs that call each RPC as a non-admin assert exactly that, unchanged. Do not read those proofs
  as contradicting the refusal-audit-row rule; they are testing the door, not the desk behind it.

**EPA state is re-checked at COMMIT — one uniform invalidation rule for every typed chemistry draft,
plus D-Z's separate structural refusal *(blocker, PR-3 — CodeRabbit Major; widened to both purposes
by blocker R11-1)*.** `create_workbook_import_proposals` already refuses a chemistry element for a product
with a usable EPA number *(D-Z, using the predicate defined exactly once above)*. But that check runs
**when the sheet is uploaded**, and **the fact it tests moves.** Between upload and approval the
product can gain a usable EPA number — by WP-4's own workflow, or by Mason typing the number in on
the WP-1 screen, which is exactly what WP-4's "cannot auto-seed until someone types the number in
first" asks him to do. The queued draft then commits **workbook chemistry onto a product whose
chemistry D-Z assigns to WP-4's auto-seed**, past a rule that ran, passed, and went stale hours
earlier. A split D-Z calls "structural, not a preference" would be enforced at one instant and
unenforced ever after.

**Revision 11 found that this was written for the case that prompted it rather than for the property
it protects, and the fix is to state ONE rule that does not know what `purpose` it is looking at
*(blocker, R11-1)*.** PR-3 bound its re-check to `workbook_import`, because D-Z's split is what
raised it. But the hazard — **the product's EPA registration moving between review and approval** —
is not a workbook hazard. It applies to **`epa_label_seed`** identically and arguably worse: an EPA
seed draft is *derived from* the registration, so a draft built against **X** and committed after
the product moved to **Y** writes **X-derived chemistry onto a Y product**, and every existing guard
misses it. The digest cannot see it (the **draft** is byte-identical; the **product** moved). The
staleness guard cannot be relied on (next paragraph). PR-3 could not see it (wrong purpose). **The
rule was one purpose short of the property.**

**So there is exactly ONE state-invalidation rule, it takes no `purpose` branch, and it is the
comparison stated once here:** under the held product lock, `commit_label_draft_proposal` compares
the product's **current** `epa_registration` against the draft's stored **`source_epa_registration`**
and **refuses on ANY difference.** Any difference means any: **X→Y**, **NULL→X**, **X→NULL**, and a
change in trimmed text. **No purpose is named in that sentence and none may be added to it** — every
typed chemistry draft is subject to it, `epa_label_seed` and `workbook_import` alike. It is a
**validation refusal** per PR-2: **no authoritative
product, chemistry, attribute, brand, or queue-state mutation; exactly one refusal audit row is
written, recording which check declined it; the draft remains `pending`** *(RR-4)* — **and therefore
restampable, which is the whole remedy: a restamp re-derives the draft against current state, and
the reviewer approves what is actually true now.**

**D-Z's usable-EPA refusal is a SEPARATE rule that stays exactly as it was — an additional entry,
never a second copy of the comparison *(R11-1)*.** It answers a different question: not *"has the
registration moved?"* but *"does this product belong to the workbook path at all?"* It uses the
single **R2-12** usable-EPA predicate, it binds **`workbook_import` chemistry only**, and it is
**structural per D-Z** — a usable EPA number means chemistry comes from WP-4's auto-seed, so a
workbook chemistry draft for such a product is refused whatever its `source_epa_registration` says.
**The two live side by side in the commit RPC's validation list, one entry each.** If a builder ever
finds themselves writing the state comparison twice — once for each purpose — **that is the error
this revision exists to prevent**; the comparison is one clause, and D-Z is one clause, and neither
is a variant of the other.

**Its resolution is deliberately human, for both rules:** **reject the draft**, or **restamp** it so
it is re-derived against current state — and where D-Z refused, **clear or fix the EPA number and
restamp**, the escape hatch the usable-EPA definition above already names. Neither is a decision an
RPC may take on Mason's behalf, which is why the refusal stops rather than choosing. **Attribute
drafts are untouched by BOTH rules:** EPA supplies no attributes, so
`commit_product_attribute_proposal` stores no `source_epa_registration` and has nothing to
re-check.

**Proof cases, required separately and distinct from the digest cases *(PR-3, R11-1)*:**

- **State invalidation, the uniform rule — proved on BOTH purposes, because a proof on one purpose
  is exactly how the gap was born:** create a typed chemistry draft (**once as `epa_label_seed`,
  once as `workbook_import`**) with the product at registration **X**; **change the product to Y**;
  attempt the commit; show the **refusal with nothing authoritative written** — no new or changed
  `product_active_ingredients` row, no `product_data_version` bump — **the refusal audit row
  present**, and the draft **still `pending`**.
- **Both absence transitions, which a naive equality test silently passes:** **NULL→X** (product had
  no registration at proposal time and has one now) and **X→NULL** (had one, cleared since) — both
  **refused**. An `IS DISTINCT FROM` comparison gets these right and a `<>` comparison does not;
  say so in the migration rather than discovering it in a proof.
- **Restamp closes it:** after any of the above refusals, **restamp and approve**, and show the
  commit succeeds against the product's current registration.
- **D-Z's separate rule, unchanged:** create a `workbook_import` chemistry draft for a product with
  **no** usable EPA number; **give that product an EPA number**; attempt the commit; show the
  refusal. *(Note this single scenario now trips **both** rules — the registration moved **and** the
  product became EPA-usable. That is fine and expected; the proof asserts the D-Z refusal
  specifically, which is why the RPC's named errors must be distinct.)*

**None of these is the R3-1 `product_id` case in different clothes:** there the **draft** moved and
the stored envelope digest caught it. Here the draft is **byte-identical** and **the product**
moved — which **no digest of the draft alone can see.**

**And do not argue that the staleness refusal already covers this, because it does not reliably
*(PR-3, and it is precisely what makes R11-1 a BLOCKER rather than a nicety)*.**
`product_data_version` is bumped by the commit RPCs this amendment specifies; **nothing
in this plan makes every route that can set `epa_registration` bump it** — WP-1's entry screen, a
WP-4 lookup write and a hand correction are separate paths, and only the ones that go through a
commit RPC are covered. A guard that holds only through an **unstated coupling between two columns**
is not a guard; it is a coincidence with good luck so far. **This paragraph is the reason
`source_epa_registration` had to exist as its own column:** the amendment already knew the version
could not be trusted to move with the registration, wrote that down, and then **left
`epa_label_seed` protected by exactly that untrusted coupling for six revisions.** **The
state-invalidation rule tests the fact it actually cares about, directly, at the moment it matters,
for every typed chemistry purpose** — which is the same reason the citation
rule was moved onto the element rather than keyed to `purpose` *(blocker, finding 4)*, and the same
reason the manual-row prohibition needed its own CHECK conjunct rather than a mirrored clause
*(BLOCKER, Revision 10)*. **Three times now, the bug has been a rule scoped to the case that
prompted it. Scope rules to the property.**

**One queue row never spans two commit paths *(blocker, finding 3)*.** Chemistry commits through
**`commit_label_draft_proposal`** *(WP-4's new RPC, RR-5)*; the WP-2 attributes commit through
**`commit_product_attribute_proposal`**
(named and specified below). A single draft carrying both would need **two RPCs and therefore two transactions** to approve, so a half-approved
row is reachable — chemistry live, attributes lost, and one audit trail describing an approval that
only half happened. So the importer **splits proposals by domain**: a `workbook_import` draft carries
**either** a non-empty `ingredients[]` (chemistry) **or** a non-empty `product_attributes` block
(attributes), **never both**, enforced by the purpose-conditional CHECK above as *exactly one of the
two populated*. **One approval = one RPC = one transaction.** A product needing both gets **two
drafts and two approvals** — the honest cost of the guarantee, and cheaper than any recovery from a
half-committed row.

**And one draft never carries the SAME ingredient twice *(Revision 10, FOLLOW-UP 2)*.** The rule
above keeps two *domains* out of one draft; this one keeps two *elements for one ingredient* out of
one `ingredients[]`. **The single-effective-row invariant says exactly one effective row per
`(product_id, ingredient_id)`** — so a draft carrying two elements that resolve to the same
ingredient asks the commit RPC a question the invariant has no answer to: **which one wins?** Any
answer it picks is an **evaluation-order** answer — last-write-wins, first-write-wins, or whatever
the loop happens to do — and the same draft approved twice could land different chemistry. **A
concentration on spray paperwork must not depend on array order.**

- **The rule:** a `workbook_import` draft whose `ingredients[]` contains **two or more elements
  resolving to the same logical ingredient identity is REFUSED.** Identity means the **same
  `ingredient_id`**, or **two `proposed_form` elements naming the same form identity** — the second
  case matters because two proposals for one new form are the same collision wearing a different
  hat, and neither element has an id yet to compare.
- **Enforced in BOTH places, for the reason every other rule here is:** `create_workbook_import_proposals`
  refuses it at import *(listed in its validation bullet above)*, and the typed commit RPC
  **re-checks it under the locks**, because the import check cannot bind a row an admin edited
  afterwards through the row-wide `UPDATE` policy.
- **Refusal semantics per the three kinds *(PR-2, RR-4)*:** at commit it is a **validation** refusal
  — no authoritative product, chemistry, attribute, brand, or queue-state mutation; exactly one
  refusal audit row; the draft remains `pending`, so the correction path stays open.
- **Negative proofs, two of them:** build a draft with **two elements for one ingredient** and show
  it **refused at import**; then **smuggle one past import** — insert the collision by admin edit,
  the same door the digest and the `manual`-relabel proofs use — and show it **refused at commit**
  with the draft still `pending`.
- **The aggregation rule this sits beside is unchanged:** all of a product's ingredient rows still
  **aggregate into one chemistry draft** *(finding 10)*. That rule says *one draft per product*;
  this one says *one element per ingredient within it*. Aggregating rows is correct; aggregating two
  readings of the **same** ingredient is the collision, and the sheet must resolve it before upload —
  the reviewer cannot resolve it at approval time, because approval is one click on a whole draft.
- **This rule is PER DRAFT, and per-draft is one scope too narrow to protect the identity itself
  *(R12-1)*.** It stops one draft contradicting itself; it says nothing about **two drafts on two
  different products** proposing the same new form. **That gap's MODEL is settled as D-AA in the next
  block *(Mason, 2026-08-27)*, and its mechanism is built in WP-1's cycle — so the gap is closed in
  principle and still open in code until then *(Revision 13)*.** The two scopes were always meant to
  compose:
  per-draft uniqueness keeps a single approval internally consistent, and **the global identity
  mechanism WP-1 builds for D-AA** keeps the catalogue consistent across every approval that will
  ever run. **Neither substitutes for the other** — a global constraint cannot see two elements inside one
  payload, and the payload check cannot see another session. **This rule stands and is unaffected by
  the withdrawal**; it is simply half of a pair whose other half is undecided.

**Canonical form identity is SETTLED as D-AA *(Mason, 2026-08-27)*, its mechanism belongs to WP-1's
build cycle, and the cross-product race stays a KNOWN OPEN HIGH until that mechanism ships
*(R12-1, de-scoped and then settled by Revision 13)*.** Every guard this amendment has built serializes on **the product**: the
mandatory product-row lock *(FOLLOW-UP 1)*, the version compare-and-set, the single-effective-row
invariant, the per-draft duplicate rule. **`active_ingredients` is not product-scoped.** It is the
shared chemical catalogue every product points into, and **nothing in the plan made two products
contend over it.** So: two admins, two products, two `workbook_import` chemistry drafts each
carrying a `proposed_form` for the same new chemical — say the same salt of the same active. Each
transaction locks **its own** product. Neither blocks. Each passes its per-draft duplicate check,
because within its own payload the form appears once. Each reaches the resolve-or-create step, finds
no matching row — **because the other transaction has not committed yet** — and creates one.
**Two `active_ingredients` rows now exist for one real-world identity, and every check passed.**

**The damage is permanent and quiet, which is why this is HIGH rather than a nicety.** Nothing
errors. Both products display correct-looking chemistry. But the two products are no longer
comparable: an ingredient-keyed query returns one or the other, MOA rollups double-count or
half-count, D-M's ranking ranks within a split, and the WP-5 copy-from-sibling path copies a form
that its sibling does not share. **And it cannot be cleaned up cheaply later** — by the time anyone
notices, both rows carry product links, provenance and possibly divergent canonical mappings, so
merging them is a data migration with judgment calls in it, not a `DELETE`.

**Revision 12 prescribed a mechanism for this, and Revision 13 WITHDRAWS it — the question underneath
was an OWNER DECISION that had not been made — and Mason has now made it *(Revision 13)*.** Revision 12
specified a UNIQUE key over `(lower(btrim(name)), coalesce(cas, ''))` and mandated
`INSERT … ON CONFLICT … DO UPDATE SET name = EXCLUDED.name RETURNING id`. A `gpt-5.6-sol` proof run
on that small diff **and** five independent connector findings then arrived at the same place from
different directions: **eight findings, all circling one question the plan never answered — what
makes two ingredients the same thing.** The mechanism was not wrong in its plumbing; it **encoded an
identity model nobody had chosen**, and several of the choices inside it were **Mason's calls about
his own catalogue**, not a builder's. **So the mechanism came out, the question went to its owner,
and he answered it the same night — D-AA below is SETTLED.** What is deliberately **not** settled
tonight is the SQL that expresses it; that belongs to WP-1's build cycle.

### D-AA *(SETTLED — ingredient identity model)*

**Mason answered all of it in chat on 2026-08-27**, the same night the mechanism was withdrawn,
after the trade-offs were explained in plain English. **The MODEL is settled; the MECHANISM that
implements it is deliberately still unwritten** — see the gate below.

| # | Question | Decision |
|---|---|---|
| **D-AA-1** *(Mason, 2026-08-27)* | Is CAS the global identity where present, and does it hold across alternate names and spellings? | **YES, both.** **Same CAS = same chemical, merged into one identity** — across trade name, IUPAC name, common name and spelling variants alike. Where a CAS is present it **is** the identity and the name is a label, not a key. **Mason's per-row review is the catch for a label typo** in the CAS itself; that is a deliberate accepted trade, not an oversight |
| **D-AA-2** *(Mason, 2026-08-27)* | How does a CAS-less row reconcile with a later CAS-bearing proposal that shares its name? | **Neither auto-merge nor silent separation — the merge is QUEUED for Mason's explicit approval**, shown **side by side**. This is the plan's standard propose-review-commit pattern (**D-I**) applied to identity: the system proposes the merge, a human decides it, nothing merges itself and nothing quietly forks |
| **D-AA-3** *(Mason, 2026-08-27)* | What happens when a proposal's name matches an existing ingredient but claims a **different canonical parent**? | **REFUSED at import, on the spot, with a named error.** The sheet is corrected and re-uploaded. **Ambiguous chemistry never enters the system** — it is not queued, not conflict-surfaced, not resolved at commit |
| **D-AA-4** *(settled technically; reviewed and confirmed)* | May a conflict-resolution path mutate a shared row's display name? What ordering governs a multi-identity draft? | **NO to the rename, under any mechanism.** Multi-identity inserts take a **deterministic order** so two drafts carrying the same identities in opposite payload order cannot deadlock |

**Why D-AA-1 and D-AA-2 are not in tension, since they look it at a glance:** where a **CAS is
present on both sides**, identity is decided and the merge is automatic (D-AA-1). Where **one side
has no CAS at all**, there is nothing authoritative to match on — only a name, which this plan
already knows is non-unique and mobile *(WP-0 re-SKUs a row and resolves three duplicate-name
groups)* — so the match is a **suspicion**, and a suspicion goes to a human (D-AA-2). **The rule is:
match on the registry identifier automatically; match on a name only with approval.**

**D-AA-4's two sub-answers keep the reasoning that produced them, because both are near-misses worth
remembering:**

- **A resolve step must never rewrite shared display state as a side effect.** Revision 12's
  `DO UPDATE SET name = EXCLUDED.name` was drafted for a plumbing reason — to make `RETURNING id`
  yield a row on both the insert and the conflict path — and its actual effect was that **one
  product's approval silently renames a row every other product shares.** Product A commits
  "Glyphosate IPA salt", product B later commits "glyphosate isopropylamine", and B's approval
  rewrites what A's screen displays, with no audit row naming the rename and no reviewer having seen
  it. **Whatever mechanism WP-1 builds, this stays forbidden.**
- **Multi-identity ordering must be deterministic.** One draft carrying two new forms X and Y
  inserts them in payload order; a concurrent draft carrying the same two in the other order gives
  the classic **`[X,Y]` / `[Y,X]` deadlock edge**. Revision 12's claim that the identity insert
  "introduces no new deadlock edge" held only for the single-identity case it pictured. **A total
  order — sorted by identity key or equivalent — is required of whatever mechanism is built.**

**GATE: WP-1's migration IMPLEMENTS D-AA as settled here, and the concrete constraint and
resolve-or-create mechanism are specified and reviewed inside WP-1's own build cycle, under WP-1's
own gates.** The model is decided; **the mechanism is deliberately not re-prescribed tonight.**
Revision 12's mechanism was withdrawn after eight findings showed it encoded an undecided model, and
**a ninth same-night mechanism attempt is exactly what was decided against** — the identity model
needed an owner's answer, it now has one, and the SQL that expresses it is a build-cycle artifact
that gets designed against a settled model and reviewed under the RLS, migration-drift and exact-SHA
gates WP-1 already carries. **Revision 12's specific forms stay withdrawn and are not a default to
fall back on:** the `(lower(btrim(name)), coalesce(cas, ''))` key contradicts D-AA-1 outright — it
keys on name and treats a CAS-less row as its own identity — and the `ON CONFLICT … DO UPDATE SET
name` form contradicts D-AA-4. **A builder starts from the model above and the acceptance criteria
below, not from the withdrawn draft.**

**The race finding stays on record until WP-1 implements it.** The cross-product same-form race
described above is **still unfixed in code** — settling the model does not close it, only building
the mechanism does. It remains a **known open HIGH, carried until WP-1's migration lands with its
D-AA implementation and the acceptance criteria pass.** **The reason that is acceptable is unchanged
and still true: nothing is built yet** — no `active_ingredients` table in production carrying this
risk, no importer running, no commit path to race, because WP-1 is unbuilt and Phase 1b runs after
WP-4. **The exposure begins the moment WP-1 ships**, which is exactly why the implementation and its
proofs sit inside WP-1's build cycle rather than after it. If the sequence ever changes so that
anything creates `active_ingredients` rows before that lands, **this finding becomes live and this
paragraph stops being true.**

**Acceptance criteria — these are now WP-1's proof obligations, and they bind the settled model
rather than any particular mechanism:**

- **Two sessions concurrently approving the same NEW form for two DIFFERENT products end with exactly
  ONE `active_ingredients` row** for that identity, both products' `product_active_ingredients` rows
  attached to it. Run the same pair against a naive check-then-insert build and it must produce
  **two** rows — a proof that passes both ways proves nothing.
- **Same CAS under two different names resolves to ONE row *(D-AA-1)*:** commit a proposal naming
  the chemical one way, then a second product's proposal naming it differently **with the same
  CAS**, and show both attached to a single identity — no second row, and no human step required.
- **A CAS-less row plus a later same-name CAS-bearing proposal produces a QUEUED merge, not a merge
  and not a fork *(D-AA-2)*:** show the proposal landing as a **pending** merge for review, both
  candidates rendered **side by side**, the live rows **unchanged** until Mason approves, and the
  merge applied only after his explicit approval with its own audit row.
- **A name match with a different canonical parent is REFUSED at IMPORT *(D-AA-3)*:** show the named
  error at upload time, **no queue row created**, and nothing written — the correction path is a
  corrected sheet, not a review decision.
- **No resolve path mutates a shared row's display name *(D-AA-4)*,** proved by committing a second
  product's differently-spelled proposal and showing the first product's rendered name unchanged.
- **A multi-identity draft pair in opposing orders does not deadlock *(D-AA-4)*,** proved by the
  two-session case the chosen ordering is supposed to make safe.

**Read-together clause, the one place this is recorded, exactly as PR-4 and RR-5 handled theirs
*(Revision 13)*.** Two passages in the base plan describe this step; **both are governed by D-AA as
settled above, and both are implemented in WP-1's build cycle:**

- **WP-1's `active_ingredients` table description** — *"(name, CAS, EPA code,
  `canonical_ingredient_id` self-FK, `canonical_fraction` nullable, `fraction_basis`)"* — **gains the
  identity constraint that expresses D-AA, designed and reviewed in WP-1's own cycle.** Revision 12's
  proposed UNIQUE key stays **withdrawn** and is **not** a default to fall back on — it keys on name
  and treats a CAS-less row as its own identity, which **D-AA-1 and D-AA-2 both contradict.**
- **The typed commit's mapping sentence** — *"resolving each `proposed_form` into a new
  `active_ingredients` row in the same transaction first"* — **is the step D-AA governs**, and its
  resolve-or-create form is specified in WP-1's build cycle against the settled model. Revision 12's
  `ON CONFLICT … DO UPDATE SET name` form stays **withdrawn** — it violates **D-AA-4**.
  *(Read `commit_label_draft` there as `commit_label_draft_proposal`, per RR-5's own read-together
  clause — that rename stands and is unaffected by any of this.)*
- **The staging rule is unchanged and still governs *(PR #435 correction)*:** an unknown form is
  **staged** in `proposed_form`, **never created on sight** and **never guessed into the canonical
  parent**. D-AA governs what happens **at the approved commit**; it grants the importer nothing, and
  the proposal-only boundary *(G-1)* is untouched by any of this.
- **The atomicity requirement already written there still binds:** *"a commit that creates a form row
  but fails to attach its concentration must roll back both"* — true under any mechanism WP-1 builds
  for D-AA.

**The normal two-domain sequence, written out because it *is* the normal path and not a recovery
*(R3-3)*.** When one product carries **both** a chemistry draft and an attribute draft, the review
surface commits **chemistry first**. That commit bumps `product_data_version`, so the sibling
attribute draft is — **by design, not by defect** — stale the instant chemistry lands: its
`source_product_data_version` now trails the product, and the staleness refusal will decline it. That
is the guard doing exactly its job.

**Revision 5 makes that serialization real rather than assumed *(PR-1)*.** The sibling pair is the
textbook case of two drafts on one product, so before PR-1 nothing forced the two commits to happen
one after the other: each locked its own draft row, both could read the same
`product_data_version`, and both could pass. **Now they contend for the *product* row**, so they run
strictly in sequence whatever order the clicks arrive in, and a reviewer who fires both at once gets
**one commit and one refusal on the version predicate** rather than two silent writes. **The
refusal is not a new failure mode — it is this paragraph's staleness arriving a few milliseconds
earlier**, and the remedy is the one already written here. **It is also a *validation* refusal, so
the losing draft stays `pending` and remains restampable *(PR-2)*** — which is what makes the next
sentence executable at all.

The reviewer then **restamps** the attribute draft — the
supersede-and-recreate action already defined above, which sets the stale row to `rejected` with its
own audit row — **one of `rejected`'s two sanctioned owners *(PR-2)*, and the reason a *refused*
draft must not already be sitting in that status** — and creates a fresh `pending` draft re-derived
against current values — and **approves
the fresh draft in the same session**, against a freshly stored envelope digest. **The reverse order
works identically with the roles swapped:** commit attributes first, restamp the chemistry draft,
approve it. The total cost is **one extra click per dual-domain product**, and the reviewer sees
current values both times, which is the point. **Do not read the sibling's staleness as a fault to be
engineered around** — no cross-domain exemption, no "commit both under one version stamp", no
softening of the refusal. **Positive proof required:** a dual-domain product runs **chemistry commit
→ restamp → attribute commit**, with **every proposed value from both drafts landing** and **every
step audited**, including the supersede.

**Rows match on `product_id`, and on nothing else *(finding 12)*.** The sheets carry **`product_id`
— the immutable key — prefilled as the first column**, beside `sku` and `product_name` which are
there for the human. `create_workbook_import_proposals` matches on **`product_id` only** — the
immutable key. It refuses an **unknown id**, and it refuses a row whose **`sku` no longer matches the
id it names**, so a **re-SKU** between generating the sheet and uploading it surfaces as a
**refusal**, never as chemistry landing on the wrong product. **Be exact about what does *not*
refuse, because revision 2 overclaimed it *(R2-15)*: a product-name change alone does not refuse
the row.** The id is authoritative and the name is decoration on the sheet, so a renamed product
imports normally and the **review surface simply shows the product's current name** beside the
proposal — which is the right behaviour, since the reviewer needs to see what the product is called
today, not what it was called when the sheet was generated. **Name-only matching is forbidden** —
WP-0 alone re-SKUs a row and resolves three duplicate-name groups, so names are known to be
non-unique *and* known to
move.

**A label-stated EPA number that disagrees with the product's needs a HOME, and revision 10 found it
had none *(P2, ITEM 5)*.** Earlier revisions said such a difference "lands in `conflicts[]` for
review" — while **R2-5 made `conflicts[]` commit-computed and importer-forbidden**, so the importer
had **nowhere to put what it actually read off the document**. The two sentences could not both be
obeyed: an importer forbidden to write `conflicts[]` and given no other field simply **discards the
observation**, and the commit RPC — which has the product's current value but never saw the label —
has nothing to compare against. **The mismatch would vanish silently**, which is the one outcome
D-L's flag-never-overwrite rule exists to prevent.

**So the observation gets its own element-level payload field, and the computation stays where R2-5
put it:**

- **The importer records what the DOCUMENT states.** Each `ingredients[]` element carries a nullable
  **`observed_epa_registration`** — the EPA registration **as printed on the cited label**, copied,
  never normalized and never reconciled. Absent when the cited document states none; **trimmed
  non-empty when present**, by RR-2's rule like every other TEXT value.
- **The commit RPC computes the conflict.** Inside the transaction, under the locks, it compares each
  stored `observed_epa_registration` against the product's **current** `epa_registration` and writes
  any difference into **`conflicts[]`** — **still commit-computed, still never importer-supplied**
  *(R2-5 intact)*. The importer supplies `conflicts[]` **empty**, exactly as before; what it supplies
  now is the **observation**, which is a fact about a document rather than a claim about a
  disagreement.
- **The review surface renders it *(G-5)*** beside the element it came from, so the reviewer sees
  *"the label says X, the product says Y"* with the citation attached.
- **A mismatch is NEVER auto-resolved, in either direction.** The commit does not overwrite
  `epa_registration` from the label, and it does not discard the observation in favour of the stored
  value. It records the disagreement and leaves it to Mason under **D-L** — the same treatment every
  other typed-versus-stored difference gets.
- **Why the element and not the draft:** one draft may cite two documents, and a per-draft field
  could not say **which** citation disagreed. This is the same reasoning that moved `source_type` /
  `source_url` / `note` onto the element *(blocker, finding 4)*, applied to the observation.

**At most one chemistry draft and one attribute draft per product per batch *(finding 10)*.** All of
a product's ingredient rows **aggregate into the one chemistry draft**: a draft per sheet row would
give one product five queue rows, five independent staleness stamps, and a first approval that
silently invalidates the other four. And a stale draft is never silently committed. The
`source_product_data_version` refusal stands **exactly as WP-4 wrote it** — unchanged, not softened
— and the review surface additionally offers an explicit **restamp / re-derive** action. **PR-1
changes how that refusal is *enforced*, never what it refuses *(revision 5)*:** the comparison is
now made atomic by the mandatory product-row lock *(FOLLOW-UP 1)*, so two concurrent commits
can no longer both pass it. **Strengthening, not softening — the same rule, now unable to be raced.**
**And the refusal leaves the draft `pending`, not `rejected` *(PR-2)*, which is what lets the
restamp action above actually run on it.** **A sibling
draft in the *other* domain going stale on the first commit is the ordinary case, not an exception:
the sequence for it — commit, restamp, approve — is written out above *(R3-3)*, and the restamp's
own concurrency rule is in the importer's contract bullets *(R3-5)*.**

**Restamp is not a new function, and that matters for the "exactly one new function" claim
*(R2-7)*.** Revision 2 named the action and left it **unowned**, which is the same unnamed-path
failure this amendment corrected twice already. The mechanism: the review surface **re-invokes
`create_workbook_import_proposals`** for that **product and domain**, with a **fresh idempotency
key**. In the **same transaction**, that RPC **supersedes** the stale draft — **taking that draft's
exact id, locking it `FOR UPDATE`, and re-verifying it under the lock before it changes anything
*(R3-5, contract bullet above)*** — the old queue row is
set to **`rejected`** with **its own audit row, naming the superseding draft** — and creates the
**fresh `pending` draft**, stamped with the **current** `product_data_version`, **a freshly read
`source_epa_registration` on a chemistry draft** *(R11-1 — which is what makes restamp the remedy
for an EPA-state refusal)*, re-rendered from
current values, and carrying a **freshly stored `payload_envelope_sha256`** computed by the RPC
itself *(R3-7)*. **Because restamp is a MODE of that RPC rather than a function of its own, its
idempotency receipt must be distinguishable from a batch import's and from another restamp's — which
is what R12-2 binds into the fingerprint** *(the mode, the stale draft id, the product, the domain
and the replacement's envelope content)*. **So Phase 1b's migration still adds exactly one new
function, literally:** restamp
adds none, the lock and the digest add none, and **RR-5's new `commit_label_draft_proposal`
adds none here either — it lands in WP-4's migration, not this one.** The re-derived draft is then reviewed and
approved like any other, against that freshly stored envelope digest.
**Restamping is a new approval**; it is never a way to carry an old approval
forward onto data that moved.

**Phase 1b adds NO commit path — only one PROPOSAL-CREATION path, and it is named above.** Revision 1
blurred these into "no new write path", which is what left the import RPC unspecified. Be precise
about the boundary, because **both** commit RPCs a workbook row can reach are new functions and
**neither belongs to Phase 1b**: `commit_product_attribute_proposal` belongs
to **WP-2**, is created by WP-2's migration, and exists whether or not the workbook ever ships;
**`commit_label_draft_proposal` belongs to WP-4** *(RR-5, below)* and likewise exists for the EPA
path whether or not the workbook ever ships. **Chemistry therefore commits through a new function —
say so plainly, because revision 5 said the opposite *(RR-5)*:** it commits through
**`commit_label_draft_proposal`**, with the single-effective-row
invariant, the `source_product_data_version` staleness refusal and **D-L**'s typed-value precedence
all applying to a workbook-sourced proposal exactly as they apply to an EPA one. Revision 5 routed
it through **`commit_label_draft`** and then piled PR-1, PR-3, PR-4 and RR-4 onto that function's
typed path — a path a **frozen ten-parameter signature could not carry**, since the echoed
`p_payload_sha256` has nowhere to arrive. **The new RPC is the resolution, and it is this plan's own
create-side precedent applied a second time.** Brand rows are
untouched — they remain `brand_proposal` → `commit_brand_proposal`. **Phase 1b builds no commit RPC**
and none is to be added. What Phase 1b **does** add is the single proposal-creation RPC above,
riding on the queue shape WP-1 owns.

**The typed commit path is a NEW RPC, `commit_label_draft_proposal`, and revision 5 left it
ownerless *(blocker, RR-5 — CodeRabbit Major, accepted; resolved by Mason, 2026-08-26)*.** This
amendment requires the typed commit path to **consume the typed payload**, **take the echoed
envelope digest**, **take the product lock** *(PR-1)*, **re-check the
usable-EPA predicate** *(PR-3)*, **compare the product's registration against the draft's
`source_epa_registration`** *(R11-1)*, **bind its idempotency receipt to actor and intent**
*(R11-2)*, **write the provenance triplet** *(PR-4)* and **write a refusal
audit row** *(PR-2, RR-4)*. **The live `commit_label_draft` does none of those things** — its
deployed body
(`supabase/migrations/20260629210000_product_label_drafts.sql:212-224`) commits a hand-entered label
draft and knows nothing about `ingredients[]`, `payload_envelope_sha256` or `product_data_version`
locks. **Do not read that as safety — revision 6 did, and was wrong *(FIX-A)*:** a body that does
not understand a typed payload will still write the scalar fields and close the row when handed
one, which is why WP-1's migration guards it.
Meanwhile the S-02 split says **"WP-4's migration adds only the EPA-specific RPC"**, and every other
package here is forbidden the queue's functions. So the plan required behaviour that **no package
was assigned to build**: a builder reaching that line either does nothing, and the typed path never
exists, or invents an overload, which is the accidental-dual-overload class this repo's
migration-drift gate exists to catch. **And the echoed `p_payload_sha256` made "just widen
`commit_label_draft`" impossible on its own terms:** that argument cannot be added to a frozen
signature — `CREATE OR REPLACE` cannot add a parameter in place, and the only routes to one are the
**overload** or the **drop-and-recreate** this plan refuses twice over.

**The resolution is this plan's OWN create-side precedent, applied a second time.** WP-4 already
faced exactly this on the create side and answered it: *"do not touch `create_label_draft` at all…
the EPA path gets a new, distinctly named public RPC — `create_label_draft_proposal`."* The commit
side gets the mirror of that answer:

- **`commit_label_draft`'s SIGNATURE is never modified — by WP-4 or by any package — and its BODY
  is re-emitted exactly ONCE, by WP-1, for the typed-purpose guard and nothing else *(amended by
  FIX-A; revision 6 said "not its body" and that was wrong).** No parameter change, no overload, no
  drop-and-recreate, ever. The rule that
  protected `create_label_draft` still protects its commit-side twin, for the same reason: a deployed
  caller is using it right now, and the apply-before-merge window means the migration lands while
  the old frontend is still live. **The single permitted body change is the guard specified in
  WP-1's migration list above** — refuse `purpose <> 'manual'`, validation-refusal semantics, every
  other line byte-identical. **WP-4 adds nothing to that function**, and neither does WP-2, WP-3,
  WP-5 or Phase 1b.
- **WP-4's migration adds a SECOND new function, `commit_label_draft_proposal`** —
  name-symmetric with `create_label_draft_proposal`, so the pair reads as one path. **It is the
  ONLY commit path for typed drafts**, meaning every draft whose `purpose` is **`epa_label_seed`**
  or **`workbook_import`**. `manual` drafts continue to commit through `commit_label_draft`, exactly
  as they do today.
- **`pg_proc` proof, at BOTH migrations *(FIX-A extends it once more)*:** after **WP-1's** migration
  applies — the one that re-emits the guarded body — assert **exactly one `commit_label_draft`**, so
  the re-emission is proved to have replaced rather than overloaded; and after **WP-4's** migration
  applies, assert **exactly one `commit_label_draft`** *and* **exactly one
  `commit_label_draft_proposal`** — by query, not by
  reading the migration — alongside the `create_label_draft` / `create_label_draft_proposal` pair
  the plan already asserts.

**Its contract, modelled on `commit_product_attribute_proposal` below so the two commit RPCs are one
shape read twice:**

- **`SECURITY DEFINER` with `SET search_path = public, pg_temp`.**
- **Resolves the actor from `auth.uid()` inside the function**, never from a caller-supplied
  argument — actor forgery is the B7/B8/B9 class.
- **Admin-only** (**D-J** / **D-S**). **Negative proof required:** call it as a non-admin, show it
  refused with **nothing at all written — no mutation and no audit row** (the **authorization**
  refusal of *A validation refusal is not a rejection* above).
- **Accepts `p_idempotency_key text DEFAULT NULL` and actually enforces it — and a key is
  *required*.** A call arriving with `p_idempotency_key IS NULL` is **refused**: a replayed approval
  is a second real write to live chemistry, not a no-op. **The receipt binds actor and intent per
  *Idempotency receipts bind actor and intent* above *(HIGH, R11-2)*:** server-derived
  `request_actor_id`, and a `request_fingerprint` over **the draft id, the decision, and the echoed
  `p_payload_sha256`** — so one key cannot replay this draft's approval for a different draft, a
  different decision, or a different reviewed digest.
- **Accepts `p_payload_sha256`** — the digest the review surface **echoed** from the stored row,
  never one it computed. **This is the parameter the frozen signature could never have carried, and
  it is the whole reason this RPC exists.** A null stored `payload_envelope_sha256` is refused.
- **In ONE transaction, IN THIS ORDER — every check and the version compare-and-set complete before
  any authoritative write *(PR-1, ordering fixed by blocker FIX-B)*:** locks the **product** row
  `FOR UPDATE` **first**, then the draft row
  **`FOR UPDATE`** — **THE lock order, the only one permitted** *(PR-1, FOLLOW-UP 1)*, built
  **identically** here, in
  `commit_product_attribute_proposal` and in the restamp, so two commits on one product serialize
  instead of deadlocking;
  **refuses if the row is not still `pending`**, so a double-approve cannot write twice;
  **recomputes the canonical envelope digest over the stored row after the locks and
  refuses on mismatch** *(R3-1, R3-7)*; **refuses if the product's current `epa_registration` IS
  DISTINCT FROM the draft's stored `source_epa_registration`** — **one clause, every typed chemistry
  draft, no `purpose` branch, any difference in either direction including the NULL transitions**
  *(blocker, R11-1)*; **and, as a SEPARATE entry, refuses a `workbook_import` chemistry draft whose
  product now has a usable EPA number** — D-Z's structural split, the single R2-12 predicate, never
  a second copy of the comparison above *(PR-3)*; *(the held product lock is what makes both
  re-checks meaningful rather than a TOCTOU, FOLLOW-UP 1)*;
  **re-checks every element's citation** — trimmed non-empty, the supplier pair-rule, no `measured`,
  no `nickname` *(G-2, R3-2)* — **and refuses a blank-basis element** *(G-3, finding 8)*; **refuses
  a draft carrying two elements that resolve to the same logical ingredient identity**
  *(FOLLOW-UP 2)*; **refuses
  any forbidden outer field** *(R2-5)*; **then settles `source_product_data_version` staleness —
  and this is the LAST thing that happens before the first authoritative write** (WP-4's rule,
  unchanged, now **genuinely atomic** and **correctly ordered**): the product row **is already held
  from the top**, so the comparison reads a value nothing can move.
  Only then does it write — **enforces the single-effective-row
  invariant**, promoting
  the committed row and retiring the one it replaces, with **D-L**'s typed-value precedence intact;
  **writes each element's `source_type`, `source_url` and `note`** into those columns on
  `product_active_ingredients` *(PR-4)*, in this same write and never as a backfill; **computes
  `conflicts[]` from each element's stored `observed_epa_registration` against the product's current
  `epa_registration`** *(R2-5 — computed here, never importer-supplied; ITEM 5)*; **writes an
  actor-bound audit
  row** on WP-1's `cost_history`-precedent trail; **bumps `product_data_version`** under the held
  lock; and **sets the
  queue row's status to the result of the *decision***, never back to `pending`.
- **But the transaction branches on the DECISION before any of that, and a REJECTION never advances
  the version *(blocker, ITEM 4)*.** Everything above describes the **approve** path. An admin's
  explicit **`rejected`** decision writes **no chemistry, no attributes, nothing to `products`** — so
  it must not bump `product_data_version` either. **A phantom bump on a rejection would spuriously
  stale every sibling draft for that product and every workbook compare-and-set derived from it**,
  turning a decision that changed nothing into a wave of false staleness refusals and forced
  restamps. So the RPC **branches on `p_decision` first**:
  - **Rejection path:** takes **only the DRAFT row `FOR UPDATE`** — **not the product row** — because
    it writes nothing the product lock protects; verifies the row is still `pending`; sets the queue
    status to **`rejected`**; writes its actor-bound audit row; and **stops**. It performs **no
    envelope recompute, no staleness comparison, no version bump, and no authoritative write**.
    *(Taking the product lock as well would be harmless for correctness, but it is not taken: the
    lock exists to serialize version changes, and this path makes none. Stating which is required so
    two builders do not pick differently and reintroduce a lock-order variant — see FOLLOW-UP 1.)*
  - **Approve path (`accepted` / `edited`):** the full sequence in the bullet above, product row
    first, version bump included. **The bump belongs exclusively to this path.**
  - **Negative proof required:** **reject** a draft; show **`product_data_version` unchanged**, no
    new or changed `product_active_ingredients` row, the queue row `rejected` with its one audit
    row — **and then show a SIBLING draft for that same product still commits successfully**, which
    is the assertion that actually catches a phantom bump. A version-only check can pass while the
    sibling has already been staled by something else; committing the sibling proves the version
    never moved.
- **Its refuse paths are of the three kinds *(PR-2, RR-4)*, identically to
  `commit_product_attribute_proposal`:** a **validation** refusal means **no authoritative product,
  chemistry, attribute, brand, or queue-state mutation; exactly one refusal audit row is written,
  naming the check that declined it; the draft remains `pending`** — and it **returns** that named
  refusal rather than raising it, per the transaction rule above. An **admin's explicit human
  rejection** writes its own actor-bound audit row and is one of the only two acts that may set
  `rejected`. An **authorization** refusal writes nothing at all.
- **`EXECUTE` to `authenticated` only, never `anon`**, and `REVOKE ALL … FROM PUBLIC, anon` on every
  internal helper, so a `SECURITY DEFINER` helper never becomes the privilege boundary.

**Four consequences, stated plainly because they are the reason this shape was chosen — and the
third one is where revision 6 was FLATLY WRONG *(FIX-A)*:**

- **The legacy manual path keeps working, and the guard is the only thing added to it.**
  `create_label_draft` is untouched entirely; `commit_label_draft` is re-emitted **once**, by WP-1,
  with one guard at the top and every other line byte-identical. There is exactly **one** body
  change in the whole plan, it is one `IF`, and it lands in the same migration that makes typed
  rows possible.
- **WP-1's legacy create-and-commit proof is extended, and it now proves MORE than it did.** Calling
  `create_label_draft` with today's five named arguments and committing that draft through
  `commit_label_draft` proves the deployed caller still works **through the guarded body** — which
  is the regression the guard could plausibly have broken. **And it gains a negative case *(FIX-A)*:
  create a TYPED draft** — `epa_label_seed` or `workbook_import` — **decide it through legacy
  `commit_label_draft`, and show it REFUSED with the named error**, no scalar fields written, the
  queue row still `pending`, one refusal audit row. **A positive-only proof would pass on the
  unguarded body**, which is precisely how revision 6's claim went unchallenged.
- **A typed draft is REACHABLE through legacy `commit_label_draft` unless it is guarded — revision 6
  said the opposite and said it confidently.** The claim was that the legacy body "predates the
  typed-payload columns" and therefore "cannot consume a typed payload because it does not know one
  exists." **That is true and irrelevant.** The body does not need to *understand* the payload to
  do damage: it checks the admin role, the decision value, idempotency and the draft's **status**,
  and **never reads `purpose`** (`20260629210000_product_label_drafts.sql:244-284`). Handed a
  workbook chemistry draft it would write the **scalar label fields**, **skip the digest, the
  version compare-and-set, the citation re-checks and the ingredient rows**, and **close the queue
  row** — an approval that wrote the wrong things, skipped every guard this amendment exists to
  install, and left nothing behind to review. **The deployed `LabelReview` screen makes that path
  live, not theoretical:** it loads **every** draft row, `select('*')`, **no `purpose` filter and no
  status filter** (`src/pages/LabelReview.tsx:210-220`), and posts decisions straight to
  `commit_label_draft`. **Revision 6's "do not add a guard to it" instruction is WITHDRAWN.** The
  guard is required, it is specified in WP-1's migration list above, and the freeze it appeared to
  protect was never protecting anything.
- **The UI consequence is real and is stated rather than glossed *(FIX-A)*.** Until Phase 1b's
  review surface ships, the legacy `LabelReview` screen will **display typed pending rows it cannot
  commit** — the guard refuses them, correctly, but the crew meets an Approve button that always
  fails. **So WP-1's screen scope includes filtering non-`manual` rows OUT of `LabelReview`**, so
  that the guard is a backstop nobody reaches rather than a wall the crew walks into daily. The
  guard is the **correctness** boundary; the filter is what keeps it from becoming a support
  ticket. Both ship; neither substitutes for the other.

**Read-together clause — the ONE place this rename is recorded, so the base plan is not rewritten
in place *(RR-5, exactly as PR-4 handled WP-1's column list)*: wherever the WP-4 section above, or
an earlier revision of this amendment, names `commit_label_draft` for the TYPED path — including
"`commit_label_draft` reads every field above by name and writes each to its mapped column", the
`source_product_data_version` staleness refusal, the single-effective-row invariant, D-L's
typed-value precedence and every commit-time re-check — read `commit_label_draft_proposal`.** Those
rules bind to it **identically and without exception**; not one of them is weakened, dropped or
renegotiated by moving to a new function. Where the same text concerns a **`manual`** draft, it
still means `commit_label_draft` — **whose signature is unchanged and whose body changes exactly
once, in WP-1's migration, to add the typed-purpose guard *(FIX-A)***. **The S-02 bullet is amended the same way:**
read "WP-4's migration adds only the EPA-specific RPC, `create_label_draft_proposal`" as **"adds
`create_label_draft_proposal` and `commit_label_draft_proposal`"**. **It still adds no queue
columns** — that half of the S-02 split is untouched, and WP-1 still owns the queue's shape.
**Phase 1b's function count is likewise untouched:** its migration still adds
`create_workbook_import_proposals` and no other function; RR-5 adds **one function to WP-4**, and
nothing anywhere else.

**The attribute commit RPC is named `commit_product_attribute_proposal`, and it is a WP-2 contract
*extension* *(blocker, R2-2; this closes revision 1's blocker 2 properly)*.** WP-2 above specifies a
**density** commit RPC — the one that enforces the **D-M** ranking on write (WP-2, finding 14). The
workbook proposes density, **net weight with its unit, package count and basis**, `formulation_type`,
`safener` and `nickname`. Revision 1 sent all of them to "WP-2's density/attribute commit RPC", whose
contract carries only the first; revision 2 correctly widened the contract and then **left the
widened function unnamed**, which is the identical unnamed-write-path failure WP-4 already corrected
once (WP-4, finding 6). It is named here. **This is a specification change to an unbuilt migration —
WP-2 is unbuilt and unapplied, so it edits nothing that exists.**

**WP-2's migration carries `commit_product_attribute_proposal`**, covering density *and* net weight
(value, unit, package count, and the package / net-weight basis) *and* `formulation_type` *and*
`safener` *and* `nickname`. Its contract, **modelled directly on this plan's own
`commit_brand_proposal` contract** so a builder has an executable shape rather than an adjective:

- **`SECURITY DEFINER` with `SET search_path = public, pg_temp`.**
- **Resolves the actor from `auth.uid()` inside the function**, never from a caller-supplied
  argument — actor forgery is the B7/B8/B9 class.
- **Admin-only** (**D-J** / **D-S**), the same boundary as `commit_brand_proposal`. **Negative proof
  required:** call it as a non-admin, show it refused with **nothing at all written — no mutation
  and no audit row** — the **authorization** refusal *(RR-4)*, which is the one refusal in this
  amendment that genuinely leaves no trace in the RPC's own hand.
- **Accepts `p_idempotency_key text DEFAULT NULL` and actually enforces it — and a key is
  *required*.** A call arriving with `p_idempotency_key IS NULL` is **refused**: a replayed approval
  is a second real write to live attributes, not a no-op. **The receipt binds actor and intent per
  *Idempotency receipts bind actor and intent* above *(HIGH, R11-2)*** — server-derived
  `request_actor_id`, and a `request_fingerprint` over **the draft id, the decision, and the echoed
  `p_payload_sha256`**, identically to `commit_label_draft_proposal`.
- **Accepts `p_payload_sha256` — the digest the review surface *echoed* from the stored row, never
  one it computed — and enforces it by recomputing the canonical envelope digest over the stored row
  after the lock**, exactly as described above (R2-3, R3-1, R3-7). A null stored digest is refused.
- **In ONE transaction, IN THIS ORDER — every check and the version compare-and-set complete before
  any authoritative write *(PR-1, ordering fixed by blocker FIX-B)*:** locks the **product** row
  `FOR UPDATE` **first**, then the draft row
  **`FOR UPDATE`** — **THE lock order, the only one permitted** *(PR-1, FOLLOW-UP 1)*, in this RPC,
  in `commit_label_draft_proposal` and in the restamp **identically**, so two commits on one product
  serialize instead of deadlocking; **refuses if the row is not still
  `pending`**, so a double-approve cannot write twice; **refuses on an envelope-digest mismatch**,
  after the locks; **re-checks that every TEXT
  value present is trimmed non-empty** and refuses a blank *(RR-2)*; **refuses a `net_weight_unit`
  outside the closed `lb` / `oz` / `kg` / `g` set** *(RR-3)*; **then settles
  `source_product_data_version` staleness — the LAST step before the
  first authoritative write** (WP-4's rule, unchanged) — **genuinely atomic and correctly
  ordered**, because the product row **is held from the line above**;
  and only then does it write —
  **enforcing the D-M ranking per field on write** — a lower-ranked candidate stays a **proposal**
  unless Mason explicitly approves it over the higher-ranked value; **converting a `per_package` net
  weight to the normalized per-purchase-unit figure and normalizing its unit to `lb` using the pinned
  named constants** *(RR-3)*, and retains the entered value, **unit**, basis and
  package count in **`net_weight_entered_value`, `net_weight_entered_unit`,
  `net_weight_entered_basis` and
  `net_weight_entered_package_count`** beside it (R2-8, R3-6, RR-3); **writes the attribute values and
  their per-field provenance — each field's `source_type`, `source_url` and `note` into that field's
  `<field>_source`, `<field>_source_url` and `<field>_source_note` columns, in this same
  transaction and never as a later backfill** *(RR-1)*; **writes an actor-bound audit row** on WP-1's
  `cost_history`-precedent trail; **bumps `product_data_version`** under the held lock
  *(PR-1, FIX-B)*; and **sets the queue row's status to the
  result of the *decision*** — one of the live CHECK's terminal decision states, **never back to
  `pending`**. A refusal is not a decision and takes none of this path *(PR-2)*.
- **The decision branch is the same one `commit_label_draft_proposal` makes, and for the same reason
  *(blocker, ITEM 4)*.** The sequence above is the **approve** path only. An admin's explicit
  **`rejected`** decision takes **only the DRAFT row `FOR UPDATE`** — **not the product row** —
  verifies the row is still `pending`, sets the status to `rejected`, writes its actor-bound audit
  row, and **stops**: **no staleness comparison, no authoritative write, and above all NO
  `product_data_version` bump.** A rejection changes nothing about the product, so advancing the
  version would **falsely stale the sibling chemistry draft** — the exact sibling pair *(R3-3)* whose
  restamp dance this amendment already spends a section on — and manufacture the failure it exists
  to prevent. **The bump belongs exclusively to the approve path.** **Negative proof:** reject an
  attribute draft; show `product_data_version` unchanged, no `products` column touched, the row
  `rejected` with one audit row, **and the sibling chemistry draft still committable**.
- **The same RPC's refuse paths are of three kinds, and only one of them touches the status *(PR-2,
  RR-4)*.**
  A **validation** refusal — staleness, including PR-1's version-predicate refusal; an
  envelope-digest mismatch; a null stored digest; a failed citation re-check; a field present with
  `null`; **a TEXT field present with a blank *(RR-2)*; a `net_weight_unit` outside the closed set
  *(RR-3)*;** a forbidden outer field — means **no authoritative product, chemistry, attribute,
  brand, or queue-state mutation; exactly one refusal audit row is written, naming the check that
  declined it; the draft remains `pending`** *(RR-4 — "writes nothing" was revision 5's wording and
  it contradicted the audit row this same contract requires)*. An **admin's explicit human
  rejection** is the second kind: it writes its own actor-bound audit row, writes nothing to
  `products`, and **is one of the only two acts that may set `rejected`**. An **authorization**
  refusal — the non-admin call above — is the third: **nothing at all, not even an audit row.** See
  *A validation refusal is not a rejection* above; revision 4 sent the first two kinds both to
  `rejected` and thereby broke restamp.
- **`EXECUTE` to `authenticated` only, never `anon`**, and `REVOKE ALL … FROM PUBLIC, anon` on every
  internal helper, so a `SECURITY DEFINER` helper never becomes the privilege boundary.
- **RPC-only with no direct column grant**, for the same reason density is (WP-2, Fable F-10).

**Per-field provenance needs somewhere to land — and "somewhere" means THREE columns per field, not
one *(R2-9; corrected by blocker RR-1)*.** WP-2 already defines **`density_source`**;
revision 5 extended that single column to **`net_weight_source`**, **`formulation_type_source`** and
**`safener_source`** and stopped there — **which quietly discarded two thirds of every citation.**
The payload requires `source_type`, `source_url` **and** `note` per attribute *(PR-5)*; one text
column can hold **one** of the three, so the commit had nowhere to put the URL or the supplier note
and would have dropped them **after** the reviewer approved on the strength of them. **Provenance
that survives review and dies on write is worse than no provenance, because the audit trail claims
it is there** — the identical sentence PR-4 wrote about chemistry, now true of attributes for
exactly the same reason.

**So the destination is the full triplet, per document-derived field:** `density_source`,
`density_source_url`, `density_source_note`; `net_weight_source`, `net_weight_source_url`,
`net_weight_source_note`; `formulation_type_source`, `formulation_type_source_url`,
`formulation_type_source_note`; `safener_source`, `safener_source_url`, `safener_source_note` —
**twelve columns, named in the delta table above and created by WP-2's migration**, written by
`commit_product_attribute_proposal` **in the same transaction as the value**, carried in the
regenerated `src/types/index.ts`, and **asserted field by field in the round-trip proof**, the URL
and the note **read back equal to what the payload carried** rather than merely non-null. **This is
the attribute side mirroring the chemistry side, which PR-4 already fixed:** `product_active_ingredients`
carries `source_type` / `source_url` / `note`, and an amendment that repaired provenance storage on
one side while leaving it lossy on the other repaired nothing. `nickname`
is **exempt** — it is Mason-only, no document states a trade shorthand, and there is nothing to rank.
**D-M's ranking governs the document-derived fields**, and **extending D-M beyond density is a
deliberate specification extension of WP-2, with `density_source` as the precedent** — stated
explicitly so a builder reads it as **decided**, not as an assumption he is free to drop. Finding 14
is unchanged in force and now matches in scope. **The retained *entered* net-weight columns ride in
the same migration and on the same precedent *(R3-6, RR-3)*** — `net_weight_entered_value`,
**`net_weight_entered_unit`**,
`net_weight_entered_basis` and `net_weight_entered_package_count`, mirroring `density_entered_value`
/ `density_entered_unit` **exactly, entered unit included** — so provenance and retained entry land
together, and neither is left as an
instruction with no column behind it. **This paragraph covers the *attribute* side only; the
*chemistry* side had the identical gap and revision 4 missed it *(PR-4)*** — element provenance lands
in `product_active_ingredients`, whose column list is amended above to carry `source_type`,
`source_url` and `note` in place of `source`. **Revision 6 finishes the job on this side *(RR-1)*,
so the two now match column for column.** Read them together: **no citation in this amendment — on
either side — has fewer destination columns than it has parts, and none of its parts is dropped at
commit.**

### Guardrails — stated as rules

| # | Rule | Why |
|---|---|---|
| **G-1** | **A workbook or AI-sourced value is NEVER written as effective chemistry directly.** Import creates **proposals only**. Every value reaches live data through the **typed commit RPCs — `commit_label_draft_proposal` for chemistry and `commit_product_attribute_proposal` for attributes *(RR-5 renames the first; revision 5 called it "the existing commit RPCs", which stopped being accurate the moment the typed path became its own function)*** — with every existing invariant intact — exactly one effective row per `(product_id, ingredient_id)` — **which is also why one draft may never carry two elements for the same ingredient, refused at import and again at commit *(FOLLOW-UP 2)*, since a collision would make the effective row depend on array order** — D-L's precedence, and refusal of a commit whose `source_product_data_version` has moved — **a refusal that is only a guard if the comparison is atomic, so **all three write paths — both commit RPCs and the restamp — take the product row `FOR UPDATE` FIRST and hold it, which since Revision 10 is the only permitted form *(PR-1, FOLLOW-UP 1)*, and the refusal itself leaves the draft `pending` rather than `rejected` *(PR-2)* while writing exactly one refusal audit row *(RR-4)* — no authoritative mutation, one audit row, draft still `pending`, which is the sentence every refuse path in this amendment now uses.** There is no bulk path around them, and none is to be added. **Nor is there a LEGACY path around them any more *(blocker, FIX-A)*: the deployed `LabelReview` screen loads every draft row with no `purpose` filter (`src/pages/LabelReview.tsx:210-220`) and posts to `commit_label_draft`, whose body never reads `purpose` — so a typed draft could have been "approved" through it, writing the scalar label fields, skipping the digest, the version compare-and-set, the citation re-checks and the ingredient rows, and closing the queue row. WP-1's migration closes that door with the typed-purpose guard, in the same migration whose CHECK first makes typed rows possible, so the door is never open for a single statement.** **`create_workbook_import_proposals` writes `product_label_drafts` (`INSERT`s, plus the single by-id supersede `UPDATE` on the restamp path, R2-7), its own actor-bound audit rows on WP-1's `cost_history`-precedent trail, and the idempotency bookkeeping the CRX contract requires — and it performs NO writes to authoritative chemistry, attributes, `products` or `product_brands`** *(R3-4; "and nothing else" was never true, since an RPC writing no audit row and no idempotency record would break two other rules in this plan)*. **That last clause is the invariant**, a property of its **body**, proved by the import's **negative before/after assertions** (zero rows changed in `active_ingredients`, `product_active_ingredients`, `products` chemistry/attribute columns, `product_brands`). **The `active_ingredients` assertion is load-bearing and nothing in R12-1 or its withdrawal weakens it:** a proposed form is created **only at the approved commit** *(G-1's boundary, untouched)*, so the importer still creates **no** form row. **What the commit does at that moment — resolve-or-create, and against what identity — is settled owner decision D-AA *(Mason, 2026-08-27)*, implemented in WP-1's build cycle; until that ships, the cross-product duplicate race stands as a known open HIGH.** That is a statement about the COMMIT path, not about this importer assertion, which holds either way. **Do not restate this as a grants argument** *(R2-6)*: the function is `SECURITY DEFINER`, so it runs as its owner and caller grants bind nothing | This is the whole safety property of **D-H** and **D-I**. An importer that writes chemistry is the ~35% WP-4 failure with a spreadsheet in front of it |
| **G-2** | **Provenance attaches to the element, and the agent fills only what a document can prove.** The AI fills **only document-derivable fields** — chemistry, density, net weight and its package basis, `formulation_type`, `safener` — and cites **per value**: `source_url` is **required** for `source_type` `sds` and `label`; a `supplier` value carries a document URL **or**, where the supplier publishes none, a **named supplier-document reference** in that value's `note`. **"Value" means value, on both sides *(PR-5)*:** chemistry elements and `product_attributes` fields each carry their own `source_type` / `source_url` / `note`, and the supplier pair-rule applies to an attribute exactly as it applies to an element — revision 4 gave attributes no `note`, which left that rule with nowhere to land on the attribute side. **Every one of those values must be *trimmed non-empty*, not merely non-null *(R3-2)*** — whitespace is a blank cell wearing a citation's clothes, and the predicate that enforces it is quoted exactly once, in the payload-contract delta table above. **`measured` is reserved for Mason's own in-app entry and is never importable** — the import RPC refuses any element claiming it, and the CHECK and the commit re-check enforce the same, so D-M's top rank cannot be claimed by a spreadsheet. **`nickname` is Mason-only** and an imported nickname element is **refused**: no document states a trade shorthand, so a cited one would be a fabricated citation. Anything the agent cannot cite stays **blank**; **blank is reviewable, a guess is not.** **And blank means one thing only *(R2-4)*: no proposal — the live value is left alone.** It never means "clear this", and where a document affirms an absence the agent writes the **explicit cited value `none`** rather than a blank. **Revision 6 makes that mechanical rather than conventional *(blocker, RR-2)*: a TEXT value is proposed only if it is *trimmed non-empty*, checked at import, by the CHECK and again at commit** — `''` and `'   '` are refused exactly as `null` is, because revision 5 counted them as real values and would have let a spreadsheet **blank out a live `formulation_type` or `safener`**. **The whole loop, and there is nothing outside it: ABSENT = no proposal; PRESENT = a trimmed non-empty value, which for a documented absence is the cited literal `none`. No third state exists.** Enforced in three places — the element rule in the payload, the import RPC, and again at commit — never by the spreadsheet alone, which anyone can edit | The citation beside the value is what makes per-row review fast enough to be real. Without it, review degrades into re-reading the label — the exact work D-Z exists to remove. And a rule keyed to `purpose` rather than to the element fails open through the one path nobody is allowed to modify |
| **G-3** | **Concentration basis is recorded as the label's own wording states it, never converted by the filler.** The template constrains `basis` to the **D-A** enum (`acid_equivalent`, `active_ingredient`, `oxide`, `elemental`) and `concentration_unit` to WP-1's list (`lb_per_lb` remains rejected), and the review surface shows the basis and the citation beside the number. **D-A's three rules and R-4a's refusing conversion function govern every use of the value** — nothing here restates, weakens or duplicates them. A label whose basis is unclear leaves `basis` **blank with a note** — and **a blank-basis chemistry element is reviewable but NOT committable: `commit_label_draft_proposal` refuses it** *(finding 8; renamed by RR-5)*. **That is a *validation* refusal *(PR-2, RR-4)*: no authoritative product, chemistry, attribute, brand, or queue-state mutation; exactly one refusal audit row is written, naming the check; the draft remains `pending`** — which is what keeps the correction path open. The correction path is the **WP-1 entry screen**, a **restamp**, or a **re-proposed row that states the basis**; it is never a default filled in at commit | Salt weight and acid equivalent on the same jug are different numbers, and a filler that "helpfully" converts destroys the one fact the row exists to record. Blank is a legitimate state for a **proposal** and an illegitimate one for **effective chemistry**: a concentration with no basis is a number whose meaning is unknown, and R-4a has nothing to refuse on because there is nothing to convert *from* |
| **G-4** | **Review remains per-row human approval by an admin, and one approval is one transaction.** **D-J** and **D-S** are unchanged: admins only, one row at a time, every change audited. Because a `workbook_import` row carries **exactly one domain**, approving it invokes **exactly one commit RPC in exactly one transaction** — there is no half-approved row and no second call to forget. **A product with drafts in *both* domains is therefore two rows and two approvals**, run in the documented order — commit one domain, restamp the sibling, approve it *(R3-3)* — which is the normal path, not an exception to this rule. **Rejection is per row on the same terms**, each with its own audit row and actor; `import_batch_id` **filters** the review session and never executes it. **And "rejection" here means the human act, which is one of only two things that may set `rejected` — the other being the restamp supersede *(PR-2)*. A commit that refuses on a validation check has rejected nothing: the draft stays `pending` and the audit row carries the story.** **Because the two commits on a dual-domain product now serialize on the product row *(PR-1)*, firing both at once yields one commit and one staleness refusal, not two writes — the same two-approval shape this rule already describes, with the order enforced instead of assumed.** **Approving — or rejecting — an entire sheet in one click is out of scope for Phase 1** and must not be built as a convenience | A one-click sheet approval is a bulk unreviewed write to live chemistry wearing a review screen's clothes — and a one-click sheet *rejection* is the same write with the audit trail of one actor standing in for a hundred decisions |
| **G-5** | **The review surface renders every element of a proposal, and approval binds to what was rendered** *(finding 6)*. Before approval the surface shows, for **each** element: the **proposed value**, the **current effective value** where one exists, the **citation** (`source_type` and `source_url`, or the named supplier reference), the **basis**, and — where the element carries one — the **`observed_epa_registration` beside the product's current `epa_registration`, rendered as a visible disagreement when they differ** *(ITEM 5)*, so the reviewer decides it under D-L rather than discovering it later in `conflicts[]`. **Approval binds to exactly the rendered content** — not to the row id, and not to the payload re-read at click time — and it binds **by mechanism**: a **server-computed `sha256` over the canonical envelope** — draft id, `product_id`, `purpose`, `payload_version`, `source_product_data_version`, domain **and** payload — **stored on the draft at creation**, **echoed** unchanged by the review surface as `p_payload_sha256`, and **recomputed over the stored row inside the commit transaction after the `FOR UPDATE` locks *(PR-1)*** — refusing on mismatch. **The client never serializes JSON for hashing** *(R2-3, R3-1, R3-7)*. **An element the surface cannot render blocks approval; it is never hidden.** Phase 1b's acceptance proof must include a **multi-element draft** showing every element rendered with its current value and citation, **and** five negative cases — a draft carrying an element the surface cannot render is **refused approval** with a named error rather than approved with that element invisible; a draft **edited after it was rendered** is **refused** on the stale envelope digest; a draft whose **`product_id` was changed after it was rendered** is **refused** on that same digest, with **nothing authoritative written on either product** *(R3-1 — the live `admin_update_product_label_drafts` policy permits exactly that row-wide edit, so a payload-only hash would have let content reviewed for one product commit onto another)*; a **`workbook_import` chemistry draft whose product gained a usable EPA number after the proposal** is **refused** at commit *(PR-3 — the draft is byte-identical, so no digest can catch this one)*; **and** **two simultaneous commits against one product from two sessions** end with **exactly one success**, the other **refused on the version predicate**, nothing authoritative written by the loser, and `product_data_version` advanced exactly once *(PR-1)*. **Revision 12 adds one, and parks one *(R12-2 live; R12-1 → D-AA)*: a same-key call to `create_workbook_import_proposals` naming a DIFFERENT restamp target is refused by name with the intended draft untouched, while the same restamp replays its original receipt with no second supersede. The cross-product identity case — two sessions concurrently approving the same NEW chemical form for two DIFFERENT products ending with exactly ONE `active_ingredients` row — is NOT a G-5 proof case yet *(Revision 13)*: it is an ACCEPTANCE CRITERION of settled owner decision D-AA *(Mason, 2026-08-27)*, and it becomes a required proof in **WP-1's build cycle**, alongside D-AA's other criteria — same-CAS-different-names resolving to one row, the queued CAS-less merge, the import refusal on a canonical-parent mismatch, no shared-name mutation, and no opposing-order deadlock.** **Revision 11 adds these *(R11-1, R11-2)*: a typed chemistry draft — proved on BOTH `epa_label_seed` AND `workbook_import` — whose product's `epa_registration` moved after proposal is refused at commit, including the NULL→X and X→NULL transitions, and a restamp then commits cleanly; and, on each of the three new mutating RPCs, a same-key call with a changed intent (different draft, decision or echoed digest) is refused, a same-key call from a different actor is refused, a same-key same-intent call replays with no second write and no second version bump, and two simultaneous same-key calls produce exactly one execution.** **Revision 10 adds three more negative cases to that list, and they are database-level rather than surface-level *(BLOCKER, FOLLOW-UP 2)*: a `manual` row carrying typed elements is refused by the purpose-conditional CHECK on INSERT; an admin `UPDATE` relabelling a typed draft to `manual` — or injecting a typed payload into a `manual` row — is refused by that same CHECK; and a draft carrying two elements for one ingredient is refused at import AND, if smuggled past by admin edit, again at commit.** **Every one of those refusals asserts the same three things, and "writes nothing" is not one of them *(RR-4)*: nothing authoritative written; the refusal audit row present; the draft still `pending` and therefore restampable, never `rejected` *(PR-2)*** — the proof asserts the status and the audit row, not only the absence of a write. **The round-trip case asserts provenance field by field on both sides *(RR-1)*:** each committed chemistry element's `source_type` / `source_url` / `note`, and each committed attribute's `<field>_source` / `<field>_source_url` / `<field>_source_note`, **read back equal to what the sheet cited** | A reviewer approves what he can see. An element rendered as a blank, a truncation, or not at all is an unreviewed write wearing a review screen's clothes — G-1's failure arriving one element at a time instead of one sheet at a time |

The WP-4 two-gate rule applies unchanged: **creating** the proposal rows is itself a bulk write to a
live table and takes Mason's approval separately from the approval that **commits** them, and R-12's
fresh backup precedes both. R-1 and R-2 also apply — the import ships with the review surface that
proves it, and its acceptance runs in the running app as a normal authenticated user, with the
non-admin refusal proved as its negative case.

### The priority worklist (D-Y)

- **Derived read-only from live sales usage** — `order_items` joined to non-deleted `orders`, and
  `delivery_items` joined to non-deleted `deliveries`, aggregated per `product_id` into a line-count
  usage score with ordered and delivered quantities carried beside it. It reads; it writes nothing.
- **Cancelled and voided parents are excluded from the aggregation *(finding 15)*.** A cancelled
  order and a voided delivery are records of work that did **not** happen, and counting them ranks a
  product by a sale that was undone. The predicate is
  `orders.status NOT IN ('cancelled','voided')` and `deliveries.status NOT IN ('cancelled','voided')`,
  **on top of** the existing `deleted_at IS NULL` filters. **Both status domains were read live from
  the current CHECK constraints on 2026-08-26, not assumed** — `orders_status_check` admits
  `confirmed`, `partially_fulfilled`, `fulfilled`, `cancelled`, `voided`; `deliveries_status_check`
  admits `scheduled`, `in_progress`, `completed`, `cancelled`, `voided`. Two column facts belong
  beside it, because guessing either produces a query that runs and lies: **`order_items` has no
  `quantity` column** — the ordered amount is **`total_units_needed`** — and `delivery_items` uses
  **`coalesce(quantity_delivered, quantity)`**.
- **The score is an ordering heuristic, not revenue, and Mason confirms the band before it locks
  scope *(finding 15)*.** A line count says how *often* a product moves, not what it is *worth*: a
  high-value product sold in a few large lines ranks below a cheap one sold constantly. That is
  acceptable for **ordering data-entry work** and unacceptable as a business metric, and **no
  revenue-weighted metric is to be built here** — it would depend on cost, tier and split-billing
  correctness this build has not yet delivered. So **Mason reviews and confirms the ranked top band
  before it locks the ≈2026-09-18 scope**; until he does, the band is a proposal like any other.
  **The order/delivery double-count is deliberate, and is disclosed rather than corrected
  *(accepted residual, R2-13)*:** a product that was both ordered and delivered contributes to both
  halves of the score, which is **signal-stacking** — a product that actually moved twice is meant to
  rank higher — not an accounting error. The guard against a distorted band is the confirmation step
  this bullet already requires: **Mason reads the ranked list and confirms it.** No revenue-weighted
  metric is to be built to "fix" it.
- **Regenerated on demand.** It is a snapshot of a moving number, not a stored artifact. Re-run it
  rather than trust a copy.
- **It orders the work and defines the scope.** Entry runs top-down, and the "top products" the
  ≈2026-09-18 comparison tool must be right about are the ranked band covering **~80% of usage**.
  Each row also carries whether the product has a **usable** EPA number — **the predicate defined
  once above (R2-12)**, not a second definition — and therefore, per D-Z, whether its chemistry comes
  from WP-4's auto-seed or from the workbook. Its **attributes** come from the workbook either way.
- **Neither workbook is committed to this repository — the template included.** The ranked list is
  customer-derived sales intelligence and this repo is public; both files live outside the repo
  tree, beside each other. The empty template was originally intended for `docs/plans/`, but the
  pre-commit Phase 3C containment guard **refuses any compressed-archive container it cannot
  inspect** (an `.xlsx` is a zip), and that fail-closed stance is kept deliberately rather than
  allowlisted: a committed template is one careless save away from a committed **filled** sheet.
  No rank, count, volume
  or product name from the worklist belongs in a plan document, a commit message or a PR body.
  **Revision 3 removed the worklist-derived counts revision 2 had published here *(R2-14)*** — the
  top-band size and its usable-EPA count — and replaced them with qualitative wording. **Revision 5
  finishes that job *(PR-6)*: qualitative wording about the band's composition is still a claim about
  customer-derived sales data, only rounded.** The one that survived — in the **D-Z** cell, asserting
  what share of the top band carries a usable EPA number — is **removed**, and the rule it was
  propping up is restated in a form that does not reference the band at all: the EPA/workbook split
  is **structural** and reads the same whatever the band contains. **No composition claim about the
  worklist — count, share, proportion or adjective — belongs anywhere in this plan.** The rule
  applies to **this amendment as much as to a PR body**, and the amendment now obeys it. *(The
  catalogue-wide label-data figures elsewhere in this plan are **not** sales-derived and stay
  exactly as they are.)*

### What does not change

- **Every settled decision stands.** D-A through D-X and the three 2026-08-20 settlements are
  untouched. This amendment adds D-Y and D-Z; it reopens nothing.
- **The WP-0…WP-5 ordering among themselves is unchanged**, and WP-4 still runs — the only thing
  Revision 3 moved is **Phase 1b's slot**, now after WP-4 rather than after WP-2, and **revisions 4,
  5 and 6 move nothing at all**: revision 4's seven fixes, revision 5's six and revision 6's five
  are all mechanism, storage shape and wording — not sequence. **RR-5 adds one function to WP-4's
  migration — `commit_label_draft_proposal` — and moves no package and no other count**; Phase 1b's
  migration still adds exactly one function, and WP-2's still adds exactly one. **FIX-A adds no
  function anywhere *(revision 7)*:** WP-1's migration **re-emits one existing function's body** to
  add the typed-purpose guard, which changes a body and not a count — `pg_proc` holds exactly one
  `commit_label_draft` before and after. **Say it that way and not as "WP-1 adds a function", because
  the two claims are audited differently.** **The division of
  labour is
  structural, not a preference:** where a product has a usable EPA number the auto-seed is its
  **only** chemistry source on this path and the workbook is **refused** one for it; the workbook
  fills the attributes EPA cannot supply, for **every** product. Revision 1's "remains the preferred
  source" wording is **replaced** — a *preference* is a tie-break a builder can decide to lose, and
  the point of the rule is that there is no tie to break.
- **Mason's typed or approved value remains the trust anchor (D-L).** A workbook row **he approves**
  becomes his approved value and holds the effective row; a later EPA lookup that disagrees is stored
  beside it as a flagged difference and never overwrites it. A workbook row he has **not** approved is
  not his value and carries no precedence whatever — it is a proposal like any other.
- **Phase 2's 573 re-derived rate values are NOT delegated to this path.** They remain individually
  human-reviewed with no bulk auto-rewrite (D-V, B-13, §4 Phase 2). Phase 1b ships **two distinct
  surfaces, and only one of them imports**: the read/export product-data workbook, whose rate columns
  remain **read-only exactly as D-C already rules (C-32 unchanged)** — and the **proposal-import
  template**, which carries **no rate columns at all** and must never gain one. Neither surface
  writes a rate.
- **The WP-1 fast-entry screen still ships (D-N).** It is where a **refused or rejected** proposal
  gets corrected — the two are different states *(PR-2)*, and both end up on the same screen — and
  where one-off edits happen. The workbook does not replace it. **WP-1's screen scope gains one
  small item in revision 7 *(FIX-A)*: filtering non-`manual` rows out of the legacy `LabelReview`
  list**, so that between WP-1 and Phase 1b the crew never meets an Approve button that the new
  typed-purpose guard will always refuse.

---

## 4. The rest of the sequence — planned, not yet handed off

| Phase | Package | Already decided |
|---|---|---|
| **1b** | Product Data Workbook | Extend existing machinery. Separate `Ingredients` / `Crop Uses` tabs, never delimited strings. Rate columns read-only (D-C). Absent row = ignore (D-D). Concurrency via `product_data_version` compare-and-set (D-E). **Resequenced to run immediately after WP-4 and before WP-5 (Amendment 2026-08-26, current revision — WP-4 owns the typed propose/commit machinery the importer rides on), + bulk proposal import mode, and it carries its own migration — one new RPC, `create_workbook_import_proposals` — see Amendment 2026-08-26** |
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
