## 2026-09-07 - Keep package-manager options from bypassing manifest guards

Follow-up verification of the saved CodeRabbit dependency-command fix found
that npm --prefix . install left-pad and npm install left-pad --no-save --save
both passed the real guard. The first hid the subcommand behind an option value;
the second overrode the exemption. Neither probe executed npm or changed files.

Parse supported leading option values before classifying the subcommand, and
deny unknown leading options rather than guessing. Competing save/global flags
invalidate the no-save/global exemption. Plain installs from the existing
manifest and unambiguous no-save installs remain permitted. Ambiguous flag
combinations may be conservatively refused; split them into a clear command.
