# ChemMan Walkthrough Analysis — "Mixer/Loader Sheet setup"

Video length: 191s. Source transcript: `C:\CRX_Manager\docs\walkthroughs\extracted\Mixer_Loader_Sheet_setup\transcript.txt`. Frames: `frames/f_001.jpg` … `frames/f_048.jpg` (1 frame every ~4s; all 48 reviewed).

App shown: **ChemMan** (branding visible in page headers: ChemMan logo top-left, "Support: (870) 238-9222", tenant "Crop RX Solutions, Inc."). Job being demoed: **Job #230588**, customer "Wells, Mason" — a demo job on Mason's own live ChemMan tenant, mixing a "Fake Field (Test)" location with real fields (Hog Farm, Huffingtons N. of County Line, Gulf West 132; 344.67 total acres, crop: Corn).

---

## Narrative (in order, with timestamps)

- **0:00–0:08** — Mason starts on the **Scheduled Jobs** grid, saying they're done applicating this job and he has already entered the as-applied data.
- **0:08–0:20** — He opens the **Applied Info** modal (as-applied entry) and explains what the sprayer operator fills in himself: his name, the sprayer/vehicle, the time he started, and when he ended.
- **0:21–0:30** — Notes he's already filled this one in, but the operator can come back and "type in what he did or didn't do" — i.e., partial/after-the-fact editing of as-applied records. "It's just really, really good."
- **0:34–0:44** — Shows the **Job Location Order** feature: he can change which field the sprayer visits first ("I want my sprayer guy to spray Huffington field first"), drags a field to position 1, and notes **that order prints out too** so the sprayer knows how to route himself.
- **0:50–0:56** — Mentions he can also **upload log files from the sprayer** (attach equipment logs to the job).
- **0:57–1:04** — Opens the **Loader Report** ("loader sheet") — "this is for the blending man who's blending the loads." Shows the toggle between **individual loads** and **condensed loads**.
- **1:11–1:35** — Opens **Edit Loader Worksheet**: "I can go in here and change anything I want... you can tell it how many gallons." Selects applicator + vehicle, shows ground crew ("that's basically who's mixing the load"), load-balance mode ("whether I want full loads"), and types the **target rate/acre: 15 gallons** — with the vehicle's default capacity it computes "**I need four fill-ups**."
- **1:44–1:52** — Changes total vehicle capacity to **5,000 gallons** ("I'm gonna mix up a five thousand gallon batch to tender to the sprayer") — total loads recalculates to **2**. "At 15 gallon per acre it shows the product, the rate per acre, so the total amount that we need to apply to this job."
- **2:04–2:22** — Changes tank capacity again to a **2,000-gallon tank**: "it already breaks out load one, load two, load three — this makes it so easy and it erases the manual errors with us making blend tickets."
- **2:21–2:38** — Reads Load 1 to the camera: "first time the tank comes in he needs to add **266 pounds of ammonium sulfate**, **2 gallons of Spray Fix** [Spray PHIx], he needs a total of 2,000 gallons, so he needs to add the rest of water." Notes "you can also edit these."
- **2:38–2:44** — Points out the **last load is only a 78-acre load** — the tool auto-right-sizes the remainder — "and there's the product quantity."
- **2:46–2:50** — "Then I can print that out."
- **2:51–3:10** — "I can even edit things in here, but it just works really nice. I can just give this to the blending guy — load one, load two, you do these amounts, and then on the third load to finish the job, here's how much he needs. It makes our workflow really nice."

---

## UI observed (full inventory of every distinct screen)

### 1. Scheduled Jobs grid (frames 1–3, 8, 12–14)
List/search page for spray jobs.
- **Top nav**: Customers, Vehicles, Applicators, Reports, Month End, Inventory, Chemical Sales, Scheduling, Invoices, Setup, Utility, Bottom Line.
- **Filters**: Job Nbr, Select Customers, Select Applicator, Schedule Date From / To, Job Tags, plus More / Search / Clear All Filters.
- **Action bar**: Map Selected Jobs, Select by Map, Mass Edit, Edit Job Tags, Job Batches, Chemical Summary Report, More Report Options, New Dispatch & Applicator View, green Add button.
- **Grid columns**: checkbox, Tags (multiple colored chips per job, e.g. "Fungicide"), Job Nbr, Customers (a job can list several customers at once), Locations ("Click for full list"), Applicators, Crops, Chemicals (multi-line product list with rate + UOM per product, e.g. "Ammonium Sulfate (AMS 51lb) (2.000000 LB)", "Hagie Chemical Application (15.000000 GL)"), Tot. ac, Rem. ac, Scheduled, Status (Pending), Created By, Updated By, Printed (red name + timestamp when printed).
- **Per-row action buttons**: map icon, green icon, "APPL" (opens Applied Info), a dropdown caret, "PRT", "EDIT".
- **Row dropdown menu** (frame 14): **Map / Logs**, **Attach Log Files**, **Loader**, Original Applicator Report, Custom Applicator Report, Enhanced Applicator Report, Chemical Application Report.

### 2. Applied Info modal (frames 4, 6, 7) — as-applied entry
- Header "Applied Info". Yellow disclaimer: weather data accuracy is not guaranteed; user acknowledges no liability.
- Green **ADD APPLIED INFO** button; "Job Total Remaining Acres: 0.00 of 344.67".
- Per-entry fields: **Applicator** (dropdown — "Shelton, Andrew"), **Vehicle** ("Hagie STS12"), **Application Date** (07/11/2026), **Beg. Tach**, **End Tach**, **Net Tach** (auto, 0.00), **Flights**, **Starts**, red remove-row button.
- "Location Summary: All Locations [100.00%] applied for a total of [344.67 ac]" + **SELECT LOCATIONS BY MAP** button.
- "Toggle Location Selection" collapsible with note that airport-strip lat/long is used for weather when selected locations are temporary.
- **Weather capture**: Start Time (with a "NOW" toggle), Start Temp (76), Start Wind Direction (90), Start Wind mph (4.7), Start Humidity (87.61), mirrored End Temp/Wind Dir/mph/Humidity, and a **GET WEATHER** button. "Weather Info: Powered by Visual Crossing."
- "Toggle Applied Info Details" table: **Location | Acres To Apply | Applied Acres | Remaining Acres** per field (Hog Farm 105.00, Huffingtons N. of County Line 82.00, Gulf West 132 122.00, Fake Field (Test) 35.67) + "Total Remaining Acres: 344.67 of 344.67" footer.
- Cancel / **SAVE APPLIED INFO**.

### 3. Select Locations by Map modal (frame 5)
Satellite map (Leaflet; Google imagery attribution) with each field boundary/marker labeled with field name + acreage (e.g. "Fake Field (Test) 35.6 AC Left", "Hog Farm ...105.00 AC Left"). Zoom controls, layer toggle. Cancel / **SAVE SELECTIONS**.

### 4. Job Location Order modal (frames 9–11) — sprayer routing
- Header "Job Location Order". Copy: "Once you save the new location order, the map labels will reflect the changes."
- Left: map with the fields marked; labels show acreage ("82.00 AC of 91.50 AC Left", "122.00 AC of 129.40 AC Left" etc.).
- Right: **numbered, reorderable list** of locations, each with lat/long (e.g. "Hog Farm 39.11360, -87.75720") and a **#range mapping locations to load numbers** ("#1–5", "#6–7", "#8–11", "#12").
- Mason drags "Huffingtons N. of County Line" from slot 2 to slot 1 (visible between frames 10 and 11).
- Cancel / **SAVE LOCATION ORDER**.

### 5. Loader Report page (frames 15–21, 42) — the "loader sheet" hub
- Header: "Loader Report — Job #230588 - Customer: Wells, Mason - Work: (618) 843-0413".
- Controls: **Show Field Location Info** (Yes/No radios) and **Load Display Type** (**Show Individual Loads** / **Condensed Loads** radios).
- Summary card "Job Nbr: #230588": table **Location | Acres Applied | Acres not Reported** per field + "Total Acres Left: 344.67".
- Green **Add New Worksheet** button.
- **Worksheet list**: Date Generated | Vehicle | Status | Total Load Acres | Total Loads | "Total Worksheets: N", one row per saved worksheet with **Select / Edit / Delete** — multiple worksheets coexist per job (frame 42 shows two: "Rogator 1100C, 3 loads, Selected" and "Hagie STS12, 5 loads"), so different vehicles/scenarios can be kept side by side.
- **Print** and **Change Display** buttons.
- Below, job detail sections: Job Nbr / Total Acres / Call Date / Schedule Date; **Applicator | Vehicle | Shares | Acres** (Shelton, Andrew — Hagie STS12 — 100.0000 — 344.6700); **Application table** (Application | Warehouse | Vendor | Rate/Acre | UM | Total Applied UM) — e.g. Spray Grade Ammonium Sulfate (AMS 51lb) / Crop Rx Solutions / Wells Ag Supply / 2.000000 LB / 689.340000 LB; Spray PHIx / Wells Brothers Ag / Van Diest Supply Co. / 2.000000 OZ / 689.340000 FL OZ (5.385469 GL); Hagie Chemical Application / 15.000000 GL / 5170.050000 GL.
- **Customer table** (Customer | Shares | Acres): five customers share this one job — Wells Mason 15.2320/52.5000, Wells Clayton 15.2320/52.5000, Huffington Farms 23.7909/82.0000, Next Generation Farms Partnership LLC 35.3962/122.0000, FAKE CUSTOMER 10.3490/35.6700 — a built-in shared-job/split-billing view.
- **Diluent per Acre**: 15.
- **Application Date | Time | Temp | Wind Dir | Wind Speed | Humidity** row (07/11/2026, 76, 90, 4.7, 87.61) + "All Locations [100.00%] applied for a total of [344.67 ac]".
- A **blank printable field-log grid**: Date | Name | License # | Comments/Signatures; Vehicle # | Airport | Acres Applied; Time Start/End | Temp Start/End | Wind Dir Start/End | Wind Spd Start/End | Humidity Start/End — the physical sign-off block the crew fills in by hand.

### 6. Edit Loader Worksheet modal (frames 22–41) — the blend/load calculator
- Header "Edit Loader Worksheet".
- **Inputs**: Applicator (Shelton, Andrew), Vehicle (Rogator 1100C), **Total Vehicle Capacity** (auto-fills 1300.00 GL from the vehicle record but fully editable — Mason retypes 5000 then 2000), **Acres** ("344.67 remaining / 344.67 total" with an editable acres field), **Ground Crew** dropdown, **Crew Members** repeatable list (+ add / red remove), **Load Balance** dropdown ("Full Loads / Remainder"), **Application Type** (Liquid), **Target Rate/Acre** (types 15, unit GL), **Total Loads** (auto-computed: 4 at 1,300 gal → 2 at 5,000 gal → 3 at 2,000 gal), **Loader Comments** free-text box.
- Info banner: "All chemical/charge items are included in the worksheet. Change this setting in system settings."
- **Chemical summary table**: Chemical Name (with warehouse/vendor subtitle) | Type (Dry/Liquid) | Rate/Acre | Total Applied — Spray Grade Ammonium Sulfate (AMS 51lb), Dry, 2.00 LB, 689 LB 5.44 OZ; Spray PHIx, Liquid, 2.00 OZ-LIQ, 5 GL 49.34 OZ; Hagie Chemical Application, Liquid, 15.00 GL, 5170 GL 6.40 OZ; footer "Target Rate/Acre: 15.000000 GL", "Total Work: 5170.050000 GL".
- **Auto-generated per-load cards** ("Load #1", "Load #2", "Load #3"): each shows Chemical Name | Rate/Acre | **Load Contribution** (e.g. Load #1 @ 2,000 gal: 266 LB 10.67 OZ ammonium sulfate, 2 GL 10.67 OZ Spray PHIx, 2000 GL 0.00 OZ carrier), plus "Effective Rate/Acre: 15.000000 GL", an **editable Acres field per load** (133.33 / 133.33 / 78.00), and "Total Load" (2000 GL / 2000 GL / 1170 GL 6.40 OZ). At 5,000-gal capacity the loads were 333.33 ac + 11.34 ac. The **last load auto-right-sizes to the remaining acres** instead of splitting evenly.
- Cancel / **Save Worksheet**.

### 7. Loader Report print preview (frames 43–48)
Browser print dialog (destination ET-4950, 2 sheets). Print layout:
- Page 1: full Loader Report header (job, customer, phone), location/acres table, worksheet list, applicator/application/customer/diluent tables, the blank field sign-off grid, then a per-vehicle block: "Vehicle: Rogator 1100C — Capacity: 2000 GL — **Total Acres: 344.67**", Load Balance: Full Loads/Remainder, Application Type: Liquid, Target Rate/Acre: 15.00 GL, **Total Loads: 3**, Loader Comments.
- Page 2: **numbered load cards** (tab labels "1 2" then "3"): each card headed "Load Acres: 133.33 | Total Acres: 344.67 — Crops: Corn" with table Chemical Name | **Load Contribution** | Rate/Acre | Total Applied — e.g. "266 LB 10.67 OZ (4,266.67 OZ)" ammonium sulfate, "2 GL 10.67 OZ (2.08 GL)" Spray PHIx, "2000 GL 0.00 OZ (2,000.00 GL)" carrier, "Total Load: 2000 GL 0.00 OZ"; last card "Load Acres: 78.00" with 156 LB 0.11 OZ / 1 GL 28.01 OZ / 1170 GL 6.40 OZ, "Total Load: 1170 GL 6.40 OZ". This is the physical sheet handed to the blending crew, one section per load.

---

## What he likes & why (quote-by-quote)

- **[0:08–0:12]** "My sprayer guy can type here and put in as-applied data." — The field operator, not office staff, enters the as-applied record at the source: his name, the sprayer, start and end time.
- **[0:24–0:30]** "He can actually type in what he did or didn't do... it's just really, really good." — As-applied entry is flexible and editable after the fact; partial records can be completed later.
- **[0:34–0:44]** "I can change the location — I want my sprayer guy to spray Huffington field first... I can change the order. And that'll print out too, just so the sprayer knows how I want him to route himself." — Manual field-sequencing within a multi-field job, and the route order carries onto the printed sheet as a physical routing guide.
- **[0:50–0:56]** "I can upload log files from the sprayer." — Raw equipment/telemetry logs attach to the job for recordkeeping.
- **[1:05–1:10]** "He can select whether he wants to blend individual loads or condensed loads." — Display flexibility on the loader sheet for how the blender wants to see it.
- **[1:11–1:19]** "I can go in here and change anything I want... you can tell it how many gallons." — Every parameter of the worksheet is user-controllable.
- **[1:21–1:43]** "Whether I want full loads — so target rate an acre, I want 15 gallon, that means I need four fill-ups." — Types the target rate once and the system computes fill-up count automatically; "Full Loads/Remainder" balance mode.
- **[1:19–1:52]** "I'm gonna mix up a five thousand gallon batch to tender to the sprayer... I got a five thousand gallon tank... that's gonna take two loads. At 15 gallon per acre it shows the product, the rate per acre, so the total amount that we need to apply to this job." — Live recalculation of load count and total product amounts when tank capacity changes; supports the mix-into-a-tender-tank workflow, not just the sprayer's own tank.
- **[2:04–2:22]** "If we have a two thousand gallon tank that we're gonna mix into, it already breaks out load one, load two, load three. **This makes it so easy and it erases the manual errors with us making blend tickets.**" — The strongest praise in the video: automatic per-load blend-ticket breakdown eliminates hand-math errors on blend tickets.
- **[2:21–2:38]** "First time the tank comes in he needs to add two hundred and sixty-six pounds of ammonium sulfate, two gallon of spray fix, he needs a total of two thousand gallons, so he needs to add the rest of water. And then you can also edit these." — Per-load instructions are concrete enough to read straight to the blender (dry lbs, liquid gals, fill-to-total with water), and still editable.
- **[2:38–2:44]** "The last load would be only a seventy-eight acre load, and there's the product quantity." — The final/remainder load is automatically right-sized to remaining acres, with its own correct product amounts.
- **[2:46–2:58]** "I can print that out... I can even edit things in here, but it just works really nice." — Print-first output; automation never locks out manual override.
- **[2:58–3:10]** "I can just give this to the blending guy — load one, load two, you do these amounts, and then on the third load to finish the job, here's how much he needs. **It makes our workflow really nice.**" — End-to-end value: one auto-generated printed sheet is the blend crew's complete work instructions.

## Pain points he states about CRX

**None stated explicitly in this video.** The entire narration is feature admiration of ChemMan; there is no verbalized "CRX doesn't do this" or any direct comparison. The only implicit pain point is historical/process, not CRX-specific: **[2:13–2:22]** "it erases the manual errors with us making blend tickets" — i.e., before this tool, blend tickets were made by hand with manual math and that produced errors. Treat every checklist item below as an implied gap for CRX rather than a stated complaint.

---

## Feature checklist (concrete, buildable capabilities demonstrated)

**As-applied data entry**
- [ ] Operator-facing "Applied Info" entry on a job: applicator, vehicle/sprayer, application date, begin/end tach (net auto-computed), flights, starts.
- [ ] Entries can be partial and edited/completed later (not a one-shot locked form).
- [ ] Per-field breakdown within a job: Acres To Apply / Applied Acres / Remaining Acres per location, with a job-level remaining-acres total.
- [ ] "Select Locations by Map": pick which field boundaries an as-applied record covers from a satellite map labeled with per-field acreage.
- [ ] Start/end weather auto-capture (temp, wind direction, wind speed, humidity) via a weather API (ChemMan uses Visual Crossing), with a "Get Weather" / "Now" quick-fill and a liability disclaimer. *(CRX already has weather auto-fill per project memory — verify parity of start+end capture and per-location handling.)*

**Job routing**
- [ ] "Job Location Order": drag-and-drop reordering of which field in a multi-field job is serviced first, with numbered map markers synced to the list, and load-number ranges shown per field (#1–5, #6–7, …).
- [ ] The saved route order flows onto the printed dispatch/loader sheet so the field crew has a physical routing guide.

**Log files**
- [ ] Attach/upload raw sprayer log files to a job record (row-level "Attach Log Files" and "Map / Logs" actions).

**Loader / mixer sheet ("blend ticket automation")**
- [ ] A per-job "Loader Report" hub listing all saved loader worksheets with Select/Edit/Delete; **multiple worksheets per job** can coexist (e.g. one per vehicle/tank scenario).
- [ ] Display toggles: Show Field Location Info (Y/N); Individual Loads vs. Condensed Loads.
- [ ] Worksheet inputs: applicator, vehicle, **tank capacity auto-filled from the vehicle record but editable** (supports tender-tank scenarios), acres (remaining/total), ground crew + repeatable crew-member list, **Load Balance mode ("Full Loads / Remainder")**, application type (Liquid/Dry), target rate/acre, loader comments.
- [ ] **Auto-computed total loads/fill-ups** from capacity, target rate, and acres — recalculates live as any input changes (4 → 2 → 3 loads in the demo).
- [ ] **Auto-generated per-load blend tickets**: exact product amounts per load (lbs+oz for dry, gal+oz for liquid, carrier fill-to-total), with per-load acres editable and effective rate/acre shown.
- [ ] **Remainder load auto-right-sizes** to leftover acres (78 ac) instead of forcing full/even loads.
- [ ] All computed values remain manually overridable after generation.
- [ ] Multi-customer shared jobs: one job carries multiple customers each with Shares % and Acres, rolled into the same loader sheet (split-billing surface).
- [ ] Diluent-per-acre shown with the product tables.
- [ ] Setting to include/exclude "chemical/charge items" from worksheets at the system-settings level.
- [ ] **Printable loader sheet**: per-vehicle summary (capacity, load balance, rate, total loads, comments) + one numbered card per load (Chemical | Load Contribution | Rate/Acre | Total Applied, "Total Load" footer, load acres + crop in the card header) + a blank field sign-off grid (date, name, license #, vehicle #, airport, acres applied, time/temp/wind/humidity start-end, comments/signatures).

---

Note: frames f_009–f_014 and f_039 contain visible Claude/ChatGPT browser-extension overlay chips in the corners of the screen recording — artifacts of the recording setup, not ChemMan UI.
