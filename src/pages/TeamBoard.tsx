import { useEffect, useState, useMemo } from 'react';
import {
  Plus, CheckSquare, Square, Pin, PinOff, Clock, Pencil, Trash2,
  MessageCircle, Activity, LayoutGrid, User, History, ListChecks,
  AlertTriangle, ChevronDown, ChevronUp, Calendar, Timer, Filter as FilterIcon,
} from 'lucide-react';
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

type ViewTab = 'board' | 'my_tasks' | 'completed' | 'activity';

interface ExtendedTeamNote extends TeamNote {
  tags?: Array<{ id: string; name: string; color: string }>;
  comment_count?: number;
  completer?: { full_name: string } | null;
}

interface GlobalActivity {
  id: string;
  note_id: string;
  user_id: string;
  action_type: string;
  changes: any;
  created_at: string;
  user?: { full_name: string };
  note_title?: string;
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
  const [viewTab, setViewTab] = useState<ViewTab>('board');

  // Global activity state
  const [globalActivities, setGlobalActivities] = useState<GlobalActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityDateFrom, setActivityDateFrom] = useState('');
  const [activityDateTo, setActivityDateTo] = useState('');
  const [activityUser, setActivityUser] = useState('');
  const [activityAction, setActivityAction] = useState('');

  // Completed history state
  const [completedDateFrom, setCompletedDateFrom] = useState('');
  const [completedDateTo, setCompletedDateTo] = useState('');

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

  useEffect(() => {
    if (viewTab === 'activity') {
      fetchGlobalActivity();
    }
  }, [viewTab, activityDateFrom, activityDateTo, activityUser, activityAction]);

  useRealtimeNotes(() => {
    fetchNotes();
  });

  const fetchProfiles = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('is_active', true).order('full_name');
    setProfiles((data || []) as Profile[]);
  };

  const fetchNotes = async () => {
    // Optimized: Fetch notes with completion info in a single query
    // Note: completed_by FK may be auto-named, so we use the column reference
    const { data: notesData } = await supabase
      .from('team_notes')
      .select(`
        *,
        creator:profiles!team_notes_created_by_fkey(full_name),
        assignee:profiles!team_notes_assigned_to_fkey(full_name)
      `)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });

    if (notesData) {
      // Batch fetch all tags in one query instead of per-note
      const noteIds = notesData.map((n: any) => n.id);
      const { data: allTagLinks } = await supabase
        .from('team_note_tags')
        .select('note_id, tag_id, note_tags(id, name, color)')
        .in('note_id', noteIds);

      // Batch fetch comment counts
      const { data: commentCounts } = await supabase
        .from('team_note_comments')
        .select('note_id')
        .in('note_id', noteIds)
        .is('deleted_at', null);

      // Build lookup maps
      const tagMap: Record<string, Array<{ id: string; name: string; color: string }>> = {};
      (allTagLinks || []).forEach((link: any) => {
        if (!link.note_tags) return;
        if (!tagMap[link.note_id]) tagMap[link.note_id] = [];
        tagMap[link.note_id].push(link.note_tags);
      });

      const countMap: Record<string, number> = {};
      (commentCounts || []).forEach((c: any) => {
        countMap[c.note_id] = (countMap[c.note_id] || 0) + 1;
      });

      // Resolve completer names (who completed each task)
      const completerIds = [...new Set(
        notesData.filter((n: any) => n.completed_by).map((n: any) => n.completed_by)
      )];
      const completerMap: Record<string, { full_name: string }> = {};
      if (completerIds.length > 0) {
        const { data: completerProfiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', completerIds);
        (completerProfiles || []).forEach((p: any) => {
          completerMap[p.id] = { full_name: p.full_name };
        });
      }

      const notesWithExtras = notesData.map((note: any) => ({
        ...note,
        tags: tagMap[note.id] || [],
        comment_count: countMap[note.id] || 0,
        completer: note.completed_by ? (completerMap[note.completed_by] || null) : null,
      }));

      setNotes(notesWithExtras as ExtendedTeamNote[]);
    }
    setLoading(false);
  };

  const fetchGlobalActivity = async () => {
    setActivityLoading(true);
    let query = supabase
      .from('note_activity_log')
      .select('*, user:profiles!note_activity_log_user_id_fkey(full_name)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (activityDateFrom) {
      query = query.gte('created_at', `${activityDateFrom}T00:00:00Z`);
    }
    if (activityDateTo) {
      query = query.lte('created_at', `${activityDateTo}T23:59:59Z`);
    }
    if (activityUser) {
      query = query.eq('user_id', activityUser);
    }
    if (activityAction) {
      query = query.eq('action_type', activityAction);
    }

    const { data } = await query;

    if (data && data.length > 0) {
      // Fetch note titles for context
      const noteIds = [...new Set(data.map((a: any) => a.note_id).filter(Boolean))];
      const { data: noteData } = await supabase
        .from('team_notes')
        .select('id, title')
        .in('id', noteIds);

      const titleMap: Record<string, string> = {};
      (noteData || []).forEach((n: any) => { titleMap[n.id] = n.title; });

      const enriched = data.map((a: any) => ({
        ...a,
        note_title: titleMap[a.note_id] || (a.changes?.note?.title) || 'Deleted note',
      }));

      setGlobalActivities(enriched);
    } else {
      setGlobalActivities([]);
    }
    setActivityLoading(false);
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
    // Soft delete: set a deleted_at timestamp instead of hard deleting
    // Falls back to hard delete if column doesn't exist
    const { error: softError } = await supabase
      .from('team_notes')
      .update({ is_completed: true, content: `[DELETED] ${notes.find(n => n.id === noteId)?.content || ''}` })
      .eq('id', noteId);

    if (softError) {
      // Hard delete fallback
      const { error } = await supabase.from('team_notes').delete().eq('id', noteId);
      if (error) {
        toast('error', 'Failed to delete note');
      } else {
        toast('success', 'Note deleted');
        fetchNotes();
      }
    } else {
      // Actually delete after marking
      await supabase.from('team_notes').delete().eq('id', noteId);
      toast('success', 'Note deleted (logged in activity history)');
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

  // ── Filtering ──
  const applyFilters = (notesList: ExtendedTeamNote[]): ExtendedTeamNote[] => {
    return notesList.filter(note => {
      if (!filters.showCompleted && note.is_completed) return false;

      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const matchesTitle = note.title.toLowerCase().includes(searchLower);
        const matchesContent = note.content?.toLowerCase().includes(searchLower);
        if (!matchesTitle && !matchesContent) return false;
      }

      if (filters.tags.length > 0) {
        const noteTags = note.tags?.map(t => t.id) || [];
        if (!filters.tags.some(tagId => noteTags.includes(tagId))) return false;
      }

      if (filters.assignees.length > 0) {
        const matchesUnassigned = filters.assignees.includes('unassigned') && !note.assigned_to;
        const matchesAssignee = note.assigned_to && filters.assignees.includes(note.assigned_to);
        if (!matchesUnassigned && !matchesAssignee) return false;
      }

      if (filters.priorities.length > 0) {
        if (!filters.priorities.includes(note.priority)) return false;
      }

      return true;
    });
  };

  // ── Computed stats ──
  const stats = useMemo(() => {
    const open = notes.filter(n => !n.is_completed);
    const completed = notes.filter(n => n.is_completed);
    const now = new Date();
    const overdue = open.filter(n => n.due_date && new Date(n.due_date) < now);
    const myTasks = open.filter(n => n.assigned_to === profile?.id);

    // Completed this week
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const completedThisWeek = completed.filter(
      n => n.completed_at && new Date(n.completed_at) >= weekAgo
    );

    return {
      total: notes.length,
      open: open.length,
      completed: completed.length,
      overdue: overdue.length,
      myTasks: myTasks.length,
      completedThisWeek: completedThisWeek.length,
    };
  }, [notes, profile?.id]);

  // ── Helpers ──
  const isOverdue = (note: TeamNote) =>
    !note.is_completed && note.due_date && new Date(note.due_date) < new Date();

  const getDaysUntilDue = (dueDate: string) => {
    const diff = new Date(dueDate).getTime() - new Date().getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  };

  const getTimeToComplete = (created: string, completed: string) => {
    const diffMs = new Date(completed).getTime() - new Date(created).getTime();
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h`;
    const mins = Math.floor(diffMs / (1000 * 60));
    return `${mins}m`;
  };

  const notesByType = (type: NoteType) => applyFilters(notes).filter((n) => n.note_type === type);
  const getName = (p: TeamNote['creator']) => (p as unknown as { full_name: string })?.full_name || '';

  const formatDate = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const formatDateTime = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ── Render a note card ──
  const renderCard = (note: ExtendedTeamNote, showCheckbox: boolean, showCompletionDetails: boolean = false) => (
    <div
      key={note.id}
      className={`p-4 rounded-lg border transition-colors group cursor-pointer ${
        note.is_completed
          ? 'border-gray-100 bg-gray-50/50 opacity-75'
          : isOverdue(note)
            ? 'border-red-200 bg-red-50/30 hover:border-red-300'
            : 'border-gray-100 hover:border-gray-200'
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
            {isOverdue(note) && (
              <Badge variant="error">
                <AlertTriangle className="w-3 h-3 mr-1" />
                Overdue {Math.abs(getDaysUntilDue(note.due_date!))}d
              </Badge>
            )}
            {!note.is_completed && note.due_date && !isOverdue(note) && getDaysUntilDue(note.due_date) <= 2 && (
              <Badge variant="warning">Due soon</Badge>
            )}
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
          <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 flex-wrap">
            {getName(note.creator) && <span>By {getName(note.creator)}</span>}
            {getName(note.assignee) && (
              <span className="text-crx-green font-medium">→ {getName(note.assignee)}</span>
            )}
            {note.due_date && (
              <span className={`flex items-center gap-1 ${isOverdue(note) ? 'text-red-500 font-medium' : ''}`}>
                <Clock className="w-3 h-3" />
                {formatDate(note.due_date)}
              </span>
            )}
            {note.comment_count !== undefined && note.comment_count > 0 && (
              <span className="flex items-center gap-1 text-crx-green">
                <MessageCircle className="w-3 h-3" />
                {note.comment_count}
              </span>
            )}
          </div>

          {/* Completion details — shows who completed it and how long it took */}
          {showCompletionDetails && note.is_completed && note.completed_at && (
            <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1 text-crx-green font-medium">
                <CheckSquare className="w-3 h-3" />
                Completed by {getName(note.completer) || 'Unknown'}
              </span>
              <span className="text-gray-400">
                {formatDateTime(note.completed_at)}
              </span>
              <span className="flex items-center gap-1 text-gray-400" title="Time from creation to completion">
                <Timer className="w-3 h-3" />
                {getTimeToComplete(note.created_at, note.completed_at)}
              </span>
            </div>
          )}
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

  // ── Global Activity action formatting ──
  const getActivityIcon = (action: string) => {
    switch (action) {
      case 'created': return <Plus className="w-4 h-4 text-blue-500" />;
      case 'completed': return <CheckSquare className="w-4 h-4 text-green-500" />;
      case 'reopened': return <Square className="w-4 h-4 text-amber-500" />;
      case 'updated': return <Pencil className="w-4 h-4 text-gray-500" />;
      case 'commented': return <MessageCircle className="w-4 h-4 text-purple-500" />;
      case 'comment_edited': return <Pencil className="w-4 h-4 text-purple-400" />;
      case 'comment_deleted': return <Trash2 className="w-4 h-4 text-purple-300" />;
      case 'assigned': return <User className="w-4 h-4 text-cyan-500" />;
      case 'deleted': return <Trash2 className="w-4 h-4 text-red-500" />;
      default: return <Activity className="w-4 h-4 text-gray-400" />;
    }
  };

  const getActivityText = (a: GlobalActivity) => {
    const user = (a.user as any)?.full_name || 'Someone';
    const actionMap: Record<string, string> = {
      created: 'created',
      completed: 'completed',
      reopened: 'reopened',
      updated: 'updated',
      commented: 'commented on',
      comment_edited: 'edited a comment on',
      comment_deleted: 'deleted a comment on',
      assigned: 'changed assignment on',
      deleted: 'deleted',
    };
    return { user, action: actionMap[a.action_type] || a.action_type };
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-64 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  // ── View-specific content ──
  const myTasks = notes.filter(n => !n.is_completed && n.assigned_to === profile?.id)
    .sort((a, b) => {
      // Overdue first, then by priority, then by due date
      const aOverdue = isOverdue(a) ? 0 : 1;
      const bOverdue = isOverdue(b) ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      const priOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      if (priOrder[a.priority] !== priOrder[b.priority]) return priOrder[a.priority] - priOrder[b.priority];
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
      return 0;
    });

  const completedNotes = notes
    .filter(n => n.is_completed)
    .filter(n => {
      if (completedDateFrom && n.completed_at && n.completed_at < `${completedDateFrom}T00:00:00`) return false;
      if (completedDateTo && n.completed_at && n.completed_at > `${completedDateTo}T23:59:59`) return false;
      return true;
    })
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));

  return (
    <div className="space-y-4">
      {/* ── Stats Bar ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'board' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('board')}
        >
          <div className="flex items-center gap-2 mb-1">
            <LayoutGrid className="w-4 h-4 text-blue-500" />
            <span className="text-xs text-secondary font-medium">Total</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{stats.total}</p>
        </div>
        <div
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'board' && !filters.showCompleted ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => { setViewTab('board'); setFilters(f => ({ ...f, showCompleted: false })); }}
        >
          <div className="flex items-center gap-2 mb-1">
            <ListChecks className="w-4 h-4 text-amber-500" />
            <span className="text-xs text-secondary font-medium">Open</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{stats.open}</p>
        </div>
        <div
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'my_tasks' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('my_tasks')}
        >
          <div className="flex items-center gap-2 mb-1">
            <User className="w-4 h-4 text-crx-green" />
            <span className="text-xs text-secondary font-medium">My Tasks</span>
          </div>
          <p className="text-xl font-semibold font-heading text-crx-green">{stats.myTasks}</p>
        </div>
        <div
          className="bg-white rounded-xl border border-gray-100 hover:border-gray-200 p-3 cursor-pointer transition-all"
          onClick={() => { setViewTab('board'); setFilters(f => ({ ...f, showCompleted: false, priorities: ['urgent', 'high'] })); }}
        >
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <span className="text-xs text-secondary font-medium">Overdue</span>
          </div>
          <p className={`text-xl font-semibold font-heading ${stats.overdue > 0 ? 'text-red-600' : 'text-nav-dark'}`}>
            {stats.overdue}
          </p>
        </div>
        <div
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'completed' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('completed')}
        >
          <div className="flex items-center gap-2 mb-1">
            <CheckSquare className="w-4 h-4 text-green-500" />
            <span className="text-xs text-secondary font-medium">Completed</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{stats.completed}</p>
          <p className="text-[10px] text-crx-green mt-0.5">+{stats.completedThisWeek} this week</p>
        </div>
        <div
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'activity' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('activity')}
        >
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-4 h-4 text-purple-500" />
            <span className="text-xs text-secondary font-medium">Activity</span>
          </div>
          <p className="text-xs text-secondary mt-1">Full audit log</p>
        </div>
      </div>

      {/* ── Tab Navigation ── */}
      <div className="flex border-b border-gray-200">
        {([
          { id: 'board' as const, label: 'Board', icon: <LayoutGrid className="w-4 h-4" /> },
          { id: 'my_tasks' as const, label: 'My Tasks', icon: <User className="w-4 h-4" />, count: stats.myTasks },
          { id: 'completed' as const, label: 'Completed History', icon: <History className="w-4 h-4" />, count: stats.completed },
          { id: 'activity' as const, label: 'All Activity', icon: <Activity className="w-4 h-4" /> },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setViewTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              viewTab === tab.id
                ? 'text-crx-green border-crx-green'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-xs font-semibold ${
                viewTab === tab.id ? 'bg-crx-green/10 text-crx-green' : 'bg-gray-100 text-gray-600'
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════ */}
      {/* ── VIEW: Board (original 3-column layout) ── */}
      {/* ══════════════════════════════════════════════════ */}
      {viewTab === 'board' && (
        <>
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
                  {notesByType('note').map((n) => renderCard(n, false, true))}
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
                  {notesByType('todo').map((n) => renderCard(n, true, true))}
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
                  {notesByType('announcement').map((n) => renderCard(n, false, true))}
                </div>
              </div>
            </Card>
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* ── VIEW: My Tasks ── */}
      {/* ══════════════════════════════════════════════════ */}
      {viewTab === 'my_tasks' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-secondary">
              {myTasks.length === 0
                ? "You're all caught up! No tasks assigned to you."
                : `${myTasks.length} task${myTasks.length !== 1 ? 's' : ''} assigned to you`}
            </p>
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => { resetForm(); setAssignedTo(profile?.id || ''); setNoteType('todo'); setModalOpen(true); }}>
              Add Task for Me
            </Button>
          </div>

          {myTasks.length > 0 && (
            <Card padding={false}>
              <div className="p-5 space-y-3">
                {myTasks.map(n => renderCard(n, true, false))}
              </div>
            </Card>
          )}

          {/* My recently completed */}
          {(() => {
            const myCompleted = notes
              .filter(n => n.is_completed && n.completed_by === profile?.id)
              .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
              .slice(0, 10);

            if (myCompleted.length === 0) return null;

            return (
              <Card padding={false}>
                <div className="p-5">
                  <CardHeader title="My Recently" accent="Completed" />
                  <div className="space-y-3 mt-3">
                    {myCompleted.map(n => renderCard(n, true, true))}
                  </div>
                </div>
              </Card>
            );
          })()}
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* ── VIEW: Completed History ── */}
      {/* ══════════════════════════════════════════════════ */}
      {viewTab === 'completed' && (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">From</label>
                <input
                  type="date"
                  value={completedDateFrom}
                  onChange={(e) => setCompletedDateFrom(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">To</label>
                <input
                  type="date"
                  value={completedDateTo}
                  onChange={(e) => setCompletedDateTo(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              {(completedDateFrom || completedDateTo) && (
                <button
                  onClick={() => { setCompletedDateFrom(''); setCompletedDateTo(''); }}
                  className="text-xs text-crx-green hover:underline pb-1"
                >
                  Clear dates
                </button>
              )}
              <div className="ml-auto text-sm text-secondary">
                {completedNotes.length} completed task{completedNotes.length !== 1 ? 's' : ''}
              </div>
            </div>
          </Card>

          {completedNotes.length === 0 ? (
            <Card>
              <div className="text-center py-12">
                <History className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-secondary text-sm">No completed tasks{completedDateFrom || completedDateTo ? ' in this date range' : ''}</p>
              </div>
            </Card>
          ) : (
            <Card padding={false}>
              <div className="divide-y divide-gray-100">
                {completedNotes.map(n => (
                  <div key={n.id} className="p-4 hover:bg-gray-50/50 transition-colors cursor-pointer"
                    onClick={() => { setSelectedNote(n); setDetailModalOpen(true); }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <CheckSquare className="w-4 h-4 text-crx-green shrink-0" />
                          <h4 className="text-sm font-medium text-nav-dark">{n.title}</h4>
                          <Badge variant={priorityVariant[n.priority]}>{n.priority}</Badge>
                          <Badge variant="default">{n.note_type}</Badge>
                        </div>
                        {n.content && (
                          <p className="text-xs text-secondary mt-1 ml-6 line-clamp-1">{n.content}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {n.completed_at && (
                          <p className="text-xs text-secondary">{formatDate(n.completed_at)}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 mt-2 ml-6 text-xs text-gray-400">
                      <span>Created by {getName(n.creator)}</span>
                      {getName(n.assignee) && (
                        <span>Assigned to <span className="text-crx-green font-medium">{getName(n.assignee)}</span></span>
                      )}
                      <span className="flex items-center gap-1 text-crx-green font-medium">
                        <CheckSquare className="w-3 h-3" />
                        Completed by {getName(n.completer) || 'Unknown'}
                      </span>
                      {n.completed_at && (
                        <span className="flex items-center gap-1">
                          <Timer className="w-3 h-3" />
                          {getTimeToComplete(n.created_at, n.completed_at)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* ── VIEW: All Activity (Global Audit Log) ── */}
      {/* ══════════════════════════════════════════════════ */}
      {viewTab === 'activity' && (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">From</label>
                <input
                  type="date"
                  value={activityDateFrom}
                  onChange={(e) => setActivityDateFrom(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">To</label>
                <input
                  type="date"
                  value={activityDateTo}
                  onChange={(e) => setActivityDateTo(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Team Member</label>
                <select
                  value={activityUser}
                  onChange={(e) => setActivityUser(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Members</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.full_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Action</label>
                <select
                  value={activityAction}
                  onChange={(e) => setActivityAction(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Actions</option>
                  <option value="created">Created</option>
                  <option value="completed">Completed</option>
                  <option value="reopened">Reopened</option>
                  <option value="updated">Updated</option>
                  <option value="assigned">Assigned</option>
                  <option value="commented">Commented</option>
                  <option value="deleted">Deleted</option>
                </select>
              </div>
              {(activityDateFrom || activityDateTo || activityUser || activityAction) && (
                <button
                  onClick={() => { setActivityDateFrom(''); setActivityDateTo(''); setActivityUser(''); setActivityAction(''); }}
                  className="text-xs text-crx-green hover:underline pb-1"
                >
                  Clear filters
                </button>
              )}
            </div>
          </Card>

          {activityLoading ? (
            <Card>
              <div className="space-y-4 animate-pulse">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="w-8 h-8 bg-gray-200 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-gray-200 rounded w-3/4" />
                      <div className="h-3 bg-gray-200 rounded w-1/4" />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : globalActivities.length === 0 ? (
            <Card>
              <div className="text-center py-12">
                <Activity className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-secondary text-sm">No activity found{activityDateFrom || activityDateTo ? ' in this date range' : ''}</p>
              </div>
            </Card>
          ) : (
            <Card padding={false}>
              <div className="divide-y divide-gray-50">
                {globalActivities.map(a => {
                  const { user, action } = getActivityText(a);
                  return (
                    <div
                      key={a.id}
                      className="px-5 py-3 flex items-start gap-3 hover:bg-gray-50/50 transition-colors cursor-pointer"
                      onClick={() => {
                        const note = notes.find(n => n.id === a.note_id);
                        if (note) {
                          setSelectedNote(note);
                          setDetailModalOpen(true);
                        }
                      }}
                    >
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                        {getActivityIcon(a.action_type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-nav-dark">
                          <span className="font-medium">{user}</span>
                          {' '}{action}{' '}
                          <span className="font-medium text-crx-green">{a.note_title}</span>
                        </p>
                        {/* Show assignment change details */}
                        {a.action_type === 'assigned' && a.changes && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            {a.changes.old_assignee && !a.changes.new_assignee && 'Unassigned'}
                            {!a.changes.old_assignee && a.changes.new_assignee && `Assigned to new team member`}
                            {a.changes.old_assignee && a.changes.new_assignee && 'Reassigned to different team member'}
                          </p>
                        )}
                        {/* Show comment preview */}
                        {a.action_type === 'commented' && a.changes?.comment?.content && (
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
                            "{a.changes.comment.content}"
                          </p>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 shrink-0 text-right">
                        <p>{formatDateTime(a.created_at)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {globalActivities.length >= 100 && (
                <div className="p-4 text-center border-t border-gray-100">
                  <p className="text-xs text-secondary">Showing most recent 100 entries. Use date filters to see older activity.</p>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* ── MODALS (shared across all views) ── */}
      {/* ══════════════════════════════════════════════════ */}

      {/* Create/Edit Modal */}
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

      {/* Note Detail Modal */}
      <Modal
        open={detailModalOpen}
        onClose={() => { setDetailModalOpen(false); setSelectedNote(null); }}
        title={selectedNote?.title || 'Note Details'}
        size="large"
      >
        {selectedNote && (
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={priorityVariant[selectedNote.priority]}>{selectedNote.priority}</Badge>
                <Badge variant="default">{selectedNote.note_type}</Badge>
                {selectedNote.is_completed && <Badge variant="info">Completed</Badge>}
                {isOverdue(selectedNote) && (
                  <Badge variant="error">
                    <AlertTriangle className="w-3 h-3 mr-1" />
                    Overdue
                  </Badge>
                )}
              </div>
              {selectedNote.content && (
                <p className="text-sm text-secondary whitespace-pre-wrap">{selectedNote.content}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-gray-400 flex-wrap">
                {getName(selectedNote.creator) && <span>Created by {getName(selectedNote.creator)}</span>}
                {getName(selectedNote.assignee) && (
                  <span className="text-crx-green font-medium">Assigned to {getName(selectedNote.assignee)}</span>
                )}
                {selectedNote.due_date && (
                  <span className={`flex items-center gap-1 ${isOverdue(selectedNote) ? 'text-red-500 font-medium' : ''}`}>
                    <Clock className="w-3 h-3" />
                    Due {formatDate(selectedNote.due_date)}
                  </span>
                )}
                <span className="text-gray-400">
                  Created {formatDateTime(selectedNote.created_at)}
                </span>
              </div>

              {/* Completion details in modal */}
              {selectedNote.is_completed && selectedNote.completed_at && (
                <div className="bg-green-50 border border-green-100 rounded-lg p-3 flex items-center gap-3 text-sm">
                  <CheckSquare className="w-5 h-5 text-green-600 shrink-0" />
                  <div>
                    <p className="font-medium text-green-800">
                      Completed by {getName(selectedNote.completer) || 'Unknown'}
                    </p>
                    <p className="text-green-600 text-xs">
                      {formatDateTime(selectedNote.completed_at)}
                      {' · '}
                      Took {getTimeToComplete(selectedNote.created_at, selectedNote.completed_at)}
                    </p>
                  </div>
                </div>
              )}
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
                    Activity Log
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

      {/* Delete Confirmation Modal */}
      <Modal
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        title="Delete"
        accent="Note"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Are you sure you want to delete this note? The deletion will be recorded in the activity history for audit purposes.
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
