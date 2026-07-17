import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ExtensionService } from './extensions.js';
import type { InvocationContext, JsonObject, ToolResponse } from './types.js';

type LiveSession = { server: McpServer; transport: StreamableHTTPServerTransport };

const responseSchema = {
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
};

const identitySchema = z.object({ sessionId: z.string().min(1), sessionToken: z.string().min(1) });

const extensionToolInput = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  session: z.string().optional(),
  mode: z.enum(['root', 'delegate']).optional(),
  phase: z.enum(['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled']).optional(),
  note: z.string().optional(),
  sessionId: z.string().optional(),
  claimCode: z.string().optional(),
  continuesSessionId: z.string().optional(),
  summary: z.string().optional(),
  objective: z.string().optional(),
  background: z.string().optional(),
  deliverables: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  task: z.record(z.string(), z.unknown()).optional(),
  nextSteps: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  milestone: z.string().optional(),
  tags: z.array(z.string()).optional(),
  targetSessionId: z.string().optional(),
  eventIds: z.array(z.string()).optional(),
  to: z.string().optional(),
  body: z.string().optional(),
  markRead: z.boolean().optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
  includeAncestors: z.boolean().optional(),
  with: z.string().optional(),
  path: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().optional(),
}).catchall(z.unknown());

const extensionSpec = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
    additionalProperties: z.literal(false),
  }),
  annotations: z.object({
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    openWorldHint: z.boolean(),
    idempotentHint: z.boolean().optional(),
  }),
  handler: z.object({
    kind: z.enum(['builtin', 'command']),
    target: z.string().optional(),
    defaults: extensionToolInput.optional(),
    executable: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeoutSec: z.number().int().optional(),
  }),
});

function toToolResult(response: ToolResponse, summary: string) {
  return {
    structuredContent: response as unknown as Record<string, unknown>,
    content: [{ type: 'text' as const, text: response.ok ? summary : `${response.error?.code}: ${response.error?.message}` }],
    isError: !response.ok,
  };
}

function contextFromCall(callContext: unknown): InvocationContext {
  const meta = (callContext as { _meta?: Record<string, unknown> } | undefined)?._meta;
  return {
    transport: 'apps',
    clientSessionKey: typeof meta?.['openai/session'] === 'string' ? meta['openai/session'] : undefined,
  };
}

export function createMcpServer(service: ExtensionService): McpServer {
  const server = new McpServer({ name: 'localterminal-lite', version: '0.4.2' }, {
    instructions: [
      'LocalTerminal Lite sessions are auditable work contexts, not ChatGPT conversation IDs.',
      'Before work, create a root with session_register(mode=root), or claim an unfinished/released session with session_inherit(sessionId, claimCode).',
      'Do not use session_inherit to continue completed work: completed sessions are immutable; create session_register(mode=root, continuesSessionId) or delegate a same-level continuation.',
      'For controller handoff, call session_release to obtain a one-time claimCode, then let the next controller call session_inherit.',
      'Pass identity={sessionId,sessionToken} on authenticated calls and finish every work turn with session_checkpoint.',
      'message_list covers both sent and received messages; message_conversation returns a two-way thread. Recipients accept session name or ID.',
      'Automatic continuation context is intentionally bounded. Use paginated session_history for permanent structured summaries, messages, state events, and sanitized tool calls.',
    ].join('\n'),
  });
  server.registerTool('extension_discover', {
    title: 'Discover extension tools',
    description: 'Use first to learn all concrete tools available behind LocalTerminal Lite, how to call them, and how to validate/register custom tools.',
    inputSchema: { query: z.string().min(1).max(200).optional(), includeSchemas: z.boolean().optional(), identity: identitySchema.optional() },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { 'openai/toolInvocation/invoking': 'Inspecting extensions…', 'openai/toolInvocation/invoked': 'Extension catalog ready' },
  }, async (input, callContext) => toToolResult(await service.discover(input as JsonObject, contextFromCall(callContext)), 'Extension catalog and usage instructions are ready.'));

  server.registerTool('extension_register', {
    title: 'Register or edit extension tool',
    description: 'Validate, upsert, or remove one declarative extension. Validate before upsert. Use extension_discover for the exact registration format.',
    inputSchema: { action: z.enum(['validate', 'upsert', 'remove']), name: z.string().optional(), spec: extensionSpec.optional(), specJson: z.string().optional(), identity: identitySchema.optional() },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    _meta: { 'openai/toolInvocation/invoking': 'Validating extension…', 'openai/toolInvocation/invoked': 'Extension registry updated' },
  }, async (input, callContext) => toToolResult(await service.register(input as JsonObject, contextFromCall(callContext)), 'Extension registration operation completed.'));

  server.registerTool('extension_call', {
    title: 'Call concrete extension tool',
    description: 'Invoke one builtin or custom extension by exact name. Put tool arguments in input (preferred) or arguments (legacy). Call extension_discover first for its schema.',
    inputSchema: { tool: z.string().min(3).max(64), input: extensionToolInput.optional(), arguments: extensionToolInput.optional(), inputJson: z.string().optional(), identity: identitySchema.optional() },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    _meta: { 'openai/toolInvocation/invoking': 'Running extension…', 'openai/toolInvocation/invoked': 'Extension call complete' },
  }, async (input, callContext) => toToolResult(await service.call(input as JsonObject, contextFromCall(callContext)), 'Extension call completed.'));
  return server;
}

export class LiteMcpTransport {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly service: ExtensionService) {}

  activeSessions(): number {
    return this.sessions.size;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const sessionId = req.header('mcp-session-id') || undefined;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session && req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = createMcpServer(this.service);
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { this.sessions.set(id, { server, transport }); },
        onsessionclosed: (id) => { this.sessions.delete(id); },
      });
      transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
      await server.connect(transport);
      session = { server, transport };
    }
    if (!session) {
      res.status(400).json({ error: 'Missing or invalid MCP session. Initialize with POST first.' });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async ({ server, transport }) => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }));
    this.sessions.clear();
  }
}
