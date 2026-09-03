import { useState, useEffect, useCallback } from 'react';
import { Tag, Plus, X, Check } from 'lucide-react';
import { sanitizeError, supabase, checkMutationResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';

interface NoteTag {
  id: string;
  name: string;
  color: string;
  created_by: string;
}

interface TagsManagerProps {
  noteId: string;
  onTagsChange?: () => void;
}

const TAG_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#84cc16', // lime
  '#6366f1', // indigo
];

export default function TagsManager({ noteId, onTagsChange }: TagsManagerProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [allTags, setAllTags] = useState<NoteTag[]>([]);
  const [noteTags, setNoteTags] = useState<NoteTag[]>([]);
  const [showTagSelector, setShowTagSelector] = useState(false);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchAllTags = async () => {
    const { data, error } = await supabase
      .from('note_tags')
      .select('*')
      .order('name');
    if (error) {
      toast('error', 'Failed to load tags');
      return;
    }
    setAllTags((data || []) as NoteTag[]);
  };

  const fetchNoteTags = useCallback(async () => {
    const { data, error } = await supabase
      .from('team_note_tags')
      .select('tag_id, note_tags(*)')
      .eq('note_id', noteId);

    if (error) {
      toast('error', 'Failed to load note tags');
      return;
    }
    if (data) {
      const tags = data.map((d: Record<string, unknown>) => d.note_tags).filter(Boolean);
      setNoteTags(tags as NoteTag[]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  useEffect(() => {
    fetchAllTags();
    fetchNoteTags();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, fetchNoteTags]);

  const createTag = async () => {
    if (!newTagName.trim() || !profile) return;

    setLoading(true);
    const { data, error } = await supabase
      .from('note_tags')
      .insert({
        name: newTagName.trim(),
        color: newTagColor,
        created_by: profile.id,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        toast('error', 'Tag already exists');
      } else {
        toast('error', 'Failed to create tag');
      }
    } else {
      toast('success', 'Tag created');
      setNewTagName('');
      setShowCreateTag(false);
      fetchAllTags();
      if (data) {
        await addTagToNote(data.id);
      }
    }
    setLoading(false);
  };

  const addTagToNote = async (tagId: string) => {
    const { error } = await supabase
      .from('team_note_tags')
      .insert({
        note_id: noteId,
        tag_id: tagId,
      });

    if (error) {
      if (error.code !== '23505') {
        toast('error', 'Failed to add tag');
      }
    } else {
      fetchNoteTags();
      if (onTagsChange) onTagsChange();
    }
  };

  const removeTagFromNote = async (tagId: string) => {
    try {
      const result = await supabase
        .from('team_note_tags')
        .delete()
        .eq('note_id', noteId)
        .eq('tag_id', tagId)
        .select();
      checkMutationResult(result, 'Remove tag from note');
      fetchNoteTags();
      if (onTagsChange) onTagsChange();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'TagsManager.removeTagFromNote' } });
      toast('error', sanitizeError(err));
    }
  };

  const isTagApplied = (tagId: string) => {
    return noteTags.some(t => t.id === tagId);
  };

  const filteredTags = allTags.filter(tag =>
    tag.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-secondary text-sm">
          <Tag className="w-4 h-4" />
          <span className="font-medium">Tags:</span>
        </div>
        {noteTags.map(tag => (
          <div
            key={tag.id}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium"
            style={{
              backgroundColor: `${tag.color}15`,
              color: tag.color,
              border: `1px solid ${tag.color}30`,
            }}
          >
            {tag.name}
            <button
              onClick={() => removeTagFromNote(tag.id)}
              className="hover:opacity-70"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        {!showTagSelector ? (
          <button
            onClick={() => setShowTagSelector(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Tag
          </button>
        ) : (
          <div className="relative">
            <button
              onClick={() => {
                setShowTagSelector(false);
                setShowCreateTag(false);
                setSearchTerm('');
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          </div>
        )}
      </div>

      {showTagSelector && (
        <div className="border border-gray-200 rounded-lg p-3 bg-white shadow-sm">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search tags..."
            aria-label="Search tags"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green mb-3"
          />

          <div className="max-h-48 overflow-y-auto space-y-1 mb-3">
            {filteredTags.length === 0 ? (
              <p className="text-sm text-secondary text-center py-4">
                No tags found
              </p>
            ) : (
              filteredTags.map(tag => {
                const applied = isTagApplied(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => applied ? removeTagFromNote(tag.id) : addTagToNote(tag.id)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="text-sm text-nav-dark">{tag.name}</span>
                    </div>
                    {applied && <Check className="w-4 h-4 text-crx-green" />}
                  </button>
                );
              })
            )}
          </div>

          {!showCreateTag ? (
            <button
              onClick={() => setShowCreateTag(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-crx-green hover:bg-crx-green/5 rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create New Tag
            </button>
          ) : (
            <div className="border-t pt-3 space-y-3">
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="Tag name"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                onKeyDown={(e) => e.key === 'Enter' && createTag()}
              />
              <div className="flex items-center gap-2">
                <span className="text-sm text-secondary">Color:</span>
                <div className="flex gap-1.5">
                  {TAG_COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => setNewTagColor(color)}
                      className={`w-6 h-6 rounded-full transition-transform ${
                        newTagColor === color ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={createTag}
                  disabled={!newTagName.trim() || loading}
                  className="flex-1 px-3 py-2 text-sm font-medium text-white bg-crx-green hover:bg-crx-green/90 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Create & Apply
                </button>
                <button
                  onClick={() => {
                    setShowCreateTag(false);
                    setNewTagName('');
                  }}
                  className="px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
