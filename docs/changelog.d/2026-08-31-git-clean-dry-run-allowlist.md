## 2026-08-31 — `git clean` dry runs are no longer blocked by the rule that recommends them

`checkDangerousCommand()` denied `git clean -nd` — a dry run that deletes nothing — with the message
"Review with `git clean -n` first". The flat pattern matched any option cluster containing `f`, `d`,
or `x`, and `-nd` contains `d`, so the guard blocked the exact command its own error text told the
reader to run.

### Design: strict allowlist, deliberately not a parser

The original destructive pattern is **kept verbatim** and still decides. The only change is that a
segment matching a tiny, boring dry-run grammar is exempted from it:

```text
^\s*git\s+clean\s+(?:-n[dx]{0,2}|--dry-run(?:\s+-[dx]{1,2})?)\s*$
```

Anything that grammar does not recognise keeps the original behaviour. **An unanticipated spelling
stays blocked** — a survivor is a false positive, never a hole.

The grammar contains **no free-text slot**: every element is a literal (`git`, `clean`, `--dry-run`)
or a bounded character class (`n`, `[dx]`), anchored at both ends. There is no operand for a shell
metacharacter to hide in.

### Why this shape, and not a parser

Two successive hand-written option parsers, and then a first allowlist with one free-text slot, were
written before this shape. The exact-HEAD `gpt-5.6-sol` review caught each of the three opening a
real destructive bypass that the flat pattern had blocked. All three were regressions introduced by
the fix, not pre-existing gaps, and **all three were caught before the branch was pushed** — the
broken states were never published:

1. **`git clean -fde*.tmp`** — git allows the `-e` exclude pattern to be **attached**, so this is
   `-f -d -e '*.tmp'`, a real force-delete. A letters-only token test skipped the token whole and
   never saw the `f`.
2. **`git -C -n -c clean.requireForce=false clean -dx`** — the `-n` is the **directory argument to
   git's global `-C`**, not a dry-run flag. Scanning every dash token in the segment read it as a dry
   run and permitted a destructive `clean -dx`.
3. **The first allowlist still had one free-text slot** — an optional `-C <path>` prefix with
   `<path>` as `[^\s]+`. That was itself a fail-open: `git -C >src/App.tsx clean -nd` matched the
   grammar, and the **shell** truncates `App.tsx` before git ever runs; command substitution in the
   same operand hides arbitrary commands the same way. Sanitising an operand is the same losing game
   as parsing one, so the slot was removed rather than tightened. `git -C <path> clean -nd` is now
   blocked; run the dry run from the directory itself.

All three stay blocked under the allowlist because none of them matches it, and the code never has to
understand any of the constructions. Each attempt also had a green self-written test suite at the
time it was found broken; the cases were written by the same author who missed the constructions.

### Behaviour

Allowed: `git clean -n`, `-nd`, `-ndx`, `-nx`, `--dry-run`, `--dry-run -d`.

Still blocked, unchanged: `-f`, `-fd`, `-fdx`, `--force`, bare `-d`, bare `-x`, `-fde*.tmp`,
`-fefoo/bar`, `-e -n -dx`, and the `-C -n -c …` form above. A dry run never excuses a destructive
sibling — `git clean -n && git clean -fd` still blocks on the second segment, because the exemption
is evaluated per segment.

Deliberately **still blocked** as fail-closed cost: `-nde*.tmp` (dry run carrying an exclude),
`-d -n` (split spelling), any `-C <path>` or other global-option prefix, and a trailing redirect such
as `git clean -nd > out.txt`. Over-blocking an exotic spelling is the intended price of a carve-out
that cannot open a bypass.

### `clean.requireForce` — an exclude-only invocation is not inherently safe

`git clean` refuses to delete without `-f` or `-n` **because of** `clean.requireForce`, so overriding
that setting deletes without the command ever naming `-f`:
`git -c clean.requireForce=false clean -e '*.tmp'`. The destructive pattern now also matches a
command-line `clean.requireForce=false` (case-insensitive, whitespace-tolerant), so such invocations
are blocked unless they match the dry-run allowlist — which they cannot, since the grammar admits no
global-option prefix.

The same setting placed in a user's `.gitconfig` is invisible to a guard reading command text. That
gap is unchanged from the base pattern and is not closable at this layer. Raised by CodeRabbit on
PR #527 (Major); an earlier draft of this record and its test wrongly described an exclude-only
invocation as "not destructive".

### Verification

`git clean -nd` executes through the live hook stack (it was denied before this change);
`git clean -fd` is still refused. `bash-safety` suite 411 → 450 assertions, pinning both directions
including every case above.

Note for future guard work: a live refusal of `git clean -fd` also comes from `permissions.deny`, so
observing that a command is blocked does **not** prove this library blocked it. Verify the layer
directly.

No product code, migration, database, money, inventory, RLS, or customer-visible change.
