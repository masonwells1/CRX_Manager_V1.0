# Patch — src/components/dashboard/ActionQueue.tsx

Purpose: mission item 3 — a new "unassigned_jobs" Action-Queue category, the
delivery-side sibling of the existing "unassigned_deliveries" category. Backed
by the migration's new `unassigned_jobs` key on `get_dashboard_action_items`
(already fetched generically by this component's `fetchData` — no fetch-side
change needed, only a new `CATEGORIES` entry).

## Old block (lines 105-120 — the `unassigned_deliveries` entry, end of CATEGORIES array)
```tsx
  {
    key: 'unassigned_deliveries',
    label: 'Unassigned Deliveries',
    icon: <User className="w-4 h-4" />,
    bg: 'bg-sky-50', border: 'border-sky-200',
    iconColor: 'text-sky-600', textColor: 'text-sky-800',
    entityPath: '/deliveries/',
    entityType: 'delivery',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' — ');
    },
  },
];
```

### New block
```tsx
  {
    key: 'unassigned_deliveries',
    label: 'Unassigned Deliveries',
    icon: <User className="w-4 h-4" />,
    bg: 'bg-sky-50', border: 'border-sky-200',
    iconColor: 'text-sky-600', textColor: 'text-sky-800',
    entityPath: '/deliveries/',
    entityType: 'delivery',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' — ');
    },
  },
  {
    // U13 (#15-21/#111): the job-side sibling of unassigned_deliveries — a
    // scheduled job with no ACTIVE per-location dispatch (mission #17). Points
    // at the Jobs list, which now surfaces the same jobs via the "Needs
    // Dispatch" badge/quick-filter (see Jobs.tsx patch) so clicking through
    // lands on a page that explains WHY it's here.
    key: 'unassigned_jobs',
    label: 'Unassigned Jobs',
    icon: <Truck className="w-4 h-4" />,
    bg: 'bg-sky-50', border: 'border-sky-200',
    iconColor: 'text-sky-600', textColor: 'text-sky-800',
    entityPath: '/jobs/',
    entityType: 'job',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' — ');
    },
  },
];
```

## Type check
`LinkedEntityType` (imported from `'../../types'`) must already include `'job'`
— confirmed: `entityType` is used as `'job'` elsewhere in this codebase (e.g.
`logActivity({ ..., entityType: 'job', ... })` throughout JobDetail.tsx), so no
type change is needed here or in `src/types/index.ts`.
