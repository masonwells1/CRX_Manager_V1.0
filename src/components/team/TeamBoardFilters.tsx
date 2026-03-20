import { useState, useEffect } from 'react';
import { Search, Filter, X, Tag, User, AlertCircle } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import HelpTip from '../ui/HelpTip';

interface NoteTag {
  id: string;
  name: string;
  color: string;
}

interface Profile {
  id: string;
  full_name: string;
}

export interface FilterState {
  search: string;
  tags: string[];
  assignees: string[];
  priorities: string[];
  showCompleted: boolean;
}

interface TeamBoardFiltersProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

export default function TeamBoardFilters({ filters, onChange }: TeamBoardFiltersProps) {
  const [tags, setTags] = useState<NoteTag[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    fetchTags();
    fetchProfiles();
  }, []);

  const fetchTags = async () => {
    try {
      const { data, error } = await supabase
        .from('note_tags')
        .select('*')
        .order('name');
      if (error) {
        Sentry.captureException(new Error(`Failed to load tags: ${error.message}`));
        return;
      }
      setTags((data || []) as NoteTag[]);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const fetchProfiles = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name');
      if (error) {
        Sentry.captureException(new Error(`Failed to load profiles: ${error.message}`));
        return;
      }
      setProfiles((data || []) as Profile[]);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const updateFilter = (key: keyof FilterState, value: string | string[] | boolean) => {
    onChange({ ...filters, [key]: value });
  };

  const toggleArrayFilter = (key: 'tags' | 'assignees' | 'priorities', value: string) => {
    const current = filters[key];
    const updated = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    updateFilter(key, updated);
  };

  const clearFilters = () => {
    onChange({
      search: '',
      tags: [],
      assignees: [],
      priorities: [],
      showCompleted: false,
    });
  };

  const hasActiveFilters =
    filters.search ||
    filters.tags.length > 0 ||
    filters.assignees.length > 0 ||
    filters.priorities.length > 0;

  const activeFilterCount =
    (filters.search ? 1 : 0) +
    filters.tags.length +
    filters.assignees.length +
    filters.priorities.length;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
            placeholder="Search notes..."
            aria-label="Search notes"
            className="w-full pl-10 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors flex items-center gap-2 ${
            showFilters || hasActiveFilters
              ? 'bg-crx-green text-white border-crx-green'
              : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="px-1.5 py-0.5 bg-white/20 rounded text-xs font-semibold">
              {activeFilterCount}
            </span>
          )}
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            title="Clear all filters"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {showFilters && (
        <div className="border border-gray-200 rounded-lg p-4 bg-white space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Tag className="w-4 h-4 text-secondary" />
              <label className="text-sm font-medium text-nav-dark">Tags</label>
              <HelpTip text="Color-coded tags help organize notes. Filter by tag to see only what's relevant — like 'Urgent' or 'Follow-up'." className="ml-1" />
            </div>
            <div className="flex flex-wrap gap-2">
              {tags.length === 0 ? (
                <p className="text-sm text-secondary">No tags available</p>
              ) : (
                tags.map(tag => {
                  const isSelected = filters.tags.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      onClick={() => toggleArrayFilter('tags', tag.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        isSelected
                          ? 'ring-2 ring-offset-1'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: `${tag.color}15`,
                        color: tag.color,
                        border: `1px solid ${tag.color}30`,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <User className="w-4 h-4 text-secondary" />
              <label className="text-sm font-medium text-nav-dark">Assigned To</label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => toggleArrayFilter('assignees', 'unassigned')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  filters.assignees.includes('unassigned')
                    ? 'bg-gray-700 text-white border-gray-700'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                }`}
              >
                Unassigned
              </button>
              {profiles.map(profile => {
                const isSelected = filters.assignees.includes(profile.id);
                return (
                  <button
                    key={profile.id}
                    onClick={() => toggleArrayFilter('assignees', profile.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      isSelected
                        ? 'bg-crx-green text-white border-crx-green'
                        : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {profile.full_name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="w-4 h-4 text-secondary" />
              <label className="text-sm font-medium text-nav-dark">Priority</label>
            </div>
            <div className="flex flex-wrap gap-2">
              {['urgent', 'high', 'medium', 'low'].map(priority => {
                const isSelected = filters.priorities.includes(priority);
                const priorityColors: Record<string, string> = {
                  urgent: 'bg-red-100 text-red-700 border-red-200',
                  high: 'bg-amber-100 text-amber-700 border-amber-200',
                  medium: 'bg-blue-100 text-blue-700 border-blue-200',
                  low: 'bg-gray-100 text-gray-700 border-gray-200',
                };
                const selectedColors: Record<string, string> = {
                  urgent: 'bg-red-600 text-white border-red-600',
                  high: 'bg-amber-600 text-white border-amber-600',
                  medium: 'bg-blue-600 text-white border-blue-600',
                  low: 'bg-gray-600 text-white border-gray-600',
                };
                return (
                  <button
                    key={priority}
                    onClick={() => toggleArrayFilter('priorities', priority)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${
                      isSelected ? selectedColors[priority] : priorityColors[priority]
                    }`}
                  >
                    {priority}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-2 border-t border-gray-200">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.showCompleted}
                onChange={(e) => updateFilter('showCompleted', e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
              />
              <span className="text-sm text-nav-dark">Show completed items</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
