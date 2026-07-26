/**
 * Vendors.tsx — Vendor master-data management (PR-25, 2026-05-10)
 *
 * Admin-only page to add, edit, deactivate, and reactivate vendors.
 * Vendors are referenced by purchase orders (legacy `vendor` text column)
 * and vendor bills (`vendor_id` FK). "Deactivate" is the soft-delete from
 * delete_vendor() (refused if unpaid bills exist); the RPC name is
 * unchanged, only the UI language is. Reactivate clears the soft-delete
 * via reactivate_vendor() (migration 20260726213000) and is blocked if an
 * active vendor now uses the same normalized name.
 *
 * Uses save_vendor() and delete_vendor() RPCs from migration 20260510120000.
 */
import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, RotateCcw } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import DataTable, { type Column } from '../components/ui/DataTable';
import PageHeader from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { sanitizeError } from '../lib/errorSanitizer';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useAuth } from '../contexts/AuthContext';
import type { Vendor } from '../types';

const blankPayload = {
  name: '',
  contact_name: '',
  phone: '',
  email: '',
  address: '',
  default_payment_terms: '',
  default_payment_terms_days: '',
  notes: '',
};

export default function Vendors() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const saveIdem = useIdempotencyKey('save_vendor', profile?.id || '');
  const deleteIdem = useIdempotencyKey('delete_vendor', profile?.id || '');
  const reactivateIdem = useIdempotencyKey('reactivate_vendor', profile?.id || '');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof blankPayload>(blankPayload);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Vendor | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [reactivateTarget, setReactivateTarget] = useState<Vendor | null>(null);
  const [reactivating, setReactivating] = useState(false);

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    let query = supabase.from('vendors').select('*');
    query = showInactive
      ? query.not('deleted_at', 'is', null)
      : query.is('deleted_at', null);
    const { data, error } = await query.order('name', { ascending: true });
    if (error) {
      toast('error', 'Failed to load vendors');
      setLoading(false);
      return;
    }
    setVendors((data || []) as Vendor[]);
    setLoading(false);
  }, [toast, showInactive]);

  useEffect(() => {
    fetchVendors();
  }, [fetchVendors]);

  // Codex P2 fix (PR #59, 2026-05-16): reset save/delete idempotency keys
  // on every modal open. Without this, if a vendor save/delete succeeded
  // on the server but the response was lost, opening the modal for a
  // different vendor and submitting would reuse the same page-scoped key
  // and replay the prior cached success — UI says success, but the new
  // vendor was NOT mutated. Reset-on-open scopes each modal interaction
  // to its own idempotency intent; retries of the same submission still
  // reuse the key correctly because resetKey() is only called here and
  // in the onSuccess paths.
  const openCreateModal = () => {
    saveIdem.resetKey();
    setEditingId(null);
    setForm(blankPayload);
    setEditModalOpen(true);
  };

  const openDeleteModal = (v: Vendor) => {
    deleteIdem.resetKey();
    setDeleteTarget(v);
  };

  const openReactivateModal = (v: Vendor) => {
    reactivateIdem.resetKey();
    setReactivateTarget(v);
  };

  const openEditModal = (v: Vendor) => {
    saveIdem.resetKey();
    setEditingId(v.id);
    setForm({
      name: v.name,
      contact_name: v.contact_name || '',
      phone: v.phone || '',
      email: v.email || '',
      address: v.address || '',
      default_payment_terms: v.default_payment_terms || '',
      default_payment_terms_days: v.default_payment_terms_days != null ? String(v.default_payment_terms_days) : '',
      notes: v.notes || '',
    });
    setEditModalOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast('error', 'Vendor name is required');
      return;
    }
    setSaving(true);
    try {
      const key = saveIdem.getKey();
      const payload = {
        name: form.name.trim(),
        contact_name: form.contact_name || null,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        default_payment_terms: form.default_payment_terms || null,
        default_payment_terms_days: form.default_payment_terms_days
          ? Number(form.default_payment_terms_days)
          : null,
        notes: form.notes || null,
      };
      const { data, error } = await supabase.rpc('save_vendor', {
        p_vendor_id: editingId as string,
        p_payload: payload,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult<{ success: boolean; vendor_id: string; is_new: boolean }>(data, 'save_vendor');
      saveIdem.resetKey();
      toast('success', editingId ? 'Vendor updated' : 'Vendor created');
      setEditModalOpen(false);
      fetchVendors();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const key = deleteIdem.getKey();
      const { data, error } = await supabase.rpc('delete_vendor', {
        p_vendor_id: deleteTarget.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult<{ success: boolean; vendor_id: string }>(data, 'delete_vendor');
      deleteIdem.resetKey();
      toast('success', `Vendor "${deleteTarget.name}" deactivated`);
      setDeleteTarget(null);
      fetchVendors();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
  };

  const handleReactivate = async () => {
    if (!reactivateTarget) return;
    setReactivating(true);
    try {
      const key = reactivateIdem.getKey();
      const { data, error } = await supabase.rpc('reactivate_vendor', {
        p_vendor_id: reactivateTarget.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult<{ success: boolean; vendor_id: string }>(data, 'reactivate_vendor');
      reactivateIdem.resetKey();
      toast('success', `Vendor "${reactivateTarget.name}" reactivated`);
      setReactivateTarget(null);
      fetchVendors();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setReactivating(false);
  };

  const columns: Column<Vendor>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span className={showInactive ? 'font-medium text-secondary' : 'font-medium'}>
          {r.name}
        </span>
      ),
    },
    { key: 'contact_name', header: 'Contact', render: (r) => r.contact_name || '-' },
    { key: 'phone', header: 'Phone', render: (r) => r.phone || '-' },
    { key: 'email', header: 'Email', render: (r) => r.email || '-' },
    {
      key: 'default_payment_terms_days',
      header: 'Terms',
      render: (r) =>
        r.default_payment_terms_days != null
          ? `${r.default_payment_terms_days}d`
          : (r.default_payment_terms || '-'),
    },
    {
      key: 'id' as keyof Vendor,
      header: '',
      render: (r) => (
        <div className="flex gap-2">
          {showInactive ? (
            <button
              onClick={(e) => { e.stopPropagation(); openReactivateModal(r); }}
              className="text-crx-green hover:text-crx-green/70 flex items-center gap-1 text-sm"
              title="Reactivate"
            >
              <RotateCcw className="w-4 h-4" /> Reactivate
            </button>
          ) : (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); openEditModal(r); }}
                className="text-crx-green hover:text-crx-green/70"
                title="Edit"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); openDeleteModal(r); }}
                className="text-red-600 hover:text-red-700"
                title="Deactivate"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Vendors"
        subtitle="Manage suppliers for purchase orders and bills."
        actions={(
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => setShowInactive(!showInactive)}>
              {showInactive ? 'Show Active' : 'Show Inactive'}
            </Button>
            {!showInactive && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={openCreateModal}>
                Add Vendor
              </Button>
            )}
          </div>
        )}
      />

      <Card>
        {!loading && vendors.length === 0 ? (
          <div className="text-center py-10 text-secondary text-sm">
            {showInactive
              ? 'No inactive vendors.'
              : 'No vendors yet. Add your first vendor to get started.'}
          </div>
        ) : (
          <DataTable<Vendor> data={vendors} columns={columns} loading={loading} />
        )}
      </Card>

      {/* Create / Edit modal */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={editingId ? 'Edit Vendor' : 'Add Vendor'}
      >
        <div className="space-y-4">
          <Input
            label="Name (required)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Contact Name"
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            />
            <Input
              label="Phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <Input
              label="Email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Input
              label="Payment Terms (text)"
              value={form.default_payment_terms}
              onChange={(e) => setForm({ ...form, default_payment_terms: e.target.value })}
              placeholder="e.g. Net 30"
            />
            <Input
              label="Payment Terms (days)"
              type="number"
              value={form.default_payment_terms_days}
              onChange={(e) => setForm({ ...form, default_payment_terms_days: e.target.value })}
              placeholder="30"
            />
          </div>
          <Input
            label="Address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
          <Input
            label="Notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setEditModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={saving}>
              {editingId ? 'Save Changes' : 'Create Vendor'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Deactivate confirmation */}
      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Deactivate Vendor"
        message={
          deleteTarget
            ? `Deactivate vendor "${deleteTarget.name}"? They are hidden from lists but all history is kept, and you can reactivate them anytime. Refused if any unpaid bills exist.`
            : ''
        }
        confirmLabel="Deactivate"
        loading={deleting}
        variant="danger"
      />

      {/* Reactivate confirmation */}
      <ConfirmModal
        open={reactivateTarget !== null}
        onClose={() => setReactivateTarget(null)}
        onConfirm={handleReactivate}
        title="Reactivate Vendor"
        message={
          reactivateTarget
            ? `Reactivate vendor "${reactivateTarget.name}"? They become available again for bills and payments. Blocked if an active vendor already uses the same name.`
            : ''
        }
        confirmLabel="Reactivate"
        loading={reactivating}
        variant="info"
        icon={RotateCcw}
      />
    </div>
  );
}
