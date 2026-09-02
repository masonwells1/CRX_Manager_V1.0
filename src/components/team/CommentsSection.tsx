import { useState, useEffect, useCallback } from 'react';
import { MessageCircle, Send, Reply, Edit2, Trash2, X } from 'lucide-react';
import { sanitizeError, supabase, checkMutationResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { useRealtimeComments } from '../../hooks/useRealtimeSubscription';
import Button from '../ui/Button';

interface Comment {
  id: string;
  note_id: string;
  parent_id: string | null;
  created_by: string;
  content: string;
  mentions: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  creator?: {
    full_name: string;
  };
}

interface Profile {
  id: string;
  full_name: string;
}

interface CommentsSectionProps {
  noteId: string;
  noteTitle: string;
}

export default function CommentsSection({ noteId }: CommentsSectionProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [comments, setComments] = useState<Comment[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [newComment, setNewComment] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchProfiles = async () => {
    // PR-07 follow-up: profile_public_view exposes only id/full_name/role/is_active.
    const { data, error } = await supabase
      .from('profile_public_view')
      .select('id, full_name')
      .eq('is_active', true);
    if (error) {
      Sentry.captureException(new Error(`Failed to load profiles: ${error.message}`));
      return;
    }
    setProfiles((data || []) as Profile[]);
  };

  const fetchComments = useCallback(async () => {
    // PR-07 follow-up: dropped creator FK embed; resolve via profile_public_view.
    const { data, error } = await supabase
      .from('team_note_comments')
      .select('*')
      .eq('note_id', noteId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      toast('error', 'Failed to load comments');
      setLoading(false);
      return;
    }

    const creatorIds = [...new Set(
      ((data || []) as Array<{ created_by?: string | null }>)
        .map((c) => c.created_by)
        .filter(Boolean) as string[]
    )];
    const creatorMap: Record<string, { full_name: string }> = {};
    if (creatorIds.length > 0) {
      const { data: creators } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', creatorIds);
      ((creators || []) as Array<{ id: string; full_name: string }>).forEach((c) => {
        creatorMap[c.id] = { full_name: c.full_name };
      });
    }

    setComments(
      ((data || []) as Comment[]).map((c) => ({
        ...c,
        creator: c.created_by ? creatorMap[c.created_by] : undefined,
      })) as Comment[],
    );
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  useEffect(() => {
    fetchComments();
    fetchProfiles();
  }, [noteId, fetchComments]);

  useRealtimeComments(noteId, fetchComments);

  const extractMentions = (text: string): string[] => {
    const mentionPattern = /@(\w+)/g;
    const mentions: string[] = [];
    let match;

    while ((match = mentionPattern.exec(text)) !== null) {
      const mentionedName = match[1].toLowerCase();
      const mentionedProfile = profiles.find(p =>
        p.full_name.toLowerCase().replace(/\s+/g, '').includes(mentionedName)
      );
      if (mentionedProfile) {
        mentions.push(mentionedProfile.id);
      }
    }

    return [...new Set(mentions)];
  };

  const handleSendComment = async (parentId: string | null = null) => {
    const content = parentId ? replyText : newComment;
    if (!content.trim() || !profile) return;

    setSending(true);
    const mentions = extractMentions(content);

    const commentResult = await supabase.from('team_note_comments').insert({
      note_id: noteId,
      parent_id: parentId,
      created_by: profile.id,
      content: content.trim(),
      mentions,
    }).select();

    if (commentResult.error) {
      toast('error', 'Failed to post comment');
    } else {
      checkMutationResult(commentResult, 'Insert team note comment');
      if (parentId) {
        setReplyText('');
      } else {
        setNewComment('');
      }
      setReplyingTo(null);
      fetchComments();
    }
    setSending(false);
  };

  const handleEditComment = async (commentId: string) => {
    if (!editContent.trim()) return;

    setSending(true);
    const mentions = extractMentions(editContent);

    try {
      const result = await supabase
        .from('team_note_comments')
        .update({
          content: editContent.trim(),
          mentions,
        })
        .eq('id', commentId)
        .select();
      checkMutationResult(result, 'Update comment');
      setEditingId(null);
      setEditContent('');
      fetchComments();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'CommentsSection.handleEditComment' } });
      toast('error', sanitizeError(err));
    }
    setSending(false);
  };

  const handleDeleteComment = async (commentId: string) => {
    if (confirmDeleteId !== commentId) {
      setConfirmDeleteId(commentId);
      return;
    }
    setConfirmDeleteId(null);
    try {
      const result = await supabase
        .from('team_note_comments')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', commentId)
        .select();
      checkMutationResult(result, 'Delete comment');
      toast('success', 'Comment deleted');
      fetchComments();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'CommentsSection.handleDeleteComment' } });
      toast('error', sanitizeError(err));
    }
  };

  const startEdit = (comment: Comment) => {
    setEditingId(comment.id);
    setEditContent(comment.content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
  };

  const getCreatorName = (comment: Comment) => {
    return comment.creator?.full_name || 'Unknown';
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const topLevelComments = comments.filter(c => !c.parent_id);
  const getReplies = (parentId: string) => comments.filter(c => c.parent_id === parentId);

  const renderComment = (comment: Comment, isReply: boolean = false) => {
    const canEdit = profile?.id === comment.created_by;
    const isEditing = editingId === comment.id;
    const replies = getReplies(comment.id);

    return (
      <div key={comment.id} className={`${isReply ? 'ml-8 mt-3' : 'mt-4'}`}>
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-crx-green/10 flex items-center justify-center text-crx-green font-medium text-sm">
            {getCreatorName(comment).charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-nav-dark">{getCreatorName(comment)}</span>
                  <span className="text-xs text-gray-400">{formatTime(comment.created_at)}</span>
                  {comment.updated_at !== comment.created_at && (
                    <span className="text-xs text-gray-400">(edited)</span>
                  )}
                </div>
                {canEdit && !isEditing && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => startEdit(comment)}
                      className="p-1 text-gray-400 hover:text-blue-500 rounded"
                      title="Edit"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeleteComment(comment.id)}
                      onBlur={() => { if (confirmDeleteId === comment.id) setConfirmDeleteId(null); }}
                      className={`p-1 rounded ${confirmDeleteId === comment.id ? 'text-red-600 bg-red-50' : 'text-gray-400 hover:text-red-500'}`}
                      title={confirmDeleteId === comment.id ? 'Click again to confirm delete' : 'Delete'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                    rows={2}
                    placeholder="Edit your comment..."
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleEditComment(comment.id)}
                      loading={sending}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={cancelEdit}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-secondary whitespace-pre-wrap">{comment.content}</p>
              )}
            </div>
            {!isEditing && !isReply && (
              <button
                onClick={() => setReplyingTo(comment.id)}
                className="mt-1 text-xs text-gray-500 hover:text-crx-green flex items-center gap-1"
              >
                <Reply className="w-3 h-3" />
                Reply
              </button>
            )}
            {replyingTo === comment.id && (
              <div className="mt-2 flex gap-2">
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  rows={2}
                  placeholder="Write a reply..."
                />
                <div className="flex flex-col gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleSendComment(comment.id)}
                    loading={sending}
                    icon={<Send className="w-3.5 h-3.5" />}
                  >
                    Reply
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setReplyingTo(null); setReplyText(''); }}
                    icon={<X className="w-3.5 h-3.5" />}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        {replies.length > 0 && (
          <div className="mt-2">
            {replies.map(reply => renderComment(reply, true))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="space-y-4 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/4" />
          <div className="h-16 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <MessageCircle className="w-5 h-5 text-secondary" />
        <h3 className="font-semibold text-nav-dark">
          Comments {comments.length > 0 && `(${comments.length})`}
        </h3>
      </div>

      <div className="mb-4">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-crx-green/10 flex items-center justify-center text-crx-green font-medium text-sm">
            {profile?.full_name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              rows={3}
              placeholder="Write a comment... (use @name to mention someone)"
            />
            <div className="mt-2 flex justify-between items-center">
              <span className="text-xs text-gray-400">
                Tip: Use @name to mention team members
              </span>
              <Button
                size="sm"
                onClick={() => handleSendComment(null)}
                loading={sending}
                icon={<Send className="w-3.5 h-3.5" />}
                disabled={!newComment.trim()}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>

      {topLevelComments.length === 0 ? (
        <div className="text-center py-8">
          <MessageCircle className="w-12 h-12 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-secondary">No comments yet. Start the conversation!</p>
        </div>
      ) : (
        <div className="space-y-1">
          {topLevelComments.map(comment => renderComment(comment))}
        </div>
      )}
    </div>
  );
}
