# Repo Scout: twentyhq/twenty

**Date:** 2026-06-19
**Scout lens focus:** CRM-UX (sales pipeline, opportunities, stages, activities) + architecture (metadata-driven custom objects/fields, i18n)

## Identity
- **Repo:** twentyhq/twenty
- **What it is:** "The open alternative to Salesforce, designed for AI." A modern open-source CRM (50k+ GitHub stars).
- **Stack:** TypeScript monorepo — React front-end (`packages/twenty-front`), NestJS + TypeORM server (`packages/twenty-server`), PostgreSQL, GraphQL, shared types (`packages/twenty-shared`), Lingui for i18n.

## Confirmed license
- **License API returns `NOASSERTION`** (GitHub can't auto-classify it because of mixed licensing).
- **Actual LICENSE file (read directly):** `GNU AFFERO GENERAL PUBLIC LICENSE Version 3` (AGPL-3.0), **with a carve-out**: certain files marked `/* @license Enterprise */` at the top are under a separate commercial license, NOT AGPL.
  - Evidence: `LICENSE` (header text: *"This project is mostly licensed under the GNU General Public License (GPL)… certain files… are licensed under a different commercial license… marked with /* @license Enterprise */"*).
- **Borrow rule:** AGPL is the strict copyleft (triggers even for a website people merely USE). CRX is hosted SaaS, so **do NOT lift source code**. Propose **ideas / data-model shapes / formulas only**, clean-room re-implemented on Supabase + React. The Enterprise-marked files are even more restricted — avoid entirely.

## Top features (grounded)
1. **Metadata-driven custom objects + custom fields engine** — the crown jewel. Workspaces define their own objects and fields at runtime; the schema is data, not migrations. (`packages/twenty-server/src/engine/metadata-modules/object-metadata/object-metadata.entity.ts`, `.../field-metadata/field-metadata.entity.ts`)
2. **Rich typed field system** — 24 field types incl. CURRENCY, RATING, SELECT/MULTI_SELECT (with colored tag options), ADDRESS, PHONES, EMAILS, LINKS, FULL_NAME, RELATION/MORPH_RELATION, RICH_TEXT, POSITION, ACTOR. (`packages/twenty-shared/src/types/FieldMetadataType.ts`, `.../FieldMetadataOptions.ts`)
3. **Sales pipeline / opportunities** — Kanban-style deal flow with `stage`, `amount` (currency), `closeDate`, `position`, `owner`, `pointOfContact`. (`packages/twenty-server/src/modules/opportunity/standard-objects/opportunity.workspace-entity.ts`)
4. **Polymorphic activity timeline** — every record (person/company/opportunity/custom) gets a unified chronological feed of notes, tasks, and system events via a `timeline-activity` join with `target*` columns + a `properties` JSON blob. (`.../modules/timeline/standard-objects/timeline-activity.workspace-entity.ts`)
5. **Notes & tasks attachable to anything** — `note-target` / `task-target` polymorphic join tables let one note or task link to a person, company, opportunity, or custom object. (`.../modules/note/standard-objects/note-target.workspace-entity.ts`, task entity)
6. **Full i18n** — Lingui-based, **31 locales** (incl. RTL ar-SA, he-IL) with a pseudo-locale for QA and fallback chains. (`packages/twenty-front/lingui.config.ts`, `packages/twenty-shared/src/translations/constants/AppLocales.ts`)
7. **Per-field/per-object permissions** (`object-permission`, `field-permission` modules) and a "flat-entity" cache layer for the metadata graph.

## Data-model highlights (cited)
- **`objectMetadata`** (`object-metadata.entity.ts`): `nameSingular/namePlural`, `labelSingular/labelPlural`, `description`, `icon`, `color`, `isActive`, `isSystem`, `isSearchable`, `isAuditLogged`, `isUIEditable/isUICreatable`, `duplicateCriteria` (jsonb), `standardOverrides` (jsonb), `workspaceId`. Unique on `(nameSingular, workspaceId)` and `(namePlural, workspaceId)`. This row IS a table definition.
- **`fieldMetadata`** (`field-metadata.entity.ts`): `objectMetadataId`, `type` (the FieldMetadataType enum), `name`, `label`, `icon`, `description`, `defaultValue` (jsonb), `options` (jsonb — for SELECT etc.), `settings` (jsonb), `isActive`, `isSystem`, `isNullable`, `isUnique` (derived), `isLabelSyncedWithName`, relation-target columns for RELATION/MORPH_RELATION. CHECK constraint enforces MORPH_RELATION requires a morphId. Unique on `(name, objectMetadataId, workspaceId)`.
- **SELECT option shape** (`FieldMetadataOptions.ts`): `{ id, position, label, value, color }` where `color` is one of ~26 named tag colors. MULTI_SELECT = array of same. This is the clean, copy-able shape for a colored-tag picker.
- **`opportunity`** (`opportunity.workspace-entity.ts`): `name`, `amount: CurrencyMetadata` (amountMicros + currencyCode), `closeDate`, `stage: string`, `position: number` (kanban ordering), `createdBy/updatedBy: ActorMetadata`, `owner`, `pointOfContact`, links to tasks/notes/attachments/timeline.
- **`timelineActivity`** (`timeline-activity.workspace-entity.ts`): `happensAt`, `name`, `properties: JSON`, `linkedRecordCachedName`, `linkedRecordId`, `linkedObjectMetadataId`, plus a `target*` FK + `target*Id` for each first-class object — a fan-out polymorphic feed.
- **`note-target` / `task-target`**: thin join rows (`targetPersonId`, `targetCompanyId`, `targetOpportunityId`, `custom`) = attach one activity to many record types without per-type tables.

---

## Candidate table

| # | Title | Lens | Relevance | Effort | Borrow | Fills gap |
|---|-------|------|-----------|--------|--------|-----------|
| 1 | Sales pipeline / opportunity board | CRM-UX | 5 | M | data-model | no CRM sales pipeline |
| 2 | Metadata-driven custom fields (registry table) | architecture | 5 | L | data-model | no metadata-driven custom fields |
| 3 | Colored-tag SELECT option model | architecture | 4 | S | data-model | custom fields (enabler) |
| 4 | Polymorphic activity timeline | CRM-UX | 4 | M | data-model | CRM pipeline (activities) |
| 5 | Notes & tasks attachable to any record | CRM-UX | 4 | M | idea | no CRM sales pipeline |
| 6 | i18n via Lingui + locale fallback chain | architecture | 3 | M | idea | no i18n |
| 7 | Kanban `position` ordering pattern | CRM-UX | 3 | S | formula | no CRM sales pipeline |
| 8 | Per-record duplicate-detection criteria | CRM-UX | 3 | S | idea | no CRM sales pipeline |

(Full detail for each candidate is in the returned structured object.)

## Translation notes for CRX (ag-retail DEALER, not a grower's farm app)
- The CRM layer maps cleanly: **Company → farm/customer, Person → grower contact, Opportunity → a booking/season deal** (e.g. "[Farm Alpha] 2026 corn program"). CRX already has customers + quotes; what's missing is the *pre-quote* pipeline (lead → qualified → quoted → won/lost) and the activity history that sits beside it.
- The **custom-fields engine** is the highest-value architectural borrow but also the heaviest — for CRX a *scoped* version (admin-defined extra fields on customers/products/fields, stored as `jsonb` + a small `custom_field_defs` registry) captures 80% of the value without rebuilding the whole runtime-schema machine.
- **Discard** Twenty's email/calendar sync, messaging campaigns, and generic CRM objects we don't need — CRX's domain objects already exist.
