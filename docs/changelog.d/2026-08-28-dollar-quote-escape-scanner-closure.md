## 2026-08-28 - Dollar-quote escape-string scanner closure

The destructive-migration scanner now recognizes PostgreSQL `E'...'` strings while it decides
whether dollar-quoted function bodies may be ignored. A backslash-escaped quote can no longer let a
dollar tag inside the string pair with a tag in a later comment and hide a real top-level `DELETE`.

The complete exploit is permanently covered both by the direct classifier and by the armed
hands-free migration path. The protected scanner change was made through an independently reviewed,
input/output-pinned maintenance transformer, and the retained maintenance harness is re-pinned to the
new scanner body.
