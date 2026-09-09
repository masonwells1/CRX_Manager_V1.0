## 2026-09-09 - Bind review-state read authorization to a stable pathname

The native review-state read exemption now refuses a pathname that reaches its
file through a symlink, junction, or other inspected reparse-point component.
It also fails closed for every native read beneath this checkout's own
junctioned state directory, including the target's external spelling: a
separate pre-tool hook cannot bind a mutable alias to the later file-tool open.

The regression uses a Windows-capable directory junction. Against the prior
guard it received an empty allow verdict, was retargeted, and then opened the
exact bytes of a hard-linked wrapper proof; after the change the pre-open
verdict denies. Symlink-specific cases remain in the suite for POSIX runners.

The durable NTFS stream changelog now distinguishes the early lexical
proof-name denial from paths that actually reach resolution/classification.
No production, database, or remote verification was performed.
