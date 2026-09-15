## 2026-09-09 - Record the unbound pre-tool/open alias-swap race

The attempted global alias refusal did not bind review-state read authorization
to a stable pathname. A separate pre-tool hook cannot bind any checked pathname
to the file a later reader opens, and the refusal made ordinary non-proof files
unreadable through junctions or symlinks, including every state-directory read
when a checkout merely sat below a junctioned parent.

The regression uses a Windows-capable directory junction. Against the prior
guard it received an empty allow verdict, was retargeted, and then opened the
exact bytes of a hard-linked wrapper proof. The reproduction records that
unavoidable pre-hook/open race; it does not claim that a pathname was bound.
Static reads whose resolved target is a proof remain denied, while ordinary
non-proof aliases remain available.

The durable NTFS stream changelog now distinguishes the early lexical
proof-name denial from paths that actually reach resolution/classification.
No production, database, or remote verification was performed.
