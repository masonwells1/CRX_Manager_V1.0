## 2026-10-09 - Invoice screens: last season's open invoices are back, and no duplicate field-application invoices

Two fixes to the invoice screens. Both are app-only; no database change.

### 1. Last season's open invoices show again on the invoice lists

**What staff will notice:** since October 1, the Chemical Sales invoice list and the Field
Invoices tabs (Drafts, Posted, All Invoices, and the tab counts) were empty of last season's
work. Every invoice from before October 1 that was still a draft, unposted, posted-but-unpaid or
overdue had disappeared. They are back on the lists. The bulk actions (Post All, Unpost All,
Select All) still act on this season's invoices only; an older one is handled one at a time (see
below).

- An **open** invoice (draft, unposted, posted, overdue) now shows on these lists whatever
  season it belongs to. A small **"Season 2026"** tag next to its date marks an invoice from an
  earlier season.
- A **closed** invoice (paid, voided, cancelled) still shows only for the current season, as
  before.
- The server posting step (`post_invoice` / `post_invoice_group`) does **not** check the
  invoice's season. It **does** refuse an invoice dated in a closed accounting period
  (`check_period_open`, run inside `_post_invoice_impl_20260714` and, for every group member,
  `_post_invoice_group_customer_scope_impl`; live read of the function bodies, 2026-10-09). All
  9 live accounting periods are open today, so nothing is refused yet. Because nothing stops a
  last-season invoice posting into its own invoice-date month (for example August), the bulk
  actions leave other-season invoices out by default:
  - **Post All** on the Drafts tab posts only **this season's** invoices. Last season's
    unposted invoices are listed (with their season tag) and counted in the totals, but Post All
    leaves them out and its confirm says how many; post each one from its own invoice page. A
    split group is left out if **any** of its members is from another season, including a member
    hidden by the current filters (the group post would post it too).
  - **Unpost All** on the Posted tab, in the default "This Season + older unpaid" scope, still
    reverses only **this season's** posted invoices, as it did before. Older unpaid invoices are
    listed but left out (the confirm and the footer say how many); to unpost one, choose its
    month batch in Scope. Month batches from an earlier season are marked "unpaid only", because
    paid invoices from that season are not on this list. The "spans more than one month-end
    batch" warning now looks at what Unpost All would change, not at every row shown.
  - On the Chemical Sales list, **Select All** picks only this season's invoices, so one Select
    All + Post / Void / Delete cannot reach last season's work. An older invoice can still be
    ticked by hand (it shows a "Season N" tag); if one is selected, the Post confirm says how
    many are not from this season. The button goes by **which** invoices are ticked, not how
    many: it reads **Select All** until every this-season invoice in view is ticked, then
    **Deselect All** (which clears everything, including hand-ticked older ones). When every
    invoice in view is from an older season, Select All is greyed out instead of silently doing
    nothing.
  - The Chemical Sales bulk buttons (Post / Void / Print / Delete and their counts) only ever act on ticked invoices that are on screen right now: a ticked invoice that a filter or the search box hides, or that the list no longer loads, is dropped from the selection, **Select All** replaces the selection with exactly this season's invoices in view (it no longer keeps rows ticked earlier), and **Clear selection** shows whenever anything on screen is ticked.
  - An invoice with no season, or a later season, counts as "not this season" for these actions.
    An invoice with no season shows a **"Season unknown"** tag, so it is never an untagged row
    that the bulk actions quietly skip. (The live `invoices.season` column cannot be empty today;
    this only matters if that ever changes.)
- The Posted tab's **Print Invoice Report** PDF now names its scope in the subtitle (for example
  "This season + older seasons' unpaid invoices", or "June 2026 batch — unpaid invoices only"),
  so a printed total says what it covers.
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

### Not in this change

The regular invoice editor (chemical sales, misc charges, job/blend field invoices) can still
Post with unsaved edits on screen: it posts the saved amounts, exactly as before. That fix moved
to the admin-only invoicing change, together with a server-side check that the invoice was not
changed between review and posting (Codex Sol HIGH on PR #892, 2026-10-09: a check in the browser
cannot bind what `post_invoice` posts). Tracked OPEN in `docs/manual/KNOWN_ISSUES.md`.

### Proof

- New component tests, each run first against the unfixed code (where they failed for the
  reason described above) and then against the fix (where they pass):
  `src/pages/Invoices.seasonWindow.test.tsx`,
  `src/components/field-invoices/FieldInvoicesSeasonWindow.test.tsx`,
  `src/pages/FieldApplicationInvoice.saveNavigation.test.tsx` (real router and real leave-page
  guard). The list tests apply the pages' real filters to an in-memory set of invoices, so they
  show which rows the queries actually return.
- The new list filter was sent to the live API read-only with the public key. It got past the
  filter parser (it stopped at the permission check), while a deliberately broken filter was
  rejected by the parser. So the filter syntax is valid on the real server.
- Review round 1 added tests for: the Post All earlier-season notice, Unpost All's this-season
  default, and overdue invoices in the Chemical Sales cards.
- Review round 2 added tests for: Post All leaving last season's invoices out and posting only
  this season's; Post All skipping a split group whose last-season member is hidden by a date
  filter; Chemical Sales Select All picking only this season (and the Post confirm naming a
  hand-ticked older invoice); plus unit tests for the season filter and the season labels. The
  Select All test was run against the round-1 code and failed there.
- Final fix round added tests for: Select All with an older invoice ticked by hand (now: selects
  exactly this season's invoices in view, see the selection fix below), Deselect All clearing a mix of this-season and older invoices,
  Clear selection, Select All greyed out when only older or unknown-season invoices are in view,
  and the "Season unknown" tag. Each was run against the round-2 code and failed there.
- Selection fix (after the final review) added tests for: a row ticked and then hidden by a
  filter not being carried into Select All + Post; a selection left under a filter with no
  selectable rows being dropped (no Print / Post button acting on it); the same for a row hidden
  by the search box; Clear selection shown
  alongside Deselect All; and a failed post re-selecting an invoice the reload no longer returns
  (it is dropped from the counts). Each was run against the previous commit (2e185c34b) and
  failed there.
- After the split (the invoice-editor Post changes taken out), typecheck, lint, the fix-1 and
  fix-2 test files, the full Vitest suite, the production build and the doc-drift check pass.

### Known gaps and deferred items (not fixed in this change)

In plain English, everything the review rounds found that this change deliberately does not fix:

- **"This season" comes from the computer's clock.** Which invoices get a season tag and which ones
  the bulk actions (Post All, Unpost All, Select All) leave out depends on the date on the
  person's computer, not the server. A wrong computer date around October 1 would treat last
  season's invoices as this season's, or the reverse. Also, invoices created through paths that
  use the database's default season are stamped from UTC time, so for about five hours on each
  September 30 evening a new invoice is stamped "next season" and the bulk actions skip it until
  midnight Chicago time.
- **Lists still stop at 2,000 rows, newest first.** The lists now include older open invoices, so
  if a list ever reaches its 2,000-row cap, the oldest still-open invoices are the first to be cut
  off — the original bug again, for exactly those rows. A message appears when the cap is hit.
  Not reachable at today's volume.
- **The Orders list is still limited to this season.** `src/pages/Orders.tsx` uses the same
  current-season-only filter the invoice lists used to, so last season's open orders (20 at the
  time of the review) are hidden from it.
- **Split-group season check looks at the selected rows.** On the Chemical Sales list, batch Post
  checks the season of the selected rows only, while posting a split group posts every member
  (including one from another season). Theoretical today: there are no live split groups, and a
  database rule keeps split members in the same season.
- **A partly-failed first save of a new field-application invoice.** If the first Save creates the
  invoice but a later step fails (for example the billing details), the page keeps a link to the
  invoice it created and a second Save updates it. But some checks (season date guard, split
  preview, billing key) still behave as if the invoice were new (the server still refuses a
  filed-season change), and if the page is refreshed before saving again, that link is lost and
  saving the re-typed form creates a second invoice (the leave-page prompt warns before the
  refresh).
- **Post All on the Drafts tab never includes older-season invoices.** Last season's unposted
  field invoice has to be posted from its own page. Whether Post All should get an "include
  older seasons" option is an owner decision.

### Not verified here

- Not clicked through in a signed-in browser against live data. Before shipping: the Invoices
  list showing the 2 overdue and the drafts; the Drafts tab showing last season's unposted field invoice
  and the Post All confirm saying it is left out; that invoice posting from its own invoice page; a
  new field-app Save landing on the saved invoice.
- The list-test helper returns whole rows whatever columns a query selects, so it would not
  notice a list that stopped selecting `season`. (Deferred product gaps are listed in "Known gaps
  and deferred items" above.)
- Owner decision (not made here): whether the server should also refuse posting an invoice into
  a **season** other than its own (it already refuses a closed accounting period).
