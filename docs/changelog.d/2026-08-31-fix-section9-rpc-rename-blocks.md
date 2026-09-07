## 2026-08-31 - Fix Section 9 RPC rename blocks

- Added the required PL/pgSQL terminators to all four Section 9 RPC rename blocks so PostgreSQL can apply the intent-binding migration.
- Expanded the network-isolated PostgreSQL harness to apply the corrected intent migration between the cumulative-billing and final serialization migrations, with a static regression check for every rename block.
