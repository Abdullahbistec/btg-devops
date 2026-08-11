import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerTools } from './tools'

// Spec 8's MCP server, folded into the dashboard's own deployment (Vercel)
// instead of a separately hosted process — every other option that needs a
// truly persistent host requires a card for anti-abuse verification (Fly,
// Render sleeps on its free tier, Cloudflare Workers can't hold a raw TCP
// connection to Postgres). The transport is already stateless (one request
// = one throwaway McpServer + transport instance, see registerTools) so it
// maps directly onto a serverless route handler with no code compromise.
export const runtime = 'nodejs'

function unauthorized() {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null },
    { status: 401 }
  )
}

function checkBearerToken(req: Request) {
  const expected = process.env.MCP_BEARER_TOKEN
  if (!expected) return false
  const header = req.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  return token === expected
}

export async function POST(req: Request) {
  if (!process.env.MCP_BEARER_TOKEN) {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'MCP_BEARER_TOKEN is not configured on the server' }, id: null },
      { status: 500 }
    )
  }
  if (!checkBearerToken(req)) return unauthorized()

  const server = new McpServer({ name: 'btg-devops-mcp', version: '1.0.0' })
  registerTools(server)
  // enableJsonResponse: true — each request is one throwaway tool call (no
  // server-initiated push needed), so a single JSON response is correct
  // here, not an SSE stream. It also means handleRequest's Response resolves
  // with a fully-buffered body, so it's safe to close the transport/server
  // right after in `finally` — an SSE stream's body is still being written
  // when handleRequest returns, so closing there would cut it off mid-flight.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)

  try {
    return await transport.handleRequest(req)
  } finally {
    transport.close()
    server.close()
  }
}

export async function GET(req: Request) {
  if (!checkBearerToken(req)) return unauthorized()
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed (stateless server — no SSE stream to resume)' }, id: null },
    { status: 405 }
  )
}
