import { useEffect, useState } from 'react';
import { Plus, CheckSquare, Square, Pin, PinOff, Clock, Pencil, Trash2 } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { TeamNote, Profile, NoteType, NotePriority } from '../types';

const priorityVariant: Record<NotePriority, 'default' | 'info' | 'warning' | 'error'> = {
  low: 'default',
  medium: 'info',
  high: 'warning',
  urgent: 'error',
};

export default function TeamBoard() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const [notes, setNotes] = useState<TeamNote[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<TeamNote | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('note');
  const [priority, setPriority] = useState<NotePriority>('medium');
  const [assignedTo, setAssignedTo] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchNotes();
    fetchProfiles();
  }, []);

  const fetchProfiles = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('is_active', true).order('full_name');
    setProfiles((data || []) as Profile[]);
  };

  const fetchNotes = async () => {
    const { data } = await supabase
      .from('team_notes')
      .select('*, creator:profiles!team_notes_created_by_fkey(full_name), assignee:profiles!team_notes_assigned_to_fkey(full_name)')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });
    setNotes((data || []) as TeamNote[]);
    setLoading(false);
  };

  const resetForm = () => {
    setTitle('');
    setContent('');
    setNoteType('note');
    setPriority('medium');
    setAssignedTo('');
    setDueDate('');
    setEditingNote(null);
  };

  const openAddModal = () => {
    resetForm();
    setModalOpen(true);
  };

  const openEditModal = (note: TeamNote) => {
    setEditingNote(note);
    setTitle(note.title);
    setContent(note.content || '');
    setNoteType(note.note_type);
    setPriority(note.priority);
    setAssignedTo(note.assigned_to || '');
    setDueDate(note.due_date || '');
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);

    if (editingNote) {
      const { error } = await supabase
        .from('team_notes')
        .update({
          title,
          content: content || null,
          note_type: noteType,
          priority,
          assigned_to: assignedTo || null,
          due_date: dueDate || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingNote.id);
      if (error) {
        toast('error', 'Failed to update note');
      } else {
        toast('success', 'Note updated');
        setModalOpen(false);
        resetForm();
        fetchNotes();
      }
    } else {
      const { error } = await supabase.from('team_notes').insert({
        title,
        content: content || null,
        note_type: noteType,
        priority,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        created_by: profile!.id,
      });
      if (error) {
        toast('error', 'Failed to add note');
      } else {
        toast('success', 'Note added');
        setModalOpen(false);
        resetForm();
        fetchNotes();
      }
    }
    setSaving(false);
  };

  const handleDelete = async (noteId: string) => {
    const { error } = await supabase.from('team_notes').delete().eq('id', noteId);
    if (error) {
      toast('error', 'Failed to delete note');
    } else {
      toast('success', 'Note deleted');
      fetchNotes();
    }
    setDeleteConfirmId(null);
  };

  const toggleComplete = async (note: TeamNote) => {
    const { error } = await supabase
      .from('team_notes')
      .update({
        is_completed: !note.is_completed,
        completed_by: !note.is_completed ? profile!.id : null,
        completed_at: !note.is_completed ? new Date().toISOString() : null,
      })
      .eq('id', note.id);
    if (!error) fetchNotes();
  };

  const togglePin = async (note: TeamNote) => {
    const { error } = await supabase
      .from('team_notes')
      .update({ is_pinned: !note.is_pinned })
      .eq('id', note.id);
    if (!error) fetchNotes();
  };

  const canEdit = (note: TeamNote) => isAdmin || note.created_by === profile?.id;

  const notesByType = (type: NoteType) => notes.filter((n) => n.note_type === type);
  const getName = (p: TeamNote['creator']) => (p as unknown as { full_name: string })?.full_name || '';

  const renderCard = (note: TeamNote, showCheckbox: boolean) => (
    <div
      key={note.id}
      className={`p-4 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors group ${
        note.is_completed ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        {showCheckbox && (
          <button onClick={() => toggleComplete(note)} className="mt-0.5 text-secondary hover:text-crx-green">
            {note.is_completed ? <CheckSquare className="w-5 h-5 text-crx-green" /> : <Square className="w-5 h-5" />}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {note.is_pinned && <Pin className="w-3.5 h-3.5 text-amber-500" />}
            <h4 className={`text-sm font-medium text-nav-dark ${note.is_completed ? 'line-through' : ''}`}>
              {note.title}
            </h4>
            <Badge variant={priorityVariant[note.priority]}>{note.priority}</Badge>
          </div>
          {note.content && (
            <p className="text-xs text-secondary mt-1 line-clamp-2">{note.content}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
            {getName(note.creator) && <span>{getName(note.creator)}</span>}
            {getName(note.assignee) && (
              <span className="text-crx-green">Assigned: {getName(note.assignee)}</span>
            )}
            {note.due_date && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(note.due_date).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
        {canEdit(note) && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={() => togglePin(note)}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-amber-500"
              title={note.is_pinned ? 'Unpin' : 'Pin'}
            >
              {note.is_pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => openEditModal(note)}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-500"
              title="Edit"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setDeleteConfirmId(note.id)}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-red-500"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-64 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<Plus className="w-4 h-4" />} onClick={openAddModal}>
          Add Note
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Notes" />
            <div className="space-y-3">
              {notesByType('note').length === 0 && (
                <p className="text-sm text-secondary py-4 text-center">No notes</p>
              )}
              {notesByType('note').map((n) => renderCard(n, false))}
            </div>
          </div>
        </Card>

        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="To-Do" />
            <div className="space-y-3">
              {notesByType('todo').length === 0 && (
                <p className="text-sm text-secondary py-4 text-center">No to-dos</p>
              )}
              {notesByType('todo').map((n) => renderCard(n, true))}
            </div>
          </div>
        </Card>

        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Announcements" />
            <div className="space-y-3">
              {notesByType('announcement').length === 0 && (
                <p className="text-sm text-secondary py-4 text-center">No announcements</p>
              )}
              {notesByType('announcement').map((n) => renderCard(n, false))}
            </div>
          </div>
        </Card>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); resetForm(); }}
        title={editingNote ? 'Edit' : 'Add'}
        accent="Note"
      >
        <div className="space-y-4">
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Type</label>
              <select
                value={noteType}
                onChange={(e) => setNoteType(e.target.value as NoteType)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="note">Note</option>
                <option value="todo">To-Do</option>
                <option value="announcement">Announcement</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as NotePriority)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Assign To</label>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Unassigned</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.full_name}</option>
                ))}
              </select>
            </div>
            <Input label="Due Date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</Button>
            <Button onClick={handleSave} loading={saving}>
              {editingNote ? 'Save Changes' : 'Add Note'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        title="Delete"
        accent="Note"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Are you sure you want to delete this note? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
              className="!bg-red-600 hover:!bg-red-700"
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
