import fs from 'fs';

// Generated straight from the workflow output, so correcting a verdict in
// findings.json and re-running is enough to rebuild the report.
const findings = JSON.parse(fs.readFileSync(new URL('./findings.json', import.meta.url), 'utf8'));
const severityOf = f => (f.verdict && f.verdict.corrected_severity) || f.severity;
const rows = findings.confirmed.map(f => ({
  t: f.title,
  s: severityOf(f),
  fi: f.finder,
  ph: f.phaseName,
  loc: String(f.location).split(';')[0].trim(),
  fs: String(f.failure_scenario || '').trim(),
}));
const refutedCount = findings.refutedCount;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shortLoc = l => esc(String(l).replace(/^supabase\/migrations\//, '').replace(/^supabase\/baselines\//, '').replace(/\s*\(.*$/, ''));

const HIGH_NOTES = {
  'Quote transition trigger leaves accepted': {
    plain: 'A quote that has already been converted into an order can be pushed back to “sent” with a single direct API call — no admin approval, no reason recorded, nothing written to the audit log.',
    why: 'You built a proper reopen path in July that is admin-only, demands a reason, refuses if a live order exists, resets the booking draws and rebuilds the inventory holds. None of that runs here. The quote and its order drift apart permanently and the booking maths is left corrupt.',
    who: 'Any admin, or the sales rep who owns the quote.',
  },
  'Deliveries can be walked scheduled': {
    plain: 'A delivery can be marked “completed” directly, skipping the function that actually does the work.',
    why: 'No stock leaves inventory, the order never advances toward fulfilled, and no invoice is generated. The delivery looks done, the customer is never billed, and your Net Position keeps counting the product as still committed.',
    who: 'Any sales rep, or the assigned driver.',
  },
  'Quote soft delete has no DB guard': {
    plain: 'Deleting a planned booking leaves its inventory holds active forever.',
    why: 'The hold-release trigger only fires on a status change, and deleting a quote does not change its status. The quote vanishes from every screen while its holds keep shrinking your available stock, with nothing left pointing at an owner. No cleanup job ever reclaims them.',
    who: 'Anyone who can delete a quote — including bulk-select in the Quotes list.',
  },
  'Soft-deleting a planned quote orphans': {
    plain: 'Same leak, confirmed independently on the crop-program hold path.',
    why: 'A 500-gallon program hold stays active indefinitely. The dispatch board shows you short, the inventory page overstates committed stock, and the low-stock warning fires on product that is actually free.',
    who: 'Office staff doing routine cleanup of stale quotes.',
  },
  'Caller-controlled cost/profit still drives': {
    plain: 'The cost and profit figures that decide commission are supplied by the caller and never re-checked on the two main order-creation paths.',
    why: 'This is the exact hole you closed on Bulk Order Import. Send a zero cost or an inflated profit and the system mints commission rows from it — overstating commission liability, margin reporting, and the audit-log totals.',
    who: 'Any active sales rep.',
  },
  'Quick-delivery invoice posted before completion': {
    plain: 'A quick delivery invoiced up front and then only partly completed bills the customer twice for the shortfall.',
    why: 'Invoice 100 units in the morning, driver delivers 60, the posted invoice is never adjusted. The 40-unit remainder spawns a follow-up delivery which auto-invoices those 40 again. The customer is billed for 140. An admin warning that used to catch this was dropped at some point.',
    who: 'Normal office workflow — no misuse required.',
  },
  'Void→rebill of an order invoice permanently': {
    plain: 'Voiding an invoice cancels the order’s commissions, and re-invoicing never brings them back.',
    why: 'Admin voids an invoice to fix a wrong price, recreates it, customer pays in full — and the rep’s commissions stay “cancelled” forever. They do not appear in the payout picker or the balance report. The rep is silently never paid unless someone hand-edits the table.',
    who: 'Normal admin correction workflow — no misuse required.',
  },
  'Assigned driver can complete a delivery': {
    plain: 'Found a second time, from a different source: the driver’s own permissions are enough to mark a delivery complete directly.',
    why: 'Same consequence as above — no inventory movement, no fulfilment, no invoice, no audit row. This one was traced through the recorded permissions snapshot rather than the migration history, so two independent readings of your own files agree on it. Both are still offline readings.',
    who: 'The assigned driver, using their own login.',
  },
  'get_customer_year_end_summary is an ungated': {
    plain: 'Any logged-in user can pull a full financial history for any customer.',
    why: 'Email, phone, billing address, payment terms, total invoiced and paid, outstanding balance, every invoice with its balance, and per-product spend — for customers they have no business seeing. The invoice permissions that would normally block this are bypassed because the function runs with elevated rights and never checks who is calling.',
    who: 'Any authenticated user, including drivers and applicators.',
  },
  'Sales reps can create orders and order lines': {
    plain: 'A sales rep can insert an order directly — including one already marked “fulfilled”.',
    why: 'No inventory reserved or consumed, no commission row, no activity record: the same impossible state you eliminated from bulk import. They can also add lines to another rep’s already-invoiced order, which silently rewrites that order’s totals.',
    who: 'Any active sales rep.',
  },
};

// BLOCKER is a severity both workflow schemas allow; a corrected verdict can
// introduce one, and it must never be rendered as anything lesser.
const TOP = new Set(['BLOCKER', 'HIGH']);
const highs = rows.filter(r => TOP.has(r.s));
// Hand-written plain-English notes exist for the ten findings that were
// top-severity at publication. Triage can promote others, so anything without a
// note falls back to its own title and failure scenario rather than aborting.
const findNote = h => {
  for (const k of Object.keys(HIGH_NOTES)) if (h.t.startsWith(k)) return HIGH_NOTES[k];
  return {
    plain: h.t,
    why: h.fs || 'See the full entry in FINDINGS.md for the failure scenario.',
    who: 'See FINDINGS.md',
  };
};

const THEMES = [
  {
    id: 'bypass',
    label: 'The rules live in the app, not the database',
    lede: 'Your safety logic sits inside the database functions the app calls — but the underlying tables are still directly writable by the same people. Anyone who talks to the API instead of clicking the button walks straight past it.',
    match: t => t.startsWith('Quote transition trigger') || t.startsWith('Deliveries can be walked') || t.startsWith('Quote soft delete') || t.startsWith('Soft-deleting a planned quote') || t.startsWith('Assigned driver can complete') || t.startsWith('Sales reps can create orders'),
  },
  {
    id: 'money',
    label: 'Money that comes out wrong on its own',
    lede: 'These need no misuse at all — they are ordinary workflows that produce the wrong number.',
    match: t => t.startsWith('Caller-controlled cost') || t.startsWith('Quick-delivery invoice posted') || t.startsWith('Void→rebill'),
  },
  {
    id: 'read',
    label: 'Data readable by the wrong people',
    lede: 'Plus several medium-severity siblings in the appendix.',
    match: t => t.startsWith('get_customer_year_end_summary'),
  },
];

// Anything promoted into top severity after publication lands here rather than
// being silently dropped from the headline.
const themedTitles = new Set(THEMES.flatMap(th => highs.filter(h => th.match(h.t)).map(h => h.t)));
const RENDER_THEMES = THEMES.concat(
  highs.some(h => !themedTitles.has(h.t))
    ? [{
        id: 'promoted',
        label: 'Raised to top severity in triage',
        lede: 'Findings a later review promoted after this report was first written. Their detail below comes straight from the finding record rather than a written summary.',
        match: h => !themedTitles.has(h),
      }]
    : []
);

const highHtml = RENDER_THEMES.map(th => {
  const items = highs.filter(h => (th.id === 'promoted' ? th.match(h.t) : th.match(h.t)));
  return `
<section class="theme">
  <h3 class="theme-h">${esc(th.label)} <span class="theme-count">${items.length}</span></h3>
  <p class="theme-lede">${items.length} of the ${highs.length}. ${esc(th.lede)}</p>
  ${items.map(h => {
    const n = findNote(h);
    return `<article class="finding">
      <div class="finding-head">
        <span class="chip chip-high">${h.s === 'BLOCKER' ? 'Blocker' : 'High'}</span>
        <span class="finding-src">${esc(h.finder ?? h.fi)}</span>
      </div>
      <h4 class="finding-t">${esc(n.plain)}</h4>
      <p class="finding-why">${esc(n.why)}</p>
      <dl class="finding-meta">
        <dt>Who can do it</dt><dd>${esc(n.who)}</dd>
        <dt>Where</dt><dd><code>${shortLoc(h.loc)}</code></dd>
        <dt>Technical title</dt><dd class="tech">${esc(h.t)}</dd>
      </dl>
    </article>`;
  }).join('\n')}
</section>`;
}).join('\n');


const PHASES = [
  ['Phase 1: Lifecycle & Holds', 'Lifecycle &amp; holds', 'Quote, order, delivery and invoice status rules; planned bookings and the inventory holds they create.'],
  ['Phase 2: Money & Idempotency', 'Money &amp; commissions', 'Cent maths and rounding, commission minting and cancellation, duplicate-submission and race protection.'],
  ['Phase 3: Security & Frontend', 'Permissions, screens &amp; reporting', 'Who can read and write what, frontend adherence to the project rules, and whether reports agree with each other.'],
];

const appendixHtml = PHASES.map(([key, label, lede]) => {
  const inPhase = rows.filter(r => r.ph === key);
  const finders = [...new Set(inPhase.map(r => r.fi))];
  const counts = ['BLOCKER', 'HIGH', 'MED', 'LOW']
    .map(s => [s, inPhase.filter(r => r.s === s).length])
    .filter(([s, n]) => n > 0 || s !== 'BLOCKER')
    .map(([s, n]) => `${n} ${s.toLowerCase()}`).join(' · ');
  return `
<section class="phase">
  <header class="phase-head">
    <h3>${label}</h3>
    <p class="phase-lede">${lede}</p>
    <p class="phase-count">${inPhase.length} findings — ${counts}</p>
  </header>
  ${finders.map(f => {
    const ORD = { BLOCKER: -1, HIGH: 0, MED: 1, LOW: 2 };
    const items = inPhase.filter(r => r.fi === f).sort((a, b) => ORD[a.s] - ORD[b.s]);
    return `<div class="finder-block">
      <h4 class="finder-h">${esc(f)}</h4>
      <ul class="rowlist">
        ${items.map(i => `<li class="row row-${i.s.toLowerCase()}">
          <span class="chip chip-${i.s === 'BLOCKER' ? 'high' : i.s.toLowerCase()}">${ { BLOCKER: 'Blocker', HIGH: 'High', MED: 'Med', LOW: 'Low' }[i.s] || i.s }</span>
          <span class="row-t">${esc(i.t)}</span>
          <code class="row-loc">${shortLoc(i.loc)}</code>
        </li>`).join('\n')}
      </ul>
    </div>`;
  }).join('\n')}
</section>`;
}).join('\n');

const counts = {
  total: rows.length,
  blocker: rows.filter(r => r.s === 'BLOCKER').length,
  high: rows.filter(r => r.s === 'HIGH').length,
  med: rows.filter(r => r.s === 'MED').length,
  low: rows.filter(r => r.s === 'LOW').length,
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ordering Cycle Review — CRX Manager</title>
<style>
  :root {
    --ground: #FCFCFA;
    --surface: #FFFFFF;
    --surface-2: #F4F6F3;
    --ink: #171D1A;
    --ink-2: #3D4744;
    --muted: #5C6862;
    --rule: #E1E5E0;
    --rule-strong: #C9D0CA;
    --accent: #2C6A4C;
    --high: #A62D1F;
    --high-bg: #F7E9E6;
    --med: #8A5D10;
    --med-bg: #F7F0E1;
    --low: #55635C;
    --low-bg: #EDF0EE;
    --shadow: 0 1px 2px rgba(23,29,26,.05), 0 8px 24px -16px rgba(23,29,26,.28);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0F1312;
      --surface: #161C1A;
      --surface-2: #1C2321;
      --ink: #E7ECE9;
      --ink-2: #C2CBC6;
      --muted: #97A29C;
      --rule: #262E2B;
      --rule-strong: #37413D;
      --accent: #63BE92;
      --high: #E8836F;
      --high-bg: #2C1D19;
      --med: #D9A64A;
      --med-bg: #2A2318;
      --low: #9AA7A0;
      --low-bg: #1E2523;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0F1312;
    --surface: #161C1A;
    --surface-2: #1C2321;
    --ink: #E7ECE9;
    --ink-2: #C2CBC6;
    --muted: #97A29C;
    --rule: #262E2B;
    --rule-strong: #37413D;
    --accent: #63BE92;
    --high: #E8836F;
    --high-bg: #2C1D19;
    --med: #D9A64A;
    --med-bg: #2A2318;
    --low: #9AA7A0;
    --low-bg: #1E2523;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
  }

  * { box-sizing: border-box; }
  body {
    background: var(--ground);
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    font-size: 17px;
    line-height: 1.6;
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 60rem; margin: 0 auto; padding: 3.5rem 1.5rem 6rem; display: flex; flex-direction: column; gap: 3rem; }

  .eyebrow {
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    font-size: .72rem; font-weight: 600; letter-spacing: .13em; text-transform: uppercase;
    color: var(--accent); margin: 0;
  }
  h1 { font-size: clamp(2rem, 4.4vw, 2.9rem); line-height: 1.12; margin: .5rem 0 0; text-wrap: balance; letter-spacing: -.015em; }
  h2 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing: -.01em; text-wrap: balance; }
  h3 { font-size: 1.22rem; margin: 0; letter-spacing: -.005em; text-wrap: balance; }
  h4 { margin: 0; }
  p { margin: 0 0 .9rem; max-width: 68ch; }
  p:last-child { margin-bottom: 0; }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .82em; color: var(--ink-2); }
  a { color: var(--accent); }

  header.masthead { border-bottom: 2px solid var(--rule-strong); padding-bottom: 1.75rem; }
  .sub { color: var(--muted); font-size: 1.06rem; margin-top: .85rem; max-width: 62ch; }
  .dateline {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .8rem; color: var(--muted);
    margin-top: 1.1rem; display: flex; flex-wrap: wrap; gap: .5rem 1.25rem;
  }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 3px; overflow: hidden; }
  .stat { background: var(--surface); padding: 1.05rem 1.15rem; display: flex; flex-direction: column; gap: .15rem; }
  .stat-n { font-size: 2rem; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .stat-l { font-family: ui-sans-serif, system-ui, sans-serif; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .stat-high .stat-n { color: var(--high); }
  .stat-med .stat-n { color: var(--med); }

  section.block { display: flex; flex-direction: column; gap: .75rem; }
  .callout {
    border-left: 3px solid var(--accent); background: var(--surface-2);
    padding: 1.1rem 1.25rem; border-radius: 0 3px 3px 0;
  }
  .callout p { font-size: .97rem; }

  .theme { display: flex; flex-direction: column; gap: 1rem; margin-top: 1.5rem; }
  .theme-h { display: flex; align-items: baseline; gap: .7rem; padding-bottom: .5rem; border-bottom: 1px solid var(--rule-strong); }
  .theme-count {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .74rem; font-weight: 600;
    color: var(--muted); border: 1px solid var(--rule-strong); border-radius: 99px; padding: .05rem .5rem;
  }
  .theme-lede { color: var(--muted); font-size: .97rem; }

  .finding {
    background: var(--surface); border: 1px solid var(--rule); border-radius: 3px;
    padding: 1.25rem 1.35rem; box-shadow: var(--shadow);
    display: flex; flex-direction: column; gap: .7rem;
  }
  .finding-head { display: flex; align-items: center; gap: .6rem; }
  .finding-src { font-family: ui-monospace, Menlo, monospace; font-size: .74rem; color: var(--muted); }
  .finding-t { font-size: 1.12rem; line-height: 1.35; text-wrap: balance; }
  .finding-why { color: var(--ink-2); font-size: .97rem; margin: 0; }
  .finding-meta {
    display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem;
    margin: 0; padding-top: .7rem; border-top: 1px solid var(--rule);
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .82rem;
  }
  .finding-meta dt { color: var(--muted); letter-spacing: .02em; }
  .finding-meta dd { margin: 0; color: var(--ink-2); }
  .finding-meta dd.tech { color: var(--muted); }

  .chip {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: .68rem; font-weight: 650;
    letter-spacing: .07em; text-transform: uppercase; padding: .12rem .45rem; border-radius: 2px; white-space: nowrap;
  }
  .chip-high { background: var(--high-bg); color: var(--high); }
  .chip-med { background: var(--med-bg); color: var(--med); }
  .chip-low { background: var(--low-bg); color: var(--low); }

  ol.waves { list-style: none; counter-reset: w; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 1rem; }
  ol.waves > li {
    counter-increment: w; display: grid; grid-template-columns: 2rem 1fr; gap: .1rem 1rem;
    border-top: 1px solid var(--rule); padding-top: 1rem;
  }
  ol.waves > li::before {
    content: counter(w); font-variant-numeric: tabular-nums; color: var(--accent);
    font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 650; font-size: .95rem; padding-top: .18rem;
  }
  .wave-t { font-size: 1.05rem; margin: 0 0 .3rem; }
  ol.waves p { font-size: .95rem; color: var(--ink-2); margin: 0; }

  .phase { display: flex; flex-direction: column; gap: 1.25rem; margin-top: 2rem; }
  .phase-head { display: flex; flex-direction: column; gap: .3rem; border-bottom: 1px solid var(--rule-strong); padding-bottom: .7rem; }
  .phase-lede { color: var(--muted); font-size: .93rem; margin: 0; }
  .phase-count { font-family: ui-sans-serif, system-ui, sans-serif; font-size: .76rem; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin: 0; }
  .finder-block { display: flex; flex-direction: column; gap: .55rem; }
  .finder-h { font-family: ui-monospace, Menlo, monospace; font-size: .8rem; font-weight: 500; color: var(--muted); letter-spacing: .02em; }
  ul.rowlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 3px; overflow: hidden; }
  .row {
    background: var(--surface); padding: .7rem .9rem;
    display: grid; grid-template-columns: 3.4rem 1fr; gap: .15rem .8rem; align-items: start;
  }
  .row-t { font-size: .95rem; line-height: 1.45; }
  .row-loc { grid-column: 2; font-size: .76rem; color: var(--muted); overflow-wrap: anywhere; }
  .row-blocker, .row-high { box-shadow: inset 3px 0 0 var(--high); }
  .row-med { box-shadow: inset 3px 0 0 var(--med); }
  .row-low { box-shadow: inset 3px 0 0 var(--rule-strong); }

  footer { border-top: 2px solid var(--rule-strong); padding-top: 1.5rem; color: var(--muted); font-size: .9rem; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>

<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">CRX Manager · Read-only review</p>
    <h1>The ordering cycle, end to end</h1>
    <p class="sub">Quote → planned booking → order → delivery → invoice, and everything that touches it: inventory holds, commissions, permissions and the reports that read from all of it.</p>
    <p class="dateline"><span>9 August 2026</span><span>112 agents · 3 phases</span><span>No code was changed</span></p>
  </header>

  <section class="stats">
    <div class="stat"><span class="stat-n">${counts.total}</span><span class="stat-l">Confirmed</span></div>
    ${counts.blocker ? `<div class="stat stat-high"><span class="stat-n">${counts.blocker}</span><span class="stat-l">Blocker</span></div>` : ''}
    <div class="stat stat-high"><span class="stat-n">${counts.high}</span><span class="stat-l">High</span></div>
    <div class="stat stat-med"><span class="stat-n">${counts.med}</span><span class="stat-l">Medium</span></div>
    <div class="stat"><span class="stat-n">${counts.low}</span><span class="stat-l">Low</span></div>
    <div class="stat"><span class="stat-n">${refutedCount}</span><span class="stat-l">Refuted</span></div>
  </section>

  <section class="block">
    <h2>How to read this</h2>
    <p>Nine reviewers went through the ordering cycle from three angles. Every single thing they reported was then handed to a separate reviewer whose only job was to prove it wrong, using the actual migration files and source. <strong>${refutedCount} claims were disproven and thrown out.</strong> The ${counts.total} below are what survived that.</p>
    <p>The reviewers worked independently and were not reconciled against each other, so a defect two of them found is counted twice. Six known overlaps mean the real backlog is closer to <strong>69 distinct defects</strong> — count the work by fix, not by finding. The duplicates are listed in the audit README.</p>
    <div class="callout">
      <p><strong>One caveat that matters.</strong> Nothing here was checked against the live database. Every reviewer worked from committed files — the migration history, and for the permissions work a disaster-recovery snapshot taken on 27 July. If anything was ever changed directly in Supabase without a migration, that change is invisible to this review. The delivery-completion problem appearing twice is two offline sources agreeing, not a live confirmation. Confirm the live function bodies and grants before fixing anything.</p>
    </div>
  </section>

  <section class="block">
    <h2>The ${highs.length} that matter</h2>
    <p>They fall into ${RENDER_THEMES.length === 1 ? 'one group' : `${RENDER_THEMES.length} groups`}, and the largest is really one problem wearing several hats.</p>
    ${highHtml}
  </section>

  <section class="block">
    <h2>Suggested order of work</h2>
    <p>Roughly by damage-per-hour-of-work. This is a recommendation, not a decision — the sequencing is yours.</p>
    <ol class="waves">
      <li>
        <h3 class="wave-t">Confirm the backups are fresh</h3>
        <p>Two automated weekly backups run — an encrypted off-site dump to the private <code>CRX_Backups</code> repo, and an in-database <code>pg_cron</code> snapshot. Neither is point-in-time, so check both are recent before touching any of this; the off-site copy is the one that survives a database-level disaster.</p>
      </li>
      <li>
        <h3 class="wave-t">Close the direct-write lane</h3>
        <p>Six of the ten high findings, and a good share of the mediums, come from the same root: the tables accept writes that skip the functions holding your safety logic. Tightening the transition triggers and the table-level permissions on quotes, orders and deliveries retires most of this group in one piece of work. It is also the change most likely to break something in normal use, so it wants care and a real test pass.</p>
      </li>
      <li>
        <h3 class="wave-t">Fix the three money bugs</h3>
        <p>Double-billing on partial quick deliveries, commissions permanently cancelled by a void-and-rebill, and caller-supplied cost driving the commission basis. These need no misuse — they are ordinary workflows producing wrong numbers, so they are quietly costing you money or trust today. Each is a self-contained fix.</p>
      </li>
      <li>
        <h3 class="wave-t">Gate the ungated read functions</h3>
        <p>The year-end summary, credit-limit check, customer summary and global search all run with elevated rights and never check who is asking. Adding a role check to each is small, low-risk work.</p>
      </li>
      <li>
        <h3 class="wave-t">Work the medium list as maintenance</h3>
        <p>36 findings, no single emergency among them, but several are cheap: the missing <code>deleted_at</code> filters that let a soft-deleted draft invoice permanently hide the Create Invoice button, the reused idempotency keys on the Quotes and Deliveries screens, the reports that each compute AR a different way.</p>
      </li>
    </ol>
  </section>

  <section class="block">
    <h2>Everything found</h2>
    <p>All ${counts.total} confirmed findings, grouped by review phase and by the reviewer that found them. Full evidence, failure scenarios and verifier reasoning for each are in <code>FINDINGS.md</code> and <code>findings.json</code> alongside this report.</p>
    ${appendixHtml}
  </section>

  <footer>
    <p>Read-only review — nothing was committed, pushed, migrated, or written to the database. Fixes are a separate job, to be scoped and approved after you have read this.</p>
  </footer>

</div>
</body>
</html>`;

fs.writeFileSync(new URL('./report.html', import.meta.url), html);
console.log('wrote report.html —', html.length, 'bytes,', rows.length, 'findings');
