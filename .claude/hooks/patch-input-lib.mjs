import { readFileSync } from "node:fs";
import path from "node:path";

export function isApplyPatchTool(toolName) {
  return /(^|__)apply_patch$/i.test(String(toolName || ""));
}

export function extractPatchTargetPaths(toolInput = {}, root = process.cwd()) {
  const patchText = String(
    toolInput.patch ?? toolInput.diff ?? toolInput.input ?? toolInput.changes ?? ""
  );
  const targets = [];
  let current = null;

  const finish = () => {
    if (!current) return;
    const selected = current.moveTo || current.filePath;
    if (selected) targets.push(path.resolve(root, selected).replace(/\\/g, "/"));
    current = null;
  };

  for (const line of patchText.split(/\r?\n/)) {
    const header = line.match(/^\*{3}\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/i);
    if (header) {
      finish();
      current = { filePath: header[2].trim(), moveTo: "" };
      continue;
    }
    if (!current) continue;
    const move = line.match(/^\*{3}\s+Move to:\s*(.+?)\s*$/i);
    if (move) current.moveTo = move[1].trim();
    if (/^\*{3}\s+End Patch\s*$/i.test(line)) finish();
  }
  finish();
  return [...new Set(targets)];
}

function findLine(lines, context, start) {
  const needle = context.trim();
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === context || lines[i].trim() === needle) return i;
  }
  return -1;
}

function findSequence(lines, sequence, start) {
  if (sequence.length === 0) return start;
  for (let i = start; i <= lines.length - sequence.length; i++) {
    if (sequence.every((line, offset) => lines[i + offset] === line)) return i;
  }
  return -1;
}

function applyUpdate(preimage, hunks) {
  const lines = preimage.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;

  for (const hunk of hunks) {
    let searchStart = cursor;
    if (hunk.context) {
      const anchor = findLine(lines, hunk.context, cursor);
      if (anchor < 0) throw new Error(`hunk anchor not found: ${hunk.context}`);
      searchStart = anchor + 1;
    }

    const oldLines = hunk.lines
      .filter(({ prefix }) => prefix === " " || prefix === "-")
      .map(({ text }) => text);
    const newLines = hunk.lines
      .filter(({ prefix }) => prefix === " " || prefix === "+")
      .map(({ text }) => text);
    const index = findSequence(lines, oldLines, searchStart);
    if (index < 0) throw new Error("hunk preimage not found");
    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }

  return lines.join("\n");
}

function relevantSafetyPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || "";
  return (
    /\.(?:sql|ts|tsx)$/.test(normalized) ||
    /\/src\/.*\.(?:js|jsx)$/.test(normalized) ||
    /^\.env(?:\.|$)/.test(basename)
  );
}

export function extractPatchChanges(toolInput = {}, root = process.cwd()) {
  const patchText = String(
    toolInput.patch ?? toolInput.diff ?? toolInput.input ?? toolInput.changes ?? ""
  );
  if (!patchText) return { changes: [], errors: [] };

  const sections = [];
  let current = null;
  let hunk = null;

  const finish = () => {
    if (!current) return;
    if (hunk) current.hunks.push(hunk);
    sections.push(current);
    current = null;
    hunk = null;
  };

  for (const line of patchText.split(/\r?\n/)) {
    const header = line.match(/^\*{3}\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/i);
    if (header) {
      finish();
      current = {
        operation: header[1].toLowerCase(),
        filePath: header[2].trim(),
        moveTo: "",
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    const move = line.match(/^\*{3}\s+Move to:\s*(.+?)\s*$/i);
    if (move) {
      current.moveTo = move[1].trim();
      continue;
    }
    if (/^\*{3}\s+End Patch\s*$/i.test(line)) {
      finish();
      continue;
    }
    const hunkHeader = line.match(/^@@(?:\s(.*))?$/);
    if (hunkHeader) {
      if (hunk) current.hunks.push(hunk);
      hunk = { context: hunkHeader[1] || "", lines: [] };
      continue;
    }
    if (/^[ +\-]/.test(line)) {
      if (!hunk) hunk = { context: "", lines: [] };
      hunk.lines.push({ prefix: line[0], text: line.slice(1) });
    }
  }
  finish();

  const changes = [];
  const errors = [];
  for (const section of sections) {
    const sourcePath = path.resolve(root, section.filePath).replace(/\\/g, "/");
    const destinationPath = section.moveTo
      ? path.resolve(root, section.moveTo).replace(/\\/g, "/")
      : sourcePath;
    try {
      let content = "";
      if (section.operation === "add") {
        content = section.hunks
          .flatMap(({ lines }) => lines.filter(({ prefix }) => prefix === "+").map(({ text }) => text))
          .join("\n");
      } else if (section.operation === "update") {
        content = applyUpdate(readFileSync(sourcePath, "utf8"), section.hunks);
      }

      if (section.moveTo) {
        changes.push({
          filePath: sourcePath,
          content: "",
          operation: "move-source",
          hasContentChanges: false,
        });
      }
      if (section.operation !== "delete") {
        const hasContentChanges = section.hunks.some(({ lines }) =>
          lines.some(({ prefix }) => prefix === "+" || prefix === "-")
        );
        changes.push({
          filePath: destinationPath,
          content,
          operation: section.moveTo ? "move-destination" : section.operation,
          hasContentChanges,
        });
      } else {
        changes.push({ filePath: sourcePath, content: "", operation: "delete", hasContentChanges: false });
      }
    } catch (error) {
      errors.push({
        filePath: destinationPath,
        relevant: relevantSafetyPath(destinationPath),
        reason: error?.message || String(error),
      });
    }
  }
  return { changes, errors };
}
