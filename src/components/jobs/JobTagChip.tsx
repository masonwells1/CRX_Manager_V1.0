import type { JobTag } from '../../types';

interface JobTagChipProps {
  tag: Pick<JobTag, 'name' | 'color'>;
  /** Optional remove handler — renders a small X when provided. */
  onRemove?: () => void;
}

/**
 * Field-app parity #4: a single color-coded job tag chip.
 * Color comes from the tag's chosen hex; styling mirrors the team-note
 * TagsManager chip (tint background + same-hue text + subtle border) so the
 * job list reads consistently with the rest of the app.
 */
export default function JobTagChip({ tag, onRemove }: JobTagChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{
        backgroundColor: `${tag.color}1a`,
        color: tag.color,
        border: `1px solid ${tag.color}40`,
      }}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: tag.color }}
        aria-hidden="true"
      />
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${tag.name}`}
          className="ml-0.5 -mr-0.5 hover:opacity-60 transition-opacity"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </span>
  );
}
