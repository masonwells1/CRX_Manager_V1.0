## 2026-09-04 - Whole-audit input validation

- Normalized object and JSON-string workflow arguments so focused audits cannot silently expand to a full run.
- Rejected empty, malformed, and unknown audit filters with explicit blocked results and executable tests.
- Required every verified finding to carry a supported severity and aligned preflight's migration ledger trigger with enforcement.
