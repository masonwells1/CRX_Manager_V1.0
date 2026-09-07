## 2026-09-05 — Workflow map: attribute a routing wrapper to the page it renders

CI's **Workflow map freshness** gate went red at the round-7 head. The failure was not a stale
regeneration — it was the map telling the truth about a generator that had stopped being able to
see the job detail page.

### What broke

Round 7 routed `jobs/:id` through `JobDetailRoute`, a wrapper whose only job is to render
`<JobDetail key={id} />` so a record change REMOUNTS the page. `scripts/generate-workflow-map.mjs`
builds its two halves from two different sources:

- **page nodes** come from the route's component name in `src/App.tsx`;
- **edge sources** come from the source file (`fileToApproxNodeId` keys off `src/pages/<Name>.tsx`).

Name the wrapper and the halves stop agreeing. The node became `job-detail-route`, `job-detail`
ceased to exist as a node, and `addEdge` silently discarded every edge whose source was
`job-detail`: navigation to `jobs`, `invoice-detail` and `quote-builder`, and the RPC groups
`r-job` and `r-blend`. **The regenerated map asserted that the job detail page makes no RPC calls
at all** — a false statement in the artifact the fleet reads for architecture orientation.

Committing that regenerated map would have turned CI green while shipping the lie. The freshness
gate compares generated output against committed output, so it catches staleness, never wrongness.

### The fix — resolved by shape, not by a name list

`resolveRouteWrapperToPage()` follows a route component through to the page it renders: a component
imported into `App.tsx` from `src/components/`, whose file imports and renders exactly one component
from `src/pages/`, is attributed to that page. Any of those conditions failing returns the original
name unchanged.

Deliberately **not** a list of wrapper names alongside the existing `WRAPPERS` set. A name list
would inherit its own omissions here and the omission would be invisible: the next unlisted wrapper
drops its page's edges and CI stays green, because both sides of the freshness diff are generated
from the same broken rule. `WRAPPERS` can afford to be a list because a wrapper missing from it
produces a visibly wrong node; this cannot.

### Second, smaller correction: test files are not application navigation

`parseNavigateCalls()` scanned `*.test.tsx` alongside application source, so
`JobDetail.recordBinding.test.tsx` navigating its own memory router to `/other` — a fixture path
that exists only to prove the operator left the job page — was reported in the **Problems** tab as
*"Broken navigate(): /other — no matching Route in App.tsx"*. A passing test read as a broken link.
Test and spec files are now skipped in that scan. No edges change (test files resolve to no node
id); the false problem entry goes away, and the problem count returns to 5.

### Proof

With both corrections, `docs/app-workflow-map.html` regenerates **byte-identical to the committed
map apart from its date stamp**, which is what a pure routing refactor should do: round 7 changed no
navigation and no RPC surface, so the architecture map must not move.

Both changes are load-bearing and are pinned by CI, verified by removing them one at a time and
regenerating:

| Mutation | Effect on the freshness gate |
|---|---|
| drop the wrapper resolution | map diff **9 insertions / 34 deletions** — the page's nav and RPC edges vanish; gate reddens |
| drop the test-file skip | map diff **10 insertions / 2 deletions** — the false `/other` problem returns; gate reddens |

Gates on the final source: `npm run typecheck` clean, `npm run lint` clean, `npm run check:docs`
PASS.

### Not verified

No test asserts `resolveRouteWrapperToPage()` directly — the script exports nothing and adding an
export plus a suite was judged out of scope for a round-8 CI fix. Its behaviour is pinned only
indirectly, by the freshness gate reddening when it is removed, as measured above. A future wrapper
that is lazily imported in a shape the declaration-line scan does not recognise would fall back to
the wrapper name and silently drop that page's edges again; the fallback is safe but unproven for
shapes other than `lazy(() => import('./components/X'))` and a plain `import X from './components/X'`.
