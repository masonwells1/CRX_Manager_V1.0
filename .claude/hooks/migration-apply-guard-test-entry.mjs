#!/usr/bin/env node
// Test-only entrypoint for fixture-backed migration-guard regression cases.
// Production hook manifests must invoke migration-apply-guard.mjs directly;
// that entrypoint performs fixed linked reads in memory and accepts no mode.

import { runMigrationApplyGuardWithCachedTestEvidence } from "./migration-apply-guard.mjs";

runMigrationApplyGuardWithCachedTestEvidence();
