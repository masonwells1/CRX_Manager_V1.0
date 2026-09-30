## 2026-09-30 — Mason's Windows Hello approval key set up and proven end to end

- **Windows PowerShell 5.1 fix.** It cannot pass a WinRT buffer returned by one call into another
  call; the value arrives as a bare `__ComObject`. Reproduced when the first real key was created.
  `owner-approval-hello.ps1` now converts buffers through .NET reflection
  (`WindowsRuntimeBufferExtensions.ToArray` / `AsBuffer` and `KeyCredential.RequestSignAsync`),
  which casts at the CLR level.
- `scripts/owner-approval-setup.mjs` now reuses a key left by an interrupted setup. That key is
  still Windows Hello-bound, and the self-test must pass before anything is pinned.
- **Setup run on Mason's PC with Mason present:**
  - Windows Hello created the key; its public half is a 2048-bit RSA key.
  - His Windows Hello test signature verified in Node (`crypto.verify` sha256, PKCS#1 v1.5), and an
    edited copy of the payload was rejected.
  - The pinned `.claude/hooks/owner-approval-key.json` (fingerprint `bf9e2957…da0297`) equals the key
    Windows holds (`readPinnedOwnerKey().equals(readLiveOwnerKey())` returned true).
- This closes the "not verified here" item in `2026-09-29-owner-windows-hello-migration-approval.md`:
  the real signature format matches the verifier.
- Nothing was applied to the live database.
