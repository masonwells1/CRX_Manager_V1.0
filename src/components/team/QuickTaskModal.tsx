import { useState, useEffect } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import type { LinkedEntityType, NoteType, NotePriority, Profile } from '../../types';

interface QuickTaskModalProps {
  open: boolean;
  onClose: () => void;
  entityType: LinkedEntityType;
  entityId: string;
  prefillTitle?: string;
  prefillContent?: string;
  prefillAssignee?: string;
}

const entityDisplayNames: Record<LinkedEntityType, string> = {
  delivery: 'Delivery',
  order: 'Order',
  customer: 'Customer',
  job: 'Job',
  purchase_order: 'Purchase Order',
  quote: 'Quote',
  invoice: 'Invoice',
  product: 'Product',
};

export default function QuickTaskModal({
  open,
  onClose,
  entityType,
  entityId,
  prefillTitle = '',
  prefillContent = '',
  prefillAssignee = '',
}: QuickTaskModalProps) {
  const { profile } = useAuth();
  const { toast } = useToast();

  const [title, setTitle] = useState(prefillTitle);
  const [content, setContent] = useState(prefillContent);
  const [noteType, setNoteType] = useState<NoteType>('todo');
  const [priority, setPriority] = useState<NotePriority>('medium');
  const [assignedTo, setAssignedTo] = useState(prefillAssignee);
  const [dueDate, setDueDate] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [saving, setSaving] = useState(false);

  // Reset form when modal opens with new prefill values
  useEffect(() => {
    if (open) {
      setTitle(prefillTitle);
      setContent(prefillContent);
      setAssignedTo(prefillAssignee);
      setNoteType('todo');
      setPriority('medium');
      setDueDate('');
    }
  }, [open, prefillTitle, prefillContent, prefillAssignee]);

  // Load profiles for the assign-to dropdown
  useEffect(() => {
    if (!open) return;
    (async () => {
      // PR-07 follow-up: assignee picker only uses p.id + p.full_name; safe via view.
      const { data } = await supabase
        .from('profile_public_view')
        .select('id, full_name, role, is_active')
        .eq('is_active', true)
        .order('full_name');
      if (data) setProfiles(data as unknown as Profile[]);
    })();
  }, [open]);

  async function handleSave() {
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }
    if (!title.trim()) {
      toast('error', 'Title is required');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.from('team_notes').insert({
        title: title.trim(),
        content: content.trim() || null,
        note_type: noteType,
        priority,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        created_by: profile.id,
        linked_entity_type: entityType,
        linked_entity_id: entityId,
      });

      if (error) throw error;

      toast('success', 'Task created successfully');
      onClose();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'QuickTaskModal.handleSave' } });
      const message = err instanceof Error ? err.message : 'Failed to create task';
      toast('error', message);
    } finally {
      setSaving(false);
    }
  }

  const selectClass =
    'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green';

  return (
    <Modal open={open} onClose={onClose} title="Quick Task" accent="Note">
      <div className="space-y-4">
        {/* Entity badge */}
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg text-sm text-secondary">
          <LinkIcon className="w-4 h-4 shrink-0" />
          <span>Linked to: {entityDisplayNames[entityType]}</span>
        </div>

        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />

        <div>
          <label className="block text-sm font-medium text-secondary mb-1">Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            className={selectClass}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Type</label>
            <select value={noteType} onChange={(e) => setNoteType(e.target.value as NoteType)} className={selectClass}>
              <option value="note">Note</option>
              <option value="todo">To-Do</option>
              <option value="announcement">Announcement</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as NotePriority)} className={selectClass}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Assign To</label>
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className={selectClass}>
              <option value="">Unassigned</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
          </div>
          <Input label="Due Date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>Create Task</Button>
        </div>
      </div>
    </Modal>
  );
}
