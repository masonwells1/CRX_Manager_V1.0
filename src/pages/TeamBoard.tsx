import { useEffect, useState, useMemo, useRef , useCallback } from 'react';
import {
  Plus, CheckSquare, Square, Pin, Clock, Pencil, Trash2,
  MessageCircle, Activity, LayoutGrid, User, Users, History, ListChecks,
  AlertTriangle, Timer,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useAuth } from '../contexts/AuthContext';
import { sanitizeError, supabase, checkMutationResult, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { parseLocalDate } from '../lib/dateUtils';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useRealtimeNotes } from '../hooks/useRealtimeSubscription';
import TeamBoardFilters, { FilterState } from '../components/team/TeamBoardFilters';
import CommentsSection from '../components/team/CommentsSection';
import TagsManager from '../components/team/TagsManager';
import ActivityFeed from '../components/team/ActivityFeed';
import NoteCard from '../components/team/NoteCard';
import EntityBadge from '../components/team/EntityBadge';
import NoteAttachments from '../components/team/NoteAttachments';
import NotePhotoUpload from '../components/team/NotePhotoUpload';
import EmptyState from '../components/ui/EmptyState';
import HelpTip from '../components/ui/HelpTip';
import TodaysDeliveries from '../components/team/TodaysDeliveries';
import YesterdayRecap from '../components/team/YesterdayRecap';
import StaleTasksAlert from '../components/team/StaleTasksAlert';
import WorkloadView from '../components/team/WorkloadView';
import type { TeamNote, Profile, NoteType, NotePriority, ExtendedTeamNote, LinkedEntityType } from '../types';
import { useSearchParams } from 'react-router-dom';

const priorityVariant: Record<NotePriority, 'default' | 'info' | 'warning' | 'error'> = {
  low: 'default',
  medium: 'info',
  high: 'warning',
  urgent: 'error',
};

type ViewTab = 'board' | 'my_tasks' | 'completed' | 'workload' | 'activity';


interface GlobalActivity {
  id: string;
  note_id: string;
  user_id: string;
  action_type: string;
  changes: Record<string, unknown> | null;
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
  const [linkedEntityType, setLinkedEntityType] = useState<string>('');
  const [linkedEntityId, setLinkedEntityId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'comments' | 'activity'>('comments');
  const [attachmentRefresh, setAttachmentRefresh] = useState(0);
  const [viewTab, setViewTab] = useState<ViewTab>('board');
  const [isNoteDirty, setIsNoteDirty] = useState(false);
  const modalInitialized = useRef(false);
  const blocker = useUnsavedChanges(modalOpen && isNoteDirty);

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
  const completeIdem = useIdempotencyKey('complete_team_note', profile?.id || '');
  const [completingNote, setCompletingNote] = useState<string | null>(null);

  useRealtimeNotes(() => {
    fetchNotes();
  });

  const fetchProfiles = useCallback(async () => {
    // PR-07 follow-up: team picker only uses p.id + p.full_name; safe via view.
    // Codex P2 (2026-05-16): exclude entity_recipient service profiles
    // (CMCTW LLC, Crop Rx Solutions) — they can't log in or receive tasks.
    const { data, error } = await supabase.from('profile_public_view').select('id, full_name, role, is_active').eq('is_active', true).neq('role', 'entity_recipient').order('full_name');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_profiles' } });
      toast('error', 'Failed to load team members. Please try again.');
      return;
    }
    setProfiles((data || []) as Profile[]);
  }, [toast]);

  const fetchNotes = useCallback(async () => {
    // Optimized: Fetch notes with completion info in a single query
    // Note: completed_by FK may be auto-named, so we use the column reference
    // PR-07 follow-up: dropped creator + assignee FK embeds; resolved via
    // profile_public_view post-fetch (see lookup below).
    const { data: notesData, error: notesError } = await supabase
      .from('team_notes')
      .select('*')
      .is('deleted_at', null)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });

    if (notesError) {
      Sentry.captureException(notesError, { tags: { source: 'fetch', action: 'load_notes' } });
      toast('error', 'Failed to load notes. Please try again.');
      setLoading(false);
      return;
    }

    if (notesData && notesData.length > 0) {
      // Batch fetch all tags in one query instead of per-note
      const noteIds = notesData.map((n: { id: string }) => n.id);
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
      ((allTagLinks || []) as unknown as Array<{ note_id: string; note_tags: { id: string; name: string; color: string } | null }>).forEach((link) => {
        if (!link.note_tags) return;
        if (!tagMap[link.note_id]) tagMap[link.note_id] = [];
        tagMap[link.note_id].push(link.note_tags);
      });

      const countMap: Record<string, number> = {};
      (commentCounts || []).forEach((c: { note_id: string }) => {
        countMap[c.note_id] = (countMap[c.note_id] || 0) + 1;
      });

      // PR-07 follow-up: resolve creator/assignee/completer names via
      // profile_public_view in one batched fetch (replaces the prior
      // creator/assignee FK embeds + the existing completer post-fetch).
      const profileIds = [...new Set([
        ...notesData.map((n: { created_by?: string | null }) => n.created_by),
        ...notesData.map((n: { assigned_to?: string | null }) => n.assigned_to),
        ...notesData.map((n: { completed_by?: string | null }) => n.completed_by),
      ].filter(Boolean) as string[])];
      const profileMap: Record<string, { full_name: string }> = {};
      if (profileIds.length > 0) {
        const { data: profileRows } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', profileIds);
        (profileRows || []).forEach((p: { id: string | null; full_name: string | null }) => {
          if (p.id) profileMap[p.id] = { full_name: p.full_name ?? '' };
        });
      }

      const notesWithExtras = (notesData as (TeamNote & { id: string; created_by?: string | null; assigned_to?: string | null; completed_by?: string | null })[]).map((note) => ({
        ...note,
        tags: tagMap[note.id] || [],
        comment_count: countMap[note.id] || 0,
        creator: note.created_by ? (profileMap[note.created_by] || null) : null,
        assignee: note.assigned_to ? (profileMap[note.assigned_to] || null) : null,
        completer: note.completed_by ? (profileMap[note.completed_by] || null) : null,
      }));

      setNotes(notesWithExtras as ExtendedTeamNote[]);
    } else {
      setNotes([]);
    }
    setLoading(false);
  }, [toast]);

  const fetchGlobalActivity = useCallback(async () => {
    setActivityLoading(true);
    let query = supabase
      .from('note_activity_log')
      .select('*')
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

    const { data, error } = await query;

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_activity_log' } });
      toast('error', 'Failed to load activity log. Please try again.');
      setActivityLoading(false);
      return;
    }

    if (data && data.length > 0) {
      // Fetch note titles for context
      const noteIds = [...new Set(data.map((a: { note_id: string | null }) => a.note_id).filter((x): x is string => Boolean(x)))];
      const titleMap: Record<string, string> = {};

      if (noteIds.length > 0) {
        const { data: noteData } = await supabase
          .from('team_notes')
          .select('id, title')
          .in('id', noteIds);

        (noteData || []).forEach((n: { id: string; title: string }) => { titleMap[n.id] = n.title; });
      }

      // PR-07 follow-up: resolve actor names via profile_public_view (safe columns
      // only) so the global activity log keeps showing names after profiles_select
      // tightens to admin-or-self.
      const userIds = [...new Set(data.map((a: { user_id: string }) => a.user_id).filter(Boolean))];
      const userMap: Record<string, { full_name: string }> = {};
      if (userIds.length > 0) {
        const { data: userData } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', userIds);
        (userData || []).forEach((u: { id: string | null; full_name: string | null }) => {
          if (u.id) userMap[u.id] = { full_name: u.full_name ?? '' };
        });
      }

      const enriched = (data as (GlobalActivity & { note_id: string; user_id: string; changes?: Record<string, unknown> | null })[]).map((a) => ({
        ...a,
        note_title: titleMap[a.note_id] || ((a.changes as Record<string, Record<string, unknown>> | null)?.note?.title as string) || 'Deleted note',
        user: userMap[a.user_id],
      }));

      setGlobalActivities(enriched);
    } else {
      setGlobalActivities([]);
    }
    setActivityLoading(false);
  }, [activityDateFrom, activityDateTo, activityUser, activityAction, toast]);

  const openNoteDetail = useCallback(async (noteId: string) => {
    let note = notes.find(n => n.id === noteId);

    // If not found in local state (e.g., page just loaded), fetch it directly
    if (!note) {
      // PR-07 follow-up: dropped creator + assignee FK embeds; resolve via
      // profile_public_view post-fetch.
      const { data, error } = await supabase
        .from('team_notes')
        .select('*')
        .eq('id', noteId)
        .is('deleted_at', null)
        .maybeSingle();

      if (error) {
        Sentry.captureException(error, { tags: { source: 'fetch', action: 'open_team_note_detail' } });
        toast('error', 'Unable to open that note right now. Please try again.');
        return;
      }

      if (data) {
        const ids = [data.created_by, data.assigned_to].filter(Boolean) as string[];
        const profMap: Record<string, { full_name: string }> = {};
        if (ids.length > 0) {
          const { data: profs } = await supabase
            .from('profile_public_view')
            .select('id, full_name')
            .in('id', ids);
          (profs || []).forEach((p: { id: string | null; full_name: string | null }) => {
            if (p.id) profMap[p.id] = { full_name: p.full_name ?? '' };
          });
        }
        note = {
          ...(data as ExtendedTeamNote),
          creator: data.created_by ? profMap[data.created_by] || null : null,
          assignee: data.assigned_to ? profMap[data.assigned_to] || null : null,
        } as ExtendedTeamNote;
      }
    }

    // `replace: true` on both arms: a plain setSearchParams PUSHES a clean
    // /team-board entry, so Back restores ?note=… , this effect re-opens the
    // note and pushes again — the user can never get back to Notifications.
    // Replacing consumes the deep link in place (Codex P2 on PR #351).
    if (note) {
      setSelectedNote(note);
      setDetailModalOpen(true);
      setSearchParams({}, { replace: true });
    } else {
      // Deleted or inaccessible note behind a stale ?note= link: say so and
      // clear the param instead of silently doing nothing.
      toast('error', 'That note no longer exists — it may have been deleted.');
      setSearchParams({}, { replace: true });
    }
  }, [notes, setSearchParams, toast]);

  // Initial load — fetch notes and profiles once on mount
  useEffect(() => {
    fetchNotes();
    fetchProfiles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep-link: open a note when ?note=<id> is in the URL. Waits for the
  // initial fetch (loading) instead of notes.length — the old guard skipped
  // the lone mount-time run on a cold load (notes not fetched yet) and never
  // re-fired, so notification links landed on the board without opening the
  // note. openNoteDetail falls back to fetching by id, so an empty board or
  // a note missing from local state still resolves.
  useEffect(() => {
    const noteId = searchParams.get('note');
    if (noteId && !loading) {
      openNoteDetail(noteId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, loading]);

  useEffect(() => {
    if (viewTab === 'activity') {
      fetchGlobalActivity();
    }
  }, [viewTab, activityDateFrom, activityDateTo, activityUser, activityAction, fetchGlobalActivity]);

  // Track dirty state for note modal form
  useEffect(() => {
    if (modalInitialized.current) setIsNoteDirty(true);
  }, [title, content, noteType, priority, assignedTo, dueDate]);

  const resetForm = () => {
    setTitle('');
    setContent('');
    setNoteType('note');
    setPriority('medium');
    setAssignedTo('');
    setDueDate('');
    setLinkedEntityType('');
    setLinkedEntityId('');
    setEditingNote(null);
    setIsNoteDirty(false);
    modalInitialized.current = false;
  };

  const openAddModal = () => {
    resetForm();
    setModalOpen(true);
    requestAnimationFrame(() => { modalInitialized.current = true; });
  };

  const openEditModal = (note: TeamNote) => {
    setEditingNote(note);
    setTitle(note.title);
    setContent(note.content || '');
    setNoteType(note.note_type);
    setPriority(note.priority);
    setAssignedTo(note.assigned_to || '');
    setDueDate(note.due_date || '');
    setLinkedEntityType(note.linked_entity_type || '');
    setLinkedEntityId(note.linked_entity_id || '');
    setModalOpen(true);
    requestAnimationFrame(() => { modalInitialized.current = true; });
  };

  const handleSave = async () => {
    if (!title.trim()) return;

    // Guard: Ensure profile is loaded before creating/updating notes
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    setSaving(true);

    if (editingNote) {
      try {
        const result = await supabase
          .from('team_notes')
          .update({
            title,
            content: content || null,
            note_type: noteType,
            priority,
            assigned_to: assignedTo || null,
            due_date: dueDate || null,
            linked_entity_type: linkedEntityType || null,
            linked_entity_id: linkedEntityId || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingNote.id)
          .select();
        checkMutationResult(result, 'Update note');
        toast('success', 'Note updated');
        setModalOpen(false);
        resetForm();
        fetchNotes();
      } catch (err: unknown) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'update_team_note' } });
        toast('error', sanitizeError(err));
      }
    } else {
      const noteResult = await supabase.from('team_notes').insert({
        title,
        content: content || null,
        note_type: noteType,
        priority,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        linked_entity_type: linkedEntityType || null,
        linked_entity_id: linkedEntityId || null,
        created_by: profile.id,
      }).select();
      if (noteResult.error) {
        toast('error', 'Failed to add note');
      } else {
        checkMutationResult(noteResult, 'Insert team note');
        toast('success', 'Note added');
        setModalOpen(false);
        resetForm();
        fetchNotes();
      }
    }
    setSaving(false);
  };

  const handleDelete = async (noteId: string) => {
    // Guard: Ensure profile is loaded
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    // Soft delete: set deleted_at timestamp for audit trail
    try {
      const result = await supabase
        .from('team_notes')
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by: profile.id,
        })
        .eq('id', noteId)
        .select();
      checkMutationResult(result, 'Delete note');
      toast('success', 'Note deleted');
      fetchNotes();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'delete_team_note' } });
      toast('error', sanitizeError(err));
    }
    setDeleteConfirmId(null);
  };

  const toggleComplete = async (note: TeamNote) => {
    // Guard: Ensure profile is loaded
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }
    // One completion at a time: the idempotency key is page-scoped, so a
    // second click before the first resolves would reuse the in-flight key
    // for a different payload and trip the server's replay-mismatch guard.
    if (completingNote) return;
    setCompletingNote(note.id);

    try {
      // Completion goes through the complete_team_note RPC (not a direct
      // table update) so the ASSIGNEE can complete tasks delegated to them —
      // tnotes_update RLS only allows the creator or an admin.
      const { data, error } = await supabase.rpc('complete_team_note', {
        p_note_id: note.id,
        p_completed: !note.is_completed,
        p_idempotency_key: completeIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'complete_team_note');
      completeIdem.resetKey();
      fetchNotes();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'toggle_note_completion' } });
      if (hasRpcCode(err, RpcErrorCodes.NOT_AUTHORIZED_TO_COMPLETE)) {
        toast('error', 'Only the person who created this note, the person it is assigned to, or an admin can check it off.');
      } else if (hasRpcCode(err, RpcErrorCodes.NOTE_NOT_FOUND)) {
        toast('error', 'This note was deleted by someone else. Refreshing the board.');
        fetchNotes();
      } else if (hasRpcCode(err, RpcErrorCodes.COMPLETE_REPLAY_PAYLOAD_MISMATCH)) {
        // A previous call committed but its response was lost, leaving a
        // stale key behind. Discard it so the next click works.
        completeIdem.resetKey();
        toast('error', 'That last change already went through. Please try again.');
        fetchNotes();
      } else if (hasRpcCode(err, RpcErrorCodes.PROFILE_INACTIVE)) {
        toast('error', 'Your account is inactive. Ask an admin to reactivate it before completing tasks.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setCompletingNote(null);
    }
  };

  const togglePin = async (note: TeamNote) => {
    try {
      const result = await supabase
        .from('team_notes')
        .update({ is_pinned: !note.is_pinned })
        .eq('id', note.id)
        .select();
      checkMutationResult(result, 'Toggle note pin');
      fetchNotes();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'toggle_note_pin' } });
      toast('error', sanitizeError(err));
    }
  };

  const canEdit = (note: TeamNote) => isAdmin || note.created_by === profile?.id;

  // Mirrors complete_team_note's authorization so the checkbox only shows to
  // people whose click can actually succeed (creator, assignee, or admin).
  const canComplete = (note: TeamNote) =>
    isAdmin || note.created_by === profile?.id || note.assigned_to === profile?.id;

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
    const overdue = open.filter(n => n.due_date && parseLocalDate(n.due_date) < now);
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
    !note.is_completed && note.due_date && parseLocalDate(note.due_date) < new Date();

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
  const getName = (p: TeamNote['creator'] | { full_name: string } | null | undefined) => (p as unknown as { full_name: string })?.full_name || '';

  const formatDate = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const formatDateTime = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const handleNoteClick = useCallback((note: ExtendedTeamNote) => {
    setSelectedNote(note);
    setDetailModalOpen(true);
  }, []);

  const handleDeleteNote = useCallback((noteId: string) => {
    setDeleteConfirmId(noteId);
  }, []);

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
    const user = (a.user as { full_name: string } | undefined)?.full_name || 'Someone';
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

  // For the Board tab's personalized sections
  const myTasksForBoard = notes
    .filter(n => !n.is_completed && n.assigned_to === profile?.id)
    .sort((a, b) => {
      const aOverdue = isOverdue(a) ? 0 : 1;
      const bOverdue = isOverdue(b) ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      const priOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
      return (priOrder[a.priority] || 4) - (priOrder[b.priority] || 4);
    });

  const pinnedAndAnnouncements = notes
    .filter(n => !n.is_completed && (n.is_pinned || n.note_type === 'announcement'));

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
          role="button"
          tabIndex={0}
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'board' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('board')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewTab('board'); } }}
        >
          <div className="flex items-center gap-2 mb-1">
            <LayoutGrid className="w-4 h-4 text-blue-500" />
            <span className="text-xs text-secondary font-medium">Total</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{stats.total}</p>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'board' && !filters.showCompleted ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => { setViewTab('board'); setFilters(f => ({ ...f, showCompleted: false })); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewTab('board'); setFilters(f => ({ ...f, showCompleted: false })); } }}
        >
          <div className="flex items-center gap-2 mb-1">
            <ListChecks className="w-4 h-4 text-amber-500" />
            <span className="text-xs text-secondary font-medium">Open</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{stats.open}</p>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'my_tasks' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('my_tasks')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewTab('my_tasks'); } }}
        >
          <div className="flex items-center gap-2 mb-1">
            <User className="w-4 h-4 text-crx-green" />
            <span className="text-xs text-secondary font-medium">My Tasks</span>
          </div>
          <p className="text-xl font-semibold font-heading text-crx-green">{stats.myTasks}</p>
        </div>
        <div
          role="button"
          tabIndex={0}
          className="bg-white rounded-xl border border-gray-100 hover:border-gray-200 p-3 cursor-pointer transition-all"
          onClick={() => { setViewTab('board'); setFilters(f => ({ ...f, showCompleted: false, priorities: ['urgent', 'high'] })); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewTab('board'); setFilters(f => ({ ...f, showCompleted: false, priorities: ['urgent', 'high'] })); } }}
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
          role="button"
          tabIndex={0}
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'completed' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('completed')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewTab('completed'); } }}
        >
          <div className="flex items-center gap-2 mb-1">
            <CheckSquare className="w-4 h-4 text-green-500" />
            <span className="text-xs text-secondary font-medium">Completed</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{stats.completed}</p>
          <p className="text-[10px] text-crx-green mt-0.5">+{stats.completedThisWeek} this week</p>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`bg-white rounded-xl border p-3 cursor-pointer transition-all ${viewTab === 'activity' ? 'border-crx-green ring-1 ring-crx-green/20' : 'border-gray-100 hover:border-gray-200'}`}
          onClick={() => setViewTab('activity')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewTab('activity'); } }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-4 h-4 text-purple-500" />
            <span className="text-xs text-secondary font-medium">Activity</span>
          </div>
          <p className="text-xs text-secondary mt-1">Full audit log</p>
        </div>
      </div>

      {/* ── Tab Navigation (horizontally scrollable on mobile) ── */}
      <div className="flex border-b border-gray-200 overflow-x-auto -mx-1 px-1 scrollbar-hide">
        {([
          { id: 'board' as const, label: 'Board', icon: <LayoutGrid className="w-4 h-4" /> },
          { id: 'my_tasks' as const, label: 'My Tasks', icon: <User className="w-4 h-4" />, count: stats.myTasks },
          { id: 'completed' as const, label: 'Completed', icon: <History className="w-4 h-4" />, count: stats.completed },
          { id: 'workload' as const, label: 'Workload', icon: <Users className="w-4 h-4" /> },
          { id: 'activity' as const, label: 'Activity', icon: <Activity className="w-4 h-4" /> },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setViewTab(tab.id)}
            className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] ${
              viewTab === tab.id
                ? 'text-crx-green border-crx-green'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.icon}
            <span className="hidden sm:inline">{tab.label}</span>
            <span className="sm:hidden">{tab.label}</span>
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
          {/* Today's Deliveries */}
          <TodaysDeliveries />

          {/* Stale Tasks — overdue tasks escalated by severity */}
          <StaleTasksAlert notes={notes} onClickNote={(note) => { setSelectedNote(note); setDetailModalOpen(true); }} />

          {/* Your Tasks & Mentions — personalized section */}
          {myTasksForBoard.length > 0 && (
            <Card padding={false}>
              <div className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-crx-green" />
                    <h3 className="text-sm font-semibold text-nav-dark">Your Tasks</h3>
                    <span className="px-1.5 py-0.5 bg-crx-green/10 text-crx-green rounded-full text-xs font-semibold">
                      {myTasksForBoard.length}
                    </span>
                  </div>
                  <button
                    onClick={() => setViewTab('my_tasks')}
                    className="text-xs text-crx-green hover:underline"
                  >
                    View All
                  </button>
                </div>
                <div className="space-y-2">
                  {myTasksForBoard.slice(0, 5).map(n => (
                    <NoteCard
                      key={n.id}
                      note={n}
                      showCheckbox={true}
                      canComplete={canComplete(n)}
                      canEdit={canEdit(n)}
                      onToggleComplete={toggleComplete}
                      onTogglePin={togglePin}
                      onEdit={openEditModal}
                      onDelete={handleDeleteNote}
                      onClick={handleNoteClick}
                    />
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Pinned & Announcements */}
          {pinnedAndAnnouncements.length > 0 && (
            <Card padding={false}>
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Pin className="w-4 h-4 text-amber-500" />
                  <h3 className="text-sm font-semibold text-nav-dark">Pinned & Announcements</h3>
                </div>
                <div className="space-y-2">
                  {pinnedAndAnnouncements.map(n => (
                    <NoteCard
                      key={n.id}
                      note={n}
                      showCheckbox={false}
                      canEdit={canEdit(n)}
                      onToggleComplete={toggleComplete}
                      onTogglePin={togglePin}
                      onEdit={openEditModal}
                      onDelete={handleDeleteNote}
                      onClick={handleNoteClick}
                    />
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Yesterday's Recap */}
          <YesterdayRecap />

          {/* Existing filters + grid below */}
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1">
              <TeamBoardFilters filters={filters} onChange={setFilters} />
            </div>
            <div className="flex items-center gap-1">
              <Button icon={<Plus className="w-4 h-4" />} onClick={openAddModal} className="hidden sm:flex">
                Add Note
              </Button>
              <HelpTip text="Notes can be tasks, reminders, or announcements. Assign to a team member, set a due date, and link to an order or delivery for context." className="ml-1 hidden sm:inline-flex" />
            </div>
          </div>

          {notes.length === 0 ? (
            <Card>
              <EmptyState
                icon={<LayoutGrid className="w-6 h-6 text-gray-400" />}
                title="Your team board is empty"
                description="Create notes, tasks, and announcements to keep your team coordinated."
                action={
                  <Button icon={<Plus className="w-4 h-4" />} onClick={openAddModal}>
                    Create First Note
                  </Button>
                }
              />
            </Card>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card padding={false}>
              <div className="p-5">
                <CardHeader title="Notes" />
                <div className="space-y-3">
                  {notesByType('note').length === 0 && (
                    <p className="text-sm text-secondary py-4 text-center">No notes</p>
                  )}
                  {notesByType('note').map((n) => <NoteCard key={n.id} note={n} showCheckbox={false} showCompletionDetails canEdit={canEdit(n)} onToggleComplete={toggleComplete} onTogglePin={togglePin} onEdit={openEditModal} onDelete={handleDeleteNote} onClick={handleNoteClick} />)}
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
                  {notesByType('todo').map((n) => <NoteCard key={n.id} note={n} showCheckbox canComplete={canComplete(n)} showCompletionDetails canEdit={canEdit(n)} onToggleComplete={toggleComplete} onTogglePin={togglePin} onEdit={openEditModal} onDelete={handleDeleteNote} onClick={handleNoteClick} />)}
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
                  {notesByType('announcement').map((n) => <NoteCard key={n.id} note={n} showCheckbox={false} showCompletionDetails canEdit={canEdit(n)} onToggleComplete={toggleComplete} onTogglePin={togglePin} onEdit={openEditModal} onDelete={handleDeleteNote} onClick={handleNoteClick} />)}
                </div>
              </div>
            </Card>
          </div>
          )}
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
                {myTasks.map(n => <NoteCard key={n.id} note={n} showCheckbox canComplete={canComplete(n)} showCompletionDetails={false} canEdit={canEdit(n)} onToggleComplete={toggleComplete} onTogglePin={togglePin} onEdit={openEditModal} onDelete={handleDeleteNote} onClick={handleNoteClick} />)}
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
                    {myCompleted.map(n => <NoteCard key={n.id} note={n} showCheckbox canComplete={canComplete(n)} showCompletionDetails canEdit={canEdit(n)} onToggleComplete={toggleComplete} onTogglePin={togglePin} onEdit={openEditModal} onDelete={handleDeleteNote} onClick={handleNoteClick} />)}
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
                    role="button"
                    tabIndex={0}
                    onClick={() => { setSelectedNote(n); setDetailModalOpen(true); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedNote(n); setDetailModalOpen(true); } }}
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
      {/* ── VIEW: Workload ── */}
      {/* ══════════════════════════════════════════════════ */}
      {viewTab === 'workload' && <WorkloadView />}

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
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        const note = notes.find(n => n.id === a.note_id);
                        if (note) {
                          setSelectedNote(note);
                          setDetailModalOpen(true);
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const note = notes.find(n => n.id === a.note_id); if (note) { setSelectedNote(note); setDetailModalOpen(true); } } }}
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
                        {a.action_type === 'assigned' && a.changes != null ? (
                          <p className="text-xs text-gray-400 mt-0.5">
                            {Boolean((a.changes as Record<string, unknown>).old_assignee) && !((a.changes as Record<string, unknown>).new_assignee) ? 'Unassigned' : null}
                            {!((a.changes as Record<string, unknown>).old_assignee) && Boolean((a.changes as Record<string, unknown>).new_assignee) ? 'Assigned to new team member' : null}
                            {Boolean((a.changes as Record<string, unknown>).old_assignee) && Boolean((a.changes as Record<string, unknown>).new_assignee) ? 'Reassigned to different team member' : null}
                          </p>
                        ) : null}
                        {/* Show comment preview */}
                        {a.action_type === 'commented' && a.changes != null && ((a.changes as Record<string, unknown>).comment as Record<string, unknown> | undefined)?.content ? (
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
                            &ldquo;{String(((a.changes as Record<string, unknown>).comment as Record<string, unknown>).content)}&rdquo;
                          </p>
                        ) : null}
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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Link to Entity<HelpTip text="Link this note to an order, quote, delivery, or customer. The note will show up on that record's detail page too." className="ml-1" /></label>
              <select
                value={linkedEntityType}
                onChange={(e) => { setLinkedEntityType(e.target.value); setLinkedEntityId(''); }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">None</option>
                <option value="delivery">Delivery</option>
                <option value="order">Order</option>
                <option value="customer">Customer</option>
                <option value="job">Job</option>
                <option value="purchase_order">Purchase Order</option>
                <option value="quote">Quote</option>
              </select>
            </div>
            {linkedEntityType && (
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Entity ID</label>
                <input
                  type="text"
                  value={linkedEntityId}
                  onChange={(e) => setLinkedEntityId(e.target.value)}
                  placeholder="Paste entity UUID"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            )}
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
                {selectedNote.linked_entity_type && selectedNote.linked_entity_id && (
                  <EntityBadge
                    entityType={selectedNote.linked_entity_type as LinkedEntityType}
                    entityId={selectedNote.linked_entity_id}
                  />
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

            <NoteAttachments noteId={selectedNote.id} canDelete={canEdit(selectedNote)} refreshKey={attachmentRefresh} />
            {!selectedNote.is_completed && (
              <NotePhotoUpload noteId={selectedNote.id} onUploadComplete={() => setAttachmentRefresh(prev => prev + 1)} />
            )}

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

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {/* Mobile FAB — floating "Add Note" button visible only on small screens */}
      <button
        onClick={openAddModal}
        className="fixed bottom-6 right-6 z-40 sm:hidden w-14 h-14 bg-crx-green text-white rounded-full shadow-lg hover:bg-crx-green/90 active:scale-95 transition-all flex items-center justify-center"
        aria-label="Add Note"
      >
        <Plus className="w-6 h-6" />
      </button>
    </div>
  );
}
