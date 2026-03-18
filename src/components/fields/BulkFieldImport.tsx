import { useState, useEffect } from 'react';
import {
  Upload,
  CheckCircle,
  AlertCircle,
  FileText,
  MapPin,
  Search,
  AlertTriangle,
} from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult } from '../../lib/db';
import {
  parseShapefileBundle,
  parseGeoJSONFile,
  parseKMLFile,
  calculateFieldMetrics,
  validateFeatureGeometry,
  type ParseResult,
} from '../../lib/fieldImportParser';
import ImportPreviewMap from './ImportPreviewMap';
import AttributeMappingStep from './AttributeMappingStep';
import type { Customer, ParsedImportField } from '../../types';


interface BulkFieldImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type FileType = 'shapefile' | 'geojson' | 'kml' | null;

const STEP_LABELS = [
  'Upload',
  'Preview',
  'Map Columns',
  'Customer',
  'Review',
  'Importing',
  'Done',
];

const ACCEPTED_EXTENSIONS = ['.shp', '.dbf', '.shx', '.prj', '.geojson', '.json', '.kml'];
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

export default function BulkFieldImport({ open, onClose, onSuccess }: BulkFieldImportProps) {
  const { toast } = useToast();
  const { profile } = useAuth();

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

  // Step 4: Customer assignment
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedCustomerName, setSelectedCustomerName] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);

  // Step 5: Validated fields
  const [parsedFields, setParsedFields] = useState<ParsedImportField[]>([]);

  // Step 6: Upload progress
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  // Step 7: Results
  const [results, setResults] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

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
    // Reset all state
    setStep(1);
    setFiles([]);
    setFileType(null);
    setParseResult(null);
    setParsing(false);
    setParseError(null);
    setColumnMapping({});
    setSelectedCustomerId('');
    setSelectedCustomerName('');
    setCustomerSearch('');
    setShowCustomerDropdown(false);
    setParsedFields([]);
    setUploading(false);
    setUploadProgress({ current: 0, total: 0 });
    setResults(null);
    onClose();
  };

  // ─── Step 1: File Upload ────────────────────────────────────────────

  const detectFileType = (fileList: File[]): FileType => {
    const names = fileList.map((f) => f.name.toLowerCase());
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
      toast('error', `Unsupported file type: ${invalidFiles[0].name}. Accepted: .shp, .dbf, .prj, .geojson, .json, .kml`);
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
      toast('error', 'Could not detect file type. Please upload .shp, .geojson, or .kml files.');
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

      // Geometry validation
      const geoErrors = validateFeatureGeometry(feature);
      errors.push(...geoErrors);

      // Calculate metrics
      let acres = 0;
      let centroid = { type: 'Point' as const, coordinates: [0, 0] as [number, number] };
      if (geoErrors.length === 0) {
        const metrics = calculateFieldMetrics(feature);
        acres = metrics.acres;
        centroid = metrics.centroid;
      }

      // Map attributes
      const getValue = (crxField: string): string | null => {
        const attrKey = columnMapping[crxField];
        if (!attrKey || props[attrKey] == null) return null;
        return String(props[attrKey]).trim() || null;
      };

      const fieldName = getValue('field_name') || `Imported Field ${i + 1}`;
      const customerId = selectedCustomerId || null;

      if (!customerId) {
        errors.push('No customer assigned');
      }

      const parsedAcres = getValue('total_acres');
      const acresFromAttr = parsedAcres ? parseFloat(parsedAcres) : null;

      fields.push({
        index: i + 1,
        field_name: fieldName,
        customer_id: customerId,
        legal_description: getValue('legal_description'),
        county: getValue('county'),
        state: getValue('state') || 'IL',
        total_acres: (acresFromAttr && acresFromAttr > 0) ? acresFromAttr : acres,
        crop_type: getValue('crop_type'),
        fsa_farm_number: getValue('fsa_farm_number'),
        fsa_tract_number: getValue('fsa_tract_number'),
        fsa_field_number: getValue('fsa_field_number'),
        soil_type: getValue('soil_type'),
        irrigation: false,
        notes: getValue('notes'),
        boundary_geojson: feature.geometry,
        centroid_geojson: centroid,
        calculated_acres: acres,
        raw_properties: props as Record<string, unknown>,
        errors,
        isValid: errors.length === 0,
      });
    }

    setParsedFields(fields);
  };

  // ─── Step 6: Upload ─────────────────────────────────────────────────

  const handleUpload = async () => {
    const validFields = parsedFields.filter((f) => f.isValid);
    if (validFields.length === 0) return;

    setUploading(true);
    setUploadProgress({ current: 0, total: validFields.length });

    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const pf of validFields) {
      try {
        const fieldPayload = {
          customer_id: pf.customer_id,
          field_name: pf.field_name,
          legal_description: pf.legal_description,
          county: pf.county,
          state: pf.state || 'IL',
          total_acres: pf.total_acres,
          fsa_farm_number: pf.fsa_farm_number,
          fsa_tract_number: pf.fsa_tract_number,
          fsa_field_number: pf.fsa_field_number,
          crop_type: pf.crop_type,
          soil_type: pf.soil_type,
          irrigation: pf.irrigation,
          notes: pf.notes,
          is_active: true,
        };

        const { data: fieldId, error: saveError } = await supabase.rpc('save_field', {
          p_field_id: null,
          p_field_payload: fieldPayload,
          p_billing_defaults: [],
          p_performed_by: profile!.id,
          p_idempotency_key: crypto.randomUUID(),
        });

        if (saveError) {
          failed++;
          errors.push(`"${pf.field_name}": ${saveError.message}`);
        } else if (assertRpcResult(fieldId, 'save_field')) {
          // Save geometry
          const { error: geoError } = await supabase.rpc('save_field_geometry', {
            p_field_id: fieldId,
            p_centroid_geojson: JSON.stringify(pf.centroid_geojson),
            p_boundary_geojson: JSON.stringify(pf.boundary_geojson),
            p_idempotency_key: crypto.randomUUID(),
          });

          if (geoError) {
            // Field was created but geometry failed — count as partial success
            errors.push(`"${pf.field_name}": Field created but boundary save failed — ${geoError.message}`);
          }
          success++;
        }
      } catch (err: unknown) {
        failed++;
        errors.push(`"${pf.field_name}": ${err instanceof Error ? err.message : String(err)}`);
      }

      setUploadProgress((prev) => ({ ...prev, current: prev.current + 1 }));
    }

    setResults({ success, failed, errors });
    setStep(7);
    setUploading(false);

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
    if (step === 4) return !!selectedCustomerId;
    if (step === 5) return parsedFields.some((f) => f.isValid);
    return false;
  };

  // ─── Helpers ────────────────────────────────────────────────────────

  const filteredCustomers = customers.filter((c) =>
    c.farm_name.toLowerCase().includes(customerSearch.toLowerCase())
  );

  const validCount = parsedFields.filter((f) => f.isValid).length;
  const invalidCount = parsedFields.filter((f) => !f.isValid).length;

  const sampleProperties = parseResult?.featureCollection.features[0]?.properties || null;

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <Modal open={open} onClose={handleClose} title="Import" accent="Fields" maxWidth="max-w-5xl">
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
                <li>For shapefiles: select ALL files (.shp, .dbf, .shx, .prj) at once</li>
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
                .shp, .dbf, .prj, .geojson, .json, .kml — Max 25MB
              </p>
              <input
                id="field-import-input"
                type="file"
                multiple
                accept=".shp,.dbf,.shx,.prj,.geojson,.json,.kml"
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
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Choose which customer (grower/farm) these fields belong to.
            </p>

            <div className="relative">
              <label className="block text-sm font-medium text-secondary mb-1">
                Customer <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={showCustomerDropdown ? customerSearch : selectedCustomerName}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value);
                    setShowCustomerDropdown(true);
                  }}
                  onFocus={() => {
                    setCustomerSearch('');
                    setShowCustomerDropdown(true);
                  }}
                  onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 200)}
                  placeholder="Search customers..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              {showCustomerDropdown && (
                <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredCustomers.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-secondary">No customers found</div>
                  ) : (
                    filteredCustomers.slice(0, 20).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSelectedCustomerId(c.id);
                          setSelectedCustomerName(c.farm_name);
                          setShowCustomerDropdown(false);
                        }}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-crx-green-tint transition-colors"
                      >
                        {c.farm_name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {selectedCustomerName && (
              <div className="p-3 bg-green-50 border border-green-100 rounded-lg flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="text-sm text-green-700">
                  All {parseResult?.featureCount} fields will be assigned to <strong>{selectedCustomerName}</strong>
                </span>
              </div>
            )}
          </div>
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

            {/* Preview of valid fields */}
            {validCount > 0 && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-2">Preview (first 5):</p>
                <div className="space-y-2">
                  {parsedFields.filter((f) => f.isValid).slice(0, 5).map((pf) => (
                    <div key={pf.index} className="text-xs bg-white p-2 rounded border border-gray-100">
                      <p className="font-medium text-nav-dark">{pf.field_name}</p>
                      <p className="text-gray-500">
                        {pf.calculated_acres} acres
                        {pf.county && ` • ${pf.county}`}
                        {pf.crop_type && ` • ${pf.crop_type}`}
                      </p>
                    </div>
                  ))}
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
            <Button variant="secondary" onClick={handleClose}>
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
