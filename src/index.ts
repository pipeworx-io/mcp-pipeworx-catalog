interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Pipeworx Catalog MCP — Exposes the full Pipeworx platform to Claude
 *
 * Provides live access to all available packs, tools, connection configs,
 * platform status, and the MCP directory. Updated daily as new packs
 * are added. Load this in every Claude session so I always know what's
 * available on Pipeworx.
 */


const GATEWAY = 'https://gateway.pipeworx.io';
const REGISTRY = 'https://registry.pipeworx.io';

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function postJsonRpc(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'list_packs',
    description: 'List all available Pipeworx MCP packs with their slug, name, category, tool count, and gateway URL. This is the master inventory of everything Pipeworx offers. Use this to find packs by category or discover what data sources are available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category (e.g., Science, Finance, Games, Humor, Entertainment, Reference)' },
      },
      required: [],
    },
  },
  {
    name: 'get_pack_tools',
    description: 'Get the full tool definitions for a specific pack — tool names, descriptions, parameters with types and required flags. Use this before calling a tool to understand its exact interface.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Pack slug (e.g., weather, pokemon, github)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_connection_config',
    description: 'Get the MCP client config JSON for connecting to one or more packs. Returns ready-to-paste config for Claude Desktop, Claude Code CLI command, and the raw gateway URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slugs: { type: 'string', description: 'Comma-separated pack slugs (e.g., "weather,github,jokes") or "all" for everything' },
      },
      required: ['slugs'],
    },
  },
  {
    name: 'search_packs',
    description: 'Search Pipeworx packs by keyword. Searches pack names, descriptions, and tool names. Use when looking for a specific capability (e.g., "translate text", "stock prices", "random jokes").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_platform_status',
    description: 'Get current Pipeworx platform health — how many packs are live, any outages or degraded services, total tool count.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_mcp_directory',
    description: 'Search the full Pipeworx MCP directory — not just hosted packs but thousands of community MCP servers indexed from across the ecosystem. Use to find MCP servers for specific use cases.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        category: { type: 'string', description: 'Filter by category' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_packs':
      return listPacks(args.category as string | undefined);
    case 'get_pack_tools':
      return getPackTools(args.slug as string);
    case 'get_connection_config':
      return getConnectionConfig(args.slugs as string);
    case 'search_packs':
      return searchPacks(args.query as string);
    case 'get_platform_status':
      return getPlatformStatus();
    case 'search_mcp_directory':
      return searchDirectory(args.query as string, args.category as string | undefined, (args.limit as number) ?? 10);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function listPacks(category?: string): Promise<unknown> {
  // Get all packs from the registry
  const apis = (await fetchJson(`${REGISTRY}/apis?limit=500`)) as {
    apis: Array<{
      api_slug: string;
      display_name: string;
      description: string;
      category: string;
      status: string;
    }>;
  };

  let packs = apis.apis;
  if (category) {
    const cat = category.toLowerCase();
    packs = packs.filter((p) => p.category?.toLowerCase().includes(cat));
  }

  return {
    total_packs: packs.length,
    gateway: GATEWAY,
    packs: packs.map((p) => ({
      slug: p.api_slug,
      name: p.display_name,
      description: p.description,
      category: p.category,
      status: p.status,
      gateway_url: `${GATEWAY}/${p.api_slug}/mcp`,
    })),
  };
}

async function getPackTools(slug: string): Promise<unknown> {
  const result = (await postJsonRpc(`${GATEWAY}/${slug}/mcp`, 'tools/list')) as {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  };

  return {
    slug,
    gateway_url: `${GATEWAY}/${slug}/mcp`,
    tool_count: result.tools.length,
    tools: result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
    connect: {
      claude_desktop: {
        mcpServers: {
          [`pipeworx-${slug}`]: {
            command: 'npx',
            args: ['-y', 'mcp-remote@latest', `${GATEWAY}/${slug}/mcp`],
          },
        },
      },
      claude_code: `claude mcp add pipeworx-${slug} -- npx -y mcp-remote@latest ${GATEWAY}/${slug}/mcp`,
    },
  };
}

async function getConnectionConfig(slugs: string): Promise<unknown> {
  const slugList = slugs === 'all' ? ['all'] : slugs.split(',').map((s) => s.trim());

  if (slugList.length === 1 && slugList[0] === 'all') {
    return {
      note: 'Connects to ALL Pipeworx tools in a single MCP connection',
      claude_desktop: {
        mcpServers: {
          pipeworx: {
            command: 'npx',
            args: ['-y', 'mcp-remote@latest', `${GATEWAY}/mcp`],
          },
        },
      },
      claude_code: `claude mcp add pipeworx -- npx -y mcp-remote@latest ${GATEWAY}/mcp`,
      endpoint: `${GATEWAY}/mcp`,
    };
  }

  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const slug of slugList) {
    mcpServers[`pipeworx-${slug}`] = {
      command: 'npx',
      args: ['-y', 'mcp-remote@latest', `${GATEWAY}/${slug}/mcp`],
    };
  }

  return {
    claude_desktop: { mcpServers },
    claude_code: slugList
      .map((s) => `claude mcp add pipeworx-${s} -- npx -y mcp-remote@latest ${GATEWAY}/${s}/mcp`)
      .join('\n'),
    endpoints: slugList.map((s) => `${GATEWAY}/${s}/mcp`),
  };
}

async function searchPacks(query: string): Promise<unknown> {
  const apis = (await fetchJson(`${REGISTRY}/apis?limit=500`)) as {
    apis: Array<{
      api_slug: string;
      display_name: string;
      description: string;
      category: string;
      status: string;
    }>;
  };

  const q = query.toLowerCase();
  const matches = apis.apis.filter(
    (p) =>
      p.api_slug?.toLowerCase().includes(q) ||
      p.display_name?.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q)
  );

  return {
    query,
    results: matches.length,
    packs: matches.map((p) => ({
      slug: p.api_slug,
      name: p.display_name,
      description: p.description,
      category: p.category,
      gateway_url: `${GATEWAY}/${p.api_slug}/mcp`,
    })),
  };
}

async function getPlatformStatus(): Promise<unknown> {
  const [status] = await Promise.all([
    fetchJson(`${REGISTRY}/status`) as Promise<{
      total_apis: number;
      live: number;
      degraded: number;
      down: number;
      status: string;
    }>,
  ]);

  return {
    gateway: GATEWAY,
    website: 'https://pipeworx.io',
    monitored_apis: status.total_apis,
    live: status.live,
    degraded: status.degraded,
    down: status.down,
    overall_status: status.status,
  };
}

async function searchDirectory(query: string, category?: string, limit: number = 10): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (category) params.set('category', category);

  const data = (await fetchJson(`${REGISTRY}/discover?${params}`)) as {
    total: number;
    results: Array<{
      name: string;
      title: string;
      description: string;
      category: string;
      quality_score: number;
      verified: boolean;
    }>;
  };

  return {
    query,
    total: data.total,
    results: data.results.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      category: r.category,
      quality_score: r.quality_score,
      verified: r.verified,
    })),
  };
}

async function callPackTool(slug: string, tool: string, argsJson?: string): Promise<unknown> {
  if (slug === 'pipeworx-catalog') throw new Error('Cannot call catalog tools recursively');
  const toolArgs = argsJson ? JSON.parse(argsJson) : {};
  const result = (await postJsonRpc(`${GATEWAY}/${slug}/mcp`, 'tools/call', {
    name: tool,
    arguments: toolArgs,
  })) as {
    content: Array<{ type: string; text: string }>;
    _meta?: unknown;
  };

  // Extract the tool response from the JSON-RPC wrapper
  if (result.content?.[0]?.text) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }
  return result;
}

export default { tools, callTool } satisfies McpToolExport;
