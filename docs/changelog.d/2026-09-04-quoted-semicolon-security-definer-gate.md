## 2026-09-04 - Quoted semicolon SECURITY DEFINER gate

- Made fallback SECURITY DEFINER statement detection quote-aware, so a semicolon inside a quoted identifier cannot hide an owner-privileged routine from the anonymous-execution guard.
