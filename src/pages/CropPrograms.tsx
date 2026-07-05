/**
 * CropPrograms.tsx — Reusable crop program templates
 * GAP FIX #19: Crop Program Templates
 *
 * Lets admins/sales reps create standard "programs" (e.g. "2026 Corn Program")
 * that contain a predefined set of products and rates. When creating a new quote,
 * they can "Apply Program" to auto-fill sections and items.
 *
 * Stored in app_settings as JSON (no new table needed).
 */
import { useEffect, useState , useCallback } from 'react';
import { Plus, Copy, Pencil, Trash2, Sprout, Save, X, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import Badge from '../components/ui/Badge';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import HelpTip from '../components/ui/HelpTip';
import { computeSeason } from '../utils/season';
import { unitOptionsForForm, isKnownUnit } from '../lib/units';
import type { Product, UnitConversion } from '../types';

interface ProgramItem {
  product_id: string;
  product_name: string;
  rate: number;
  rate_unit: string;
  section_name: string;
  notes: string;
}

interface CropProgram {
  id: string;
  name: string;
  description: string;
  crop_type: string;
  season: string;
  is_active: boolean;
  items: ProgramItem[];
  created_at: string;
  updated_at: string;
}

const CROP_TYPES = ['Corn', 'Soybeans', 'Wheat', 'Cotton', 'Hay/Forage', 'Other'];
function getSeasonChoices(): string[] {
  // Season year = crop year ending Sep 30. Uses centralized computeSeason().
  const base = computeSeason();
  return [String(base - 1), String(base), String(base + 1)];
}
const SEASONS = getSeasonChoices();
const SECTION_PRESETS = ['Pre-Emerge', 'Post-Emerge', 'Burndown', 'Fungicide', 'Insecticide', 'Fertilizer', 'Seed Treatment', 'Other'];

export default function CropPrograms() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const [programs, setPrograms] = useState<CropProgram[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProgram, setEditingProgram] = useState<CropProgram | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) { Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } }); return; }
      setUnitConversions((data || []) as UnitConversion[]);
    });
  }, []);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formCrop, setFormCrop] = useState('Corn');
  const [formSeason, setFormSeason] = useState(SEASONS[1]);
  const [formItems, setFormItems] = useState<ProgramItem[]>([]);
  const [saving, setSaving] = useState(false);

  const isAdmin = role === 'admin';

  const fetchPrograms = useCallback(async () => {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .eq('setting_key', 'crop_programs')
      .maybeSingle();

    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load crop programs.');
      setLoading(false);
      return;
    }

    if (data?.setting_value) {
      try {
        const parsed = JSON.parse(data.setting_value);
        setPrograms(Array.isArray(parsed) ? parsed : []);
      } catch {
        setPrograms([]);
      }
    }
    setLoading(false);
  }, [toast]);

  const fetchProducts = useCallback(async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name')
      .limit(500);
    if (error) {
      Sentry.captureException(error);
    }
    setProducts((data || []) as Product[]);
  }, []);

  useEffect(() => {
    fetchPrograms();
    fetchProducts();
  }, [fetchPrograms, fetchProducts]);

  const savePrograms = async (updated: CropProgram[]) => {
    const { data: existing } = await supabase
      .from('app_settings')
      .select('id')
      .eq('setting_key', 'crop_programs')
      .maybeSingle();

    const value = JSON.stringify(updated);

    if (existing) {
      const updateResult = await supabase
        .from('app_settings')
        .update({ setting_value: value, updated_by: profile?.id, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select();
      checkMutationResult(updateResult, 'Update crop programs setting');
    } else {
      const insertResult = await supabase.from('app_settings').insert({
        setting_key: 'crop_programs',
        setting_value: value,
        updated_by: profile?.id,
      }).select();
      checkMutationResult(insertResult, 'Create crop programs setting');
    }
    setPrograms(updated);
  };

  const openNew = () => {
    setEditingProgram(null);
    setFormName('');
    setFormDesc('');
    setFormCrop('Corn');
    setFormSeason(SEASONS[1]);
    setFormItems([{ product_id: '', product_name: '', rate: 0, rate_unit: 'oz', section_name: 'Pre-Emerge', notes: '' }]);
    setModalOpen(true);
  };

  const openEdit = (prog: CropProgram) => {
    setEditingProgram(prog);
    setFormName(prog.name);
    setFormDesc(prog.description);
    setFormCrop(prog.crop_type);
    setFormSeason(prog.season);
    setFormItems([...prog.items]);
    setModalOpen(true);
  };

  const handleDuplicate = (prog: CropProgram) => {
    const dup: CropProgram = {
      ...prog,
      id: crypto.randomUUID(),
      name: `${prog.name} (Copy)`,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items: prog.items.map((item) => ({ ...item })),
    };
    savePrograms([...programs, dup]);
    toast('success', `Program duplicated as "${dup.name}"`);
  };

  const handleDelete = async (progId: string) => {
    const updated = programs.filter((p) => p.id !== progId);
    await savePrograms(updated);
    setDeleteConfirm(null);
    toast('success', 'Program deleted');
  };

  const addItem = () => {
    setFormItems([...formItems, { product_id: '', product_name: '', rate: 0, rate_unit: 'oz', section_name: 'Pre-Emerge', notes: '' }]);
  };

  const removeItem = (idx: number) => {
    setFormItems(formItems.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, field: keyof ProgramItem, value: string | number) => {
    const updated = [...formItems];
    (updated[idx] as unknown as Record<string, string | number>)[field] = value;
    if (field === 'product_id') {
      const prod = products.find((p) => p.id === value);
      updated[idx].product_name = prod?.product_name || '';
      if (prod?.rate_unit) updated[idx].rate_unit = prod.rate_unit;
      if (prod?.rate_per_acre) updated[idx].rate = prod.rate_per_acre;
    }
    setFormItems(updated);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast('error', 'Program name is required');
      return;
    }
    if (formItems.filter((i) => i.product_id).length === 0) {
      toast('error', 'Add at least one product');
      return;
    }

    const now = new Date().toISOString();
    const cleanItems = formItems.filter((i) => i.product_id);

    await runCriticalAction({
      action: async () => {
        if (editingProgram) {
          const updated = programs.map((p) =>
            p.id === editingProgram.id
              ? { ...p, name: formName, description: formDesc, crop_type: formCrop, season: formSeason, items: cleanItems, updated_at: now }
              : p
          );
          await savePrograms(updated);
          if (profile) {
            await logActivity({ event: 'program_updated', description: `Crop program "${formName}" updated`, performedBy: profile.id, entityType: 'setting', entityId: editingProgram.id });
          }
        } else {
          const newProg: CropProgram = {
            id: crypto.randomUUID(),
            name: formName,
            description: formDesc,
            crop_type: formCrop,
            season: formSeason,
            is_active: true,
            items: cleanItems,
            created_at: now,
            updated_at: now,
          };
          await savePrograms([...programs, newProg]);
          if (profile) {
            await logActivity({ event: 'program_created', description: `Crop program "${formName}" created with ${cleanItems.length} products`, performedBy: profile.id, entityType: 'setting', entityId: newProg.id });
          }
        }
      },
      toast,
      setLoading: setSaving,
      successMessage: editingProgram ? 'Program updated' : 'Program created',
      sentryTag: editingProgram ? 'update_crop_program' : 'create_crop_program',
      onSuccess: () => {
        setModalOpen(false);
      },
    });
  };

  const toggleActive = async (progId: string) => {
    const updated = programs.map((p) =>
      p.id === progId ? { ...p, is_active: !p.is_active, updated_at: new Date().toISOString() } : p
    );
    await savePrograms(updated);
  };

  const filtered = programs.sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  });

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <SplitHeading title="Crop" accent="Programs" />
          <HelpTip text="Reusable product templates for common crop programs (e.g. '2026 Corn Program'). When building a quote, use 'Apply Program' to auto-fill sections and items with pre-set products and rates." />
        </span>
        <Button icon={<Plus className="w-4 h-4" />} onClick={openNew}>
          New Program
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <Sprout className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-secondary text-sm">No crop programs yet</p>
            <p className="text-xs text-gray-400 mt-1">
              Create a program template to quickly build quotes for common crop applications
            </p>
            <Button className="mt-4" icon={<Plus className="w-4 h-4" />} onClick={openNew}>
              Create First Program
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((prog) => (
            <Card key={prog.id} className={!prog.is_active ? 'opacity-60' : ''}>
              <div className="flex items-start justify-between">
                <div
                  className="flex-1 cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedId(expandedId === prog.id ? null : prog.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(expandedId === prog.id ? null : prog.id); } }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                      <Sprout className="w-5 h-5 text-crx-green" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-nav-dark">{prog.name}</h3>
                        <Badge variant={prog.is_active ? 'success' : 'default'}>
                          {prog.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <p className="text-xs text-secondary mt-0.5">
                        {prog.crop_type} &middot; {prog.season} &middot; {prog.items.length} product{prog.items.length !== 1 ? 's' : ''}
                      </p>
                      {prog.description && (
                        <p className="text-xs text-gray-400 mt-1">{prog.description}</p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setExpandedId(expandedId === prog.id ? null : prog.id)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-nav-dark hover:bg-gray-100 transition-colors"
                  >
                    {expandedId === prog.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => openEdit(prog)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-crx-green hover:bg-crx-green-light transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDuplicate(prog)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                    title="Duplicate"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => setDeleteConfirm(prog.id)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded product list */}
              {expandedId === prog.id && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="px-3 py-2 text-left font-medium text-secondary">Section</th>
                        <th className="px-3 py-2 text-left font-medium text-secondary">Product</th>
                        <th className="px-3 py-2 text-left font-medium text-secondary">Rate</th>
                        <th className="px-3 py-2 text-left font-medium text-secondary">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prog.items.map((item, idx) => (
                        <tr key={idx} className="border-b border-gray-50">
                          <td className="px-3 py-2 text-secondary">{item.section_name}</td>
                          <td className="px-3 py-2 font-medium text-nav-dark">{item.product_name}</td>
                          <td className="px-3 py-2 font-mono text-sm">
                            {item.rate} {item.rate_unit}
                          </td>
                          <td className="px-3 py-2 text-gray-400">{item.notes || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-end mt-3">
                    <button
                      onClick={() => toggleActive(prog.id)}
                      className="text-xs text-secondary hover:text-crx-green underline"
                    >
                      {prog.is_active ? 'Deactivate' : 'Activate'} Program
                    </button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Delete Program?">
        <p className="text-sm text-secondary">
          This will permanently delete this crop program template. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3 mt-6">
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>
            Delete
          </Button>
        </div>
      </Modal>

      {/* Create/Edit Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editingProgram ? 'Edit Program' : 'New Crop Program'} maxWidth="lg">
        <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Program Name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. 2026 Corn Program" />
            <Input label="Description" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Optional description" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Crop Type</label>
              <select
                value={formCrop}
                onChange={(e) => setFormCrop(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                {CROP_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Season</label>
              <select
                value={formSeason}
                onChange={(e) => setFormSeason(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-nav-dark">Products</h4>
              <button
                onClick={addItem}
                className="text-xs text-crx-green hover:text-crx-green-dark font-medium flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add Product
              </button>
            </div>

            <div className="space-y-3">
              {formItems.map((item, idx) => (
                <div key={idx} className="bg-gray-50 rounded-lg p-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                    <div className="col-span-2 sm:col-span-3">
                      <label className="block text-xs font-medium text-secondary mb-1">Section</label>
                      <select
                        value={item.section_name}
                        onChange={(e) => updateItem(idx, 'section_name', e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg"
                      >
                        {SECTION_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2 sm:col-span-4">
                      <label className="block text-xs font-medium text-secondary mb-1">Product</label>
                      <select
                        value={item.product_id}
                        onChange={(e) => updateItem(idx, 'product_id', e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg"
                      >
                        <option value="">Select product...</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>{p.product_name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-1 sm:col-span-2">
                      <label className="block text-xs font-medium text-secondary mb-1">Rate</label>
                      <input
                        type="number"
                        value={item.rate || ''}
                        onChange={(e) => updateItem(idx, 'rate', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg"
                        placeholder="0"
                      />
                    </div>
                    <div className="col-span-1 sm:col-span-2">
                      <label className="block text-xs font-medium text-secondary mb-1">Unit <span className="text-gray-400 font-normal">(per acre)</span></label>
                      <select
                        value={item.rate_unit || ''}
                        onChange={(e) => updateItem(idx, 'rate_unit', e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg"
                      >
                        <option value="">-- Select --</option>
                        {/* WaveB: canonical bare units (match the product master + stored data); the rate is per-acre. Grandfather a legacy value not in the list. */}
                        {item.rate_unit && !isKnownUnit(unitConversions, null, item.rate_unit) && (
                          <option value={item.rate_unit}>{item.rate_unit} (existing)</option>
                        )}
                        {unitOptionsForForm(unitConversions, null).map((uc) => (
                          <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2 sm:col-span-1 flex justify-center sm:justify-center">
                      <button
                        onClick={() => removeItem(idx)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
          <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
            {editingProgram ? 'Save Changes' : 'Create Program'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
