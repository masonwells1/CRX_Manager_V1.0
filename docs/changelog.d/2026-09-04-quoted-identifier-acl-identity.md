## 2026-09-04 - Quoted identifier ACL identity

- Preserved quoted PostgreSQL routine identifiers exactly while using a separate offset-preserving view for ACL keyword recognition.
- Added a control-character collision regression so a revoke for one quoted routine cannot satisfy the SECURITY DEFINER guard for a distinct routine.
