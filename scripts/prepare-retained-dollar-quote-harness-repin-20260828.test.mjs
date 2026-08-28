import assert from "node:assert/strict";
import { buildRepinnedProducer, gitBlob } from "./prepare-retained-dollar-quote-harness-repin-20260828.mjs";

const built = await buildRepinnedProducer();
assert.equal(gitBlob(built.proposed), built.producerBlob, "producer blob must bind the complete proposed producer");
assert.equal(gitBlob(built.generatedOutput), built.generatedBlob, "generated blob must bind the complete generated scanner output");
assert.notEqual(built.current, built.proposed, "the retained producer must actually be re-pinned");
const changedLines = built.proposed.split("\n").filter((line) => !built.current.split("\n").includes(line));
assert.equal(changedLines.length, 2, "only the two reviewed blob constants may be introduced");
assert.ok(changedLines.some((line) => line.includes("EXPECTED_INPUT_BLOB")));
assert.ok(changedLines.some((line) => line.includes("EXPECTED_OUTPUT_BLOB")));

process.stdout.write(JSON.stringify({ generatedBlob: built.generatedBlob, producerBlob: built.producerBlob }) + "\n");
