# Recovery replays

Files in this directory are **not Supabase migration ledger sources**. They are
public, reviewable recovery programs for an applied payload that cannot be
published because it contains sensitive production row identities and money
preimages.

The applied ledger entry remains authoritative:

- version: `20260812154757`
- submitted name: `20260812115238_repair_historical_order_line_cents`
- LF-normalized bytes: `18770`
- SHA-256: `7498b0befab4cd6355560cf9dc29c270a3e0098d2327d24d7eb7ab13d0d927ca`

The public replay has a different filename and identity on purpose. It derives
the same 35-row candidate population under an exclusive lock, then requires the
original full-population digest, counts, impact totals, mapped postimage, and
validated constraint before it can commit. The captured-ledger prover pins both
hashes and executes this replay only to reconstruct the post-state in a
network-isolated disposable database.

Current LF-normalized public recovery replay fingerprint: `13903` bytes,
SHA-256 `d480fab48c6502c7617f4543f61ef05b39299f698aff9562a51f1f78de46c3ec`.

Do not move a recovery replay into `supabase/migrations/`, rename it to an
applied version, or pass it to `supabase migration repair`. A restored database
must first restore the corrected business data from backup, record the private
ledger version only after verifying that data, and use this replay solely for
the independently guarded schema/post-state repair.
