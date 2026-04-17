#!/usr/bin/env node
// Entry point for the `coderblock-mcp` binary — stdio MCP server.
// See documentation/architecture/CLI_AND_MCP.md §8.
import('../dist/mcp/main.js').catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
