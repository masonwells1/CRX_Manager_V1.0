# ChemMan Walkthrough — "Field Mapping" (174s)

Source: `docs/walkthroughs/extracted/Field_Mapping/transcript.txt` + frames `f_001`–`f_044` (1 frame every 4s).

## Narrative (in order, with timestamps)

1. **[0.0–9.5]** Mason opens ChemMan's field list and states up front: "the other piece that Kenman [ChemMan] is still way better at than our app is adding fields... I can have all the fields. It's so easy."
2. **[9.5–17.5]** "Our app is too cluttered. You have to go to too many screens to see all the fields." He's on ChemMan's **Manage Field Locations** screen — a single flat, scrollable list of every field for every customer in the whole system (f_001–f_004 show hundreds of rows: Name, Strip, Description, Crops, Customers, Permit, Planted, Total, Edit).
3. **[17.5–28]** Opens the "Select Customers" filter dropdown, types a name, narrows the list to one customer. "I'll put my name in Mason and then here's all my fields" (f_005–f_007: typeahead search → filtered results showing only "Wells, Mason" / "Wells, Clayton" / "Wells, Chad" fields).
4. **[29–33]** "I really like, I just, I really do like it."
5. **[33–43]** Points at **Upload Maps / Upload Maps (Group)** buttons on the list toolbar (f_009–f_011): "I can upload maps from like John Deere Field View or anywhere and it'll automatically log it on a map."
6. **[43–55]** "when I go to add fields, this is what's way better... I can see every customer's field that's in our system on the screen at the same time." f_012 shows the **Edit Location(s) / "Location new"** screen: map on the left with dozens of overlapping field polygons/labels/acreages shown at once, full field-detail form on the right.
7. **[55.5–65.5]** Clicks a toggle to hide the overlapping labels "if it gets cluttered" (f_014→f_015: labels disappear). Points out small **obstacle markers**: "you can add obstacles like I have oil wells here... little windmills so my sprayer guys know where there's obstacles at" (f_015–f_018 show small white windmill/pinwheel icons scattered across a field).
8. **[72.5–79.5]** "I got them all marked in there and makes it really nice." Starts adding a new field.
9. **[80–90]** Types the new field name — f_021 shows "FAKE" typed, f_022 shows "FAKE FIELD 40" (page title updates live). Clicks into edit-map mode — f_023 shows top bar switch to "UNDO CHANGES"/"SAVE MAP CHANGES" with a drawing toolbar (select/circle/pencil/move/delete icons) on the map's right edge.
10. **[90–99]** "I can see FSA boundaries" — f_024/f_025 show a basemap-layer picker (**MapBox Sat / Google Sat / Road View / Enhanced Street**, "SAVE SELECTIONS" button) plus tan FSA (Farm Service Agency) section-boundary lines over satellite imagery.
11. **[99–115.5]** "I can just click off the FSA boundaries so I don't even have to manually do it." f_027–f_029: clicking an FSA section polygon highlights it yellow, snaps to the real irregular field edge (follows a creek on one side), and auto-populates Total acres = 51.96, Planted acres = 51.96, Lat/Long = 39.142500 / -87.776900.
12. **[115.5–130.5]** "It's 51.96 acres. I can hit legal lookup and based off the coordinates that automatically pulls in the section, township, range, everything else." f_031: **LEGAL LOOKUP** auto-fills Section=17, Township=08N, Range=12W, Base & Meridian=02, State=Illinois, County=Crawford.
13. **[130.5–138]** "I want this customer is 50% share on this field and then Mason wells the other 50%." f_033–f_035: **Customers** section with searchable typeahead; two rows each with Shares + auto-computed Acre — FAKE CUSTOMER: Shares 50/Acre 25.98; Wells, Mason: Shares 50/Acre 25.98 (auto-split from 51.96 total).
14. **[138–153]** "I can also click edit and I can edit those FSA boundaries, the auto-pulled in. Or I can draw multiple polygons." f_036–f_038: boundary in vertex-edit mode (draggable white dots on every point, including the jagged creek edge) and a "Draw Polygons" tooltip.
15. **[153–165.5]** Draws a second, physically separate polygon in the same field (f_039 shows a small blue in-progress shape). "It all saves as one field in our app... most times fields are broken up in different sections." f_040: Total acres jumps 51.96 → **53.51**, both customer shares recompute to 26.755 each.
16. **[165.5–174.5]** "We're going to save it. And then if I select this field for a job, it knows the billing splits, knows the acres — it's really slick." (f_041–f_044: final state — two yellow polygons forming "FAKE FIELD 40," two-customer 50/50 split shown below.)

## UI observed

**1. "Manage Field Locations" — master field list**
- Full ERP nav bar (Customers, Vehicles, Applicators, Reports, Month End, Inventory, Chemical Sales, Scheduling, Invoices, Setup, Utility, Bottom Line).
- Filter bar: Location text, Strip dropdown, Crop dropdown, Select Customers (searchable typeahead), Status dropdown, Search button. Pagination above the toolbar.
- Toolbar: Select by Map, Map Selected Location(s), Map Selected (List), Edit, Quick Edit, Upload Maps, Upload Maps (Group); green "+ Add Location(s)" / "+ Add Single Location" on the right.
- Dismissible yellow notice banner about map upload status.
- Grid columns: Name (sortable), Strip, Description, Crops, Customers (stacks multiple names for shared fields), Permit, Planted, Total, Edit button per row.
- Flat list shows every field in the system regardless of customer until filtered; selecting a customer instantly filters the grid.

**2. "Edit Location(s)" — field detail / map editor (core screen)**
Two-pane layout, map left / form right.

Map pane: header "EDIT MAP" (turns green in edit mode) with a location/lat-lon search box; S/T/R toggle top-left; expand-fullscreen, layers-stack icon, and FSA toggle top-right. Non-edit view overlays every nearby field's boundary + customer name/ID + crop + "X ac of Y ac" text directly on the satellite image (this is both the "everything visible at once" feature he likes and the "gets cluttered" problem with its own hide toggle). Small white windmill/pinwheel obstacle markers pinned on fields. Basemap picker panel: MapBox Sat / Google Sat / Road View / Enhanced Street radios + Save Selections. FSA toggle overlays tan USDA section-boundary polygons; clicking inside one selects/highlights it (yellow) and adopts it as the field boundary. Edit mode swaps the top bar to UNDO CHANGES / SAVE MAP CHANGES and adds a vertical drawing toolbar (select, draw-circle/point, undo, pencil freehand, move/pan, zoom, delete). Every vertex becomes a draggable white dot for manual reshaping. Supports multiple disjoint polygons per field, with acreage summed automatically. Standard zoom +/-, Leaflet attribution.

Form pane: Field Location/Site ID (text, live-updates page title) + Status dropdown; Description; Total acres/Planted acres (auto-filled, editable) + an unlabeled toggle and a "WIND" toggle; Crop/Strip dropdowns; Latitude-Degrees/Longitude-Degrees (auto-filled); Section/Township/Range (auto-filled by Legal Lookup); teal LEGAL LOOKUP button; Block ID, Base & Meridian; State/County/Nearest Town; Customers section — repeatable rows of Select Customer (typeahead) + Shares (number) + auto-computed Acre + red remove button; bottom Invoice Comments and Additional Notes & Information text boxes; footer Cancel Without Saving / Save Location Changes buttons.

## What Mason likes & WHY (paraphrased quote + timestamp)

- **[0.0–9.5]** "I can have all the fields. It's so easy." — values low-friction field creation/management as a category.
- **[9.5–17.5]** "Our app is too cluttered... too many screens to see all the fields." — likes that ChemMan shows every field for every customer on one list screen.
- **[17.5–28]** "I can select by customer... here's all my fields." — likes the instant customer-scoped filter on that same list.
- **[29–33]** "I really do like it." — general reiterated enthusiasm.
- **[33–43]** "I can upload maps from like John Deere Field View or anywhere and it'll automatically log it on a map." — likes bulk import of external precision-ag map exports, auto-placed.
- **[43–55]** "I can see every customer's field on the screen at the same time." — likes full spatial context when placing a new field.
- **[55.5–61.5]** "I can click this button to not show it if it gets cluttered." — likes that density is opt-in via a declutter toggle.
- **[61.5–70.5]** "You can add obstacles like oil wells... little windmills so my sprayer guys know where there's obstacles." — likes pinning operational hazard markers his applicator drivers need.
- **[90–99]** "It has Map Box, Google Sat... road view or enhance street." — likes multiple basemap/imagery layers plus FSA overlay.
- **[99–110.5]** "I can just click off the FSA boundaries. So I don't even have to manually do it." — strong specific like: auto-boundary-detection from FSA data eliminates manual tracing.
- **[117.5–130.5]** "Legal lookup... automatically pulls in the section, township, range, everything else." — likes auto-derived legal-description metadata from coordinates.
- **[138–153]** "I can edit those FSA boundaries, the auto-pulled in. Or I can draw multiple polygons." — likes that the auto boundary is a fully editable starting point, with free-hand/multi-polygon support.
- **[159.5–172.5]** "It all saves as one field... if I select this field for a job, it knows the billing splits, knows the acres. It's really slick." — likes multi-polygon-to-one-field consolidation and that ownership/billing splits flow automatically into job selection downstream.

## Pain points he states about CRX

- **"Our app is too cluttered."** [9.5–11.5]
- **"You have to go to too many screens to see all the fields here [vs. ChemMan]."** [11.5–15.5] — CRX apparently requires multiple screens (likely per-customer) to see the full field inventory.
- **"You can only do one polygon [in our app], but most times fields are broken up in different sections... we need to be able to add this."** [159.5–165.5] — explicit, direct gap statement: CRX (as he understands it) supports only a single polygon per field.
- Implicit: the whole video is framed around CRX's field/map management lagging ChemMan generally — no evidence shown that CRX has FSA auto-boundary-detection, Legal Lookup, obstacle markers, or share-based multi-customer acreage splitting on its field editor.

## Feature checklist (buildable capabilities demonstrated)

Field list / management:
- Single master "all fields" list across every customer (name, strip, description, crop, customer(s), permit, planted acres, total acres), paginated.
- Filter bar: location text, strip, crop, customer (searchable typeahead, partial match), status, explicit Search.
- Bulk actions: select-by-map, map selected locations, quick edit, bulk map upload (single + group).
- Bulk import of external precision-ag map exports (e.g., John Deere) that auto-place boundaries on the map.

Map-based field editor:
- Map view rendering all nearby fields simultaneously (boundary + label + customer + crop + shared-acreage text) for context while placing/editing a field.
- One-click toggle to hide/show overlapping field labels/boundaries.
- Multiple basemap layers: 2+ satellite providers, road/street, "enhanced street."
- FSA parcel-boundary overlay with click-to-select: clicking inside a section polygon auto-adopts it as the field boundary and computes acreage + centroid lat/long.
- "Legal Lookup": auto-fill Section, Township, Range, Base & Meridian, State, County from the drawn polygon's coordinates.
- Manual polygon editing: draggable vertex handles, freehand pencil draw, undo, delete.
- Multi-polygon fields: multiple disjoint shapes counted as one logical field record with combined acreage.
- Obstacle/hazard markers pinnable at specific points on a field (distinct icon) for field-crew visibility.
- Field detail fields: Location/Site ID, Status, Description, Total/Planted acres, Crop, Strip, Lat/Long, Section/Township/Range, Block ID, Base & Meridian, State/County/Nearest Town, Invoice Comments, Additional Notes.
- Multi-customer field ownership: N customers per field, each with a Shares percentage and auto-computed Acre allocation (add/remove rows freely).
- Downstream payoff: selecting a multi-owner field for a job auto-applies the correct acreage and per-owner billing split with no re-entry.
