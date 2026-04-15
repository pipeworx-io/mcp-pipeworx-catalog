# mcp-pipeworx-catalog

Pipeworx Catalog MCP — Exposes the full Pipeworx platform to Claude

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|
| `list_packs` | List all available Pipeworx MCP packs with their slug, name, category, tool count, and gateway URL. This is the master inventory of everything Pipeworx offers. Use this to find packs by category or discover what data sources are available. |
| `get_pack_tools` | Get the full tool definitions for a specific pack — tool names, descriptions, parameters with types and required flags. Use this before calling a tool to understand its exact interface. |
| `get_connection_config` | Get the MCP client config JSON for connecting to one or more packs. Returns ready-to-paste config for Claude Desktop, Claude Code CLI command, and the raw gateway URL. |
| `search_packs` | Search Pipeworx packs by keyword. Searches pack names, descriptions, and tool names. Use when looking for a specific capability (e.g., "translate text", "stock prices", "random jokes"). |
| `get_platform_status` | Get current Pipeworx platform health — how many packs are live, any outages or degraded services, total tool count. |
| `search_mcp_directory` | Search the full Pipeworx MCP directory — not just hosted packs but thousands of community MCP servers indexed from across the ecosystem. Use to find MCP servers for specific use cases. |

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "pipeworx-catalog": {
      "url": "https://gateway.pipeworx.io/pipeworx-catalog/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use pipeworx-catalog
```

## License

MIT
