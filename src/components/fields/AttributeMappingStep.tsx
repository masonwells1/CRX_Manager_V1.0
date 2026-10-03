import { useEffect } from 'react';

const CRX_FIELDS = [
  { key: 'field_name', label: 'Field Name', recommended: true },
  { key: 'county', label: 'County', recommended: false },
  { key: 'state', label: 'State', recommended: false },
  { key: 'total_acres', label: 'Acres', recommended: false },
  { key: 'crop_type', label: 'Crop Type', recommended: false },
  { key: 'legal_description', label: 'Legal Description', recommended: false },
  { key: 'fsa_farm_number', label: 'FSA Farm #', recommended: false },
  { key: 'fsa_tract_number', label: 'FSA Tract #', recommended: false },
  { key: 'fsa_field_number', label: 'FSA Field #', recommended: false },
  { key: 'soil_type', label: 'Soil Type', recommended: false },
  { key: 'notes', label: 'Notes', recommended: false },
] as const;

const FUZZY_ALIASES: Record<string, string[]> = {
  field_name: ['field_name', 'fieldname', 'name', 'field', 'fld_name', 'fldname', 'label', 'description', 'field_id', 'fld'],
  county: ['county', 'cnty', 'co', 'county_name'],
  state: ['state', 'st', 'state_name', 'state_abbr'],
  total_acres: ['acres', 'total_acres', 'area', 'acreage', 'ac', 'gis_acres', 'calc_acres', 'shape_area'],
  crop_type: ['crop', 'crop_type', 'croptype', 'land_use', 'landuse', 'crop_name'],
  legal_description: ['legal', 'legal_desc', 'legal_description', 'plss', 'section', 'legal_desc_1'],
  fsa_farm_number: ['farm_num', 'farm_number', 'fsa_farm', 'farm_no', 'farm#', 'farm'],
  fsa_tract_number: ['tract', 'tract_num', 'tract_number', 'fsa_tract', 'tract_no'],
  fsa_field_number: ['field_num', 'field_number', 'fsa_field', 'fld_num', 'fld_no', 'field_no'],
  soil_type: ['soil', 'soil_type', 'soiltype', 'soil_name'],
  notes: ['notes', 'comments', 'memo', 'remark', 'remarks', 'comment'],
};

function autoDetectMapping(attributeKeys: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const usedKeys = new Set<string>();

  for (const [crxField, aliases] of Object.entries(FUZZY_ALIASES)) {
    for (const attrKey of attributeKeys) {
      if (usedKeys.has(attrKey)) continue;
      const normalized = attrKey.toLowerCase().trim().replace(/\s+/g, '_');
      if (aliases.includes(normalized)) {
        mapping[crxField] = attrKey;
        usedKeys.add(attrKey);
        break;
      }
    }
  }

  return mapping;
}

interface AttributeMappingStepProps {
  attributeKeys: string[];
  mapping: Record<string, string>;
  onMappingChange: (mapping: Record<string, string>) => void;
  sampleProperties: Record<string, unknown> | null;
}

export default function AttributeMappingStep({
  attributeKeys,
  mapping,
  onMappingChange,
  sampleProperties,
}: AttributeMappingStepProps) {
  // Auto-detect on first render if mapping is empty
  useEffect(() => {
    if (Object.keys(mapping).length === 0 && attributeKeys.length > 0) {
      const detected = autoDetectMapping(attributeKeys);
      onMappingChange(detected);
    }
  }, [attributeKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (crxField: string, attrKey: string) => {
    const newMapping = { ...mapping };
    if (attrKey === '') {
      delete newMapping[crxField];
    } else {
      newMapping[crxField] = attrKey;
    }
    onMappingChange(newMapping);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-secondary">
        Map your file's columns to CRX fields. Auto-detected mappings are pre-selected.
        {!mapping.field_name && (
          <span className="text-amber-600 font-medium">
            {' '}If no field name column is mapped, fields will be named "Imported Field 1, 2, 3..."
          </span>
        )}
      </p>

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-3 py-2 font-medium text-secondary">CRX Field</th>
              <th className="text-left px-3 py-2 font-medium text-secondary">File Attribute</th>
              <th className="text-left px-3 py-2 font-medium text-secondary">Sample Value</th>
            </tr>
          </thead>
          <tbody>
            {CRX_FIELDS.map(({ key, label, recommended }) => {
              const selectedAttr = mapping[key] || '';
              const sampleValue = selectedAttr && sampleProperties
                ? String(sampleProperties[selectedAttr] ?? '—')
                : '—';

              return (
                <tr key={key} className="border-b border-gray-100 last:border-b-0">
                  <td className="px-3 py-2">
                    <span className="text-nav-dark">{label}</span>
                    {recommended && (
                      <span className="ml-1 text-xs text-amber-600">*</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={selectedAttr}
                      onChange={(e) => handleChange(key, e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green bg-white"
                    >
                      <option value="">(none)</option>
                      {attributeKeys.map((attr) => (
                        <option key={attr} value={attr}>
                          {attr}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-secondary text-xs truncate max-w-[200px]">
                    {sampleValue}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {attributeKeys.length > 0 && (
        <p className="text-xs text-secondary">
          Available attributes in your file: {attributeKeys.join(', ')}
        </p>
      )}
    </div>
  );
}
