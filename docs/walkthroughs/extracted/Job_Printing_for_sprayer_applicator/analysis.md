# Job Printing for Sprayer Applicator — ChemMan Walkthrough Analysis

Source: 68-second screen recording, continuation of the "Job Scheduling" video. Mason narrates
while operating the ChemMan (Kenman/Datamart) "Applicator Report" screen for a scheduled job
(Job #230588, Wells Brothers Ag, Crop RX Solutions Inc., Martinsville, IL).

## Narrative (in order, with timestamps)

- **[0.0–3.2]** Mason opens on the **Applicator Report** page for a job, noting this continues
  from the job-scheduling video. The page shows a **"Job Settings"** panel full of print-options
  dropdowns above a live preview of the job packet (frame f_001).
- **[3.2–7.4]** He sets **Display Map Type** to **"Both"** ("I want both types of maps") — this
  reveals a new **"Location Settings"** section below the Job Settings block (f_002), meaning the
  form is dynamic/conditional based on the map-type choice.
- **[8.7–12.2]** He talks through more options: "I want to show field information, map pages" —
  pointing at fields like **Show Field Location Info**, **Map Pages Only**, while leaving some at
  defaults (f_003).
- **[14.3–17.8]** He points at **Show Previous App. Info** ("show any previous application on
  those farms") — currently set to "No" in the frame shown, but he's narrating that the
  *capability* exists (f_004).
- **[17.8–20.1]** "What rate am I spraying it at?" — referencing the **Liquid Rate Unit** field
  (set to GL) and the rate configuration used later in the loader worksheet (f_005).
- **[22.7–25.0]** "I can edit any information I want" — general statement that all these job
  settings/report fields are editable before printing.
- **[25.0–28.1]** "This is for my blender man" — he opens the **loader/blend worksheet**, i.e. a
  distinct report artifact aimed at the person mixing/loading chemical into the sprayer, not the
  applicator driving it.
- **[28.2–31.3]** "How many gallon is the tank of the sprayer?" — pointing at **Vehicle Capacity**
  (1150 gal for the Hagie STS12) inside the **Edit Loader Worksheet** modal (f_007/f_008).
- **[31.3–35.2]** "Where I'm spraying at, so that's saying I need five loads" — the worksheet
  auto-calculates **Total Loads = 5** from Total Acres (344.67), Target Rate (15 GL/ac), and
  Vehicle Capacity (1150 gal), and breaks it into a load table (f_007, f_009).
- **[36.6–38.3]** "So that's my loader sheet" — confirms the modal he's showing is the
  blend/loader worksheet, separate from the applicator map packet.
- **[40.3–44.3]** He closes the modal and returns to the Applicator Report / job selected-locations
  view (f_010), moving toward printing.
- **[47.4–48.7]** "When I hit print" — triggers the browser print dialog (f_013), which reports a
  7-sheet document.
- **[55.3–57.7]** "It's got my blowout like I just showed you" — the print preview shows the full
  combined "blowout" map of all fields for the job on one page (f_015), matching the multi-field
  overview map he showed earlier in the job-scheduling video.
- **[57.7–61.3]** "Then it shows the close-ups of each individual field" — subsequent print pages
  are per-field zoomed-in maps, one page per field/farm (f_016 Huffingtons N. of County Line,
  f_017 "Fake Field (Test)"), each labeled with job #, farm/customer name, lat/lon, and acreage.
- **[63.6–65.5]** "And I can just print this out real easy" — reiterates the one-click print flow.
- **[65.5–67.1]** "...and give to my applicator" — end goal: a physical packet handed to the person
  driving the sprayer in the field.

## UI observed

1. **Applicator Report / Job Settings panel** (f_001–f_006) — a dense options form sitting above
   a live preview, with fields grouped as:
   - **Job Settings** row 1: Display Map Type (Combined / Both / etc.), Show Field Location Info
     (Yes/No), Show Loader/Application Info (dropdown, e.g. "Only first page"), Combined Map Size
     (Full Page).
   - **Job Settings** row 2: Map Pages Only (Yes/No), Blank App. Info Sect. (numeric count, e.g.
     "0"), Liquid Rate Unit (GL), Dry Rate Unit (LB).
   - **Job Settings** row 3: Show Previous App. Info (Yes/No), Show Store Banner (Yes/No), Load
     Display Type (e.g. "Show Individual Lo...").
   - **Location Settings** (appears only when Display Map Type includes location maps): Location
     Blanks (numeric), Location Map Size (Full Page dropdown).
   - Action buttons: **SAVE SYSTEM SETTINGS** (green), **PRINT** (blue), plus an "Old Applicator"
     link (legacy report version).
   - Below that: **"Toggle Job Selected Locations/Loader Work Sheet Details"** (collapsible
     section) and an **EDIT LOADER WORKSHEET** button, with a hint line: "Click or tap loads to
     mark them done."

2. **Job header / location summary block** (f_006, f_010) — under the toggle, shows:
   - Report date, dealer/branch banner ("WELLSBROTHERSAG - CROP RX SOLUTIONS, INC.
     (MARTINSVILLE, IL)")
   - Job number (JOB #230588) and assigned **Vehicle** (Hagie STS12)
   - A per-customer/per-field table: customer name + ID, acreage and **percent of total job
     acreage** (e.g. "Wells, Mason (1000) — 52.50 acre / 15.23%"; "Next Generation Farms
     Partnership, LLC — 122.00 acre / 35.40%"), and a phone number per customer.
   - Total acreage footer (344.67 acre) and a "First Lat/Lon" reference point
     (39.150800°, -87.777300°).
   - An inline overview map with all job fields outlined in yellow and acreage labels overlaid,
     plus small icon controls (layers/expand/print) in the corner of the map.

3. **Edit Loader Worksheet modal** (f_007–f_009) — a dedicated blend/load-planning dialog:
   - Header shows **Total Remaining Acres: 344.67**.
   - Inputs row 1: Applicator (person, "Shelton, Andrew"), Vehicle (dropdown, "Hagie STS12"),
     Chemical Type (Liquid/Dry), **Vehicle Capacity** (numeric gallons — 1150).
   - Inputs row 2: Load Balance strategy (dropdown, "Full Loads Remainder"), Acre (numeric,
     editable, defaults to total remaining acres 344.67), **Target Rate/ac (GL)** (numeric, 15),
     **Total Loads** (numeric — computed to 5, editable).
   - A results table: **# Loads | Effective Rate | Load Acres | Load Contribution** — "4 loads @
     15.00 GL, 76.67 acres each, 1150.00 GL each" plus "1 load @ 15.01 GL, 37.99 acres, 570.05
     GL" — i.e. it splits the total acreage into full tank loads plus one partial/remainder load,
     showing exactly how much solution each load contributes.
   - Footer buttons: CLOSE, SAVE LOADER WORKSHEET.

4. **Field/location map detail view with export buttons** (f_011–f_012) — the on-screen per-field
   map view shows a row of export/format buttons above the map: **JOHN DEERE**, **SHAPEFILE**,
   **KML**, **JOBFILE**, **JOBFILE OLDER THAN G4**, **IMAGE** — the same field boundary/job data
   can be exported directly into precision-ag equipment formats (John Deere Operations Center,
   ESRI shapefile, Google KML, generic "jobfile") in addition to being printed. Map has compass
   (N), zoom controls, layer toggles, and a "Report a map error" link (Google/Airbus/Landsat/
   Copernicus imagery rendered via Leaflet). A dashed "PAGE BREAK" marker is shown inline between
   report sections, previewing print pagination.

5. **Browser print preview / final printed packet** (f_013–f_017):
   - Standard browser Print dialog (destination network printer, Pages: All, 7 sheets of paper,
     Color).
   - **Page 1 (blowout)**: the combined overview map — all fields for the job in one aerial
     image, each field outlined in yellow with acreage labels and farm/owner names overlaid
     directly on the imagery (e.g. "2.80 ac of 84.25 ac", "Hog Farm 105.00 AC of 109.45 AC").
     Header repeats report date, dealer name, Job #, lat/lon, and farm acreage.
   - **Subsequent pages**: one page per individual field/farm, each a zoomed-in aerial close-up
     with the field boundary highlighted in yellow, header showing Job #, Lat/Lon, farm name and
     acreage (e.g. "Huffingtons N. of County Line: 82.00 acre", "Fake Field (Test): 35.67
     acre"). Each page is self-contained and can be handed off on its own.

## What Mason likes & WHY

- **"I can select, I want both types of maps."** [3.2–7.4] — The map output isn't fixed; he can
  choose to print the combined overview AND the individual field close-ups together, tailoring
  the packet per job/applicator preference.
- **"I want to show field information, map pages... show any previous application on those
  farms."** [8.7–17.8] — He values that field info and historical application data can be toggled
  onto the same printed packet, so the applicator can see what was sprayed there before without a
  separate report.
- **"What rate am I spraying it at?"** [17.8–20.1] — The application rate (and its unit) is
  visible/configurable right on this same print-settings screen, not buried elsewhere.
- **"I can edit any information I want."** [22.7–25.0] — Flexibility/control: every field of the
  report is editable before printing; it's not a rigid fixed template.
- **"This is for my blender man... how many gallon is the tank of the sprayer? ... that's saying
  I need five loads." / "So that's my loader sheet."** [25.0–38.3] — His strongest praise point: a
  dedicated **loader/blend worksheet** that automatically calculates how many tank loads the job
  needs from total acres + target rate + tank capacity, and breaks out the exact rate/acres/
  gallons per load (including the partial last load). He explicitly frames it as serving a
  distinct crew member (the person loading the sprayer), separate from the applicator's map
  packet.
- **"It's got my blowout... then it shows the close-ups of each individual field."** [55.3–61.3] —
  He likes the printed packet's structure: one overview map of the whole job followed by
  auto-generated per-field close-up pages.
- **"I can just print this out real easy and give to my applicator."** [63.6–67.1] — Simplicity
  and speed of the final step: one Print click produces a complete, ready-to-hand-off paper
  packet with zero manual formatting.
- (Implicit, shown but not verbally called out) The **export-to-equipment-format** buttons (John
  Deere, Shapefile, KML, Jobfile, Image) sit right next to the map/print view — the same job/field
  data can feed sprayer guidance/rate-controller systems directly, not just paper.

## Pain points he states about CRX

None stated explicitly in this clip. The video is framed entirely around what he likes in ChemMan
as a feature reference for CRX Manager; no direct CRX complaints or comparisons are voiced in the
transcript.

## Feature checklist (buildable capabilities demonstrated)

- **Configurable job/applicator print packet** — a settings panel controlling what's included
  before printing (not just print-what-you-see):
  - Map type selector: combined overview / per-field detail / both
  - Toggle: show field location info
  - Toggle: show loader/application info, with placement control (e.g. "first page only")
  - Combined map page size option (full page vs. smaller)
  - Toggle: map pages only (map-only packet vs. map + data)
  - Numeric: blank application-info sections (blank lines for handwritten notes in the field)
  - Liquid rate unit and dry rate unit selectors (GL, LB, ...)
  - Toggle: show previous application info per farm/field (application-history recall on the
    printout)
  - Toggle: show store/dealer banner on the printed packet
  - Load display type selector (individual loads vs. combined)
  - Conditional location-map settings (location blanks count, location map size) that appear
    only when the relevant map type is selected
  - "Save system settings" so a preferred print configuration persists as the default
- **Job summary/header block**: job #, assigned vehicle, dealer/branch name, report date, and a
  per-customer/per-field breakdown table with acreage, % of total job acreage, and contact phone
  number per customer, plus total job acreage and a reference lat/lon.
- **Inline overview map** of all job fields with yellow boundary outlines and acreage labels,
  embedded in the job page itself (not only in print output), with zoom/expand/layer controls.
- **Loader/Blend Worksheet** (a distinct artifact from the applicator map packet):
  - Inputs: applicator name, vehicle, chemical type (liquid/dry), vehicle tank capacity
  - Inputs: total/remaining acres, target application rate per acre, load-balance strategy
    (e.g. "full loads + remainder")
  - Auto-calculated **total number of loads** from tank capacity, acreage, and rate
  - Auto-generated **load-by-load breakdown table**: # loads at an effective rate, acres covered
    per load, and gallons contributed per load — correctly splitting a partial remainder load
    from the full loads
  - Editable inputs that recompute the load table
  - "Click or tap loads to mark them done" — checklist-style per-load completion tracking
  - Saved as its own worksheet record tied to the job
- **Per-field close-up print pages**: one page per field, each with the field boundary
  highlighted on aerial imagery and a header carrying job #, farm/customer name, lat/lon, and
  acreage — auto-generated in sequence after the overview "blowout" page, with explicit page
  breaks.
- **One-click Print** that assembles the whole multi-page packet (overview + all per-field
  pages, ~7 sheets in the demo) into the standard browser print/PDF flow, ready to hand to a
  driver.
- **Direct export to precision-ag/equipment formats** from the same map view: John Deere
  (Operations Center), ESRI Shapefile, KML, generic "Jobfile" (plus a legacy "Jobfile older than
  G4" variant), and static Image — letting field-boundary and job data flow straight into
  guidance/rate-controller systems, not just onto paper.
- A "legacy report" escape hatch ("Old Applicator" link) kept alongside the new report during
  transition.
