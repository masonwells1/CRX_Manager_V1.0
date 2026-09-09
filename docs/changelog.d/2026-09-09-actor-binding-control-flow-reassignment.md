## 2026-09-09 - Reject same-line control-flow reassignment of trusted actor locals

- The actor-binding hook now treats `BEGIN`, `THEN`, `ELSE`, and `LOOP` as valid statement
  boundaries when it looks for PL/pgSQL `:=` assignments to a local initialized from
  `auth.uid()`.
- This closes a case where `IF true THEN v_actor := p_target_id; END IF;` could overwrite the
  trusted local on the same line while the later actor check was still accepted as authentic.
- The exact exploit was added as a regression first and failed against the old scanner. After the
  bounded boundary change, the full actor-binding suite passes all 583 assertions.
