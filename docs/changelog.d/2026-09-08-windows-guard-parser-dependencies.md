## 2026-09-08 - Windows guard parser dependencies

The Windows containment job now installs the locked Node dependencies before it
runs the shared guard suite, so the RPC call-site matcher can load the
TypeScript parser and the required Windows safety check can complete.
