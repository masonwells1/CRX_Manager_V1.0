import { useEffect, useState } from 'react';
import { Plus, CheckSquare, Square, Pin, PinOff, Clock, Pencil, Trash2, MessageCircle, Tag as TagIcon, Activity } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { useRealtimeNotes } from '../hooks/useRealtimeSubscription';
import TeamBoardFilters, { FilterState } from '../components/team/TeamBoardFilters';
import CommentsSection from '../components/team/CommentsSection';
import TagsManager from '../components/team/TagsManager';
import ActivityFeed from '../components/team/ActivityFeed';
import type { TeamNote, Profile, NoteType, NotePriority } from '../types';
import { useSearchParams } from 'react-router-dom';

const priorityVariant: Record<NotePriority, 'default' | 'info' | 'warning' | 'error'> = {
  low: 'default',
  medium: 'info',
  high: 'warning',
  urgent: 'error',
};

interface ExtendedTeamNote extends TeamNote {
  tags?: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  comment_count?: number;
}

export default function TeamBoard() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notes, setNotes] = useState<ExtendedTeamNote[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedNote, setSelectedNote] = useState<ExtendedTeamNote | null>(null);
  const [editingNote, setEditingNote] = useState<TeamNote | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('note');
  const [priority, setPriority] = useState<NotePriority>('medium');
  const [assignedTo, setAssignedTo] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'comments' | 'activity'>('comments');

  const [filters, setFilters] = useState<FilterState>({
    search: '',
    tags: [],
    assignees: [],
    priorities: [],
    showCompleted: false,
  });

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchNotes();
    fetchProfiles();

    const noteId = searchParams.get('note');
    if (noteId) {
      openNoteDetail(noteId);
    }
  }, [searchParams]);

  useRealtimeNotes(() => {
    fetchNotes();
  });

  const fetchProfiles = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('is_active', true).order('full_name');
    setProfiles((data || []) as Profile[]);
  };

  const fetchNotes = async () => {
    const { data: notesData } = await supabase
      .from('team_notes')
      .select('*, creator:profiles!team_notes_created_by_fkey(full_name), assignee:profiles!team_notes_assigned_to_fkey(full_name)')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });

    if (notesData) {
      const notesWithExtras = await Promise.all(
        notesData.map(async (note) => {
          const { data: tags } = await supabase
            .from('team_note_tags')
            .select('tag_id, note_tags(id, name, color)')
            .eq('note_id', note.id);

          const { count: commentCount } = await supabase
            .from('team_note_comments')
            .select('*', { count: 'exact', head: true })
            .eq('note_id', note.id)
            .is('deleted_at', null);

          return {
            ...note,
            tags: tags?.map((t: any) => t.note_tags).filter(Boolean) || [],
            comment_count: commentCount || 0,
          };
        })
      );

      setNotes(notesWithExtras as ExtendedTeamNote[]);
    }
    setLoading(false);
  };

  const openNoteDetail = async (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    if (note) {
      setSelectedNote(note);
      setDetailModalOpen(true);
      setSearchParams({});
    }
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

  const applyFilters = (notes: ExtendedTeamNote[]): ExtendedTeamNote[] => {
    return notes.filter(note => {
      if (!filters.showCompleted && note.is_completed) return false;

      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const matchesTitle = note.title.toLowerCase().includes(searchLower);
        const matchesContent = note.content?.toLowerCase().includes(searchLower);
        if (!matchesTitle && !matchesContent) return false;
      }

      if (filters.tags.length > 0) {
        const noteTags = note.tags?.map(t => t.id) || [];
        const hasTag = filters.tags.some(tagId => noteTags.includes(tagId));
        if (!hasTag) return false;
      }

      if (filters.assignees.length > 0) {
        const isUnassigned = !note.assigned_to;
        const matchesUnassigned = filters.assignees.includes('unassigned') && isUnassigned;
        const matchesAssignee = note.assigned_to && filters.assignees.includes(note.assigned_to);
        if (!matchesUnassigned && !matchesAssignee) return false;
      }

      if (filters.priorities.length > 0) {
        if (!filters.priorities.includes(note.priority)) return false;
      }

      return true;
    });
  };

  const notesByType = (type: NoteType) => applyFilters(notes).filter((n) => n.note_type === type);
  const getName = (p: TeamNote['creator']) => (p as unknown as { full_name: string })?.full_name || '';

  const renderCard = (note: ExtendedTeamNote, showCheckbox: boolean) => (
    <div
      key={note.id}
      className={`p-4 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors group cursor-pointer ${
        note.is_completed ? 'opacity-60' : ''
      }`}
      onClick={() => {
        setSelectedNote(note);
        setDetailModalOpen(true);
      }}
    >
      <div className="flex items-start gap-3">
        {showCheckbox && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleComplete(note); }}
            className="mt-0.5 text-secondary hover:text-crx-green"
          >
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
          {note.tags && note.tags.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {note.tags.map(tag => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                  style={{
                    backgroundColor: `${tag.color}15`,
                    color: tag.color,
                    border: `1px solid ${tag.color}30`,
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </div>
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
            {note.comment_count !== undefined && note.comment_count > 0 && (
              <span className="flex items-center gap-1 text-crx-green">
                <MessageCircle className="w-3 h-3" />
                {note.comment_count}
              </span>
            )}
          </div>
        </div>
        {canEdit(note) && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); togglePin(note); }}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-amber-500"
              title={note.is_pinned ? 'Unpin' : 'Pin'}
            >
              {note.is_pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); openEditModal(note); }}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-blue-500"
              title="Edit"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(note.id); }}
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
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1">
          <TeamBoardFilters filters={filters} onChange={setFilters} />
        </div>
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
        open={detailModalOpen}
        onClose={() => { setDetailModalOpen(false); setSelectedNote(null); }}
        title={selectedNote?.title || 'Note Details'}
        size="large"
      >
        {selectedNote && (
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant={priorityVariant[selectedNote.priority]}>{selectedNote.priority}</Badge>
                <Badge variant="default">{selectedNote.note_type}</Badge>
                {selectedNote.is_completed && <Badge variant="info">Completed</Badge>}
              </div>
              {selectedNote.content && (
                <p className="text-sm text-secondary whitespace-pre-wrap">{selectedNote.content}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-gray-400">
                {getName(selectedNote.creator) && <span>Created by {getName(selectedNote.creator)}</span>}
                {getName(selectedNote.assignee) && (
                  <span className="text-crx-green">Assigned to {getName(selectedNote.assignee)}</span>
                )}
                {selectedNote.due_date && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Due {new Date(selectedNote.due_date).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>

            <TagsManager noteId={selectedNote.id} onTagsChange={fetchNotes} />

            <div className="border-t border-gray-200">
              <div className="flex border-b border-gray-200">
                <button
                  onClick={() => setActiveTab('comments')}
                  className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === 'comments'
                      ? 'text-crx-green border-b-2 border-crx-green'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <div className="flex items-center justify-center gap-2">
                    <MessageCircle className="w-4 h-4" />
                    Comments
                    {selectedNote.comment_count !== undefined && selectedNote.comment_count > 0 && (
                      <span className="px-1.5 py-0.5 bg-crx-green/10 text-crx-green rounded-full text-xs font-semibold">
                        {selectedNote.comment_count}
                      </span>
                    )}
                  </div>
                </button>
                <button
                  onClick={() => setActiveTab('activity')}
                  className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                    activeTab === 'activity'
                      ? 'text-crx-green border-b-2 border-crx-green'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <div className="flex items-center justify-center gap-2">
                    <Activity className="w-4 h-4" />
                    Activity
                  </div>
                </button>
              </div>
              <div className="mt-4">
                {activeTab === 'comments' ? (
                  <CommentsSection noteId={selectedNote.id} noteTitle={selectedNote.title} />
                ) : (
                  <ActivityFeed noteId={selectedNote.id} />
                )}
              </div>
            </div>
          </div>
        )}
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
