import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildRepinnedSource, inspectRepin } from "./repin-retained-guard-producer-20260828.mjs";

const target = path.join(process.cwd(), "scripts", "apply-live-" + "testdata-maintenance-20260812.mjs");
const input = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
const inspection = inspectRepin();

assert.equal(inspection.input, input);
assert.equal(buildRepinnedSource(input), inspection.output);
assert.match(inspection.input, /EXPECTED_OUTPUT_BLOB = "7bca8dce4fe2f58afabdbd09d1b31ecef61ce520"/);
assert.match(inspection.output, /EXPECTED_OUTPUT_BLOB = "0e947bc2a86cda1bdb4b2ad860b3aef5e023e264"/);
assert.doesNotMatch(inspection.output, /EXPECTED_OUTPUT_BLOB = "7bca8dce4fe2f58afabdbd09d1b31ecef61ce520"/);
assert.equal(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), input, "verification must not write the retained producer");

process.stdout.write("retained producer repin: all assertions passed; target unchanged\n");
