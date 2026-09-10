## 2026-09-03 - Fail closed on reviewer policy and caller evidence ambiguity

Protected reviewer-policy reads now use the fixed Git executable with a minimal,
non-redirectable environment in both proof creation and proof validation.

The SECURITY DEFINER scanner recognizes ALTER FUNCTION and quoted identifiers.
Migration internal-caller evidence is deliberately withheld until a lexical
PostgreSQL body parser can prove that a call is executable, rather than allowing
comments or literals to be reported as authenticated callers.
