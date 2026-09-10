## 2026-09-03 - Confine migration reviewer packets

Migration-proof reviewer processes now reuse the push-proof packet-only permission profile, including the Windows restricted sandbox, a sanitized environment, and stdin-only prompt delivery. Their saved stdout and stderr also use the shared secret-shaped-text redaction. Focused launcher, evidence, and push-proof tests passed; the full correction suite and independent exact-head review remain required before delivery.
