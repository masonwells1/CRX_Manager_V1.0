import type { ChangeEvent } from 'react';
import type { LoaderWorksheet } from '../../lib/loaderWorksheet';
import type { LoaderVesselOption } from '../../lib/loaderVesselOptions';

interface LegacyLoaderWorksheetProps {
  carrierRateGpa: string;
  onCarrierRateChange: (value: string) => void;
  loaderVesselId: string;
  loaderVesselOptions: LoaderVesselOption[];
  onVesselChange: (value: string) => void;
  tankCapacity: string;
  onTankCapacityChange: (value: string) => void;
  assignedVehicleCapacity: number | null;
  assignedVehicleName: string | null;
  assignedVehicleCapacityUnit: string | null;
  loaderWorksheet: LoaderWorksheet;
  loaderComment: string;
  onLoaderCommentChange: (value: string) => void;
  canEdit: boolean;
}

/** The original single-form loader worksheet, retained for new jobs and legacy jobs. */
export function LegacyLoaderWorksheet({
  carrierRateGpa,
  onCarrierRateChange,
  loaderVesselId,
  loaderVesselOptions,
  onVesselChange,
  tankCapacity,
  onTankCapacityChange,
  assignedVehicleCapacity,
  assignedVehicleName,
  assignedVehicleCapacityUnit,
  loaderWorksheet,
  loaderComment,
  onLoaderCommentChange,
  canEdit,
}: LegacyLoaderWorksheetProps): JSX.Element {
  const inputValue = (event: ChangeEvent<HTMLInputElement>): string => event.target.value;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-nav-dark mb-1">Carrier Rate (gal/acre)</label>
          <input
            type="number"
            value={carrierRateGpa}
            onChange={(event) => onCarrierRateChange(inputValue(event))}
            disabled={!canEdit}
            step="0.1"
            min="0"
            placeholder="e.g. 15"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
          />
          <p className="mt-1 text-xs text-secondary">Spray volume = total acres × carrier rate.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-nav-dark mb-1">Vessel being loaded</label>
          <select
            value={loaderVesselId}
            onChange={(event) => onVesselChange(event.target.value)}
            disabled={!canEdit}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
          >
            {loaderVesselOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <label className="block text-sm font-medium text-nav-dark mt-3 mb-1">Tank Capacity (gal)</label>
          <input
            type="number"
            value={tankCapacity}
            onChange={(event) => onTankCapacityChange(inputValue(event))}
            disabled={!canEdit}
            step="1"
            min="0"
            placeholder={assignedVehicleCapacity ? `Vehicle: ${assignedVehicleCapacity}` : 'Enter capacity'}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
          />
          <p className="mt-1 text-xs text-secondary">
            {tankCapacity.trim() !== ''
              ? 'Per-job override.'
              : assignedVehicleCapacity
                ? `Using the ${assignedVehicleName || 'vehicle'} capacity (${assignedVehicleCapacity} ${assignedVehicleCapacityUnit || 'gal'}).`
                : 'No vehicle capacity — enter one to plan loads.'}
          </p>
        </div>
      </div>

      {loaderWorksheet.valid ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-2xl font-bold text-nav-dark">{loaderWorksheet.spray_volume.toLocaleString()}</p>
              <p className="text-xs text-secondary">Spray Volume (gal)</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-2xl font-bold text-nav-dark">{loaderWorksheet.tank_capacity.toLocaleString()}</p>
              <p className="text-xs text-secondary">Tank Capacity (gal)</p>
            </div>
            <div className="bg-crx-green-tint rounded-lg p-3">
              <p className="text-2xl font-bold text-crx-green">{loaderWorksheet.loads_count}</p>
              <p className="text-xs text-secondary">Loads Needed</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-2xl font-bold text-nav-dark">
                {loaderWorksheet.partial_load_volume > 0 ? `${loaderWorksheet.partial_load_volume.toLocaleString()}` : 'None'}
              </p>
              <p className="text-xs text-secondary">Partial Last Load (gal)</p>
            </div>
          </div>

          {loaderWorksheet.loads[0]?.products.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 px-2 font-medium text-secondary">Product</th>
                    {loaderWorksheet.loads.map((load) => (
                      <th key={load.load_number} className="text-right py-2 px-2 font-medium text-secondary whitespace-nowrap">
                        Load {load.load_number}
                        <span className="block text-[10px] font-normal">
                          {load.volume.toLocaleString()} gal{load.is_partial ? ' (partial)' : ''}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loaderWorksheet.loads[0].products.map((product, productIndex) => (
                    <tr key={productIndex} className="border-b border-gray-100">
                      <td className="py-1.5 px-2 text-nav-dark">{product.product_name}{product.unit ? ` (${product.unit})` : ''}</td>
                      {loaderWorksheet.loads.map((load) => (
                        <td key={load.load_number} className="text-right py-1.5 px-2 text-nav-dark">
                          {load.products[productIndex]?.amount.toLocaleString() ?? '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
          <p className="text-sm font-medium text-amber-800">Loads cannot be calculated</p>
          <p className="text-xs text-amber-700 mt-0.5">{loaderWorksheet.invalid_reason}</p>
        </div>
      )}

      <div className="mt-4">
        <label className="block text-sm font-medium text-nav-dark mb-1">Loader Comment</label>
        <textarea
          value={loaderComment}
          onChange={(event) => onLoaderCommentChange(event.target.value)}
          rows={2}
          disabled={!canEdit}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none disabled:bg-gray-50"
          placeholder="Instructions for the loader (mix order, etc.)..."
        />
      </div>
    </>
  );
}
