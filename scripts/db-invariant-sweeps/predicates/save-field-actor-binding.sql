-- predicate (j): save-field-actor-binding
-- Narrow standing regression control for the audited 2026-07-19 save_field
-- actor-forgery defect. This deliberately checks ONLY the exact five-argument
-- save_field signature rather than pretending to parse every PL/pgSQL actor
-- style in the catalog. Contract: pre-apply exactly this row; post-apply zero.
-- A passing body must bind v_actor=auth.uid before every write/idempotency
-- action, reject p_performed_by mismatch before those actions, and write the
-- activity sink with v_actor rather than the caller parameter. Error tokens,
-- comments, and dead strings are not accepted as proof.

WITH target AS (
  SELECT p.prosrc
  FROM pg_proc p
  WHERE p.oid = 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure
),
normalized AS (
  -- Analyze executable body text only. Strip tagged and untagged dollar-quoted
  -- literals before ordinary quoted strings (including doubled-quote escapes),
  -- then multiline block comments and line comments.
  -- Every structural check below uses normalized_src, never raw prosrc.
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   prosrc,
                   chr(92) || chr(36) || '([a-z_][a-z0-9_]*)' ||
                   chr(92) || chr(36) || '(.|\n)*?' ||
                   chr(92) || chr(36) || chr(92) || '1' ||
                   chr(92) || chr(36),
                   '', 'gi'
                 ),
                 chr(92) || chr(36) || chr(92) || chr(36) ||
                 '(.|\n)*?' ||
                 chr(92) || chr(36) || chr(92) || chr(36),
                 '', 'g'
               ),
               '''([^'']|'''')*''', '', 'g'
             ),
             chr(47) || chr(92) || chr(42) || '([^' || chr(42) || ']|' ||
             chr(92) || chr(42) || '+[^' || chr(42) || chr(47) || '])*' ||
             chr(92) || chr(42) || '+' || chr(47),
             ' ', 'g'
           ),
           chr(45) || chr(45) || E'[^\\n]*', ' ', 'g'
         ) AS normalized_src
  FROM target
),
positions AS (
  SELECT n.*,
         regexp_instr(n.normalized_src, 'v_actor\s*:=\s*auth\.uid\s*\(\s*\)', 1, 1, 0, 'i') AS actor_bind_pos,
         regexp_instr(n.normalized_src, 'if\s+p_performed_by\s+is\s+not\s+null\s+and\s+p_performed_by\s+is\s+distinct\s+from\s+v_actor\s+then(.|\n){0,240}raise\s+exception[^;]{0,240};\s*end\s+if', 1, 1, 0, 'i') AS guard_pos,
         regexp_instr(n.normalized_src, 'insert\s+into\s+(public\.)?activity_feed', 1, 1, 0, 'i') AS sink_pos,
         regexp_instr(n.normalized_src, 'insert\s+into\s+(public\.)?activity_feed\s*\([^)]*performed_by[^)]*\)\s*values\s*\([^;]*\mv_actor\M', 1, 1, 0, 'i') AS actor_sink_pos
  FROM normalized n
),
ordered AS (
  SELECT p.*,
         (
           SELECT min(pos)
           FROM unnest(ARRAY[
             nullif(regexp_instr(p.normalized_src, 'check_idempotency\s*\(', 1, 1, 0, 'i'), 0),
             nullif(regexp_instr(p.normalized_src, 'insert\s+into\s+fields', 1, 1, 0, 'i'), 0),
             nullif(regexp_instr(p.normalized_src, 'update\s+fields\s+set', 1, 1, 0, 'i'), 0),
             nullif(regexp_instr(p.normalized_src, 'delete\s+from\s+field_billing_defaults', 1, 1, 0, 'i'), 0),
             nullif(regexp_instr(p.normalized_src, 'insert\s+into\s+(public\.)?activity_feed', 1, 1, 0, 'i'), 0),
             nullif(regexp_instr(p.normalized_src, 'save_idempotency\s*\(', 1, 1, 0, 'i'), 0)
           ]) AS action(pos)
         ) AS first_action_pos
  FROM positions p
)
SELECT 'save_field(uuid, jsonb, jsonb, uuid, text)' AS violation_key
FROM ordered
WHERE NOT (
  actor_bind_pos > 0
  AND guard_pos > 0
  AND first_action_pos IS NOT NULL
  AND actor_bind_pos < first_action_pos
  AND guard_pos < first_action_pos
  AND sink_pos > guard_pos
  AND actor_sink_pos = sink_pos
  AND substring(normalized_src FROM sink_pos FOR 1500) !~* '\mp_performed_by\M'
);
