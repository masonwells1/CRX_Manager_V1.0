# Repo scout: ekylibre/ekylibre

_Mined 2026-06-19 for ideas/data-models/formulas to improve CRX Manager._

## Identity
- **Repo:** ekylibre/ekylibre
- **What it is:** A full Farm Management Information System (FMIS) + agricultural ERP. It is a *grower's own-farm* app, but it carries a remarkably complete **double-entry accountancy module** and a **pesticide-traceability/compliance engine** — the two areas where CRX (an ag-retail dealer) has named gaps.
- **Stack:** Ruby on Rails + PostgreSQL + **PostGIS** (geometry on field/working zones). ~390 ActiveRecord models in `app/models/`. (README: `gh api repos/ekylibre/ekylibre/readme`.)
- **CONFIRMED license:** **AGPL-3.0** (`gh api repos/ekylibre/ekylibre/license --jq '.license.spdx_id'` → `AGPL-3.0`; per-file headers confirm "GNU Affero General Public License ... version 3"). Strong copyleft incl. the network-use trigger. **Borrow IDEAS / DATA-MODEL shapes / FORMULAS only, clean-room re-implemented on Supabase+React. Do NOT copy source.**

## Top features (relevant to CRX)
1. **Full double-entry general ledger** — `journal`, `journal_entry`, `journal_entry_item`, `account` (chart of accounts), `financial_year`, balanced debit/credit with triple-currency tracking and account "lettering" (reconciliation). (`app/models/journal_entry.rb`, `journal_entry_item.rb`, `account.rb`)
2. **Phytosanitary product/usage registry ("lexicon")** — a reference DB of every registered chemical with re-entry interval, pre-harvest interval, max applications/year, max dose *per crop*, buffer zones, signal/risk phrases. (`app/models/lexicon/registered_phytosanitary_product.rb`, `registered_phytosanitary_usage.rb`)
3. **Interventions** = planned-vs-actual application records with full input traceability (batch numbers, dose, spray volume) and automatic compliance checks against the registry. (`app/models/intervention.rb`, `intervention_input.rb`)
4. **PFI / IFT (treatment frequency index)** — a per-application dose-intensity compliance metric. (`app/models/pfi_intervention_parameter.rb`)
5. **`Affair`** — a polymorphic "deal" object that nets sales + purchases + payments + credits for one third party into a single balanced reckoning, with a reconciliation letter and a CRM-style win-probability. (`app/models/affair.rb`)
6. **Metadata-driven custom fields** — admin-defined typed fields attachable to any model. (`app/models/custom_field.rb`)
7. **Fixed-asset depreciation schedules** (linear/declining), prescriptions, manure/nutrient management plans, activity budgets.

## Data-model highlights (cited)

### Double-entry ledger (`journal_entry` / `journal_entry_item`)
- An **entry** carries `balance`, `debit`, `credit`, plus `real_*` (financial-year currency) and `absolute_*` (company currency) — three currency planes per row. `continuous_number` is uniquely indexed → legally-immutable sequential numbering. `state` (draft/confirmed/closed) and `validated_at` enforce period locking. `compliance` jsonb stamps the audit/validation vendor+result on the entry itself. (`app/models/journal_entry.rb` table block, lines 26–60.)
- An **item** belongs to an `account` and carries `letter` + `lettered_at` (reconciliation/matching of an invoice line to its payment line), `tax_id` + `pretax_amount`, and `cumulated_absolute_debit/credit` (running balance). (`app/models/journal_entry_item.rb` table block.)
- `account.number` is format-validated (`/\A\d(\d(\d[0-9A-Z]*)?)?\z/`), `reconcilable` flag, and `CENTRALIZING_NATURES = [client, supplier, employee, payslip_contributor]` — i.e. AR/AP subledgers roll up into centralizing GL accounts. (`app/models/account.rb`.)

### Phytosanitary registry — the label-data shape (`registered_phytosanitary_usage`)
The usage row is keyed by **product × crop** and carries exactly the label fields CRX is missing (0/604 products today):
- `in_field_reentry_delay` (REI, an interval), `pre_harvest_delay` (PHI, interval) + `pre_harvest_delay_bbch` (growth-stage form), `applications_count` / `applications_frequency` (max/year + min interval between), `dose_quantity` + `dose_unit` (max legal rate **per crop**), `development_stage_min/max`, `untreated_buffer_aquatic/arthropod/plants` (no-spray buffers), `state` (authorized/withdrawn → go/caution/stop), `france_maaid` (the EU registration id, the EPA-reg-# analogue). (`app/models/lexicon/registered_phytosanitary_usage.rb` table block + `#status`.)
- The product row (`registered_phytosanitary_product`) adds `active_compounds[]`, `firm_name`, `in_field_reentry_delay`, `restricted_mentions` (the RUP flag analogue), `operator_protection_mentions`, `record_checksum` (for incremental sync of an externally-maintained registry). (`app/models/lexicon/registered_phytosanitary_product.rb`.)

### Application-time enforcement (`intervention_input`)
On create, the input **copies the live registry values onto the application record** so the record is frozen even if the registry later changes: `allowed_entry_factor` ← phyto `in_field_reentry_delay`; `allowed_harvest_factor` ← usage `pre_harvest_delay`; `applications_frequency` ← usage value. Also stores `batch_number`, `quantity_value/unit`, `spray_volume_value`, `working_zone` (PostGIS polygon). (`app/models/intervention_input.rb` `before_validation` block, lines ~60–90.)

### Affair (deal-netting / pipeline)
Polymorphic hub: one `affair` has_many sales, purchase_invoices, incoming_payments, outgoing_payments, credits, gaps for one `third` (entity). Header carries `debit`/`credit`/`pretax_amount`, a reconciliation `letter`, `closed`/`closed_at`, `dead_line_at`, and **`probability_percentage`** (deal win-likelihood). The header comment is a tidy debit/credit truth-table by deal type. (`app/models/affair.rb` lines 24–95.)

### Custom fields (metadata-driven)
`custom_field`: `customized_type` (which model), `column_name` (auto-slugged, unique per type), `nature` ∈ {text, decimal, boolean, date, datetime, choice}, plus min/max length+value validators; choices in `custom_field_choice`. Values live in a `custom_fields` jsonb column on the host model (e.g. `accounts.custom_fields`, `interventions.custom_fields`). (`app/models/custom_field.rb`.)

## Candidate table
See structured output. Highest-value, gap-filling picks: **phytosanitary usage registry** (label data, REI/PHI), **application-time compliance freeze**, **double-entry ledger**, **PFI/treatment-intensity metric**, **affair deal-netting**, **metadata custom fields**.

## License note (applies to every candidate)
AGPL-3.0, copyleft + network clause. Everything below is an **idea / data-model shape / formula** to re-implement clean-room on Supabase Postgres + React. No Ruby source is copied into CRX.
