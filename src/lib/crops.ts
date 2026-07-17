// Allowed values for customers.crops (text[]) — kept in lockstep with the
// CHECK constraint added by the companion migration on feat/crm-crops-and-volume.
// If that constraint's allowed list ever changes, update both places together.
export type CropValue =
  | 'corn'
  | 'soybeans'
  | 'wheat'
  | 'milo'
  | 'cotton'
  | 'alfalfa'
  | 'pasture_hay'
  | 'other';

export const ALLOWED_CROPS: ReadonlyArray<{ value: CropValue; label: string }> = [
  { value: 'corn', label: 'Corn' },
  { value: 'soybeans', label: 'Soybeans' },
  { value: 'wheat', label: 'Wheat' },
  { value: 'milo', label: 'Milo' },
  { value: 'cotton', label: 'Cotton' },
  { value: 'alfalfa', label: 'Alfalfa' },
  { value: 'pasture_hay', label: 'Pasture/Hay' },
  { value: 'other', label: 'Other' },
];
