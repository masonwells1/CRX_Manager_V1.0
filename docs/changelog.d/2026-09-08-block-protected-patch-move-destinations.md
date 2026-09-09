## 2026-09-08 - block protected patch move destinations

The shared patch-destination parser now recognizes apply_patch's actual
`*** Move to: <destination>` header. Sol's review found that checking only the
source path allowed an ordinary file to be moved onto a protected guard or
wrapper-owned review proof. Direct raw and structured evaluator tests now deny
both destinations. JSON/stdin tests observe the specific protection decision
with a successful process exit and no error output. An ordinary documentation
move that only mentions a protected path remains allowed through both routes.
The shared parser and production guard suites passed locally; these checks do
not change hooks in other existing checkouts.
