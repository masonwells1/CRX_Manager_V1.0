import path from "node:path";

function normalizedAbsolute(root, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.resolve(root, text);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function resolveCommandExecutionContext(payload, projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot || process.cwd());
  const input = payload?.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : payload?.toolInput && typeof payload.toolInput === "object"
      ? payload.toolInput
      : {};
  const explicitValues = [];
  for (const key of ["workdir", "cwd"]) {
    if (input[key] === undefined || input[key] === null || input[key] === "") continue;
    if (typeof input[key] !== "string") {
      return { cwd: "", error: `the tool-level ${key} is not a static string` };
    }
    explicitValues.push(normalizedAbsolute(root, input[key]));
  }
  if (explicitValues.length === 2 && !samePath(explicitValues[0], explicitValues[1])) {
    return { cwd: "", error: "the tool-level cwd and workdir disagree" };
  }
  if (explicitValues.length > 0) return { cwd: explicitValues[0], error: "" };
  if (payload?.cwd === undefined || payload?.cwd === null || payload?.cwd === "") {
    return { cwd: "", error: "the command execution directory is missing" };
  }
  if (typeof payload.cwd !== "string") {
    return { cwd: "", error: "the command execution directory is not a static string" };
  }
  return { cwd: normalizedAbsolute(root, payload.cwd), error: "" };
}
