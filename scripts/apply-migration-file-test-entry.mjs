#!/usr/bin/env node
// Regression-only wrapper. It can evaluate fixture evidence and exercise the
// real file-loader/dry-run path, but the imported entry structurally refuses
// every transmission attempt.

import { runApplyMigrationFileWithCachedTestEvidence } from "./apply-migration-file.mjs";

await runApplyMigrationFileWithCachedTestEvidence(process.argv.slice(2));
