## 2026-10-09 — Invoice screens: last season's open invoices are back, no duplicate field invoices, no posting unsaved edits

Three fixes to the invoice screens. All are app-only; no database change.

### 1. Last season's open invoices show again on the invoice lists

**What staff will notice:** since October 1, the Chemical Sales invoice list and the Field
Invoices tabs (Drafts, Posted, All Invoices, and the tab counts) were empty of last season's
work. Every invoice from before October 1 that was still a draft, unposted, posted-but-unpaid or
overdue had disappeared, and the Drafts tab's **Post All** could not reach them. They are back.

- An **open** invoice (draft, unposted, posted, overdue) now shows on these lists whatever
  season it belongs to. A small **"Season 2026"** tag next to its date marks an invoice from an
  earlier season.
- A **closed** invoice (paid, voided, cancelled) still shows only for the current season, as
  before.
- **Post All** on the Drafts tab now includes last season's unposted field invoices. It posts
  them through the same server posting step as always, so every server-side rule (including the
  filed-season rules) still decides whether each one may post.
- The Posted tab's scope menu now reads "This Season + older unpaid", and the All Invoices tab
  says it also shows older unposted or unpaid invoices.

Live check (read-only, 2026-10-09): 12 open invoices exist, all from before October 1
(11 chemical sale, 1 unposted field invoice). The old list filters showed **0** of them; the new
filters show **all 12**. The one paid invoice from last season stays hidden, as intended.

### 2. Saving a new field-application invoice no longer shows a false "Unsaved Changes" box

**What staff will notice:** after the first Save of a new field-application invoice, the page now
goes straight to the saved invoice. Before, an "Unsaved Changes" box appeared even though the save
had worked, and choosing **Stay** then **Save** created a **second, duplicate** invoice.

- A fully successful save moves to the saved invoice with no prompt.
- If part of the save fails (for example the billing details), the form keeps your typed values
  and the prompt still appears, as before. Choosing Stay and saving again now **updates the
  invoice that was already created** instead of creating another one.

### 3. Post is blocked on the invoice editor while there are unsaved edits

**What staff will notice:** on the regular invoice editor (chemical sales, misc charges, and
job/blend field invoices), the **Post** button is greyed out while you have unsaved changes, with
the note "Save your changes before posting." Before, Post could be clicked with unsaved edits on
screen: it posted the old saved amounts and then quietly threw the edits away.

- Save first, then Post.
- The credit-limit check and the restricted-use (RUP) license warning before posting now look at
  the saved invoice that will actually be posted, not at what happens to be on screen.

### Proof

- New component tests, each run first against the unfixed code (where they failed for the
  reason described above) and then against the fix (where they pass):
  `src/pages/Invoices.seasonWindow.test.tsx`,
  `src/components/field-invoices/FieldInvoicesSeasonWindow.test.tsx`,
  `src/pages/FieldApplicationInvoice.saveNavigation.test.tsx` (real router and real leave-page
  guard), `src/pages/InvoiceDetail.postUnsaved.test.tsx`. The list tests apply the pages' real
  filters to an in-memory set of invoices, so they show which rows the queries actually return.
- The new list filter was sent to the live API read-only with the public key. It got past the
  filter parser (it stopped at the permission check), while a deliberately broken filter was
  rejected by the parser. So the filter syntax is valid on the real server.
- typecheck, lint, the full Vitest suite and the production build pass.

### Not verified here

- Not clicked through in a signed-in browser against live data.
- Out of scope and unchanged: Print, Email and Transfer to Scheduling on the invoice editor still
  use what is on screen. The invoice editor still has no leave-page warning for unsaved edits. The
  Orders list (`src/pages/Orders.tsx`) uses the same current-season-only filter. Transfer to
  Scheduling on the field-application editor uses the same `setDirty(false)` then navigate
  pattern, and may show the same false prompt.
