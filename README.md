# mcp-pipeworx-catalog

Pipeworx Catalog MCP — Exposes the full Pipeworx platform to Claude

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 250+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `list_packs` | Browse all available Pipeworx packs. Returns pack names, categories, tool counts, and gateway URLs. Use to discover data sources or explore what\'s available. |
| `get_pack_tools` | Get tool definitions for a specific pack (e.g., \'weather\', \'stocks\'). Returns tool names, descriptions, parameters, and requirements. Use before calling a tool to verify its interface. |
| `get_connection_config` | Get MCP setup instructions for connecting to Pipeworx packs. Returns connection details and gateway URLs. Use to configure your environment. |
| `search_packs` | Search packs by keyword across names, descriptions, and tools (e.g., \'weather\', \'translate\'). Returns matching packs with details. Use to find specific capabilities. |
| `get_platform_status` | Check Pipeworx platform health and availability. Returns pack count, active tool count, and any service alerts. Use to verify system status before operations. |
| `search_mcp_directory` | Search thousands of MCP servers by use case (e.g., \'database\', \'email\', \'calendar\'). Returns community and hosted servers. Use to find tools beyond Pipeworx. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pipeworx-catalog": {
      "url": "https://gateway.pipeworx.io/pipeworx-catalog/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 250+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Pipeworx Catalog data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
