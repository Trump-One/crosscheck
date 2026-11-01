// Keep subscription credentials, but never execute checkout hooks or auto-load MCP.
export const CLAUDE_AUTOMATION_ARGS = [
  '--no-session-persistence',
  '--setting-sources', 'user',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
  '--disable-slash-commands',
] as const
