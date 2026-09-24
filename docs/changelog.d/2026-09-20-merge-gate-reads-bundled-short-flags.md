## 2026-09-20 - The merge gate reads bundled short flags, and admin always wins

Two halves of one hole, both in the cancellation exemption added earlier the
same day:

1. The gh parser recognised a value-taking short option only as a standalone
   word. pflag bundles boolean shorts, so a bundle ending in the body option
   swallows the NEXT word as its value — which meant gh never received the
   cancellation flag, while the administrator flag after it stayed live. The
   guard read the command as a cancellation and stood down on an administrator
   merge. The parser now walks a bundle the way pflag does: the first
   value-taking short consumes the rest of its own token, or the next word when
   nothing follows it.
2. Both guards honoured the cancellation before refusing the administrator flag.
   A cancellation now stands the gate down only when the request carries no
   administrator flag; otherwise it falls through to the existing refusal.

Proven by driving five commands through the guard process: the bundled bypass,
its unbundled spelling, and cancellation-plus-admin are all refused, while a
plain cancellation and a cancellation carrying a boolean short stay allowed.
Locked in by assertions in `.claude/hooks/guards.test.mjs` and
`.claude/hooks/pr-merge-guard.test.mjs`.

Found by the `gpt-5.6-sol` exact-SHA review of `7ac256ea3` (HIGH) on PR #630,
measured as base-blocks/candidate-allows.
