import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { VintedClient } from './vendor/client/session.js';
import { callTool } from './vendor/dispatch.js';
import { TOOLS, PROMPTS, registerPromptHandler } from './vendor/mcp-defs.js';
import { VERSION } from './vendor/version.js';

interface Env {
  MCP_TOKEN: string;
  VINTED_CACHE_TTL_MS?: string;
  VINTED_RATE_LIMIT_PER_SEC?: string;
  VINTED_RATE_LIMIT_BURST?: string;
}

const MCP_PATH = '/mcp';

// Lebt pro Isolate: Session-Cookies und Cache überleben warme Requests.
let client: VintedClient | undefined;
const getClient = (env: Env) =>
  (client ??= new VintedClient({
    cacheTtlMs: Number(env.VINTED_CACHE_TTL_MS ?? 60_000),
    rateLimitPerSec: Number(env.VINTED_RATE_LIMIT_PER_SEC ?? 3),
    rateLimitBurst: Number(env.VINTED_RATE_LIMIT_BURST ?? 6),
  }));

function makeServer(env: Env): Server {
  const server = new Server(
    { name: 'vinted', version: VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  registerPromptHandler(server, GetPromptRequestSchema);
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await callTool(getClient(env), req.params.name, req.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  });
  return server;
}

async function sha256(v: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
}

async function authorized(req: Request, token: string): Promise<boolean> {
  const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const [a, b] = await Promise.all([sha256(given), sha256(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/' || pathname === '/health') {
      return Response.json({ name: 'vinted-mcp', version: VERSION, endpoint: MCP_PATH });
    }
    if (pathname !== MCP_PATH) return new Response('Not Found', { status: 404 });

    if (!env.MCP_TOKEN) {
      return new Response('MCP_TOKEN secret is not set. Run: wrangler secret put MCP_TOKEN', { status: 500 });
    }
    if (!(await authorized(req, env.MCP_TOKEN))) {
      return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    }

    const server = makeServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  },
};
