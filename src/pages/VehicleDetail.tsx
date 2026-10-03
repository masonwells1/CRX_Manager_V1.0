import { useEffect, useRef, useState , useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { sanitizeError, supabase, checkMutationResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import type { Vehicle, VehicleType, VehicleStatus } from '../types';

const CATEGORY_SUGGESTIONS = ['Sprayer', 'Tender', 'Spreader', 'Drone', 'Other'];

export default function VehicleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const isNew = id === 'new';
  const isAdmin = role === 'admin';

  const [form, setForm] = useState<{
    vehicle_name: string;
    vehicle_type: VehicleType;
    category: string;
    capacity_gallons: string;
    capacity_unit: string;
    registration: string;
    status: VehicleStatus;
    notes: string;
  }>({
    vehicle_name: '',
    vehicle_type: 'ground',
    category: '',
    capacity_gallons: '',
    capacity_unit: 'gallons',
    registration: '',
    status: 'active',
    notes: '',
  });

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [form]);

  const fetchVehicle = useCallback(async () => {
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('id', id!)
      .single();

    if (error || !data) {
      toast('error', 'Vehicle not found');
      navigate('/vehicles');
      return;
    }

    const v = data as Vehicle;
    setForm({
      vehicle_name: v.vehicle_name,
      vehicle_type: v.vehicle_type,
      category: v.category || '',
      capacity_gallons: v.capacity_gallons?.toString() || '',
      capacity_unit: v.capacity_unit || 'gallons',
      registration: v.registration || '',
      status: v.status,
      notes: v.notes || '',
    });
    setLoading(false);
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [id, toast, navigate]);

  useEffect(() => {
    if (!isNew && id) {
      fetchVehicle();
    } else {
      setTimeout(() => { initialLoadDone.current = true; }, 0);
    }
  }, [id, isNew, fetchVehicle]);

  const handleSave = async () => {
    if (!form.vehicle_name.trim()) {
      toast('error', 'Vehicle name is required');
      return;
    }
    if (!isAdmin) {
      toast('error', 'Only admins can manage vehicles');
      return;
    }

    setSaving(true);
    const payload = {
      vehicle_name: form.vehicle_name.trim(),
      vehicle_type: form.vehicle_type,
      category: form.category || null,
      capacity_gallons: form.capacity_gallons ? parseFloat(form.capacity_gallons) : null,
      capacity_unit: form.capacity_unit || 'gallons',
      registration: form.registration || null,
      status: form.status,
      notes: form.notes || null,
      ...(isNew ? { created_by: profile?.id } : {}),
    };

    try {
      if (isNew) {
        const result = await supabase.from('vehicles').insert(payload).select().single();
        checkMutationResult(result, 'Create vehicle');
        if (profile) logActivity({ event: 'vehicle_created', description: `Vehicle "${form.vehicle_name}" created`, performedBy: profile.id });
        toast('success', 'Vehicle created');
        setIsDirty(false);
        navigate(`/vehicles/${result.data!.id}`);
      } else {
        const result = await supabase.from('vehicles').update(payload).eq('id', id!).select().single();
        checkMutationResult(result, 'Update vehicle');
        if (profile) logActivity({ event: 'vehicle_updated', description: `Vehicle "${form.vehicle_name}" updated`, performedBy: profile.id });
        toast('success', 'Vehicle saved');
        setIsDirty(false);
      }
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_vehicle' } });
      toast('error', sanitizeError(err));
    }
    setSaving(false);
  };

  const updateField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-gray-100 rounded w-48 animate-pulse" />
        <div className="h-64 bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/vehicles')}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          aria-label="Back to vehicles"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-nav-dark">
            {isNew ? 'New Vehicle' : form.vehicle_name}
          </h1>
          {!isNew && (
            <p className="text-sm text-secondary mt-0.5">
              {form.vehicle_type === 'air' ? 'Aircraft' : 'Ground Vehicle'} &middot; {form.status}
            </p>
          )}
        </div>
        {isAdmin && (
          <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
            {isNew ? 'Create Vehicle' : 'Save Changes'}
          </Button>
        )}
      </div>

      {/* Form */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Input
            label="Vehicle Name"
            value={form.vehicle_name}
            onChange={(e) => updateField('vehicle_name', e.target.value)}
            required
            placeholder="e.g. Hagie STS-16"
          />
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Type</label>
            <select
              value={form.vehicle_type}
              onChange={(e) => updateField('vehicle_type', e.target.value as VehicleType)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="ground">Ground</option>
              <option value="air">Air</option>
            </select>
          </div>
          <div>
            <Input
              id="vehicle-category"
              label="Category"
              value={form.category}
              onChange={(e) => updateField('category', e.target.value)}
              list="vehicle-category-suggestions"
              placeholder="e.g. Tender"
            />
            <datalist id="vehicle-category-suggestions">
              {CATEGORY_SUGGESTIONS.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </div>
          <div className="flex gap-3">
            <Input
              label="Capacity"
              type="number"
              value={form.capacity_gallons}
              onChange={(e) => updateField('capacity_gallons', e.target.value)}
              placeholder="e.g. 1000"
              min={0}
              className="flex-1"
            />
            <div className="w-32">
              <label className="block text-sm font-medium text-nav-dark mb-1">Unit</label>
              <select
                value={form.capacity_unit}
                onChange={(e) => updateField('capacity_unit', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="gallons">Gallons</option>
                <option value="lbs">Lbs</option>
                <option value="tons">Tons</option>
              </select>
            </div>
          </div>
          <Input
            label="Registration / ID"
            value={form.registration}
            onChange={(e) => updateField('registration', e.target.value)}
            placeholder={form.vehicle_type === 'air' ? 'FAA N-number (e.g. N12345)' : 'DOT# or internal ID'}
          />
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Status</label>
            <select
              value={form.status}
              onChange={(e) => updateField('status', e.target.value as VehicleStatus)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="maintenance">Maintenance</option>
            </select>
          </div>
        </div>
        <div className="mt-5">
          <label className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => updateField('notes', e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
            placeholder="Maintenance schedule, special considerations..."
          />
        </div>
      </Card>
    </div>
  );
}
