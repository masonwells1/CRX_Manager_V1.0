## 2026-09-01 — the ratchet could fail CI on a change that touched no claim at all

A follow-up P2 from the automatic PR reviewer on PR #530, and the one with the worst blast radius so
far, because it points **outward** at other people's work rather than inward at the guard.

Widening the wrap window let a claim span up to five lines. That window also fed `claimKey`, and
nothing stopped it running off the end of the comment into the code below. So a claim that wrapped
and was followed by implementation code carried that code in its stored identity. The reviewer
reproduced the consequence: editing a plain `if (…)` line beneath the wrapped `Fail closed.` comment
in `idempotency-body-check.mjs` changed the key, the **unchanged** claim then read as NEW and
unannotated, and the enforced `test:correction-guards` suite failed — on a change that touched no
safety claim whatsoever.

That is worse than the missed claims fixed earlier today. A missed claim is a gap; a false alarm on
innocent edits is a tax on everyone else, and a ratchet that red-flags innocent edits is a ratchet
someone eventually switches off.

Fixed by ending the wrap window at the first line that cannot continue prose. A comment line or the
next piece of a split string literal continues a claim; implementation code does not. Blank and
marker-only lines already ended it.

Tests pin the actual failure: the same wrapped claim with two different lines of code beneath it must
produce the **same** `claimKey`, and no code token may appear in the recorded claim text. Removing
the guard clause fails exactly that assertion.

Baseline regenerated once more — still 163 entries, same claims, with the trailing code no longer
part of their identity.
