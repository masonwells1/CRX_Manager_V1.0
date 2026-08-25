#!/usr/bin/env node
// Regression-only wrapper for snapshot invalidation ordering. The transmission
// implementation is fixed to an in-process throw and can never reach a network.

import {
  runApplyMigrationFileWithSimulatedFailedTransmission,
} from "./apply-migration-file.mjs";

await runApplyMigrationFileWithSimulatedFailedTransmission(process.argv.slice(2));
