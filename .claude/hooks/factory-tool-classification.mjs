const LOCAL_STRUCTURED_WRITE_TOOL = /^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i;
const MCP_WRITE_OPERATION = /(?:^|_)(?:write|edit|patch|replace|create|delete|remove|move|rename|copy|upload|push|apply|update|append|deploy|publish|commit|merge|set)(?:_|$)/i;
const MCP_READ_OPERATION = /(?:^|_)(?:read|list|search|find|get|stat|info|view|download)(?:_|$)/i;
const LOCAL_FILESYSTEM_MCP_SERVERS = new Set(["filesystem", "desktop_commander"]);

function mcpToolParts(toolName) {
  const match = String(toolName || "").match(/^mcp__([a-z0-9_]+)__(.+)$/i);
  if (!match) return null;
  return { server: match[1].toLowerCase(), operation: match[2].toLowerCase() };
}

export function isPotentialStructuredMutationTool(toolName) {
  if (LOCAL_STRUCTURED_WRITE_TOOL.test(String(toolName || ""))) return true;
  const mcpTool = mcpToolParts(toolName);
  if (!mcpTool) return false;
  if (MCP_WRITE_OPERATION.test(mcpTool.operation)) return true;
  return !MCP_READ_OPERATION.test(mcpTool.operation);
}

export function isStructuredFilesystemMutationTool(toolName) {
  const name = String(toolName || "");
  if (LOCAL_STRUCTURED_WRITE_TOOL.test(name)) return true;
  const mcpTool = mcpToolParts(name);
  return Boolean(
    mcpTool
      && LOCAL_FILESYSTEM_MCP_SERVERS.has(mcpTool.server)
      && MCP_WRITE_OPERATION.test(mcpTool.operation),
  );
}
