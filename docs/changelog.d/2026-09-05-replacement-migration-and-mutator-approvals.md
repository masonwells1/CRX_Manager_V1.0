## 2026-09-05 - Close replacement migration and alternate filesystem routes

Independent review of 70a96f1a4 found two remaining approval gaps. Replacement
Supabase UUIDs and aliases now require an exact ask/deny entry for apply_migration,
matching their SQL rule. Existing named/registered server routes retain the
technical migration guards and their existing authorization requirements.

The Desktop Commander deny list now includes edit_file, create_file,
create_directory, and delete_file. These cannot route around native protected-file
approval by reaching Auto mode. A parity assertion derives the filesystem mutator
names recognized by the hook and requires a settings denial for every one, preventing
the lists drifting again. Synthetic tests cover unapproved and allow-only migration
calls plus delegation to explicit ask/deny tiers; no migration is executed.
