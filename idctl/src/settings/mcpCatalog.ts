/**
 * Curated catalog of common MCP servers — so the operator picks a server and
 * fills labeled fields (a directory, a token) instead of memorizing the exact
 * `npx` incantation. Each entry builds a McpServerProfile deterministically.
 * The Test button verifies whatever is built actually launches and lists tools,
 * so a slightly-stale package name is self-correcting rather than silent.
 *
 * The filesystem/memory/sequential-thinking/everything entries are verified to
 * launch + list tools; the token-gated ones (github/brave/postgres) need the
 * operator's secret and should be Tested after filling it in.
 */

import type { McpServerProfile } from './schema.ts';

export interface McpCatalogInput {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;        // render as a password field (tokens)
  default?: string;
  /** Where the value goes: a trailing CLI arg, or an env var. */
  target: 'arg' | 'env';
  envKey?: string;         // required when target === 'env'
}

export interface McpCatalogEntry {
  id: string;              // also the default server name
  name: string;            // friendly label
  description: string;
  command: string;         // e.g. 'npx'
  baseArgs: string[];      // e.g. ['-y', '@modelcontextprotocol/server-filesystem']
  inputs?: McpCatalogInput[];
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files in a directory you allow (read_file, write_file, list_directory, …).',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    inputs: [{ key: 'path', label: 'Directory', placeholder: '/tmp', default: '/tmp', required: true, target: 'arg' }],
  },
  {
    id: 'memory',
    name: 'Memory (knowledge graph)',
    description: 'A persistent knowledge graph the agent can write to and recall (entities, relations, observations).',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'A structured step-by-step reasoning tool for complex problems.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'everything',
    name: 'Everything (reference/test)',
    description: 'The reference MCP server — echo, sampling, prompts. Great for testing the wiring.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-everything'],
  },
  {
    id: 'headroom',
    name: 'Headroom (context compression)',
    description: 'Optional local context compression tools with reversible retrieval handles. Requires the Headroom CLI; test before attaching.',
    command: 'headroom',
    baseArgs: ['mcp', 'serve'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, PRs, search. Needs a GitHub personal access token.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-github'],
    inputs: [{ key: 'token', label: 'GitHub token', placeholder: 'ghp_…', required: true, secret: true, target: 'env', envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN' }],
  },
  {
    id: 'brave-search',
    name: 'Brave Search (web)',
    description: 'Web, local, image, video, news search via the Brave Search API. Needs a Brave API key.',
    command: 'npx',
    baseArgs: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    inputs: [{ key: 'key', label: 'Brave API key', placeholder: 'BSA…', required: true, secret: true, target: 'env', envKey: 'BRAVE_API_KEY' }],
  },
  {
    id: 'postgres',
    name: 'Postgres (read-only)',
    description: 'Query a Postgres database read-only. Needs a connection string.',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    inputs: [{ key: 'url', label: 'Connection URL', placeholder: 'postgresql://user:pass@host:5432/db', required: true, secret: true, target: 'arg' }],
  },

  // ---- Browser / web ---------------------------------------------------
  {
    id: 'playwright',
    name: 'Playwright (browser)',
    description: 'Drive a real browser — navigate, click, type, screenshot, scrape — via the accessibility tree. No API key.',
    command: 'npx',
    baseArgs: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'browsermcp',
    name: 'Browser MCP (your Chrome)',
    description: 'Automate YOUR real Chrome via the Browser MCP extension (uses your logged-in sessions). No key.',
    command: 'npx',
    baseArgs: ['-y', '@browsermcp/mcp@latest'],
  },
  {
    id: 'fetch',
    name: 'Fetch (URL → markdown)',
    description: 'Fetch a web page and convert it to clean markdown. Python server — needs `uv` installed.',
    command: 'uvx',
    baseArgs: ['mcp-server-fetch'],
  },

  // ---- Search / docs ---------------------------------------------------
  {
    id: 'context7',
    name: 'Context7 (live docs)',
    description: 'Up-to-date, version-correct docs + code examples for any library, on demand. No key needed.',
    command: 'npx',
    baseArgs: ['-y', '@upstash/context7-mcp@latest'],
  },
  {
    id: 'tavily',
    name: 'Tavily (web search)',
    description: 'AI-optimized web search + content extract. Needs a Tavily API key.',
    command: 'npx',
    baseArgs: ['-y', 'tavily-mcp@latest'],
    inputs: [{ key: 'key', label: 'Tavily API key', placeholder: 'tvly-…', required: true, secret: true, target: 'env', envKey: 'TAVILY_API_KEY' }],
  },
  {
    id: 'exa',
    name: 'Exa (neural search)',
    description: 'Neural web search + content retrieval. Needs an Exa API key.',
    command: 'npx',
    baseArgs: ['-y', 'exa-mcp-server'],
    inputs: [{ key: 'key', label: 'Exa API key', required: true, secret: true, target: 'env', envKey: 'EXA_API_KEY' }],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl (scrape/crawl)',
    description: 'Scrape, crawl, and extract structured data from websites. Needs a Firecrawl API key.',
    command: 'npx',
    baseArgs: ['-y', 'firecrawl-mcp'],
    inputs: [{ key: 'key', label: 'Firecrawl API key', placeholder: 'fc-…', required: true, secret: true, target: 'env', envKey: 'FIRECRAWL_API_KEY' }],
  },

  // ---- Productivity / design -------------------------------------------
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read/write Notion pages, databases, and comments. Needs a Notion integration token.',
    command: 'npx',
    baseArgs: ['-y', '@notionhq/notion-mcp-server'],
    inputs: [{ key: 'token', label: 'Notion token', placeholder: 'ntn_… / secret_…', required: true, secret: true, target: 'env', envKey: 'NOTION_TOKEN' }],
  },
  {
    id: 'figma',
    name: 'Figma (Framelink)',
    description: 'Pull Figma file/frame data + images for implementing designs. Needs a Figma API key.',
    command: 'npx',
    baseArgs: ['-y', 'figma-developer-mcp', '--stdio'],
    inputs: [{ key: 'key', label: 'Figma API key', required: true, secret: true, target: 'env', envKey: 'FIGMA_API_KEY' }],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read/post Slack messages, list channels, search. Needs a Slack user (xoxp) token.',
    command: 'npx',
    baseArgs: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'],
    inputs: [{ key: 'token', label: 'Slack xoxp token', placeholder: 'xoxp-…', required: true, secret: true, target: 'env', envKey: 'SLACK_MCP_XOXP_TOKEN' }],
  },
];

/** Build a registrable MCP server profile from a catalog entry + filled inputs. */
export function buildFromCatalog(entry: McpCatalogEntry, name: string, values: Record<string, string>): McpServerProfile {
  const args = [...entry.baseArgs];
  const env: Record<string, string> = {};
  for (const inp of entry.inputs ?? []) {
    const v = (values[inp.key] ?? inp.default ?? '').trim();
    if (!v) continue;
    if (inp.target === 'arg') args.push(v);
    else if (inp.target === 'env' && inp.envKey) env[inp.envKey] = v;
  }
  return {
    name: name.trim() || entry.id,
    transport: 'stdio',
    command: entry.command,
    args,
    ...(Object.keys(env).length > 0 && { env }),
    enabled: true,
  };
}
