## 2026-09-05 - Require approval before browser navigation

Move Claude Browser navigate from allow to ask. Opening an authentication-bearing
URL can change the browser session, so navigation needs the same approval as the
other interactive browser tools. This resolves the GitHub review on PR #605.

Final installed-Claude file verification succeeded: an ordinary source file was
written, the guard-file write was recorded in permission_denials, and no guard
file was created. A preceding probe accidentally triggered the hold detector;
the successful probe used a normal continue instruction, with no permission
override. The unlisted local connector also received a normal permission denial.

The in-progress review of the preceding commit was cancelled when this new
finding was read. A fresh review must cover this correction before delivery.
