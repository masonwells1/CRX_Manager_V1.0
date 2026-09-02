import { useCallback, useEffect, useRef, useState } from 'react';
import { Edit3, MessageCircle, Phone, Plus, Star, UserX } from 'lucide-react';
import { sanitizeError, assertRpcResult, checkMutationResult, supabase } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { Sentry } from '../../lib/sentry';
import type { CustomerContact, CustomerInteraction, InteractionOutcome, InteractionType, PreferredContactMethod } from '../../types';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import Badge from '../ui/Badge';

interface CustomerContactsProps { customerId: string; performedBy: string; }

interface ContactDraft { name: string; role: string; phone_display: string; email: string; preferred_contact_method: PreferredContactMethod | null; is_primary: boolean; can_place_orders: boolean; is_decision_maker: boolean; is_billing_contact: boolean; }

const emptyDraft: ContactDraft = { name: '', role: '', phone_display: '', email: '', preferred_contact_method: null, is_primary: false, can_place_orders: false, is_decision_maker: false, is_billing_contact: false };
const methods: PreferredContactMethod[] = ['phone', 'text', 'email'];
const interactionTypes: InteractionType[] = ['call', 'visit', 'meeting', 'text', 'email', 'voicemail'];
const interactionOutcomes: InteractionOutcome[] = ['connected', 'left_voicemail', 'no_answer', 'busy', 'follow_up_needed', 'order_placed', 'resolved', 'other'];
const contactsTable = () => supabase.from('customer_contacts');
const interactionsTable = () => supabase.from('customer_interactions');

// Mirrors public.normalize_phone_e164: strip display punctuation, accept US 10/11 digit forms or a valid E.164 value.
function normalizePhoneE164(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && /^\+[1-9]\d{7,14}$/.test(`+${digits}`)) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export default function CustomerContacts({ customerId, performedBy }: CustomerContactsProps) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [contactToDeactivate, setContactToDeactivate] = useState<CustomerContact | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [editing, setEditing] = useState<CustomerContact | null>(null);
  const [draft, setDraft] = useState<ContactDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);

  // Same stale-response discipline as the later CRM components: a slow
  // response for the previous customer must never render under this one.
  const requestSeq = useRef(0);

  const loadContacts = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const { data, error } = await contactsTable().select('*').eq('customer_id', customerId).order('is_active', { ascending: false }).order('is_primary', { ascending: false }).order('name');
      if (seq !== requestSeq.current) return;
      if (error) toast('error', 'Failed to load contacts');
      setContacts((data || []) as CustomerContact[]);
    } catch {
      if (seq === requestSeq.current) toast('error', 'Failed to load contacts');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [customerId, toast]);

  useEffect(() => { requestSeq.current += 1; setContacts([]); void loadContacts(); }, [loadContacts]);

  const begin = (contact?: CustomerContact) => {
    setEditing(contact || null);
    setDraft(contact ? {
      name: contact.name || '', role: contact.role || '', phone_display: contact.phone_display || '', email: contact.email || '',
      preferred_contact_method: contact.preferred_contact_method, is_primary: contact.is_primary, can_place_orders: contact.can_place_orders,
      is_decision_maker: contact.is_decision_maker, is_billing_contact: contact.is_billing_contact,
    } : emptyDraft);
    setOpen(true);
  };

  const save = async () => {
    if (!draft.name.trim() && !draft.phone_display.trim() && !draft.email.trim()) { toast('error', 'Add a name, phone number, or email address'); return; }
    // A customer must never be left with no primary: demotion only happens by
    // promoting someone else (the atomic RPC handles the transfer).
    if (editing?.is_primary && !draft.is_primary) { toast('error', 'To change the primary contact, promote another contact instead — every customer keeps one primary.'); return; }
    setSaving(true);
    try {
      // Promotion (making a not-already-primary contact primary) must go through
      // the atomic RPC so the (customer_id) WHERE is_primary unique index never
      // sees two primaries. Plain field edits keep the direct .update()/.insert().
      const wasPrimary = editing?.is_primary ?? false;
      const needsPromotion = draft.is_primary && !wasPrimary;
      const payload = {
        name: draft.name.trim() || null,
        role: draft.role.trim() || null,
        phone_display: draft.phone_display.trim() || null,
        phone_e164: normalizePhoneE164(draft.phone_display),
        email: draft.email.trim() || null,
        preferred_contact_method: draft.preferred_contact_method,
        can_place_orders: draft.can_place_orders,
        is_decision_maker: draft.is_decision_maker,
        is_billing_contact: draft.is_billing_contact,
        // When promoting, write the row non-primary first and let the RPC flip it.
        is_primary: needsPromotion ? false : draft.is_primary,
      };
      let contactId = editing?.id;
      if (editing) {
        // customer_id in the predicate: an edit can never touch a row outside
        // this customer, even with a stale editing reference (Sol final gauntlet).
        // When the write would set is_primary=false, also require the row to
        // CURRENTLY be non-primary: client state can be stale (another tab may
        // have promoted this contact), and the DB only enforces "at most one
        // primary", not "at least one" — a matched-0-rows loud failure beats
        // silently leaving the customer with no primary.
        let update = contactsTable().update(payload).eq('id', editing.id).eq('customer_id', customerId);
        if (payload.is_primary === false) update = update.eq('is_primary', false);
        const result = await update.select();
        checkMutationResult(result, 'update contact');
      } else {
        const result = await contactsTable().insert({ ...payload, customer_id: customerId }).select();
        checkMutationResult(result, 'add contact');
        contactId = result.data?.[0]?.id;
      }
      if (needsPromotion && contactId) {
        const { data, error } = await supabase.rpc('set_primary_customer_contact', { p_customer_id: customerId, p_contact_id: contactId });
        if (error) throw error;
        assertRpcResult<{ success: boolean; contact_id: string }>(data, 'set_primary_customer_contact');
      }
      await logActivity({ event: editing ? 'contact_updated' : 'contact_added', description: `${editing ? 'Updated' : 'Added'} contact ${draft.name.trim() || draft.phone_display.trim() || draft.email.trim()}`, performedBy, entityType: 'customer_contact', entityId: editing?.id, customerId });
      toast('success', editing ? 'Contact updated' : 'Contact added');
      setOpen(false);
      await loadContacts();
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'CustomerContacts.save' } });
      const message = error instanceof Error ? error.message : 'Failed to save contact';
      // Prefer the Postgres unique-violation code; keep the constraint-name
      // substring as a fallback for wrappers that strip the code.
      const isPrimaryConflict =
        (!!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505' && message.includes('customer_contacts'))
        || message.includes('customer_contacts_customer_id_is_primary');
      toast('error', isPrimaryConflict ? 'Only one active primary contact is allowed.' : message);
    } finally { setSaving(false); }
  };

  const requestDeactivate = (contact: CustomerContact) => {
    if (contact.is_primary) { toast('error', 'This is the primary contact — promote another contact to primary before deactivating them.'); return; }
    setContactToDeactivate(contact);
  };

  const deactivate = async () => {
    if (!contactToDeactivate) return;
    setDeactivating(true);
    try {
      // is_primary=false predicate: if this contact became primary after the
      // list rendered (stale client state), the deactivate matches 0 rows and
      // fails loudly instead of leaving the customer with no primary.
      const result = await contactsTable().update({ is_active: false, is_primary: false }).eq('id', contactToDeactivate.id).eq('customer_id', customerId).eq('is_primary', false).select();
      checkMutationResult(result, 'deactivate contact');
      toast('success', 'Contact deactivated');
      setContactToDeactivate(null);
      await loadContacts();
    } catch (error: unknown) { toast('error', sanitizeError(error)); }
    finally { setDeactivating(false); }
  };

  const toggle = (key: keyof Pick<ContactDraft, 'is_primary' | 'can_place_orders' | 'is_decision_maker' | 'is_billing_contact'>) => setDraft((current) => ({ ...current, [key]: !current[key] }));

  return <>
    <Card padding={false}>
      <div className="p-4 sm:p-5 flex items-center justify-between gap-3"><CardHeader title="Customer" accent="Contacts" /><Button size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={() => begin()}>Add Contact</Button></div>
      <ConfirmModal
        open={Boolean(contactToDeactivate)}
        onClose={() => { if (!deactivating) setContactToDeactivate(null); }}
        onConfirm={() => void deactivate()}
        title="Deactivate contact"
        message={`Deactivate ${contactToDeactivate?.name || 'this contact'}? They will stop appearing in contact pickers; promoting them to primary later reactivates them.`}
        confirmLabel="Deactivate"
        variant="danger"
        loading={deactivating}
      />
      {loading ? <div className="px-4 pb-4 space-y-2">{[1, 2].map((item) => <div key={item} className="h-20 rounded-lg bg-gray-100 animate-pulse" />)}</div> : contacts.length === 0 ? <p className="px-4 pb-5 text-sm text-secondary">No contacts yet.</p> : <div className="divide-y divide-gray-100">{contacts.map((contact) => <div key={contact.id} className={`p-4 ${contact.is_active ? '' : 'opacity-60'}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-nav-dark">{contact.name || 'Unnamed contact'}</p>{contact.is_primary && <Badge variant="success"><Star className="w-3 h-3 mr-1" />Primary</Badge>}{!contact.is_active && <Badge variant="default">Inactive</Badge>}</div><p className="text-sm text-secondary">{contact.role || 'No role listed'}</p>{contact.phone_display && <a className="mt-1 inline-flex min-h-11 items-center text-sm text-crx-green hover:underline" href={`tel:${contact.phone_e164 || contact.phone_display}`}><Phone className="mr-1 w-3.5 h-3.5" />{contact.phone_display}</a>}{contact.email && <a className="block text-sm text-crx-green hover:underline break-all" href={`mailto:${contact.email}`}>{contact.email}</a>}<div className="mt-2 flex flex-wrap gap-1">{contact.can_place_orders && <Badge variant="info">Orders</Badge>}{contact.is_decision_maker && <Badge variant="warning">Decision maker</Badge>}{contact.is_billing_contact && <Badge variant="default">Billing</Badge>}</div></div><div className="flex shrink-0 gap-1"><Button variant="ghost" size="sm" icon={<Edit3 className="w-4 h-4" />} showChevron={false} onClick={() => begin(contact)}>Edit</Button>{contact.is_active && <button type="button" className="min-h-11 px-2 text-gray-400 hover:text-red-600" aria-label={`Deactivate ${contact.name || 'contact'}`} onClick={() => requestDeactivate(contact)}><UserX className="w-4 h-4" /></button>}</div></div></div>)}</div>}
    </Card>
    <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit' : 'Add'} accent="Contact" size="large" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={saving} onClick={() => void save()}>Save Contact</Button></div>}><div className="space-y-4"><div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Input label="Name" value={draft.name || ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /><Input label="Role" value={draft.role || ''} onChange={(e) => setDraft({ ...draft, role: e.target.value })} /><Input label="Phone" value={draft.phone_display || ''} onChange={(e) => setDraft({ ...draft, phone_display: e.target.value })} /><Input label="Email" type="email" value={draft.email || ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></div><div><p className="mb-2 text-sm font-medium text-secondary">Preferred contact method</p><div className="flex flex-wrap gap-2">{methods.map((method) => <button type="button" key={method} onClick={() => setDraft({ ...draft, preferred_contact_method: draft.preferred_contact_method === method ? null : method })} className={`min-h-11 rounded-lg px-3 text-sm capitalize ${draft.preferred_contact_method === method ? 'bg-crx-green text-white' : 'border border-gray-200 text-secondary'}`}>{method}</button>)}</div></div><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{([{ key: 'is_primary', label: 'Primary contact' }, { key: 'can_place_orders', label: 'Can place orders' }, { key: 'is_decision_maker', label: 'Decision maker' }, { key: 'is_billing_contact', label: 'Billing contact' }] as const).map(({ key, label }) => <label key={key} className="flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-sm text-nav-dark"><input type="checkbox" checked={draft[key]} onChange={() => toggle(key)} className="h-4 w-4 accent-crx-green" />{label}</label>)}</div></div></Modal>
  </>;
}

interface CustomerInteractionsHistoryProps { customerId: string; }

export function CustomerInteractionsHistory({ customerId }: CustomerInteractionsHistoryProps) {
  const { toast } = useToast();
  const [interactions, setInteractions] = useState<CustomerInteraction[]>([]);
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [typeFilter, setTypeFilter] = useState<InteractionType | ''>('');
  const [outcomeFilter, setOutcomeFilter] = useState<InteractionOutcome | ''>('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { void (async () => {
    setLoading(true);
    const [{ data: interactionData, error }, { data: contactData }] = await Promise.all([
      interactionsTable().select('*').eq('customer_id', customerId).order('occurred_at', { ascending: false }).limit(50),
      contactsTable().select('*').eq('customer_id', customerId),
    ]);
    if (error) toast('error', 'Failed to load interactions');
    const loadedInteractions = (interactionData || []) as CustomerInteraction[];
    setInteractions(loadedInteractions); setContacts((contactData || []) as CustomerContact[]);
    const ownerIds = [...new Set(loadedInteractions.map((item) => item.owner_user_id).filter((value): value is string => Boolean(value)))];
    if (ownerIds.length) { const { data } = await supabase.from('profile_public_view').select('id, full_name').in('id', ownerIds); setNames(Object.fromEntries((data || []).filter((profile): profile is { id: string; full_name: string | null } => Boolean(profile.id)).map((profile) => [profile.id, profile.full_name || 'Unknown user']))); }
    setLoading(false);
  })(); }, [customerId, toast]);
  const relative = (value: string) => { const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000); if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes}m ago`; const hours = Math.round(minutes / 60); if (hours < 24) return `${hours}h ago`; return new Date(value).toLocaleDateString(); };
  const visible = interactions.filter((item) => (!typeFilter || item.interaction_type === typeFilter) && (!outcomeFilter || item.outcome === outcomeFilter));
  return <Card padding={false}><div className="p-4 sm:p-5"><CardHeader title="Interaction" accent="History" /><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><select aria-label="Filter interaction type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as InteractionType | '')} className="min-h-11 rounded-lg border border-gray-200 px-3 text-sm"><option value="">All types</option>{interactionTypes.map((item) => <option key={item} value={item}>{item}</option>)}</select><select aria-label="Filter interaction outcome" value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value as InteractionOutcome | '')} className="min-h-11 rounded-lg border border-gray-200 px-3 text-sm"><option value="">All outcomes</option>{interactionOutcomes.map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}</select></div></div>{loading ? <div className="px-4 pb-4 space-y-2">{[1, 2].map((item) => <div key={item} className="h-16 rounded-lg bg-gray-100 animate-pulse" />)}</div> : visible.length === 0 ? <p className="px-4 pb-5 text-sm text-secondary">No interactions match these filters.</p> : <div className="divide-y divide-gray-100">{visible.map((item) => { const contact = contacts.find((row) => row.id === item.contact_id); return <div key={item.id} className="p-4"><div className="flex gap-3"><MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-crx-green" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium capitalize text-nav-dark">{item.interaction_type}</span>{item.direction && <Badge variant="default">{item.direction}</Badge>}{item.outcome && <Badge variant="info">{item.outcome.replace(/_/g, ' ')}</Badge>}</div><p className="mt-1 text-sm text-secondary">{contact?.name || 'No contact selected'} · {names[item.owner_user_id || ''] || 'Unknown user'} · {relative(item.occurred_at)}</p>{item.summary && <p className="mt-2 whitespace-pre-wrap text-sm text-nav-dark">{item.summary}</p>}</div></div></div>; })}</div>}</Card>;
}
