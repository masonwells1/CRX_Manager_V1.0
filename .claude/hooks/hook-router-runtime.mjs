#!/usr/bin/env node

import { readFileSync } from "node:fs";

class RoutedHookExit extends Error {
  constructor(code = 0) {
    super("routed hook exit");
    this.code = Number(code) || 0;
  }
}

function parsePayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

function mergeOutputs(outputs, eventName) {
  const contexts = [];
  const reasons = [];
  let decision = "";

  for (const output of outputs) {
    if (output?.decision === "block") {
      decision = "block";
      if (output.reason) reasons.push(String(output.reason));
    }
    const context = output?.hookSpecificOutput?.additionalContext;
    if (context) contexts.push(String(context));
  }

  if (!decision && contexts.length === 0) return null;

  const merged = {};
  if (decision) {
    merged.decision = decision;
    merged.reason = reasons.join("\n\n---\n\n");
  }
  if (contexts.length > 0) {
    merged.hookSpecificOutput = {
      hookEventName: eventName,
      additionalContext: contexts.join("\n\n---\n\n"),
    };
  }
  return merged;
}

export async function runHookRouter({ eventName, modulePaths, payload = parsePayload() }) {
  if (!payload || !Array.isArray(modulePaths) || modulePaths.length === 0) return null;

  const originalExit = process.exit;
  const originalWrite = process.stdout.write;
  const priorPayload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD;
  const hadPriorPayload = Object.hasOwn(globalThis, "__CRX_ROUTED_HOOK_PAYLOAD");
  const outputs = [];
  let failed = false;

  globalThis.__CRX_ROUTED_HOOK_PAYLOAD = payload;
  process.exit = (code = 0) => { throw new RoutedHookExit(code); };

  try {
    for (const modulePath of modulePaths) {
      let captured = "";
      process.stdout.write = (chunk) => {
        captured += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        return true;
      };

      try {
        await import(new URL(modulePath, import.meta.url));
      } catch (error) {
        if (!(error instanceof RoutedHookExit)) {
          failed = true;
          process.stderr.write(`HOOK ROUTER: ${modulePath} failed: ${error?.stack || error}\n`);
        } else if (error.code !== 0) {
          failed = true;
          process.stderr.write(`HOOK ROUTER: ${modulePath} exited ${error.code}.\n`);
        }
      }

      if (captured.trim()) {
        try {
          outputs.push(JSON.parse(captured));
        } catch {
          failed = true;
          process.stderr.write(`HOOK ROUTER: ${modulePath} emitted invalid JSON.\n`);
        }
      }
    }
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalWrite;
    if (hadPriorPayload) globalThis.__CRX_ROUTED_HOOK_PAYLOAD = priorPayload;
    else delete globalThis.__CRX_ROUTED_HOOK_PAYLOAD;
  }

  if (failed) process.exitCode = 1;
  return mergeOutputs(outputs, eventName);
}

