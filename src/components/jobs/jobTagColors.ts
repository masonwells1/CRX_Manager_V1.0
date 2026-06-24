// Field-app parity #4: the color set offered when creating / editing a job tag.
// ChemMan offers Blue/Green/Teal/Red/Black/Yellow/etc.; we map those to the
// brand-consistent hex palette already used by the team-note TagsManager plus
// the ChemMan-named extras (teal, black, yellow). The DB CHECK constraint only
// requires a 7-char hex string, so this list is the UI-suggested set, not a
// hard limit.
export const JOB_TAG_COLORS: { hex: string; label: string }[] = [
  { hex: '#3b82f6', label: 'Blue' },
  { hex: '#10b981', label: 'Green' },
  { hex: '#14b8a6', label: 'Teal' },
  { hex: '#ef4444', label: 'Red' },
  { hex: '#111827', label: 'Black' },
  { hex: '#eab308', label: 'Yellow' },
  { hex: '#8b5cf6', label: 'Purple' },
  { hex: '#ec4899', label: 'Pink' },
  { hex: '#f97316', label: 'Orange' },
  { hex: '#84cc16', label: 'Lime' },
];

export const DEFAULT_JOB_TAG_COLOR = JOB_TAG_COLORS[0].hex;
