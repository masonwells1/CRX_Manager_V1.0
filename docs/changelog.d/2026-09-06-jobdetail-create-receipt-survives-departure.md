## 2026-09-06 — JobDetail: a new job's receipt and credit check survive the operator leaving

The `gpt-5.6-sol` proof at head `2b9c19c4c` returned BLOCKED with one High, **CRX-ENTITY-003 — a
regression this branch introduced.** It is fixed here rather than deferred: a regression a PR
introduces cannot be filed as a follow-up, because deferring it ships it.

### What went wrong

An earlier round wrapped the whole save-success block in `if (stillOnThisJob())`:

```tsx
if (stillOnThisJob()) {
  toast('success', isNew ? 'Job created' : 'Job saved');
  setIsDirty(false);
  /* … */
  if (isNew) {
    navigate(`/jobs/${result.job_id}`);
    void warnIfOverCreditLimit(customerId, toast);
  } else {
    await fetchJob();
  }
}
```

`main` has no `stillOnThisJob` at all (0 occurrences vs 14 here) and this block is UNGATED there,
so the suppression is new on this branch.

For an UPDATE the gate is purely protective. For a CREATE it is not. `save_job` runs with
`p_job_id: null` and **the row commits regardless** — the code's own comment says only the
on-screen consequences are gated. `useUnsavedChanges` is `useBlocker(isDirty)`, so it gates on
dirty and not on `saving`; leaving mid-save is a dismissible prompt away. So: the operator saves a
new job, clicks into another, the job COMMITS, and both the toast and the redirect are swallowed.
They never learn it exists.

They then create it again — and `useIdempotencyKey` holds its map in a `useRef`, which is
**component-local and destroyed on unmount**. The retry mints a FRESH key, the database's replay
check cannot match it, and the second `save_job` writes a **duplicate job** that can be completed,
invoiced, or move inventory.

The guard traded a VISIBLE wrong (the operator yanked onto the job they just made) for a SILENT
one. For a CREATE the acknowledgement is the only evidence the record exists, so suppressing it is
not a smaller harm than a wrong navigation — it is a different and worse one.

### The second suppressed statement in the same arm

`warnIfOverCreditLimit` sat inside the same `if (isNew)` branch — one call site, at `:2636` on
`main` (ungated) and `:2869` here (gated). `src/lib/creditLimit.ts:11` does two things when the
limit is exceeded: it raises a toast, **and** it calls `notifyCreditLimitExceeded` →
`notifyAdmins`, which writes a durable notification row. So a job booked for a customer already
over their credit limit committed with **no record of the breach**. A credit control that leaves no
trace is not a weakened control, it is an absent one — and a repair scoped to the redirect alone
would have left that half broken while reading as fixed.

### The fix: split the gate

- **Ungated** — the CREATE toast, and `warnIfOverCreditLimit`.
- **Gated** — `setIsDirty`, `setSavedApplicatorId`, `setSavedJobDate`, `navigate`, `fetchJob`.
- **Still gated** — the UPDATE toast. There the record is already known to exist, so a late "Job
  saved" carries no receipt, only the false impression that the job now on screen saved. The
  update ERROR path (`:2929`) was already ungated, so a failed late update is still reported.

#### The partition rule, stated narrowly on purpose

A first draft of this entry stated the rule as *"does the statement touch component state at ALL?
If not, gating can only subtract."* **That rule is wrong — it over-generalises**, and applied
literally it would also ungate `toast('Job started')` (`:2962`), `toast('Job completed! …')`
(`:3007`), `toast('Job cancelled')` (`:3044`) and the two invoice-created toasts (`:3075`,
`:3077`). None of those touch component state either, and all five stay GATED deliberately.

The rule actually applied has two halves, and both are load-bearing:

> Ungate a statement only when it touches no page state **AND** it carries information the
> operator cannot otherwise recover.

The four sites above fail the second half, because their RPCs refuse a replay:
`complete_job` requires `in_progress`
(`supabase/migrations/20260722012359_auto_draft_skipped_activity_row.sql:154`) and
`transfer_job_to_invoice` refuses with `'Job already invoiced'`
(`20260713060000_harden_field_split_sum100.sql:142`). A retry there yields an explanatory error,
so a lost toast costs the operator a confusing moment, not a duplicate row. **`save_job` with
`p_job_id` NULL is the one site where the retry silently duplicates** — which is exactly what makes
its receipt load-bearing rather than merely courteous.

### The stale receipt names the customer

A late toast lands over an unrelated page and auto-dismisses after 4 seconds
(`src/components/ui/Toast.tsx:47`), so a bare "Job created" is a floating claim the operator cannot
attach to anything. `SaveJobResult` carries only `{ job_id }` (`:199`) and the RPC returns no job
number, so the most identifying value available without another round trip is the farm name
already in the closure (the same lookup `logActivity` uses at `:2800`). The stale message is
therefore **"Job for {farm} created — find it in the jobs list"**.

Stated plainly against the reviewer's prescribed remedy — *"a durable, entity-specific background
success receipt with a link to the created job"* — this delivers **entity-specific**, and does not
deliver **durable** or **linked**. Durability is the residual below. A link is deliberately
omitted: a toast that navigates is the same wrong-record hazard this PR exists to remove.

### The option NOT taken: holding the operator during a create

The reviewer's first listed remedy was to prevent departure while a create is in flight. Rejected,
and the reason matters because the obvious reason is wrong.

It is **not** that operators would be made to wait. `isDirty` is `snap !== baselineRef.current`
(`:1634`) and nothing clears it until the save succeeds, so `useBlocker(isDirty)`
(`src/hooks/useUnsavedChanges.ts:12`) is **already** true throughout an in-flight create — the
operator who leaves has already clicked through the Unsaved Changes modal (`:3552`). A
`saving`-aware block would change that one modal in that one window and pause nobody on the normal
path.

The real objection is the hung request. `supabase-js` applies no request timeout, so a
non-dismissible hold could strand a tablet on a dead RPC with no exit but a reload — trading a
recoverable silent-duplicate risk for an unrecoverable stuck screen, on the same field hardware.
A cheaper follow-up is available if wanted: when `saving && isNew`, have `UnsavedChangesModal` say
a new job is still being saved, while leaving Leave enabled.

### Where the toast comes from — corrected twice

An early draft said `ToastProvider` sits ABOVE the router. It does not. `RootLayout` is at
`src/App.tsx:164`, `ToastProvider` at `:167`, and `App` returns `<RouterProvider>` at `:334` —
so the provider is a ROUTE element, inside the router.

A second draft then over-corrected, claiming logging out loses the toast. **It does not.** Every
route except the dev-only `/design-preview` is a child of `RootLayout`, including `/login` (`:190`)
and the `*` catch-all; `AuthProvider` renders `{children}` unconditionally
(`src/contexts/AuthContext.tsx:197`), `signOut` only sets state (`:165`), and `ProtectedRoute`
redirects with `<Navigate>` (`src/components/auth/ProtectedRoute.tsx:25`) rather than a hard
location change. The provider stays mounted and the toast renders on the login page.

What actually loses it: a reload, a closed tab, a hard navigation, and — much the likeliest — the
4-second auto-dismiss. So the toast is **best-effort**; the `notifyAdmins` row is unconditional.
"The operator did not see a toast" and "no record of the breach exists" are different severities,
and the second is the one that matters.

### Coverage

`src/pages/JobDetail.staleLoad.test.tsx` gains one test: a `/jobs/new` creation that commits after
the operator has navigated to another job. It asserts all three halves at once — the receipt
reaches the operator AND names the customer, `check_customer_credit_limit` still runs and
`notifyCreditLimitExceeded` still fires, and the page the operator is on NOW is untouched (no
redirect onto the new job, heading unchanged).

Verified 2026-09-06 that it **FAILS against the fully-gated source** with the production symptom,
and passes with the split — re-verified after the message was made entity-specific, since changing
both the message and the assertion invalidates the earlier falsification. The three existing
JobDetail suites plus `JobDetailRoute.test.tsx` — 43 tests — stay green, including
`recordBinding.test.tsx:289`, which asserts that a stale EXISTING-job save emits no
acknowledgement. That still passes because the UPDATE toast is still gated.

The coverage gap that let this through is worth naming: `recordBinding.test.tsx:289` covered only
an existing-job save and explicitly asserted no acknowledgement. Nothing exercised an in-flight
`/jobs/new` creation across a departure — the suite certified the exact shape that hid the defect.

### Not fixed here, and stated rather than hidden

- **A crash, force-quit, or a dismissed "leave site?" prompt** still leaves a committed job with no
  on-screen receipt. Closing that needs an in-flight-save record surviving the page's destruction —
  a larger money-path change belonging in its own work. The admin notification row is what remains
  as protection there.
- **Pre-existing, on `main` too:** the two failure backstops at `:2757` and `:2787` let a new job
  commit with no credit check at all. Out of scope for this PR; not introduced by it.
