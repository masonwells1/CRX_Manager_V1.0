import { useEffect, useMemo, useRef, useState } from 'react';
import { PhoneCall } from 'lucide-react';
import { checkMutationResult, supabase } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { Sentry } from '../../lib/sentry';
import type { CustomerContact, InteractionDirection, InteractionOutcome, InteractionType } from '../../types';

// Only these two fields are read from profile_public_view (assignee picker).
type AssigneeOption = { id: string; full_name: string | null };
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';

interface LogInteractionModalProps { open: boolean; onClose: () => void; customerId: string; userId: string; customerName: string; onLogged?: () => void; }
const types: InteractionType[] = ['call', 'visit', 'meeting', 'text', 'email', 'voicemail'];
const directions: InteractionDirection[] = ['outbound', 'inbound'];
const outcomes: InteractionOutcome[] = ['connected', 'left_voicemail', 'no_answer', 'busy', 'follow_up_needed', 'order_placed', 'resolved', 'other'];
const contactsTable = () => supabase.from('customer_contacts');
const interactionsTable = () => supabase.from('customer_interactions');
const toLocalInput = () => { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };

export default function LogInteractionModal({ open, onClose, customerId, userId, customerName, onLogged }: LogInteractionModalProps) {
  const { toast } = useToast(); const summaryRef = useRef<HTMLTextAreaElement>(null);
  const [contacts, setContacts] = useState<CustomerContact[]>([]); const [profiles, setProfiles] = useState<AssigneeOption[]>([]);
  const [contactId, setContactId] = useState(''); const [type, setType] = useState<InteractionType>('call'); const [direction, setDirection] = useState<InteractionDirection>('outbound'); const [outcome, setOutcome] = useState<InteractionOutcome | null>(null); const [occurredAt, setOccurredAt] = useState(toLocalInput()); const [minutes, setMinutes] = useState(''); const [summary, setSummary] = useState(''); const [followUp, setFollowUp] = useState(false); const [followTitle, setFollowTitle] = useState(''); const [assignedTo, setAssignedTo] = useState(''); const [dueDate, setDueDate] = useState(''); const [saving, setSaving] = useState(false);
  const selectedContact = useMemo(() => contacts.find((contact) => contact.id === contactId), [contacts, contactId]);
  useEffect(() => { if (!open) return; void (async () => { const [{ data: contactData }, { data: profileData }] = await Promise.all([contactsTable().select('*').eq('customer_id', customerId).eq('is_active', true).order('is_primary', { ascending: false }).order('name'), supabase.from('profile_public_view').select('id, full_name, role, is_active').eq('is_active', true).neq('role', 'entity_recipient').order('full_name')]); const loadedContacts = (contactData || []) as CustomerContact[]; setContacts(loadedContacts); setProfiles((profileData || []).flatMap((row) => (row.id !== null ? [{ id: row.id, full_name: row.full_name }] : []))); setContactId(loadedContacts.find((contact) => contact.is_primary)?.id || ''); setType('call'); setDirection('outbound'); setOutcome(null); setOccurredAt(toLocalInput()); setMinutes(''); setSummary(''); setFollowUp(false); setFollowTitle(''); setAssignedTo(''); setDueDate(''); setTimeout(() => summaryRef.current?.focus(), 0); })(); }, [open, customerId]);
  const save = async () => {
    if (!summary.trim()) { toast('error', 'Add a short call summary'); return; }
    if (followUp && !followTitle.trim()) { toast('error', 'Add a follow-up title'); return; }
    // Build + validate the occurred_at ISO string BEFORE any write: an empty or
    // unparseable datetime-local value must abort with zero rows written.
    const occurredDate = new Date(occurredAt);
    if (!occurredAt || Number.isNaN(occurredDate.getTime())) { toast('error', 'Enter a valid date and time for this interaction'); return; }
    const occurredAtIso = occurredDate.toISOString();
    const duration = minutes.trim() ? Math.round(Number(minutes) * 60) : null;
    if (duration !== null && (!Number.isFinite(duration) || duration < 0)) { toast('error', 'Duration must be a positive number of minutes'); return; }
    setSaving(true);
    try {
      // The interaction is the record of truth — write it FIRST. The follow-up
      // todo is a best-effort convenience created afterward.
      const interactionResult = await interactionsTable().insert({ customer_id: customerId, contact_id: contactId || null, interaction_type: type, direction, source: 'rep', occurred_at: occurredAtIso, duration_seconds: duration, outcome, summary: summary.trim(), owner_user_id: userId, created_by: userId }).select();
      checkMutationResult(interactionResult, 'log interaction');
      const interactionId = interactionResult.data?.[0]?.id;
      await logActivity({ event: 'call_logged', description: `${type === 'call' ? 'Logged call' : `Logged ${type}`} — ${outcome ? outcome.replace(/_/g, ' ') : 'no outcome'}`, performedBy: userId, entityType: 'customer_interaction', entityId: interactionId, customerId });
      if (followUp) {
        // If the follow-up insert fails AFTER the interaction committed, do not
        // throw it away — warn and still finish the log.
        try {
          const noteResult = await supabase.from('team_notes').insert({ title: followTitle.trim(), content: `Follow-up from ${type} with ${selectedContact?.name || customerName}: ${summary.trim()}`, note_type: 'todo', priority: 'medium', assigned_to: assignedTo || null, due_date: dueDate || null, created_by: userId, linked_entity_type: 'customer', linked_entity_id: customerId }).select();
          checkMutationResult(noteResult, 'create interaction follow-up');
        } catch (noteError: unknown) {
          Sentry.captureException(noteError instanceof Error ? noteError : new Error(String(noteError)), { extra: { context: 'LogInteractionModal.followUp' } });
          toast('warning', 'Call logged, but the follow-up could not be created — add it manually');
          onLogged?.();
          onClose();
          return;
        }
      }
      toast('success', 'Interaction logged');
      onLogged?.();
      onClose();
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'LogInteractionModal.save' } });
      toast('error', error instanceof Error ? error.message : 'Failed to log interaction');
    } finally { setSaving(false); }
  };
  const chips = <T extends string>(options: T[], value: T | null, onChange: (item: T) => void) => <div className="flex flex-wrap gap-2">{options.map((item) => <button type="button" key={item} onClick={() => onChange(item)} className={`min-h-11 rounded-lg px-3 text-sm capitalize ${value === item ? 'bg-crx-green text-white' : 'border border-gray-200 text-secondary'}`}>{item.replace(/_/g, ' ')}</button>)}</div>;
  return <Modal open={open} onClose={onClose} title="Log" accent="Interaction" size="large" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} icon={<PhoneCall className="w-4 h-4" />} showChevron={false} onClick={() => void save()}>Log Call</Button></div>}><div className="space-y-5"><div><label className="mb-1 block text-sm font-medium text-secondary">Contact <span className="font-normal">(optional)</span></label><select value={contactId} onChange={(event) => setContactId(event.target.value)} className="w-full min-h-11 rounded-lg border border-gray-200 px-3 text-sm"><option value="">No contact selected</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name || contact.phone_display || contact.email || 'Unnamed contact'}{contact.is_primary ? ' (Primary)' : ''}</option>)}</select></div><div><p className="mb-2 text-sm font-medium text-secondary">Type</p>{chips(types, type, setType)}</div><div><p className="mb-2 text-sm font-medium text-secondary">Direction</p>{chips(directions, direction, setDirection)}</div><div><p className="mb-2 text-sm font-medium text-secondary">Outcome</p>{chips(outcomes, outcome, setOutcome)}</div><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><Input label="When" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /><Input label="Duration (minutes)" type="number" min="0" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></div><div><label className="mb-1 block text-sm font-medium text-secondary">Summary</label><textarea ref={summaryRef} value={summary} onChange={(event) => setSummary(event.target.value)} rows={4} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20" /></div><div className="rounded-lg border border-gray-200 p-3"><label className="flex min-h-11 items-center gap-2 text-sm font-medium text-nav-dark"><input type="checkbox" checked={followUp} onChange={() => setFollowUp(!followUp)} className="h-4 w-4 accent-crx-green" />Create follow-up</label>{followUp && <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Title" value={followTitle} onChange={(event) => setFollowTitle(event.target.value)} /><div><label className="mb-1 block text-sm font-medium text-secondary">Assignee</label><select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} className="w-full min-h-11 rounded-lg border border-gray-200 px-3 text-sm"><option value="">Unassigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.full_name}</option>)}</select></div><Input label="Due date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></div>}</div></div></Modal>;
}
