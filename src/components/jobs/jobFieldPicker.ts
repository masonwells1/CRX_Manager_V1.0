import { billableAcres } from '../../lib/fieldGeometry';

/** Keep Mapbox work bounded even when a crop search matches the whole database. */
export const JOB_FIELD_PICKER_MAP_LIMIT = 300;

export interface JobFieldPickerField {
  id: string;
  customer_id: string;
  customer_name: string | null;
  field_name: string;
  county: string | null;
  crop_type: string | null;
  total_acres: number | null;
  measured_acres?: number | null;
  override_acres?: number | null;
  billable_acres?: number | null;
  is_active: boolean;
  centroid_geojson: string | null;
  boundary_geojson: string | null;
}

export interface JobFieldPickerFilters {
  customerId: string;
  crop: string;
  fieldName: string;
  county: string;
}

export interface JobFieldPickerSelection {
  field_id: string;
  field_name: string;
  customer_id: string;
  customer_name: string | null;
  crop: string | null;
  billable_acres: number | null;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Uses the same billable-acre precedence as fields and invoices. */
export function pickerBillableAcres(field: JobFieldPickerField): number | null {
  return field.billable_acres
    ?? billableAcres(field.override_acres, field.measured_acres, field.total_acres);
}

/** Pure, client-side filter for the one all-fields GeoJSON load. */
export function filterJobPickerFields(
  fields: readonly JobFieldPickerField[],
  filters: JobFieldPickerFilters,
): JobFieldPickerField[] {
  const fieldName = normalized(filters.fieldName);
  const county = normalized(filters.county);

  return fields.filter((field) => {
    if (!field.is_active) return false;
    if (filters.customerId && field.customer_id !== filters.customerId) return false;
    if (filters.crop && field.crop_type !== filters.crop) return false;
    if (fieldName && !normalized(field.field_name).includes(fieldName)) return false;
    if (county && !normalized(field.county ?? '').includes(county)) return false;
    return true;
  });
}

/** Selection intentionally does not depend on the active filter. */
export function toggleJobPickerSelection(
  selectedIds: ReadonlySet<string>,
  fieldId: string,
  alreadyOnJobIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selectedIds);
  if (alreadyOnJobIds.has(fieldId)) return next;
  if (next.has(fieldId)) next.delete(fieldId);
  else next.add(fieldId);
  return next;
}

export function selectedJobPickerFields(
  fields: readonly JobFieldPickerField[],
  selectedIds: ReadonlySet<string>,
): JobFieldPickerField[] {
  return fields.filter((field) => selectedIds.has(field.id));
}

export function selectedJobPickerAcres(
  fields: readonly JobFieldPickerField[],
  selectedIds: ReadonlySet<string>,
): number {
  return selectedJobPickerFields(fields, selectedIds)
    .reduce((total, field) => total + (pickerBillableAcres(field) ?? 0), 0);
}

export function mapFieldsForJobPicker(
  fields: readonly JobFieldPickerField[],
  limit = JOB_FIELD_PICKER_MAP_LIMIT,
  center?: readonly [number, number],
): JobFieldPickerField[] {
  if (!center) return fields.slice(0, limit);
  const distanceFromCenter = (field: JobFieldPickerField): number => {
    if (!field.centroid_geojson) return Number.POSITIVE_INFINITY;
    try {
      const parsed: unknown = JSON.parse(field.centroid_geojson);
      if (!parsed || typeof parsed !== 'object') return Number.POSITIVE_INFINITY;
      const coordinates = (parsed as { coordinates?: unknown }).coordinates;
      if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') {
        return Number.POSITIVE_INFINITY;
      }
      // Squared degrees are sufficient for ordering a capped map result and avoid needless
      // trigonometry over every field while the map is being moved.
      return (coordinates[0] - center[0]) ** 2 + (coordinates[1] - center[1]) ** 2;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  return [...fields].sort((left, right) => distanceFromCenter(left) - distanceFromCenter(right)).slice(0, limit);
}

export function toJobFieldPickerSelection(field: JobFieldPickerField): JobFieldPickerSelection {
  return {
    field_id: field.id,
    field_name: field.field_name,
    customer_id: field.customer_id,
    customer_name: field.customer_name,
    crop: field.crop_type,
    billable_acres: pickerBillableAcres(field),
  };
}
