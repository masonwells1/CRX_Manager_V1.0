const LOCAL_STRUCTURED_WRITE_TOOL = /^(?:Write|Edit|NotebookEdit|MultiEdit|apply_patch)$/i;
const MCP_WRITE_OPERATION = /(?:^|_)(?:write|edit|patch|replace|create|delete|remove|move|rename|copy|upload)(?:_|$)/i;

export function isStructuredFilesystemMutationTool(toolName) {
  const name = String(toolName || "");
  if (LOCAL_STRUCTURED_WRITE_TOOL.test(name)) return true;
  const mcpTool = name.match(/^mcp__[a-z0-9_]+__(.+)$/i);
  return Boolean(mcpTool && MCP_WRITE_OPERATION.test(mcpTool[1]));
}
