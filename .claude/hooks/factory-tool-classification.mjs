const LOCAL_STRUCTURED_WRITE_TOOL = /^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i;
const MCP_WRITE_OPERATION = /(?:^|_)(?:write|edit|patch|replace|create|delete|remove|move|rename|copy|upload)(?:_|$)/i;
const LOCAL_FILESYSTEM_MCP_SERVERS = new Set(["filesystem", "desktop_commander"]);

function mcpMutationParts(toolName) {
  const match = String(toolName || "").match(/^mcp__([a-z0-9_]+)__(.+)$/i);
  if (!match || !MCP_WRITE_OPERATION.test(match[2])) return null;
  return { server: match[1].toLowerCase(), operation: match[2].toLowerCase() };
}

export function isPotentialStructuredMutationTool(toolName) {
  return LOCAL_STRUCTURED_WRITE_TOOL.test(String(toolName || ""))
    || Boolean(mcpMutationParts(toolName));
}

export function isStructuredFilesystemMutationTool(toolName) {
  const name = String(toolName || "");
  if (LOCAL_STRUCTURED_WRITE_TOOL.test(name)) return true;
  const mcpTool = mcpMutationParts(name);
  return Boolean(mcpTool && LOCAL_FILESYSTEM_MCP_SERVERS.has(mcpTool.server));
}
