## 2026-08-31 — Close three bypasses in the guarded-surface lock

An exact-SHA `gpt-5.6-sol` review of the lock's own first head returned BLOCKED with three HIGH
findings. All three were real, each with a working exploit path, and each is now closed with
adversarial tests.

**1. The unlock record could be forged.** The lock protected `scripts/guard-unlock.mjs` but not the
JSON record that script writes. `Write` is blanket-allowed, so an agent could write itself a
fresh-looking unlock, rewrite a production guard, and then invoke the already auto-allowed live SQL,
migration, or push. The interactive TTY prompt was irrelevant to this route — there is no need to
answer a prompt if you can write the answer directly. This one defeated the entire design. The
record path is now guarded. The legitimate flow is unaffected: the unlock script writes and clears
the file with node's `fs` from inside its own process, which is not a tool call and never reaches
the hook.

**2. Mixed-case paths bypassed the lock on Windows.** The guarded patterns were case-sensitive while
CRX runs on a case-insensitive filesystem, so `.CLAUDE/hooks/sql-safety.mjs` edited the real guard
while the matcher returned allow. Path normalization now folds case, closing the class rather than
enumerating spellings.

**3. A lone `&` defeated the read/write split.** Segment splitting handled `&&` but not a single `&`,
which separates commands exactly like `;`. So `cat <a guard> & <writer> <another guard>` stayed one
segment whose head was the read-only `cat`, and the whole command was allowed. Splitting now covers
a lone `&` and carriage returns.

Twenty adversarial assertions added, one per exploit shape, including the forged record through
three different tool fields (`file_path`, `path`, and a shell redirect). 186 assertions total.

**Worth recording as a pattern, not just three fixes.** The lock had 166 passing assertions, had
been observed blocking its own author mid-task, and still carried a fatal hole. Self-written tests
kept confirming the author's own model of the threat; an independent adversarial reader found all
three in a single pass. This is the second time in one session that the Codex gate caught something
that local testing had pronounced sound — the first being the HIGH on removing the `ask` entries.
Guard work in particular should not be considered done on the strength of its own test suite.
