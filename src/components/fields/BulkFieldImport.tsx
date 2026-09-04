import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Upload,
  CheckCircle,
  AlertCircle,
  FileText,
  MapPin,
  AlertTriangle,
} from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult, rpcAuthErrorMessage } from '../../lib/db';
import {
  parseShapefileBundle,
  parseShapefileZip,
  parseGeoJSONFile,
  parseKMLFile,
  calculateFieldMetrics,
  validateFullGeometry,
  geometryAcres,
  type ParseResult,
} from '../../lib/fieldImportParser';
import {
  acreDivergencePct,
  isAcreDivergent,
  ACRE_DIVERGENCE_THRESHOLD_PCT,
  isAcreInBand,
  isAcreDenominatedColumn,
  parseAcreInput,
  ACRE_BAND_MIN,
  ACRE_BAND_MAX,
} from '../../lib/fieldGeometry';
import type { Polygon, MultiPolygon } from 'geojson';
import ImportPreviewMap from './ImportPreviewMap';
import AttributeMappingStep from './AttributeMappingStep';
import FieldCustomerAssignment from './FieldCustomerAssignment';
import {
  resolveFieldCustomerId,
  allFieldsAssigned,
  type AssignableField,
} from '../../lib/fieldImportCustomers';
import type { Customer, ParsedImportField } from '../../types';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { fingerprintIntentPayload } from '../../lib/idempotency';


interface BulkFieldImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type FileType = 'shapefile' | 'shapefile-zip' | 'geojson' | 'kml' | null;

const STEP_LABELS = [
  'Upload',
  'Preview',
  'Map Columns',
  'Customer',
  'Review',
  'Importing',
  'Done',
];

const ACCEPTED_EXTENSIONS = ['.zip', '.shp', '.dbf', '.shx', '.prj', '.geojson', '.json', '.kml'];
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export default function BulkFieldImport({ open, onClose, onSuccess }: BulkFieldImportProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const saveFieldIdem = useIdempotencyKey('save_field', profile?.id || '');
  const setBoundaryIdem = useIdempotencyKey('set_field_boundary', profile?.id || '');
  const setOverrideAcresIdem = useIdempotencyKey('set_field_override_acres', profile?.id || '');

  // Step tracking
  const [step, setStep] = useState<Step>(1);

  // Step 1: Files
  const [files, setFiles] = useState<File[]>([]);
  const [fileType, setFileType] = useState<FileType>(null);

  // Step 2: Parse results
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // Step 3: Column mapping
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});

  // Step 4: Customer assignment (per-field, with an apply-to-all fast path)
  const [customers, setCustomers] = useState<Customer[]>([]);
  // The "apply to all" / fallback customer; per-field overrides live in fieldCustomerAssignments.
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [fieldCustomerAssignments, setFieldCustomerAssignments] = useState<Record<number, string>>({});

  // Step 5: Validated fields
  const [parsedFields, setParsedFields] = useState<ParsedImportField[]>([]);

  // Step 6: Upload progress
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const uploadInFlightRef = useRef(false);

  // Step 7: Results
  const [results, setResults] = useState<{ success: number; failed: number; errors: string[]; warnings: string[] } | null>(null);

  // Fetch customers for step 4
  useEffect(() => {
    if (open) {
      fetchCustomers();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fetchCustomers = async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name')
      .limit(500);
    if (error) {
      toast('error', 'Failed to load customers');
      return;
    }
    setCustomers((data || []) as Customer[]);
  };

  const handleClose = () => {
    // The import pipeline is intentionally not cancellable once it starts:
    // closing would let the old session mutate a newly opened dialog and call
    // onSuccess for the wrong session. Keep every dismissal path disabled
    // until the current upload has reached its terminal result screen.
    if (uploadInFlightRef.current) return;
    // Reset all state
    setStep(1);
    setFiles([]);
    setFileType(null);
    setParseResult(null);
    setParsing(false);
    setParseError(null);
    setColumnMapping({});
    setSelectedCustomerId('');
    setFieldCustomerAssignments({});
    setParsedFields([]);
    setUploading(false);
    setUploadProgress({ current: 0, total: 0 });
    setResults(null);
    onClose();
  };

  // ─── Step 1: File Upload ────────────────────────────────────────────

  const detectFileType = (fileList: File[]): FileType => {
    const names = fileList.map((f) => f.name.toLowerCase());
    if (names.some((n) => n.endsWith('.zip'))) return 'shapefile-zip';
    if (names.some((n) => n.endsWith('.shp'))) return 'shapefile';
    if (names.some((n) => n.endsWith('.geojson') || n.endsWith('.json'))) return 'geojson';
    if (names.some((n) => n.endsWith('.kml'))) return 'kml';
    return null;
  };

  const handleFileSelect = (selectedFiles: FileList | File[]) => {
    const fileArray = Array.from(selectedFiles);

    // Validate extensions
    const invalidFiles = fileArray.filter((f) => {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase();
      return !ACCEPTED_EXTENSIONS.includes(ext);
    });
    if (invalidFiles.length > 0) {
      toast('error', `Unsupported file type: ${invalidFiles[0].name}. Accepted: .zip, .shp, .dbf, .prj, .geojson, .json, .kml`);
      return;
    }

    // Validate total size
    const totalSize = fileArray.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_SIZE) {
      toast('error', `Files too large (${(totalSize / 1024 / 1024).toFixed(1)}MB). Maximum is 25MB.`);
      return;
    }

    const type = detectFileType(fileArray);
    if (!type) {
      toast('error', 'Could not detect file type. Please upload a .zip shapefile, loose .shp/.dbf, .geojson, or .kml.');
      return;
    }

    // Shapefile validation: must have both .shp and .dbf
    if (type === 'shapefile') {
      const names = fileArray.map((f) => f.name.toLowerCase());
      if (!names.some((n) => n.endsWith('.shp'))) {
        toast('error', 'Shapefile bundle requires a .shp file.');
        return;
      }
      if (!names.some((n) => n.endsWith('.dbf'))) {
        toast('error', 'Shapefile bundle requires a .dbf file. Please include it alongside the .shp file.');
        return;
      }
    }

    setFiles(fileArray);
    setFileType(type);
    setParseError(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files);
    }
  };

  // ─── Step 2: Parse files ────────────────────────────────────────────

  const handleParse = async () => {
    if (files.length === 0 || !fileType) return;
    setParsing(true);
    setParseError(null);
    // A fresh parse means a different set of fields — drop any prior per-field customer assignments
    // so a stale index from a previous file can't silently reattach a customer to the wrong field.
    setFieldCustomerAssignments({});
    setSelectedCustomerId('');

    try {
      let result: ParseResult;

      if (fileType === 'shapefile') {
        const shpFile = files.find((f) => f.name.toLowerCase().endsWith('.shp'));
        const dbfFile = files.find((f) => f.name.toLowerCase().endsWith('.dbf'));
        const prjFile = files.find((f) => f.name.toLowerCase().endsWith('.prj'));

        const shpBuffer = await shpFile!.arrayBuffer();
        const dbfBuffer = await dbfFile!.arrayBuffer();
        const prjText = prjFile ? await prjFile.text() : null;

        result = await parseShapefileBundle(shpBuffer, dbfBuffer, prjText);
      } else if (fileType === 'shapefile-zip') {
        const zipFile = files.find((f) => f.name.toLowerCase().endsWith('.zip'));
        const zipBuffer = await zipFile!.arrayBuffer();   // binary — a zip, not text
        result = await parseShapefileZip(zipBuffer);
      } else if (fileType === 'geojson') {
        const jsonFile = files.find(
          (f) => f.name.toLowerCase().endsWith('.geojson') || f.name.toLowerCase().endsWith('.json')
        );
        const text = await jsonFile!.text();
        result = parseGeoJSONFile(text);
      } else {
        // KML
        const kmlFile = files.find((f) => f.name.toLowerCase().endsWith('.kml'));
        const text = await kmlFile!.text();
        result = await parseKMLFile(text);
      }

      setParseResult(result);
      setStep(2);
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse files.');
    }

    setParsing(false);
  };

  // ─── Step 5: Build validated field list ─────────────────────────────

  const buildParsedFields = () => {
    if (!parseResult) return;

    const fc = parseResult.featureCollection;
    const fields: ParsedImportField[] = [];

    for (let i = 0; i < fc.features.length; i++) {
      const feature = fc.features[i];
      const props = feature.properties || {};
      const errors: string[] = [];

      // Geometry validation — validate ALL parts of the full geometry (the import sends the full
      // multi-part geometry to set_field_boundary), not just the largest display polygon.
      const geoErrors = validateFullGeometry(parseResult.fullGeometries[i] as Polygon | MultiPolygon);
      errors.push(...geoErrors);

      // Calculate metrics
      let acres = 0;
      let fullAcres = 0;
      let centroid = { type: 'Point' as const, coordinates: [0, 0] as [number, number] };
      if (geoErrors.length === 0) {
        const metrics = calculateFieldMetrics(feature);
        acres = metrics.acres;
        centroid = metrics.centroid;
        // Only after validation passes — geometryAcres (turf) can throw on a malformed geometry.
        fullAcres = geometryAcres(parseResult.fullGeometries[i] as Polygon | MultiPolygon);
      }

      // Map attributes
      const getValue = (crxField: string): string | null => {
        const attrKey = columnMapping[crxField];
        if (!attrKey || props[attrKey] == null) return null;
        return String(props[attrKey]).trim() || null;
      };

      const fieldName = getValue('field_name') || `Imported Field ${i + 1}`;
      // Per-field assignment (a county/co-op file covers many growers), falling back to the
      // "apply to all" customer. A field still left without one is invalid → surfaced + skipped.
      const customerId = resolveFieldCustomerId(i + 1, fieldCustomerAssignments, selectedCustomerId);

      if (!customerId) {
        errors.push('No customer assigned');
      }

      const acreAttrKey = columnMapping['total_acres'] ?? null;
      // Strict parse (strips thousands separators; rejects "40 ac"/junk) so a formatted string
      // like "1,234.5" can't become a 1-acre bill via parseFloat's partial parse.
      const acresFromAttr = parseAcreInput(getValue('total_acres'));
      // The acreage the FILE reported, but ONLY from an ACRE-denominated column — a GIS area
      // column (area/shape_area, square meters) must never set money (a 1-ac field's shape_area
      // ≈ 4047 would bill as 4047 ac). The value is PRESERVED even when 0/negative/out-of-band so
      // the review flags it (isAcreInBand decides whether it can actually bill); null only when
      // the column is non-acre or unparseable.
      const statedAcres = isAcreDenominatedColumn(acreAttrKey) ? acresFromAttr : null;

      fields.push({
        index: i + 1,
        field_name: fieldName,
        customer_id: customerId,
        legal_description: getValue('legal_description'),
        county: getValue('county'),
        state: getValue('state') || 'IL',
        // Seed the legacy total_acres from the file ONLY when it's in-band; an out-of-band value
        // bills on measured anyway, and seeding it here could fail the create or leave a bad legacy
        // acreage on an orphaned field if the boundary RPC later fails.
        total_acres: isAcreInBand(statedAcres) ? statedAcres : acres,
        crop_type: getValue('crop_type'),
        fsa_farm_number: getValue('fsa_farm_number'),
        fsa_tract_number: getValue('fsa_tract_number'),
        fsa_field_number: getValue('fsa_field_number'),
        soil_type: getValue('soil_type'),
        irrigation: false,
        notes: getValue('notes'),
        boundary_geojson: feature.geometry,
        // The full original geometry (multi-part preserved) — sent to set_field_boundary so
        // the server measures the whole field, not just the largest-ring display polygon.
        full_boundary_geojson: parseResult.fullGeometries[i],
        full_acres: fullAcres,
        stated_acres: statedAcres,
        centroid_geojson: centroid,
        calculated_acres: acres,
        raw_properties: props as Record<string, unknown>,
        errors,
        isValid: errors.length === 0,
      });
    }

    setParsedFields(fields);
  };

  // ─── Step 4 helpers: per-field customer assignment ──────────────────

  // The lightweight per-field list shown on the assignment step (name + acreage). Derived from the
  // parsed features + the column mapping; acreage is best-effort (a malformed geometry is caught and
  // shown as 0 here, and flagged for real in the Review step).
  const assignableFields: AssignableField[] = useMemo(() => {
    if (!parseResult) return [];
    return parseResult.featureCollection.features.map((feature, i) => {
      const props = feature.properties || {};
      const nameKey = columnMapping['field_name'];
      const rawName = nameKey && props[nameKey] != null ? String(props[nameKey]).trim() : '';
      let acres = 0;
      try {
        acres = geometryAcres(parseResult.fullGeometries[i] as Polygon | MultiPolygon);
      } catch {
        acres = 0;
      }
      return { index: i + 1, name: rawName || `Imported Field ${i + 1}`, acres };
    });
  }, [parseResult, columnMapping]);

  // Apply-to-all is the single source of truth for the fast path: it sets the fallback customer and
  // CLEARS per-field overrides, so the per-field map only ever holds true overrides. resolveFieldCustomerId
  // (used by the UI, the gate, and buildParsedFields alike) then resolves each field to its override or
  // this fallback — one notion of "assigned" everywhere.
  const handleApplyToAll = (customerId: string) => {
    setSelectedCustomerId(customerId);
    setFieldCustomerAssignments({});
  };

  const handleAssignField = (index: number, customerId: string) => {
    setFieldCustomerAssignments((prev) => ({ ...prev, [index]: customerId }));
  };

  // ─── Step 6: Upload ─────────────────────────────────────────────────

  const handleUpload = async () => {
    if (!profile || uploadInFlightRef.current) return;
    const validFields = parsedFields.filter((f) => f.isValid);
    if (validFields.length === 0) return;

    uploadInFlightRef.current = true;
    setUploading(true);
    setUploadProgress({ current: 0, total: validFields.length });

    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];

    // Counts how many rows in THIS import already claimed each save_field identity.
    // It replaces the row's file position in the scope below: a position moves when
    // only the failed row is re-imported, but "the second copy of this content" does
    // not. Two genuinely distinct rows carrying identical attributes still get
    // separate keys, so they still become two fields.
    const saveIdentityOccurrences = new Map<string, number>();

    for (const pf of validFields) {
      try {
        // Pre-validate the FULL multi-part acreage against the server's 0.1–5000 band BEFORE
        // creating the field. Otherwise an out-of-band import creates a field that
        // set_field_boundary then rejects, leaving an orphan a sales_rep cannot delete
        // (fields_delete RLS is admin-only).
        if (pf.full_acres < 0.1 || pf.full_acres > 5000) {
          failed++;
          errors.push(`"${pf.field_name}": ${pf.full_acres} ac is outside the allowed 0.1–5000 acre range; not imported.`);
          setUploadProgress((prev) => ({ ...prev, current: prev.current + 1 }));
          continue;
        }

        // Everything save_field writes EXCEPT the geometry-derived acreage seed.
        // Deriving fieldPayload from this (rather than listing the columns twice)
        // keeps the intent identity automatically in step with the payload: a
        // column added here joins the scope, and only total_acres is exempt.
        const fieldIdentity = {
          customer_id: pf.customer_id,
          field_name: pf.field_name,
          legal_description: pf.legal_description,
          county: pf.county,
          state: pf.state || 'IL',
          fsa_farm_number: pf.fsa_farm_number,
          fsa_tract_number: pf.fsa_tract_number,
          fsa_field_number: pf.fsa_field_number,
          crop_type: pf.crop_type,
          soil_type: pf.soil_type,
          irrigation: pf.irrigation,
          notes: pf.notes,
          is_active: true,
        };
        // total_acres is a transient seed, NOT part of the identity: set_field_boundary
        // overwrites it with the server-measured billable acreage a moment later
        // (`total_acres = v_billable`), so the value save_field stores never survives
        // and must never be able to mint a second field.
        const fieldPayload = { ...fieldIdentity, total_acres: pf.total_acres };

        // ── Per-STAGE intent scopes ──────────────────────────────────────────
        // save_field COMMITS before set_field_boundary runs, so its scope must not
        // carry anything the later stages own. It previously carried the row's file
        // position, the boundary geometry and the stated acreage: if the boundary
        // call failed and the operator corrected the geometry and re-imported just
        // that row, the position AND the geometry both changed, a fresh key was
        // minted, save_field ran again with p_field_id: null, and the retry created
        // a SECOND field while the first, boundary-less one stayed orphaned — and
        // fields_delete RLS is admin-only, so a sales_rep cannot clean that up.
        //
        // save_field's replay is the ONLY thing preventing that duplicate:
        // check_idempotency is key-only (no actor or payload binding), and the live
        // RPC cannot be handed a client-generated id instead — with a NULL id it
        // INSERTs and lets Postgres pick, and with a non-null id it UPDATEs with no
        // NOT FOUND check, so a made-up id would write nothing and still report
        // success.
        const saveIdentityDigest = fingerprintIntentPayload(fieldIdentity);
        const saveOccurrence = saveIdentityOccurrences.get(saveIdentityDigest) ?? 0;
        saveIdentityOccurrences.set(saveIdentityDigest, saveOccurrence + 1);
        const saveScope = `import:save:${saveIdentityDigest}:#${saveOccurrence}`;

        const { data: fieldId, error: saveError } = await supabase.rpc('save_field', {
          p_field_id: (null as string | null) as string,
          p_field_payload: fieldPayload,
          p_billing_defaults: [],
          p_performed_by: profile.id,
          p_idempotency_key: saveFieldIdem.getKeyFor(saveScope),
        });

        if (saveError) {
          failed++;
          errors.push(`"${pf.field_name}": ${rpcAuthErrorMessage(saveError) ?? saveError.message}`);
        } else if (assertRpcResult(fieldId, 'save_field')) {
          // Stages 2 and 3 own the geometry and the stated acreage, so each binds to
          // the field save_field ACTUALLY returned plus its own exact payload —
          // never to a sibling stage's data. A corrected boundary is real new work
          // and correctly mints a fresh key here, while an unchanged retry of a lost
          // response still replays onto the same field.
          const boundaryScope = `import:boundary:${fieldId}:${fingerprintIntentPayload(pf.full_boundary_geojson)}`;
          const overrideScope = `import:override:${fieldId}:${pf.stated_acres ?? 'none'}`;

          // Persist the boundary via the server-authoritative acreage RPC — it measures the
          // FULL (multi-part) geometry, enforces the 0.1–5000 acre band, keeps field_polygons +
          // legacy boundary/centroid in sync, and sets measured_acres (the billable default).
          let boundaryOk = false;
          try {
            const { data: bData, error: bErr } = await supabase.rpc('set_field_boundary', {
              p_field_id: fieldId,
              p_boundary_geojson: JSON.stringify(pf.full_boundary_geojson),
              p_performed_by: profile.id,
              p_idempotency_key: setBoundaryIdem.getKeyFor(boundaryScope),
            });
            if (bErr) throw bErr;
            assertRpcResult(bData, 'set_field_boundary');
            boundaryOk = true;
          } catch (geoError: unknown) {
            // Acreage was pre-validated above, so set_field_boundary rejecting here is a rare
            // residual (degenerate geometry / a DB error). The field exists with an in-band
            // client total_acres; count it as failed (an admin can remove it — a sales_rep
            // delete is RLS-blocked). A fully-atomic create_field_with_boundary RPC is the
            // documented follow-up that would also avoid this residual.
            const msg = geoError instanceof Error ? geoError.message : String(geoError);
            failed++;
            errors.push(`"${pf.field_name}": Field created but boundary measurement failed — ${msg}`);
          }
          if (boundaryOk) {
            // Bill on the FILE's stated acreage (owner choice 2026-06-23): set it as the billable
            // override. measured_acres still holds the true map measure underneath, so the field
            // screen can show the gap. Apply the SAME 0.1–5000 band the measured path enforces
            // BEFORE sending it — set_field_override_acres only rejects <= 0 / > 5000 (no 0.1
            // floor), so a tiny stated value would otherwise bill below the safety floor. An
            // out-of-band or RPC-rejected stated value is a non-fatal warning: the field still
            // imports, billing on the measured acres.
            if (pf.stated_acres != null) {
              if (!isAcreInBand(pf.stated_acres)) {
                warnings.push(`"${pf.field_name}": the file's ${pf.stated_acres} ac is outside the allowed ${ACRE_BAND_MIN}–${ACRE_BAND_MAX} acre range — billing on the measured ${pf.full_acres} ac instead.`);
              } else {
                try {
                  const { data: ovData, error: ovErr } = await supabase.rpc('set_field_override_acres', {
                    p_field_id: fieldId,
                    p_override_acres: pf.stated_acres,
                    p_performed_by: profile.id,
                    p_idempotency_key: setOverrideAcresIdem.getKeyFor(overrideScope),
                  });
                  if (ovErr) throw ovErr;
                  assertRpcResult(ovData, 'set_field_override_acres');
                } catch (ovError: unknown) {
                  const msg = ovError instanceof Error ? ovError.message : String(ovError);
                  warnings.push(`"${pf.field_name}": imported, but the file's ${pf.stated_acres} ac couldn't be set as the billable acres (${msg}) — billing on the measured ${pf.full_acres} ac instead.`);
                }
              }
            }
            success++;
            // Retire at ROW completion, never per stage.
            //
            // save_field's key must NOT be retired at its own success: it is the
            // only thing stopping a retry-after-boundary-failure from creating a
            // second field, and that failure happens AFTER save_field has already
            // committed. Retiring it here — once the boundary and any override have
            // landed — means a later re-import of a finished row is new intent,
            // while a retry of a half-finished row still replays onto the same field.
            //
            // Stages 2 and 3 are keyed on that same field id, so they retire with it.
            // overrideScope may never have been minted (no stated acreage, or an
            // out-of-band one); retiring an unminted scope is a no-op.
            saveFieldIdem.resetKeyFor(saveScope);
            setBoundaryIdem.resetKeyFor(boundaryScope);
            setOverrideAcresIdem.resetKeyFor(overrideScope);
          }
        }
      } catch (err: unknown) {
        failed++;
        errors.push(`"${pf.field_name}": ${err instanceof Error ? err.message : String(err)}`);
      }

      setUploadProgress((prev) => ({ ...prev, current: prev.current + 1 }));
    }

    setResults({ success, failed, errors, warnings });
    setStep(7);
    setUploading(false);
    uploadInFlightRef.current = false;

    if (success > 0) {
      onSuccess();
    }
  };

  // ─── Navigation ─────────────────────────────────────────────────────

  const handleNext = () => {
    if (step === 1) {
      handleParse();
      return;
    }
    if (step === 2) {
      setStep(3);
      return;
    }
    if (step === 3) {
      setStep(4);
      return;
    }
    if (step === 4) {
      // Build validated field list and go to review
      buildParsedFields();
      setStep(5);
      return;
    }
    if (step === 5) {
      setStep(6);
      handleUpload();
      return;
    }
  };

  const handleBack = () => {
    if (step === 2) { setStep(1); setParseResult(null); return; }
    if (step === 3) { setStep(2); return; }
    if (step === 4) { setStep(3); return; }
    if (step === 5) { setStep(4); return; }
  };

  const canAdvance = (): boolean => {
    if (step === 1) return files.length > 0 && fileType !== null && !parsing;
    if (step === 2) return parseResult !== null;
    if (step === 3) return true; // mapping is optional
    if (step === 4) return allFieldsAssigned(assignableFields, fieldCustomerAssignments, selectedCustomerId);
    if (step === 5) return parsedFields.some((f) => f.isValid);
    return false;
  };

  // ─── Helpers ────────────────────────────────────────────────────────

  const validCount = parsedFields.filter((f) => f.isValid).length;
  const invalidCount = parsedFields.filter((f) => !f.isValid).length;

  // A field bills on the FILE's acreage only when it is present AND within the 0.1–5000 band —
  // exactly what handleUpload enforces. Otherwise it bills on the measured map acres. The review
  // shows this real basis so the owner never approves one basis and gets another after import.
  const billsOnFileAcres = (f: ParsedImportField) => f.stated_acres != null && isAcreInBand(f.stated_acres);

  // Fields that WILL bill on the file acreage but differ from the MAP measure by >= the threshold
  // (over OR under) — flagged so the owner can eyeball "something's off" before importing
  // (e.g. an applicator sprayed part of one field under another field's name).
  const flaggedFields = parsedFields.filter(
    (f) => f.isValid && billsOnFileAcres(f) && isAcreDivergent(f.stated_acres, f.full_acres),
  );

  // Fields whose file acreage is OUT OF the 0.1–5000 band → they bill on the measured map acres
  // instead. Surfaced at review so the displayed basis matches what actually imports.
  const outOfBandFields = parsedFields.filter(
    (f) => f.isValid && f.stated_acres != null && !isAcreInBand(f.stated_acres),
  );

  const sampleProperties = parseResult?.featureCollection.features[0]?.properties || null;

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeDisabled={uploading}
      title="Import"
      accent="Fields"
      maxWidth="max-w-5xl"
    >
      <div className="space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-1">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex-1">
              <div
                className={`h-1.5 rounded-full transition-colors ${
                  step > i + 1
                    ? 'bg-crx-green'
                    : step === i + 1
                    ? 'bg-crx-green'
                    : 'bg-gray-200'
                }`}
              />
              <p
                className={`text-xs mt-1 text-center ${
                  step === i + 1 ? 'text-crx-green font-medium' : 'text-secondary'
                }`}
              >
                {label}
              </p>
            </div>
          ))}
        </div>

        {/* ─── Step 1: Upload ─── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
              <h4 className="text-sm font-medium text-nav-dark mb-2">How to Import Fields</h4>
              <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
                <li>Export field boundaries from ChemMan, FieldView, or AgFiniti</li>
                <li>Easiest: a single <strong>.zip</strong> shapefile (John Deere Operations Center / Climate FieldView export)</li>
                <li>Or loose shapefile parts: select ALL files (.shp, .dbf, .shx, .prj) at once</li>
                <li>For GeoJSON or KML: select the single file</li>
                <li>Preview on map, map columns, assign customer, and import</li>
              </ol>
              <div className="mt-3 p-2 bg-white rounded border border-gray-200">
                <p className="text-xs font-medium text-secondary mb-1">Supported Formats:</p>
                <p className="text-xs text-gray-500">
                  Shapefile (.shp + .dbf + .prj), GeoJSON (.geojson / .json), KML (.kml)
                </p>
              </div>
            </div>

            {/* Drag and drop zone */}
            <div
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-crx-green hover:bg-crx-green-tint transition-colors cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={() => document.getElementById('field-import-input')?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('field-import-input')?.click(); } }}
            >
              <Upload className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-nav-dark">
                Drop files here or click to browse
              </p>
              <p className="text-xs text-secondary mt-1">
                .zip, .shp, .dbf, .prj, .geojson, .json, .kml — Max 25MB
              </p>
              <input
                id="field-import-input"
                type="file"
                multiple
                accept=".zip,.shp,.dbf,.shx,.prj,.geojson,.json,.kml"
                onChange={handleInputChange}
                className="hidden"
              />
            </div>

            {/* Selected files list */}
            {files.length > 0 && (
              <div className="space-y-1">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-secondary">
                    <FileText className="w-4 h-4 shrink-0" />
                    <span>{f.name}</span>
                    <span className="text-gray-400">({(f.size / 1024).toFixed(1)} KB)</span>
                  </div>
                ))}
                {fileType === 'shapefile' && !files.some((f) => f.name.toLowerCase().endsWith('.prj')) && (
                  <div className="flex items-center gap-2 text-xs text-amber-600">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>No .prj file — coordinates will be assumed as WGS84</span>
                  </div>
                )}
              </div>
            )}

            {parseError && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{parseError}</p>
              </div>
            )}
          </div>
        )}

        {/* ─── Step 2: Map Preview ─── */}
        {step === 2 && parseResult && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-lg">
                <MapPin className="w-4 h-4" />
                <span className="font-medium">{parseResult.featureCount} field boundaries found</span>
              </div>
              {parseResult.crsDetected && (
                <span className="text-secondary text-xs">
                  Coordinate system: {parseResult.crsDetected}
                </span>
              )}
            </div>

            <ImportPreviewMap featureCollection={parseResult.featureCollection} />

            {parseResult.warnings.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-amber-700 mb-1">Warnings:</p>
                {parseResult.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-600">{w}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── Step 3: Attribute Mapping ─── */}
        {step === 3 && parseResult && (
          <AttributeMappingStep
            attributeKeys={parseResult.attributeKeys}
            mapping={columnMapping}
            onMappingChange={setColumnMapping}
            sampleProperties={sampleProperties}
          />
        )}

        {/* ─── Step 4: Customer Assignment ─── */}
        {step === 4 && (
          <FieldCustomerAssignment
            fields={assignableFields}
            customers={customers}
            assignments={fieldCustomerAssignments}
            fallbackCustomerId={selectedCustomerId}
            onAssign={handleAssignField}
            onApplyToAll={handleApplyToAll}
          />
        )}

        {/* ─── Step 5: Review ─── */}
        {step === 5 && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-secondary">Valid Fields</span>
                </div>
                <p className="text-2xl font-semibold text-green-600">{validCount}</p>
                <p className="text-xs text-secondary mt-1">Ready to import</p>
              </div>
              <div className="p-4 bg-red-50 border border-red-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                  <span className="text-sm font-medium text-secondary">Invalid Fields</span>
                </div>
                <p className="text-2xl font-semibold text-red-600">{invalidCount}</p>
                <p className="text-xs text-secondary mt-1">Will be skipped</p>
              </div>
            </div>

            {/* Fields to review — the file's acreage differs materially from the map measurement
                (over OR under). They still import on the file's number; this just flags them. */}
            {flaggedFields.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg max-h-40 overflow-y-auto">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <p className="text-xs font-medium text-amber-700">
                    {flaggedFields.length} field{flaggedFields.length > 1 ? 's' : ''} to review — the file's acreage differs from the map by {ACRE_DIVERGENCE_THRESHOLD_PCT}% or more
                  </p>
                </div>
                <div className="space-y-1">
                  {flaggedFields.map((pf) => {
                    const pct = acreDivergencePct(pf.stated_acres, pf.full_acres);
                    const dir = (pf.stated_acres ?? 0) > pf.full_acres ? 'over' : 'under';
                    return (
                      <p key={pf.index} className="text-xs text-amber-700">
                        <span className="font-medium">{pf.field_name}</span>: bills {pf.stated_acres} ac (file) vs {pf.full_acres} ac (map) — {pct != null ? Math.round(pct) : 0}% {dir}
                      </p>
                    );
                  })}
                </div>
                <p className="text-xs text-amber-600 mt-1.5">These still import on the file's acreage; open a field afterward to adjust if it looks wrong.</p>
              </div>
            )}

            {/* File acreage out of the 0.1–5000 band → bills on the measured map acres instead.
                Shown so the review basis matches what actually imports (Codex P2). */}
            {outOfBandFields.length > 0 && (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg max-h-40 overflow-y-auto">
                <p className="text-xs font-medium text-blue-700 mb-1">
                  {outOfBandFields.length} field{outOfBandFields.length > 1 ? 's' : ''} will bill on the map measurement — the file's acreage is outside {ACRE_BAND_MIN}–{ACRE_BAND_MAX} ac
                </p>
                <div className="space-y-1">
                  {outOfBandFields.map((pf) => (
                    <p key={pf.index} className="text-xs text-blue-700">
                      <span className="font-medium">{pf.field_name}</span>: file says {pf.stated_acres} ac → bills the measured {pf.full_acres} ac
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Preview of valid fields */}
            {validCount > 0 && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-2">Preview (first 5):</p>
                <div className="space-y-2">
                  {parsedFields.filter((f) => f.isValid).slice(0, 5).map((pf) => {
                    const onFile = billsOnFileAcres(pf);
                    const outOfBand = pf.stated_acres != null && !isAcreInBand(pf.stated_acres);
                    const divergent = onFile && isAcreDivergent(pf.stated_acres, pf.full_acres);
                    return (
                      <div key={pf.index} className="text-xs bg-white p-2 rounded border border-gray-100">
                        <p className="font-medium text-nav-dark">{pf.field_name}</p>
                        <p className="text-gray-500">
                          {onFile ? (
                            <>Bills <span className="font-medium">{pf.stated_acres} ac</span> (file) · map measures {pf.full_acres} ac</>
                          ) : outOfBand ? (
                            <>Bills <span className="font-medium">{pf.full_acres} ac</span> (map) · file's {pf.stated_acres} ac is out of range</>
                          ) : (
                            <>
                              {/* no file acreage → bills the measured acres set_field_boundary computes */}
                              Bills <span className="font-medium">{pf.full_acres} ac</span> (map measured)
                              {pf.full_acres !== pf.calculated_acres && ` — multi-part, ${pf.calculated_acres} ac in the largest piece`}
                            </>
                          )}
                          {pf.county && ` • ${pf.county}`}
                          {pf.crop_type && ` • ${pf.crop_type}`}
                        </p>
                        {divergent && (
                          <p className="text-amber-600 mt-0.5">
                            ⚠ {Math.round(acreDivergencePct(pf.stated_acres, pf.full_acres) ?? 0)}% {(pf.stated_acres ?? 0) > pf.full_acres ? 'over' : 'under'} the map measurement
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {validCount > 5 && (
                    <p className="text-xs text-secondary text-center pt-1">
                      + {validCount - 5} more fields
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Invalid fields list */}
            {invalidCount > 0 && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">Invalid Fields:</p>
                <div className="space-y-1">
                  {parsedFields.filter((f) => !f.isValid).map((pf) => (
                    <p key={pf.index} className="text-xs text-secondary">
                      Field {pf.index} ({pf.field_name}): {pf.errors.join(', ')}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Small preview map */}
            {parseResult && validCount > 0 && (
              <ImportPreviewMap
                featureCollection={parseResult.featureCollection}
                className="h-[200px] w-full rounded-lg overflow-hidden"
              />
            )}
          </div>
        )}

        {/* ─── Step 6: Uploading ─── */}
        {step === 6 && (
          <div className="space-y-4 py-8">
            <div className="text-center">
              <Upload className="w-12 h-12 text-crx-green mx-auto mb-3 animate-pulse" />
              <p className="text-sm font-medium text-nav-dark">
                Importing field {uploadProgress.current} of {uploadProgress.total}...
              </p>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-crx-green h-2 rounded-full transition-all duration-300"
                style={{
                  width: uploadProgress.total > 0
                    ? `${(uploadProgress.current / uploadProgress.total) * 100}%`
                    : '0%',
                }}
              />
            </div>
          </div>
        )}

        {/* ─── Step 7: Results ─── */}
        {step === 7 && results && (
          <div className="space-y-3">
            <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center">
              <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
              <h4 className="text-sm font-medium text-nav-dark mb-1">Import Complete</h4>
              <p className="text-xs text-secondary">
                Successfully imported {results.success} field(s)
                {results.failed > 0 && `, ${results.failed} failed`}
              </p>
            </div>

            {results.errors.length > 0 && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">Errors:</p>
                {results.errors.map((err, i) => (
                  <p key={i} className="text-xs text-secondary">{err}</p>
                ))}
              </div>
            )}

            {results.warnings.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-amber-700 mb-1">Imported, with notes:</p>
                {results.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-600">{w}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── Navigation buttons ─── */}
        <div className="flex justify-between pt-2">
          <div>
            {step > 1 && step < 6 && (
              <Button variant="secondary" onClick={handleBack}>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleClose} disabled={uploading}>
              {step === 7 ? 'Close' : 'Cancel'}
            </Button>
            {step < 6 && (
              <Button
                onClick={handleNext}
                disabled={!canAdvance()}
                loading={parsing || uploading}
                icon={step === 1 ? <Upload className="w-4 h-4" /> : step === 5 ? <CheckCircle className="w-4 h-4" /> : undefined}
              >
                {step === 1
                  ? 'Parse Files'
                  : step === 5
                  ? `Import ${validCount} Field(s)`
                  : 'Next'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
