## 2026-09-12 - Job acreage decimal submission guard

Follow-up to #582, #596 and #606; their landed server protections remain unchanged.

- Compare converted chemical quantities against the server's inclusive decimal tolerance using scaled integers and cross-multiplied unit sizes. Pass the exact sum of numeric field payload values, rather than rounding that sum back to a JavaScript number.
- Refuse typed acreage that would silently change in the existing numeric save payload. Intentional blanks still mean zero; exactly representable scientific notation remains supported. The refusal runs inside `performSave`, including the expired-license admin override, before saving state or RPC work.
- Preserve numeric payload shapes, unit tables, dry-fluid refusal, money calculations and database schema. No migration or live mutation is part of this change.

Observed red baseline: four regressions failed before implementation (converted lower-boundary calculation, actual rendered Save refusal at that boundary, and two typed acreage precision losses). Independent review then found an inherited-unit-property render crash; positive safe-integer unit-size validation and constructor/toString/__proto__ regressions repaired it. Final independent compliance review was clean and all 184 focused tests passed, including actual rendered Save, precision refusal and admin override paths. The corrected full run passed 374 files and 5,277 tests (123 skipped), with lint, typecheck, build, dependency and documentation checks passing. The earlier full run with the crash is not clearance. Exact-commit independent review and protected delivery remain required; this entry is not a claim of deployment.
