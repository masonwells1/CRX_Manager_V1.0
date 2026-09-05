## 2026-09-05 - Run the usage-report regression automatically

Add the usage-report transcript fixture to test:agent-workflows, the existing
suite run by CI. Fable's follow-up review confirmed the prompt-count fix and
identified this missing automatic coverage. The test executes first and retains
the existing suite's failure propagation. No runtime dependency changes.
