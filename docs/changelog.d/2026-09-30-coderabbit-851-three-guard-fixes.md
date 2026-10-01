## 2026-09-30 - Guards: three CodeRabbit findings on PR #851 fixed

Mason chose "fix the 3" after CodeRabbit's full review of PR #851 (the delivery PR for #795's guard work):

- **Clustered `-o`:** `bash -oc xtrace '<command>'` passed the merge guards, because only a bare `-o`
  took a value, so `xtrace` was read as the command. Every `o`/`O` in a cluster now takes the next word.
- **Run-time arguments in a decoded payload:** `pwsh -EncodedCommand` carrying
  `$f='--admin'; gh pr merge 123 --squash $f` was not refused, because neither the outer text nor the
  program name was the trigger. The decoded text's own gh/git mention now counts.
- **Substitutions in a here-document body:** with an unquoted delimiter, bash runs `$( )` and backticks in
  the body, so `cat <<EOF` + `$(cat payload.txt | bash)` fed bash unseen. Such a body is now refused;
  a quoted delimiter (`<<'EOF'`) keeps the body literal and passes.

Proof: the pre-fix shared library, run on each command, found no nested merge, no run-time text and no
interpreter feed; the fixed one finds each. The real hooks refuse all five attack spellings and pass
`bash -o pipefail -c 'npm test'`, a quoted here-document with `$( )`, and a harmless encoded command.
Every earlier attack and control gives the same result as before.

The fourth finding, `python3 -W ignore` reading its program from input, was already accepted in round 4
and is answered, not changed.

Not verified: real bash was not run on `-oc`; the rule follows the bash manual. Unquoted here-documents
that legitimately use `$( )` in their body are now refused (quote the delimiter instead).
