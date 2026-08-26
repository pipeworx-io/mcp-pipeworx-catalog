# mcp-pipeworx-catalog

Pipeworx Catalog MCP — Exposes the full Pipeworx platform to Claude

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `list_packs` | Browse all available Pipeworx packs. Returns pack names, categories, tool counts, and gateway URLs. Use to discover data sources or explore what's available. |
| `get_pack_tools` | Get tool definitions for a specific pack (e.g., 'weather', 'stocks'). Returns tool names, descriptions, parameters, and requirements. Use before calling a tool to verify its interface. |
| `get_connection_config` | Get MCP setup instructions for connecting to Pipeworx packs. Returns connection details and gateway URLs. Use to configure your environment. |
| `search_packs` | Search packs by keyword across names, descriptions, and tools (e.g., 'weather', 'translate'). Returns matching packs with details. Use to find specific capabilities. |
| `get_platform_status` | Check Pipeworx platform health and availability. Returns pack count, active tool count, and any service alerts. Use to verify system status before operations. |
| `search_mcp_directory` | Search thousands of MCP servers by use case (e.g., 'database', 'email', 'calendar'). Returns community and hosted servers. Use to find tools beyond Pipeworx. |
| `data_freshness` | MEASURES publication lag for a curated set of high-value live-data sources — how fresh is this data, how old is this number, is this feed real-time, what's the data staleness on X. Every entry is PROBED LIVE against its upstream (not read from a hardcoded table): fetches the newest available datapoint right now and reports the observed lag between that datapoint and this moment. Use before pricing or settling off a number ("can I trust this PortWatch chokepoint count as current", "how stale is Polymarket vs Kalshi order flow", "when did BLS last publish CPI"). Covers maritime chokepoint traffic (IMF PortWatch), vessel AIS positions (Digitraffic), prediction-market trade tape (Polymarket, Kalshi), global news event ingestion (GDELT), and US CPI (BLS) — pass `source` (forgiving match, e.g. "portwatch", "digitraffic ais", "polymarket", "kalshi", "gdelt", "cpi") or `category` ("maritime", "markets", "news", "economics") to scope the probe, or omit both to probe every curated source. Lag is measured at call time and can vary between calls — this tool never reports a lag it did not just observe. |

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/pipeworx-catalog/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Pipeworx Catalog data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
