/**
 * Loader-vessel picker helpers. The selected vessel is deliberately UI-only: the
 * job continues to persist just its numeric loader_tank_capacity override.
 */

import { isGallonCapacityUnit } from './loaderWorksheet';

export const ASSIGNED_VEHICLE_VESSEL_VALUE = '__assigned_vehicle__';

export interface LoaderVessel {
  id: string;
  vehicle_name: string;
  status: string;
  capacity_gallons: number | null;
  capacity_unit?: string | null;
  category: string | null;
}

export interface LoaderVesselOption {
  value: string;
  label: string;
  capacity_gallons: number | null;
}

/**
 * Build the picker options with the assigned-vehicle fallback first, followed by
 * active fleet vessels with a recorded gallon capacity. A zero capacity is
 * retained here because it is still a recorded fleet value; the existing worksheet
 * guard will correctly require a positive capacity before calculating loads.
 */
export function buildLoaderVesselOptions(vehicles: readonly LoaderVessel[]): LoaderVesselOption[] {
  const options: LoaderVesselOption[] = [{
    value: ASSIGNED_VEHICLE_VESSEL_VALUE,
    label: 'Assigned vehicle (default)',
    capacity_gallons: null,
  }];

  for (const vehicle of vehicles) {
    if (
      vehicle.status !== 'active'
      || vehicle.capacity_gallons == null
      || !isGallonCapacityUnit(vehicle.capacity_unit)
    ) continue;

    options.push({
      value: vehicle.id,
      label: `${vehicle.vehicle_name} \u2014 ${vehicle.capacity_gallons} gal${vehicle.category ? ` \u00b7 ${vehicle.category}` : ''}`,
      capacity_gallons: vehicle.capacity_gallons,
    });
  }

  return options;
}

/**
 * Return the form value to apply for a picker choice. Selecting the assigned
 * vehicle clears the override, restoring the existing assigned-vehicle fallback.
 */
export function capacityForLoaderVesselSelection(
  value: string,
  options: readonly LoaderVesselOption[],
): string {
  if (value === ASSIGNED_VEHICLE_VESSEL_VALUE) return '';

  const selected = options.find((option) => option.value === value);
  return selected?.capacity_gallons != null ? String(selected.capacity_gallons) : '';
}
