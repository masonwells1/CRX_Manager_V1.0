import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, Edit3, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { checkMutationResult, supabaseUntyped } from '../../lib/db';
import {
  computeLoaderWorksheet,
  type LoaderLoadBalanceMode,
  type LoaderProductInput,
} from '../../lib/loaderWorksheet';
import {
  condensedLoaderLoadLabel,
  condenseLoaderLoads,
  hasValidPerLoadAcres,
  isLoaderWorksheetSelectionConflict,
  toggleLoaderLoadDone,
  validLoaderLoadDone,
  type LoaderWorksheetDisplayMode,
} from '../../lib/loaderWorksheets';
import {
  ASSIGNED_VEHICLE_VESSEL_VALUE,
  buildLoaderVesselOptions,
  capacityForLoaderVesselSelection,
} from '../../lib/loaderVesselOptions';
import type { JobLoaderWorksheet, Vehicle } from '../../types';

const MANUAL_VESSEL_VALUE = '__manual_vessel__';

interface LegacyWorksheetValues {
  vehicleId: string | null;
  capacityGal: number | null;
  carrierRateGpa: number | null;
  comment: string | null;
}

interface WorksheetDraft {
  id: string | null;
  vesselValue: string;
  capacityGal: string;
  carrierRateGpa: string;
  mode: LoaderLoadBalanceMode;
  comment: string;
}

interface LoaderWorksheetsPanelProps {
  jobId: string;
  vehicles: Vehicle[];
  jobVehicleId: string | null;
  totalAcres: number;
  products: LoaderProductInput[];
  defaultCarrierRateGpa: number | null;
  legacyWorksheet: LegacyWorksheetValues;
  legacyContent: ReactNode;
  canEdit: boolean;
  displayMode: LoaderWorksheetDisplayMode;
  onDisplayModeChange: (mode: LoaderWorksheetDisplayMode) => void;
}

function worksheetFromRow(row: unknown): JobLoaderWorksheet {
  return row as JobLoaderWorksheet;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCreatedDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function makeDraft(
  row: JobLoaderWorksheet | null,
  legacy: LegacyWorksheetValues,
  defaultCarrierRateGpa: number | null,
): WorksheetDraft {
  if (row) {
    return {
      id: row.id,
      vesselValue: row.vehicle_id ?? MANUAL_VESSEL_VALUE,
      capacityGal: String(row.capacity_gal),
      carrierRateGpa: row.carrier_rate_gpa == null ? '' : String(row.carrier_rate_gpa),
      mode: row.load_balance_mode,
      comment: row.comment ?? '',
    };
  }

  return {
    id: null,
    vesselValue: legacy.vehicleId ?? ASSIGNED_VEHICLE_VESSEL_VALUE,
    capacityGal: legacy.capacityGal == null ? '' : String(legacy.capacityGal),
    carrierRateGpa: (legacy.carrierRateGpa ?? defaultCarrierRateGpa) == null
      ? ''
      : String(legacy.carrierRateGpa ?? defaultCarrierRateGpa),
    mode: 'proportional',
    comment: legacy.comment ?? '',
  };
}

/**
 * Saved multi-scenario loader worksheet UI. The parent supplies the legacy form;
 * it is deliberately rendered only after a successful, empty saved-row read.
 */
export function LoaderWorksheetsPanel({
  jobId,
  vehicles,
  jobVehicleId,
  totalAcres,
  products,
  defaultCarrierRateGpa,
  legacyWorksheet,
  legacyContent,
  canEdit,
  displayMode,
  onDisplayModeChange,
}: LoaderWorksheetsPanelProps): JSX.Element {
  const { toast } = useToast();
  const [worksheets, setWorksheets] = useState<JobLoaderWorksheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<WorksheetDraft>(() => makeDraft(null, legacyWorksheet, defaultCarrierRateGpa));
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JobLoaderWorksheet | null>(null);
  const [perLoadAcres, setPerLoadAcres] = useState<string[]>([]);
  const [perLoadError, setPerLoadError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setReadError(false);
    try {
      const { data, error } = await supabaseUntyped
        .from('job_loader_worksheets')
        .select('id, job_id, vehicle_id, capacity_gal, carrier_rate_gpa, load_balance_mode, per_load_acres, loads_done, comment, is_selected, created_by, created_at, updated_at')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setWorksheets((data ?? []).map(worksheetFromRow));
    } catch (_error) {
      setWorksheets([]);
      setReadError(true);
      toast('error', 'Saved loader worksheets could not be loaded. The legacy worksheet is hidden so the printed plan is not misleading.');
    } finally {
      setLoading(false);
    }
  }, [jobId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const vehicleNameById = useMemo(
    () => new Map(vehicles.map((vehicle) => [vehicle.id, vehicle.vehicle_name])),
    [vehicles],
  );
  const vesselOptions = useMemo(() => {
    const options = buildLoaderVesselOptions(vehicles);
    const optionValues = new Set(options.map((option) => option.value));
    if (draft.vesselValue !== MANUAL_VESSEL_VALUE && !optionValues.has(draft.vesselValue)) {
      options.push({
        value: draft.vesselValue,
        label: `${vehicleNameById.get(draft.vesselValue) ?? 'Saved vehicle'} (not active)`,
        capacity_gallons: null,
      });
    }
    options.push({ value: MANUAL_VESSEL_VALUE, label: 'Manual capacity', capacity_gallons: null });
    return options;
  }, [draft.vesselValue, vehicleNameById, vehicles]);

  const draftCapacity = Number(draft.capacityGal);
  const draftRate = draft.carrierRateGpa.trim() === '' ? null : Number(draft.carrierRateGpa);
  const draftWorksheet = computeLoaderWorksheet({
    total_acres: totalAcres,
    carrier_rate_gpa: draftRate != null && Number.isFinite(draftRate) ? draftRate : null,
    tank_capacity: Number.isFinite(draftCapacity) ? draftCapacity : null,
    mode: draft.mode,
    products,
  });
  const selectedWorksheet = worksheets.find((worksheet) => worksheet.is_selected) ?? null;
  const selectedComputed = selectedWorksheet
    ? computeLoaderWorksheet({
      total_acres: totalAcres,
      carrier_rate_gpa: selectedWorksheet.carrier_rate_gpa,
      tank_capacity: selectedWorksheet.capacity_gal,
      mode: selectedWorksheet.load_balance_mode,
      perLoadAcresOverride: selectedWorksheet.per_load_acres ?? undefined,
      products,
    })
    : null;
  const selectedAutoAcres = selectedComputed?.valid
    ? selectedComputed.loads.map((load) => String(load.volume / selectedComputed.carrier_rate_gpa)).join('|')
    : '';
  const selectedWorksheetId = selectedWorksheet?.id ?? null;
  const selectedSavedAcres = selectedWorksheet?.per_load_acres?.join('|') ?? '';
  const selectedManualAcres = selectedWorksheet?.per_load_acres ?? null;
  const selectedWorksheetValid = selectedComputed?.valid ?? false;
  const selectedLoadsDone = selectedComputed
    ? validLoaderLoadDone(selectedWorksheet?.loads_done ?? [], selectedComputed.loads_count)
    : [];

  useEffect(() => {
    if (!selectedWorksheetId || !selectedWorksheetValid) {
      setPerLoadAcres([]);
      return;
    }
    setPerLoadAcres(
      selectedManualAcres?.map(String)
        ?? selectedAutoAcres.split('|'),
    );
    setPerLoadError('');
  }, [selectedAutoAcres, selectedManualAcres, selectedSavedAcres, selectedWorksheetId, selectedWorksheetValid]);

  useEffect(() => {
    if (!canEdit) {
      setEditorOpen(false);
      setDeleteTarget(null);
    }
  }, [canEdit]);

  const rejectReadOnlyMutation = (): boolean => {
    if (canEdit) return false;
    toast('error', 'You no longer have permission to edit loader worksheets.');
    return true;
  };

  const openNewEditor = () => {
    setDraft(makeDraft(null, legacyWorksheet, defaultCarrierRateGpa));
    setEditorOpen(true);
  };

  const openEditEditor = (worksheet: JobLoaderWorksheet) => {
    setDraft(makeDraft(worksheet, legacyWorksheet, defaultCarrierRateGpa));
    setEditorOpen(true);
  };

  const handleVesselChange = (vesselValue: string) => {
    const capacityFromOption = capacityForLoaderVesselSelection(vesselValue, vesselOptions);
    setDraft((current) => ({
      ...current,
      vesselValue,
      capacityGal: vesselValue === ASSIGNED_VEHICLE_VESSEL_VALUE
        ? (legacyWorksheet.capacityGal == null ? '' : String(legacyWorksheet.capacityGal))
        : capacityFromOption || current.capacityGal,
    }));
  };

  const saveWorksheet = async () => {
    if (rejectReadOnlyMutation()) return;
    const capacityGal = Number(draft.capacityGal);
    const carrierRateGpa = draft.carrierRateGpa.trim() === '' ? null : Number(draft.carrierRateGpa);
    if (!Number.isFinite(capacityGal) || capacityGal <= 0) {
      toast('error', 'Enter a tank capacity greater than zero.');
      return;
    }
    if (carrierRateGpa != null && (!Number.isFinite(carrierRateGpa) || carrierRateGpa < 0)) {
      toast('error', 'Carrier rate must be zero or more.');
      return;
    }

    const payload = {
      vehicle_id: draft.vesselValue === MANUAL_VESSEL_VALUE || draft.vesselValue === ASSIGNED_VEHICLE_VESSEL_VALUE
        ? (draft.vesselValue === ASSIGNED_VEHICLE_VESSEL_VALUE ? jobVehicleId : null)
        : draft.vesselValue,
      capacity_gal: capacityGal,
      carrier_rate_gpa: carrierRateGpa,
      load_balance_mode: draft.mode,
      comment: draft.comment.trim() || null,
    };

    const savedWorksheet = draft.id == null ? null : worksheets.find((worksheet) => worksheet.id === draft.id) ?? null;
    const layoutChanged = savedWorksheet !== null && (
      savedWorksheet.capacity_gal !== capacityGal
      || savedWorksheet.carrier_rate_gpa !== carrierRateGpa
      || savedWorksheet.load_balance_mode !== draft.mode
    );
    const updatePayload = layoutChanged && savedWorksheet.per_load_acres !== null
      ? { ...payload, per_load_acres: null }
      : payload;

    setSaving(true);
    try {
      if (draft.id) {
        const result = await supabaseUntyped
          .from('job_loader_worksheets')
          .update(updatePayload)
          .eq('id', draft.id)
          .eq('job_id', jobId)
          .select('id');
        checkMutationResult(result, 'Update loader worksheet');
        toast('success', layoutChanged && savedWorksheet?.per_load_acres !== null
          ? 'Manual load acres reset — layout changed'
          : 'Loader worksheet updated');
      } else {
        const result = await supabaseUntyped
          .from('job_loader_worksheets')
          .insert({ ...payload, job_id: jobId, per_load_acres: null, loads_done: [], is_selected: false })
          .select('id');
        checkMutationResult(result, 'Save loader worksheet');
        toast('success', 'Loader worksheet saved');
      }
      setEditorOpen(false);
      await refresh();
    } catch (_error) {
      toast('error', 'Could not save the loader worksheet. You may not have permission.');
    } finally {
      setSaving(false);
    }
  };

  const selectWorksheet = async (worksheet: JobLoaderWorksheet) => {
    if (rejectReadOnlyMutation()) return;
    if (worksheet.is_selected) return;
    setBusyId(worksheet.id);
    try {
      const hasOtherWorksheet = worksheets.some((item) => item.id !== worksheet.id);
      const clearResult = await supabaseUntyped
        .from('job_loader_worksheets')
        .update({ is_selected: false })
        .eq('job_id', jobId)
        .neq('id', worksheet.id)
        .select('id');
      // If this is the only row, an empty result is expected. Otherwise the
      // normal mutation checker catches an RLS-denied clear before the target set.
      if (hasOtherWorksheet) checkMutationResult(clearResult, 'Clear selected loader worksheet');
      else if (clearResult.error) throw clearResult.error;

      const selectResult = await supabaseUntyped
        .from('job_loader_worksheets')
        .update({ is_selected: true })
        .eq('id', worksheet.id)
        .eq('job_id', jobId)
        .select('id');
      checkMutationResult(selectResult, 'Select loader worksheet');
      await refresh();
      toast('success', 'Loader worksheet selected for printing');
    } catch (error) {
      await refresh();
      if (isLoaderWorksheetSelectionConflict(error)) {
        toast('error', 'Selection changed elsewhere — refreshed');
      } else {
        toast('error', 'Could not select that loader worksheet. Refreshed to match the saved selection.');
      }
    } finally {
      setBusyId(null);
    }
  };

  const deleteWorksheet = async () => {
    if (rejectReadOnlyMutation()) return;
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      const result = await supabaseUntyped
        .from('job_loader_worksheets')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('job_id', jobId)
        .select('id');
      checkMutationResult(result, 'Delete loader worksheet');
      toast('success', 'Loader worksheet deleted');
      setDeleteTarget(null);
      await refresh();
    } catch (_error) {
      toast('error', 'Could not delete that loader worksheet. You may not have permission.');
    } finally {
      setBusyId(null);
    }
  };

  const savePerLoadAcres = async () => {
    if (rejectReadOnlyMutation()) return;
    if (!selectedWorksheet || !selectedComputed) return;
    const acres = perLoadAcres.map((value) => Number(value));
    if (!hasValidPerLoadAcres(acres, selectedComputed.loads_count, totalAcres)) {
      setPerLoadError(`Load acres must total ${formatNumber(totalAcres)} acres.`);
      return;
    }
    const manualWorksheet = computeLoaderWorksheet({
      total_acres: totalAcres,
      carrier_rate_gpa: selectedWorksheet.carrier_rate_gpa,
      tank_capacity: selectedWorksheet.capacity_gal,
      mode: selectedWorksheet.load_balance_mode,
      perLoadAcresOverride: acres,
      products,
    });
    if (!manualWorksheet.valid) {
      setPerLoadError(manualWorksheet.invalid_reason);
      return;
    }
    setBusyId(selectedWorksheet.id);
    try {
      const result = await supabaseUntyped
        .from('job_loader_worksheets')
        .update({ per_load_acres: acres })
        .eq('id', selectedWorksheet.id)
        .eq('job_id', jobId)
        .select('id');
      checkMutationResult(result, 'Save per-load acres');
      setPerLoadError('');
      toast('success', 'Per-load acres saved');
      await refresh();
    } catch (_error) {
      toast('error', 'Could not save per-load acres. You may not have permission.');
    } finally {
      setBusyId(null);
    }
  };

  const resetPerLoadAcres = async () => {
    if (rejectReadOnlyMutation()) return;
    if (!selectedWorksheet) return;
    setBusyId(selectedWorksheet.id);
    try {
      const result = await supabaseUntyped
        .from('job_loader_worksheets')
        .update({ per_load_acres: null })
        .eq('id', selectedWorksheet.id)
        .eq('job_id', jobId)
        .select('id');
      checkMutationResult(result, 'Reset per-load acres');
      setPerLoadError('');
      toast('success', 'Per-load acres reset to automatic');
      await refresh();
    } catch (_error) {
      toast('error', 'Could not reset per-load acres. You may not have permission.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleDone = async (loadIndex: number) => {
    if (rejectReadOnlyMutation()) return;
    if (!selectedWorksheet || !selectedComputed) return;
    const previous = selectedWorksheet.loads_done;
    const next = toggleLoaderLoadDone(previous, loadIndex, selectedComputed.loads_count);
    setWorksheets((current) => current.map((worksheet) => worksheet.id === selectedWorksheet.id
      ? { ...worksheet, loads_done: next }
      : worksheet));
    setBusyId(selectedWorksheet.id);
    try {
      const result = await supabaseUntyped
        .from('job_loader_worksheets')
        .update({ loads_done: next })
        .eq('id', selectedWorksheet.id)
        .eq('job_id', jobId)
        .select('id');
      checkMutationResult(result, 'Update completed loads');
    } catch (_error) {
      setWorksheets((current) => current.map((worksheet) => worksheet.id === selectedWorksheet.id
        ? { ...worksheet, loads_done: previous }
        : worksheet));
      toast('error', 'Could not update the completed load. It was restored.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <p className="py-8 text-center text-sm text-secondary">Loading saved loader worksheets…</p>;
  }

  if (readError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p className="font-medium">Saved worksheets could not be loaded.</p>
        <p className="mt-1">The legacy worksheet is hidden until this read succeeds, because it might not match the selected print plan.</p>
        <Button variant="secondary" size="sm" showChevron={false} icon={<RefreshCw className="h-4 w-4" />} onClick={() => void refresh()} className="mt-3">
          Try again
        </Button>
      </div>
    );
  }

  if (worksheets.length === 0) {
    return (
      <>
        {legacyContent}
        {canEdit && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <Button variant="secondary" size="sm" showChevron={false} icon={<Save className="h-4 w-4" />} onClick={openNewEditor}>
              Save as worksheet
            </Button>
            <p className="mt-1 text-xs text-secondary">Save this plan to keep it alongside other vehicle or capacity scenarios.</p>
          </div>
        )}
        {editorOpen && renderEditor()}
      </>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-semibold text-nav-dark">Saved worksheets</h3>
          <p className="text-sm text-secondary">Select one plan for printing, then mark loads done as the job is applied.</p>
        </div>
        {canEdit && (
          <Button size="sm" showChevron={false} icon={<Plus className="h-4 w-4" />} onClick={openNewEditor}>
            Add new worksheet
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-secondary">
            <tr>
              <th className="px-3 py-2">Date generated</th>
              <th className="px-3 py-2">Vehicle</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Total load acres</th>
              <th className="px-3 py-2 text-right">Total loads</th>
              {canEdit && <th className="px-3 py-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {worksheets.map((worksheet) => {
              const calculated = computeLoaderWorksheet({
                total_acres: totalAcres,
                carrier_rate_gpa: worksheet.carrier_rate_gpa,
                tank_capacity: worksheet.capacity_gal,
                mode: worksheet.load_balance_mode,
                perLoadAcresOverride: worksheet.per_load_acres ?? undefined,
                products,
              });
              return (
                <tr key={worksheet.id} className="border-t border-gray-100">
                  <td className="px-3 py-3 text-secondary">{formatCreatedDate(worksheet.created_at)}</td>
                  <td className="px-3 py-3 text-nav-dark">
                    {worksheet.vehicle_id ? vehicleNameById.get(worksheet.vehicle_id) ?? 'Manual' : 'Manual'}
                    <span className="block text-xs text-secondary">{formatNumber(worksheet.capacity_gal)} gal &middot; {worksheet.load_balance_mode === 'full_loads_remainder' ? 'Full loads + remainder' : 'Proportional'}</span>
                  </td>
                  <td className="px-3 py-3">
                    {worksheet.is_selected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-crx-green-tint px-2 py-0.5 text-xs font-medium text-crx-green"><Check className="h-3.5 w-3.5" /> Selected</span>
                    ) : <span className="text-secondary">Saved</span>}
                  </td>
                  <td className="px-3 py-3 text-right text-nav-dark">{calculated.valid ? formatNumber(calculated.total_acres) : <>&mdash;</>}</td>
                  <td className="px-3 py-3 text-right text-nav-dark">{calculated.valid ? calculated.loads_count : <>&mdash;</>}</td>
                  {canEdit && (
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" showChevron={false} disabled={busyId === worksheet.id || worksheet.is_selected} onClick={() => void selectWorksheet(worksheet)}>Select</Button>
                        <button type="button" aria-label={`Edit loader worksheet ${formatCreatedDate(worksheet.created_at)}`} onClick={() => openEditEditor(worksheet)} className="rounded p-1.5 text-secondary hover:bg-gray-100 hover:text-crx-green"><Edit3 className="h-4 w-4" /></button>
                        <button type="button" aria-label={`Delete loader worksheet ${formatCreatedDate(worksheet.created_at)}`} onClick={() => setDeleteTarget(worksheet)} className="rounded p-1.5 text-secondary hover:bg-gray-100 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!selectedWorksheet && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="status">
          No worksheet selected — printing uses the job&apos;s legacy loader values.
        </div>
      )}

      {editorOpen && renderEditor()}

      {selectedWorksheet && selectedComputed && (
        <section className="space-y-3 border-t border-gray-200 pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-semibold text-nav-dark">Selected worksheet loads</h3>
              <p className="text-sm text-secondary">Click or tap a load to mark it done.</p>
            </div>
            <div className="inline-flex rounded-lg border border-gray-200 p-0.5" aria-label="Load display">
              <button type="button" onClick={() => onDisplayModeChange('individual')} className={`rounded px-3 py-1.5 text-sm ${displayMode === 'individual' ? 'bg-crx-green text-white' : 'text-secondary hover:bg-gray-50'}`}>Individual</button>
              <button type="button" onClick={() => onDisplayModeChange('condensed')} className={`rounded px-3 py-1.5 text-sm ${displayMode === 'condensed' ? 'bg-crx-green text-white' : 'text-secondary hover:bg-gray-50'}`}>Condensed</button>
            </div>
          </div>

          {!selectedComputed.valid ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p>{selectedComputed.invalid_reason}</p>
              {canEdit && selectedWorksheet.per_load_acres !== null && (
                <div className="mt-3">
                  <p className="mb-2">This worksheet has saved manual load acres that no longer fit this layout. Reset them to automatic loads, then review the revised plan.</p>
                  <Button variant="ghost" size="sm" showChevron={false} onClick={() => void resetPerLoadAcres()} disabled={busyId === selectedWorksheet.id}>Reset to auto</Button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs font-medium text-secondary">
                    <tr><th className="px-3 py-2">Load</th><th className="px-3 py-2 text-right">Acres</th><th className="px-3 py-2 text-right">Spray volume</th><th className="px-3 py-2">Status</th></tr>
                  </thead>
                  <tbody>
                    {displayMode === 'individual' ? selectedComputed.loads.map((load, index) => {
                      const done = selectedLoadsDone.includes(index);
                      return (
                        <tr key={load.load_number} className={`border-t border-gray-100 ${done ? 'bg-gray-50 text-secondary line-through' : ''}`}>
                          <td className="px-3 py-2">Load {load.load_number}{load.is_partial ? ' (remainder)' : ''}</td>
                          <td className="px-3 py-2 text-right">
                            {canEdit ? <input aria-label={`Load ${load.load_number} acres`} type="number" min="0" step="0.01" value={perLoadAcres[index] ?? ''} onChange={(event) => setPerLoadAcres((current) => current.map((value, currentIndex) => currentIndex === index ? event.target.value : value))} className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-nav-dark" /> : formatNumber(load.volume / selectedComputed.carrier_rate_gpa)}
                          </td>
                          <td className="px-3 py-2 text-right">{formatNumber(load.volume)} gal</td>
                          <td className="px-3 py-2">
                            {canEdit ? <button type="button" disabled={busyId === selectedWorksheet.id} onClick={() => void toggleDone(index)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-crx-green hover:bg-crx-green-tint disabled:opacity-50"><Check className="h-3.5 w-3.5" />{done ? 'Done' : 'Mark done'}</button> : (done ? <span className="inline-flex items-center gap-1 text-crx-green"><Check className="h-4 w-4" />Done</span> : <span>&mdash;</span>)}
                          </td>
                        </tr>
                      );
                    }) : condenseLoaderLoads(selectedComputed.loads, selectedLoadsDone).map((group) => {
                      const load = group.loads[0];
                      const each = group.loads.length > 1 ? ' each' : '';
                      return (
                        <tr key={group.key} className={`border-t border-gray-100 ${group.done ? 'bg-gray-50 text-secondary line-through' : ''}`}>
                          <td className="px-3 py-2">{condensedLoaderLoadLabel(group)}{load.is_partial ? ' (remainder)' : ''}</td>
                          <td className="px-3 py-2 text-right">{formatNumber(load.volume / selectedComputed.carrier_rate_gpa)}{each}</td>
                          <td className="px-3 py-2 text-right">{formatNumber(load.volume)} gal{each}</td>
                          <td className="px-3 py-2">{group.done ? <span className="inline-flex items-center gap-1 text-crx-green"><Check className="h-4 w-4" />Done</span> : <span>&mdash;</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {canEdit && displayMode === 'individual' && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" showChevron={false} icon={<Save className="h-4 w-4" />} loading={busyId === selectedWorksheet.id} onClick={() => void savePerLoadAcres()}>Save load acres</Button>
                  <Button variant="ghost" size="sm" showChevron={false} onClick={() => void resetPerLoadAcres()} disabled={busyId === selectedWorksheet.id || selectedWorksheet.per_load_acres === null}>Reset to auto</Button>
                  {perLoadError && <p className="text-sm text-red-600">{perLoadError}</p>}
                </div>
              )}
            </>
          )}
        </section>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void deleteWorksheet()}
        title="Delete loader worksheet?"
        message="This removes this saved worksheet scenario. Other saved scenarios and the job’s legacy loader fields stay unchanged."
        confirmLabel="Delete worksheet"
        variant="danger"
        loading={busyId === deleteTarget?.id}
      />
    </div>
  );

  function renderEditor(): JSX.Element {
    return (
      <section className="rounded-lg border border-crx-green/30 bg-crx-green-tint/30 p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-semibold text-nav-dark">{draft.id ? 'Edit worksheet' : 'New worksheet'}</h3>
          <button type="button" onClick={() => setEditorOpen(false)} className="rounded p-1 text-secondary hover:bg-white" aria-label="Close worksheet editor"><ChevronUp className="h-4 w-4" /></button>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-nav-dark">Vessel being loaded
            <select value={draft.vesselValue} onChange={(event) => handleVesselChange(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              {vesselOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-nav-dark">Tank capacity (gal)
            <input type="number" min="0" step="1" value={draft.capacityGal} onChange={(event) => setDraft((current) => ({ ...current, capacityGal: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium text-nav-dark">Carrier rate (gal/acre)
            <input type="number" min="0" step="0.1" value={draft.carrierRateGpa} onChange={(event) => setDraft((current) => ({ ...current, carrierRateGpa: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-nav-dark">Load balance</legend>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-secondary">
              <label className="inline-flex items-center gap-2"><input type="radio" name="load-balance-mode" checked={draft.mode === 'proportional'} onChange={() => setDraft((current) => ({ ...current, mode: 'proportional' }))} /> Proportional</label>
              <label className="inline-flex items-center gap-2"><input type="radio" name="load-balance-mode" checked={draft.mode === 'full_loads_remainder'} onChange={() => setDraft((current) => ({ ...current, mode: 'full_loads_remainder' }))} /> Full loads + remainder</label>
            </div>
          </fieldset>
          <label className="block text-sm font-medium text-nav-dark md:col-span-2">Loader comment
            <textarea rows={2} value={draft.comment} onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" placeholder="Instructions for the loader (mix order, etc.)..." />
          </label>
        </div>
        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-nav-dark"><ChevronDown className="h-4 w-4" /> Live load preview</div>
          {draftWorksheet.valid ? <p className="text-sm text-secondary">{draftWorksheet.loads.map((load) => `${formatNumber(load.volume / draftWorksheet.carrier_rate_gpa)} ac${load.is_partial ? ' remainder' : ''}`).join(' · ')}</p> : <p className="text-sm text-amber-700">{draftWorksheet.invalid_reason}</p>}
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" showChevron={false} onClick={() => setEditorOpen(false)}>Cancel</Button>
          <Button showChevron={false} icon={<Save className="h-4 w-4" />} loading={saving} onClick={() => void saveWorksheet()}>Save worksheet</Button>
        </div>
      </section>
    );
  }
}
