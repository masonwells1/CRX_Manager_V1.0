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
- **Post All** on the Drafts tab now includes last season's unposted field invoices. Important:
  the server posting step (`post_invoice` / `post_invoice_group`) has **no season or
  closed-month check** (live read of the function bodies, 2026-10-09), so a last-season invoice
  posts into its own invoice-date month batch (for example August). The Post All confirm box
  therefore says how many of the invoices it is about to post are from an earlier season; to
  leave them out, filter them out of the view first.
- **Unpost All** on the Posted tab, in the default "This Season + older unpaid" scope, still
  reverses only **this season's** posted invoices, as it did before. Older unpaid invoices are
  listed but left out (the confirm says how many); to unpost one, choose its month batch in Scope.
  Month batches from an earlier season are marked "unpaid only", because paid invoices from that
  season are not on this list.
- The Chemical Sales **Posted Total** and **Outstanding** cards now count overdue invoices too
  (an overdue invoice is a posted invoice past its due date; before, the two live overdue
  invoices were listed but left out of both totals). A note under the cards says older open
  invoices are included.
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
- Deleting a field-application invoice, or transferring it back to scheduling, also leaves the
  page without a false "Unsaved Changes" prompt.

### 3. Post is blocked on the invoice editor while there are unsaved edits

**What staff will notice:** on the regular invoice editor (chemical sales, misc charges, and
job/blend field invoices), the **Post** button is greyed out while you have unsaved changes, with
the note "Save your changes before posting." Before, Post could be clicked with unsaved edits on
screen: it posted the old saved amounts and then quietly threw the edits away.

- Save first, then Post. **Print**, **Email** and **Transfer to Scheduling** are greyed out the
  same way, because they also work from the saved invoice.
- Before the Post confirm opens, the app re-reads the saved invoice. The credit-limit check uses
  the saved **customer and total**, and the restricted-use (RUP) license warning uses the saved
  lines — what will actually be posted, not what happens to be on screen.
- If that re-read fails, nothing is posted: an error says to try again (it no longer falls back
  to the possibly out-of-date copy on screen). If the invoice was changed somewhere else (another
  tab or another person) to a different customer or total, the page reloads it and asks you to
  check it and post again.
- Typing into an empty PO or notes field and deleting it again no longer counts as an unsaved edit.

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
- Review round 1 added tests for: the saved-invoice re-read failing (no post), the invoice moved
  to another customer elsewhere (reload, then the credit check uses the new customer and total),
  the unsaved-edit baseline being retaken after a save, Print disabled with unsaved edits, the
  Post All earlier-season notice, Unpost All's this-season default, and overdue invoices in the
  Chemical Sales cards. The two new Post tests fail on the round-0 code.
- typecheck, lint, the full Vitest suite and the production build pass.

### Not verified here

- Not clicked through in a signed-in browser against live data. Before shipping: the Invoices
  list showing the 2 overdue and the drafts; the Drafts tab showing last season's unposted field invoice
  and the Post All confirm naming it as an earlier-season invoice; a new field-app Save landing on the saved
  invoice; invoice-editor Post/Print disabled after an edit and enabled after Save.
- Out of scope and unchanged: the invoice editor still has no leave-page warning for unsaved edits
  (its component tests use a plain router that cannot host the leave-page blocker; adding it needs
  that test setup changed first). The Orders list (`src/pages/Orders.tsx`) uses the same
  current-season-only filter, so last season's 20 open orders are hidden from it. After a
  partly-failed first save of a new field-app invoice, the page still treats some checks
  (season date guard, split preview, billing key) as for a new invoice; the server still refuses
  a filed-season change. The lists still load at most 2,000 rows newest-first (a message appears
  when the cap is hit), so at very large volumes the oldest open invoices would drop off first.
- Owner decision (not made here): whether `post_invoice` should refuse posting into a closed or
  prior-season month.
