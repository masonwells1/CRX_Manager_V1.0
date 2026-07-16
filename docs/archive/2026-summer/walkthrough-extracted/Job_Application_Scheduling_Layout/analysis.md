# Walkthrough Analysis — "Job Application Scheduling Layout" (ChemMan)

Source video: 322 seconds. Mason recorded this to show what he likes about ChemMan (a competitor ag-chem management app) so CRX Manager can be improved. He calls this video the most important one and opens by saying he loves ChemMan's "billing, like their dispatch on application."

Transcript: `transcript.txt` (93 lines, timestamped).
Frames used: `frames/f_001.jpg` … `f_081.jpg` (every-other-frame base pass + all frames aligned to narrated moments), each 4 seconds apart, frame `f_NNN.jpg` = `(NNN-1)*4` seconds.

---

## Narrative (in order, with timestamps)

- **[0:00–0:04]** Intro: "Okay, here's the walkthrough of what I like about Kimman [ChemMan]."
- **[0:04–0:09]** Headline: "I love their billing, like their dispatch on application."
- **[0:08]** (frame f_003) Starting screen is ChemMan's **Scheduled Jobs** grid (Scheduling → Manage Job Scheduling), a list of existing jobs with columns Tags, Job Nbr, Customers, Locations, Applicators, Crops, Chemicals, Tot ac, Rem ac, Scheduled, Status, Created By, Updated By, Printed, plus per-row action icons.
- **[0:09–0:14]** "So when I go to schedule a job out, I hit **Add**."
- **[0:12]** (frame f_004) New **Job Schedule** record opens (Job #230588) with 5 tabs: **Locations | Chemical/Charges | Loader Worksheet | Applied Info | Notifications**.
- **[0:16–0:25]** "What I really like is everything being **on the same screen**... That's about the biggest thing."
- **[0:27–0:32]** "I can add any location. So I click this button" — clicks **SELECT LOCATIONS**.
- **[0:28]** (frame f_008) **Select Locations** modal opens: full-screen satellite map (Leaflet + Google/Airbus imagery) on the left, filters at top (Select Customers, Location text search, Crop dropdown, Strip dropdown, Search), results table on the right (Map #, Name, Crops, Customers, Planted, Total) with pagination.
- **[0:34–0:39]** "and then I can just type corn and search" — sets Crop = Corn, no customer filter.
- **[0:42–0:51]** "Every acre of corn that we have in our system pulls up **no matter who the customer is**." Map fills with dozens of yellow-outlined fields across the whole territory, each labeled with name + acreage.
- **[0:51–0:56]** "I can also filter by just what customer I want to look at."
- **[0:58–0:70]** Narrates specific fields on the map ("owned by Next Generation Farms... by Huffington's").
- **[0:71–0:80]** Types "Annapolis," picks **Annapolis Grain Co. (1014)**.
- **[0:76]** (frame f_021) Map/table narrow to exactly 3 checked rows: Huffingtons N. of County Line (91.50 ac), Gulf West 132 (129.40 ac), Fake Field (Test) (35.67 ac).
- **[0:81–0:89]** Clears customer filter, types "wells" → autocomplete list (Brothers Ag Wells; Wells, Chad; **Wells, Clayton (1001)**; **Wells, Mason (1000)**; Wells Farms LLC).
- **[0:84]** (frame f_022) Autocomplete dropdown shown.
- **[0:94–0:99]** "Here's my job... you can see all the fields over here." Selects Wells, Mason (1000); map recenters; results table now shows the **combined** running list (Annapolis fields + Wells fields: Hog Farm, L14–L18…) — selections persisted across filter changes.
- **[0:99–0:113]** Narrates ownership per field: Huffington Farm, Next Generation Farm, Billing Split/Fake Field, and "Hog Farm, which is a 50-50 split of Mason [and] Clayton [Wells]."
- **[0:113–0:117]** "I can hit **select locations**" — confirms modal, returns to job.
- **[0:117–0:124]** (frame f_031) Locations table now has 4 rows: field name, full customer name+ID+address, Acres (planted), editable Applied acres, Wind toggle, Crop dropdown, Strip dropdown, Pests dropdown, remove button. Total Applied Acres sum below.
- **[0:131–0:147]** Types actual applied acres per field, overriding planted: Hog Farm 109.50→105, Huffingtons 91.50→82, Gulf West 129.40→122, Fake Field stays 35.67.
- **[0:148–0:168]** Switches to **Chemical/Charges** tab; adds lines: Spray Grade Ammonium Sulfate (AMS 51lb), Spray PHix, Hagie Chemical Application — each with Warehouse, Vendor, Rate/ac, UM, auto-computed Total Applied (e.g. 689.34 LB, 5.39 GL, $5170.05 GL).
- **[0:168–0:175]** Sets **Diluent Rate** = 15 (gal/acre), notes Hours Reentry / Days Preharvest fields.
- **[0:174–0:180]** Scrolls to **Loader Worksheet Setup**: Applicator = Shelton, Andrew; Vehicle dropdown (Hagie STS12, Rogator 1100C, Customer Sprayer, Customer Toolbar, 1903 TerraGator, DJI T-60 DRONE); Vehicle Capacity, Rate, Acre, computed Total Job Acres/Loads; **USE AS APPLIED INFO** button.
- **[0:182–0:183]** "Job's done."
- **[0:185–0:192]** "I hit **add applied info**" — Applied Info tab: Total Remaining Acres counter, weather disclaimer, ADD APPLIED INFO creates a pass row (Applicator, Vehicle, Application Date, Beg./End Tach, Net Tach, Flights, Starts), a Location Summary bar ("All Locations [100.00%] applied for 344.67 ac"), and a Toggle Location Selection panel (Percentage/Acre per field).
- **[0:192–0:196]** Sets Application Date = 07/11/2026.
- **[0:196–0:200]** Clicks **GET WEATHER** — auto-fills Start/End Time, Temp (76°F), Wind Direction (90°), Wind mph (4.7), Humidity (87.61%).
- **[0:200–0:202]** Clicks **SAVE JOB #230588**.
- **[0:204–0:205]** "I love it."
- **[0:206–0:214]** Back on Scheduled Jobs grid: job row highlighted, Tags = "Fungicide," Rem ac = 0.00, Chemicals list shown.
- **[0:214–0:222]** "Total acres, the remaining, zero acres left on this job."
- **[0:222–0:230]** Explains: if the fields weren't fully finished, Rem ac would show a remainder.
- **[0:229–0:236]** Reopens job in edit mode; points at **TRANSFER TO INVOICE** (next to MARK JOB AS CANCELLED, SEND POST NOTIFICATION) but doesn't click — "that's gonna affect real customers."
- **[0:239–0:255]** Explains Transfer to Invoice would auto-split every product/charge across customers by applied-acre share — "phenomenal, phenomenal feature."
- **[0:258–0:267]** "It's just a really good layout. I mean, it is the best."
- **[0:267–0:273]** Navigates to **Applicator Report**.
- **[0:272]** (frame f_069) Report screen: Job Settings panel (Display Map Type=Combined, Show Field Location Info, Show Loader/Application Info, Combined Map Size=Full Page, Map Pages Only, Blank App. Info Sect., Liquid/Dry Rate Unit, Show Previous App. Info, Show Store Banner, Load Display Type) + SAVE SYSTEM SETTINGS; below, a per-customer billing-split table (name, acres, %, phone) for all 5 owners on the job, then an embedded combined satellite map labeled "JOB #230588" with yellow field outlines, acreages, and applicator markers.
- **[0:273–0:294]** "I can print out application maps... combine[d]... show what's in the tank mix... hit print" — opens native browser print dialog showing the report as the print document.
- **[0:299–0:308]** "It shows the acres, the billing splits, the phone numbers, the customers... a grand overview of all the jobs we need to do."
- **[0:310–0:311]** "It's phenomenal."
- **[0:311–0:320]** Describes an option for **per-field "blow-up" maps** in addition to the combined map (not demonstrated live).
- **[0:320–0:321]** "So this is what I love." (end)

---

## UI observed (every distinct ChemMan screen shown)

**1. Home / dashboard** — top nav (Customers, Vehicles, Applicators, Reports, Month End, Inventory, Chemical Sales, Scheduling, Invoices, Setup, Utility, Bottom Line) over a stock sky/cornfield image; duplicate button-tile grid below; Scheduling flyout (Manage Job Scheduling, Job Schedule Report, Dispatch & Applicator View).

**2. Scheduled Jobs grid** — filter bar (Job Nbr, Select Customers, Select Applicator, Schedule Date From/To, Job Tags, MORE/SEARCH/CLEAR ALL FILTERS, PRINT); bulk-action bar (MAP SELECTED JOBS, SELECT BY MAP, MASS EDIT, EDIT JOB TAGS, JOB BATCHES, CHEMICAL SUMMARY REPORT, MORE REPORT OPTIONS, NEW DISPATCH & APPLICATOR VIEW, green ADD); grid columns as above with multi-line rows for multi-field/multi-chemical jobs; per-row icons (map, export, PDF, edit).

**3. Job Schedule record — 5-tab single-screen editor:**
- *Locations tab*: SELECT LOCATIONS / TOGGLE LOCATION DETAILS / EDIT-SHOW MAPS / ADD TEMPORARY LOCATION / ADD LOCATION buttons; table (Map, Location+Customer+address, Acres, Planted, Wind, Applied, Crop, Strip, icons, Pests, remove); per-field Select Customer/Shares%/Acre sub-row for splits; Total Applied Acres; scheduling metadata (Call Date, Date Proposed, Time Proposed, Schedule Date, Date Expires, Consultant).
- *Select Locations modal*: filter row (Select Customers, Location, Crop, Strip, Search); satellite map with yellow field polygons + acreage labels; paginated results table with running Total Locations/Total Planted Acres; selections persist across filter changes; CANCEL/SELECT LOCATIONS footer.
- *Chemical/Charges tab*: SELECT RECIPE / USE LAST USED RECIPE / New Recipe Name + SAVE AS RECIPE; repeatable rows (Chemical/Charge Search autocomplete, Select Warehouse, Select Vendor, Rate/ac, unit toggle, UM, auto Total Applied); Diluent Rate, Hours Reentry, Days Preharvest.
- *Loader Worksheet*: Select Applicator, Vehicle (real fleet list incl. drone), Vehicle Capacity, Rate, Acre, computed Total Job Acres/Loads, USE AS APPLIED INFO.
- *Applied Info tab*: Toggle Applied Info Details; Total Remaining Acres; weather disclaimer; ADD APPLIED INFO row (Applicator, Vehicle, Application Date, Beg./End Tach, Net Tach, Flights, Starts); Location Summary bar; Toggle Location Selection (% / Acre split); Start/End Time (NOW toggle), Temp, Wind Direction, Wind mph, Humidity + GET WEATHER; Comment, Ground Crew, Ground Crew Member + add.
- *Notifications tab*: "No notifications have been sent yet"; Loader Comment, Additional Info, Internal Job/Invoice Memo (Not Printed).
- *Persistent bottom bar*: MARK JOB AS CANCELLED, TRANSFER TO INVOICE, SEND POST NOTIFICATION, CANCEL WITHOUT SAVING, SAVE JOB.

**4. Applicator Report** — Job Settings panel (Display Map Type, Show Field Location Info, Show Loader/Application Info, Combined Map Size, Map Pages Only, Blank App. Info Sect., Liquid/Dry Rate Unit, Show Previous App. Info, Show Store Banner, Load Display Type) + SAVE SYSTEM SETTINGS; Old Applicator link + PRINT; collapsible "Toggle Job Selected Locations/Loader Worksheet Details"; report body (date, dealer info, Job #, Vehicle, per-customer billing-split table with acres/%/phone, embedded combined map with field outlines/acreages/markers).

**5. Native browser Print Preview** — standard OS print dialog rendering the Applicator Report (map page + billing-split table page).

---

## What Mason likes & WHY

- **[0:04]** "I love their billing, like their dispatch on application." — the connective tissue from scheduling → capturing what was sprayed → billing is what draws him.
- **[0:16–0:25]** "Everything being on the same screen. That's about the biggest thing." — one job record with 5 tabs instead of separate disconnected pages.
- **[0:42–0:51]** "Every acre of corn... pulls up no matter who the customer is." — global, crop-first field search independent of customer scoping.
- **[0:94–0:99]** Selections persist/accumulate across repeated searches — builds a multi-customer job without losing prior picks.
- **[0:108–0:113]** Native support for split-owned fields ("50-50 split of Mason [and] Clayton").
- **[0:131–0:147]** Per-field planted vs. applied acres, entered independently, for partial-field spraying.
- **[0:196–0:200]** One-click **Get Weather** auto-fills temp/wind direction/wind mph/humidity at start and end.
- **[0:204]** "I love it." — reaction right after the single Save Job action.
- **[0:222–0:230]** Job list's Rem ac column automatically reflects partially-completed jobs.
- **[0:239–0:255]** "It would split out based off of the acres I actually applied... phenomenal, phenomenal feature." — Transfer to Invoice auto pro-rates every product/charge by each customer's applied-acre share.
- **[0:262–0:267]** "It's just a really good layout. I mean, it is the best."
- **[0:279–0:294]** Applicator Report offers combined vs. per-field maps and a tank-mix visibility toggle.
- **[0:299–0:308]** One printed sheet gives acres, billing splits, phone numbers, customers — everything office + applicator need.
- **[0:310–0:320]** Optional per-field "blow-up" zoomed maps alongside the combined overview.

---

## Pain points he states about CRX

**None explicit.** This transcript contains no direct "CRX does X wrong" statement — it's framed entirely as praise for ChemMan. The one caution stated is procedural, not a CRX complaint: at **[0:236–0:239]** he avoids clicking Transfer to Invoice specifically because it would "affect real customers" in ChemMan's live data, not because of anything about CRX. Every feature he calls "phenomenal" / "the best" / "I love it" should be read as an implicit gap CRX should close — there is no stated evidence either way about whether CRX already has each piece, only that he wants CRX to work this way.

---

## Feature checklist (concrete, buildable capabilities demonstrated)

**Job record structure**
- Single job record with tabbed sections (Locations, Chemicals/Charges, Loader Worksheet, Applied Info, Notifications) instead of separate flows.
- Persistent bottom action bar across all tabs: Cancel Job, Transfer to Invoice, Send Post Notification, Cancel Without Saving, Save Job.
- Job status field always visible at top.
- Job-level tags (e.g. "Fungicide") editable from both list and record, shown as colored pills in the list.

**Location / field picker**
- Global "select locations" modal: live satellite map + results table, searchable by crop, free-text location, and "strip," independent of customer.
- Map shows every matching field (any owner) as a labeled, outlined polygon with acreage callout.
- Selections persist/accumulate across repeated searches and filter changes in the same modal session.
- Customer-name autocomplete within the picker.
- Split-ownership / multi-customer fields with Select Customer + Shares % + Acre sub-row.
- Field row shows full customer name + ID + mailing address inline.
- Per-field planted acres vs. editable applied acres, decoupled for partial-field application.
- Per-field Crop, Strip, Pests dropdowns and a Wind toggle directly in the locations grid row.
- Running "Total Applied Acres" sum below the locations grid.
- Scheduling metadata block: Call Date, Date Proposed, Time Proposed, Schedule Date, Date Expires, Consultant.

**Chemicals / charges**
- Chemical/product autocomplete per line with Warehouse and Vendor selection per line (supports multi-source sourcing on one job).
- Rate/ac input with unit-conversion toggle and UM dropdown.
- Auto-computed Total Applied quantity/dollar total per line, recalculated live as applied acres change.
- Recipe system: Select Recipe / Use Last Used Recipe / Save As Recipe.
- Diluent Rate, Hours Reentry, Days Preharvest fields tied to the mix.

**Loader worksheet / dispatch**
- Applicator + Vehicle assignment with a real equipment/fleet picker (incl. drone).
- Vehicle capacity/rate/acres feed a computed Total Job Acres and Loads count.
- "Use as Applied Info" button auto-populates Applied Info from the loader worksheet.

**Applied info (post-application record)**
- "Add Applied Info" creates one row per actual pass: Applicator, Vehicle, Application Date, Beg./End Tach, Net Tach, Flights, Starts.
- Location Summary bar with %/acres allocation of the pass across fields ("ALL Locations" shortcut or per-field split).
- One-click "Get Weather" auto-fills Start/End Time, Temp, Wind Direction, Wind mph, Humidity.
- Ground Crew + Ground Crew Member selection, addable per pass.
- Loader Comment, Additional Info, and an internal-only "Internal Job/Invoice Memo (Not Printed)" field.

**Job list / dispatch board**
- Rem ac (remaining/unapplied acres) column reflecting partial completion, distinct from Tot ac.
- Bulk tools: Map Selected Jobs, Select by Map, Mass Edit, Edit Job Tags, Job Batches, Chemical Summary Report, dedicated Dispatch & Applicator View.
- Per-row quick actions: map, export, PDF, edit — without opening the full record.

**Billing / invoice transfer**
- "Transfer to Invoice" auto pro-rates every chemical/charge across multiple customers/fields by applied-acre share.

**Applicator report / print**
- Configurable report: Display Map Type (Combined vs. per-field), Show Field Location Info, Show Loader/Application Info, Combined Map Size, Map Pages Only, Blank App. Info Section, Liquid/Dry Rate Unit, Show Previous App. Info, Show Store Banner, Load Display Type — saveable as defaults.
- Per-customer billing-split table (customer, acreage, % of job, phone) alongside the map.
- Combined satellite map with job number label, yellow field outlines, acreage callouts, applicator/loader markers.
- Toggle to show/hide tank-mix contents on the printed report.
- Optional per-field "blow-up" (zoomed) maps in addition to the combined overview.
- Standard print-to-printer flow producing a ready-to-hand paper/PDF sheet.
