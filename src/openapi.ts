import type { LiteConfig } from './types.js';

function objectSchema(properties: Record<string, unknown>, required: string[] = [], additionalProperties = false) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties };
}

const errorSchema = objectSchema({
  code: { type: 'string' },
  message: { type: 'string' },
  retryable: { type: 'boolean' },
}, ['code', 'message', 'retryable']);

const responseSchema = objectSchema({
  ok: { type: 'boolean' },
  data: { type: 'object', additionalProperties: true },
  error: errorSchema,
}, ['ok']);

function operation(args: { operationId: string; summary: string; description: string; requestSchemaRef: string; consequential: boolean; examples: Record<string, unknown> }) {
  return {
    operationId: args.operationId,
    summary: args.summary,
    description: args.description,
    'x-openai-isConsequential': args.consequential,
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: args.requestSchemaRef }, examples: args.examples } },
    },
    responses: {
      200: { description: 'Operation completed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolResponse' } } } },
      400: { description: 'Malformed or invalid input.' },
      401: { description: 'Missing or invalid Bearer credential.' },
      404: { description: 'Extension or resource not found.' },
      500: { description: 'Unexpected server failure.' },
    },
  };
}

export function buildOpenApi(config: LiteConfig) {
  const toolInput = objectSchema({
    name: { type: 'string', description: 'Session or extension name.' },
    role: { type: 'string', description: 'Session collaboration role.' },
    session: { type: 'string', description: 'Session name or ID to update, remove, or inspect.' },
    status: { type: 'string', enum: ['active', 'idle', 'blocked', 'completed'] },
    note: { type: 'string' },
    from: { type: 'string', description: 'Optional sender session name or ID; sessionId is used when omitted.' },
    to: { type: 'string', description: 'Required recipient session name or ID for message_send.' },
    body: { type: 'string', description: 'Required durable message body for message_send.' },
    markRead: { type: 'boolean', description: 'Mark returned inbox messages as read.' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    path: { type: 'string', description: 'Workspace-relative file path.' },
    query: { type: 'string' },
    pattern: { type: 'string' },
    include: { type: 'string' },
    exclude: { type: 'string' },
    maxResults: { type: 'integer' },
    maxBytes: { type: 'integer' },
    startLine: { type: 'integer', minimum: 1 },
    endLine: { type: 'integer', minimum: 1 },
    content: { type: 'string' },
    expectedSha256: { type: 'string' },
    createParents: { type: 'boolean' },
    replacements: { type: 'array', items: objectSchema({ oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, ['oldText', 'newText']) },
    command: { type: 'string' },
    cwd: { type: 'string' },
    timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 },
    revision: { type: 'string' },
    includeTest: { type: 'boolean' },
  }, [], true);
  const jsonSchemaProperty = objectSchema({
    type: { type: 'string', enum: ['object', 'array', 'string', 'number', 'integer', 'boolean'] },
    description: { type: 'string' },
    enum: { type: 'array', items: {} },
    default: {},
    minLength: { type: 'integer', minimum: 0 },
    maxLength: { type: 'integer', minimum: 0 },
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    minItems: { type: 'integer', minimum: 0 },
    maxItems: { type: 'integer', minimum: 0 },
    items: { type: 'object', additionalProperties: true },
  }, ['type'], true);
  const jsonObjectSchema = objectSchema({
    type: { type: 'string', enum: ['object'] },
    properties: { type: 'object', additionalProperties: { $ref: '#/components/schemas/JsonSchemaProperty' } },
    required: { type: 'array', items: { type: 'string' } },
    additionalProperties: { type: 'boolean', enum: [false] },
  }, ['type', 'properties', 'additionalProperties']);
  const extensionAnnotations = objectSchema({
    readOnlyHint: { type: 'boolean' },
    destructiveHint: { type: 'boolean' },
    openWorldHint: { type: 'boolean' },
    idempotentHint: { type: 'boolean' },
  }, ['readOnlyHint', 'destructiveHint', 'openWorldHint']);
  const extensionHandler = objectSchema({
    kind: { type: 'string', enum: ['builtin', 'command'] },
    target: { type: 'string', description: 'Existing builtin name when kind=builtin.' },
    defaults: { $ref: '#/components/schemas/ExtensionToolInput' },
    executable: { type: 'string', description: 'Fixed executable name when kind=command.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Literal or {{input.field}} argument templates.' },
    cwd: { type: 'string' },
    timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 },
  }, ['kind']);
  const extensionSpec = objectSchema({
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' },
    title: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', minLength: 10, maxLength: 800 },
    inputSchema: { $ref: '#/components/schemas/JsonObjectSchema' },
    annotations: { $ref: '#/components/schemas/ExtensionAnnotations' },
    handler: { $ref: '#/components/schemas/ExtensionHandler' },
  }, ['name', 'title', 'description', 'inputSchema', 'annotations', 'handler']);
  const discoverRequest = objectSchema({
    query: { type: 'string', minLength: 1, maxLength: 200 },
    includeSchemas: { type: 'boolean', default: true },
    sessionId: { type: 'string', maxLength: 120 },
  });
  const registerRequest = objectSchema({
    action: { type: 'string', enum: ['validate', 'upsert', 'remove'] },
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' },
    spec: { $ref: '#/components/schemas/ExtensionSpec' },
    specJson: { type: 'string', description: 'Fallback: complete ExtensionSpec encoded as a JSON object string.' },
    sessionId: { type: 'string', maxLength: 120 },
  }, ['action']);
  const callRequest = objectSchema({
    tool: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' },
    input: { $ref: '#/components/schemas/ExtensionToolInput', description: 'Preferred tool arguments. session_register needs name; message_send needs to and body.' },
    arguments: { $ref: '#/components/schemas/ExtensionToolInput', description: 'Legacy alias for input.' },
    inputJson: { type: 'string', description: 'Fallback for custom fields: tool input encoded as a JSON object string.' },
    sessionId: { type: 'string', maxLength: 120 },
  }, ['tool']);
  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: 'LocalTerminal Lite Extensions',
      version: '0.1.0',
      description: 'Three-operation facade for discovering, registering, and invoking LocalTerminal Lite extensions. Concrete tools are managed behind this facade.',
    },
    servers: [{ url: config.publicBaseUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/actions/extensions/discover': {
        post: operation({
          operationId: 'extensionDiscover',
          summary: 'Discover available extension tools',
          description: 'Use first to learn which concrete tools are available, their input schemas, collaboration workflow, and the declarative tool registration format.',
          consequential: false,
          requestSchemaRef: '#/components/schemas/ExtensionDiscoverRequest',
          examples: {
            fullCatalog: { summary: 'Return every available tool and its input schema', value: { includeSchemas: true } },
          },
        }),
      },
      '/actions/extensions/register': {
        post: operation({
          operationId: 'extensionRegister',
          summary: 'Validate, register, edit, or remove an extension tool',
          description: 'Use validate before upsert. For validate/upsert, pass the complete declarative ExtensionSpec in spec; specJson is a JSON-string fallback. Removing or replacing a tool is consequential.',
          consequential: true,
          requestSchemaRef: '#/components/schemas/ExtensionRegisterRequest',
          examples: {
            validateBuiltinAlias: {
              summary: 'Validate a complete declarative builtin alias',
              value: {
                action: 'validate',
                spec: {
                  name: 'list_collaborators',
                  title: 'List collaborators',
                  description: 'List all registered collaboration sessions through a builtin alias.',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
                  handler: { kind: 'builtin', target: 'session_list' },
                },
              },
            },
          },
        }),
      },
      '/actions/extensions/call': {
        post: operation({
          operationId: 'extensionCall',
          summary: 'Invoke one concrete extension tool',
          description: 'Invoke a builtin or registered custom tool by exact name. Put its arguments inside input (preferred) or arguments (legacy); inputJson is a JSON-string fallback. For session_register input needs name. For message_send input needs to and body. Include sessionId for attribution.',
          consequential: true,
          requestSchemaRef: '#/components/schemas/ExtensionCallRequest',
          examples: {
            registerSession: { summary: 'Register a collaborating session', value: { tool: 'session_register', input: { name: 'builder', role: 'developer' } } },
            sendMessage: { summary: 'Send a durable message', value: { tool: 'message_send', sessionId: 'ses_sender', input: { to: 'ses_recipient', body: 'Please review this change.' } } },
            readInbox: { summary: 'Read and acknowledge an inbox', value: { tool: 'message_inbox', sessionId: 'ses_recipient', input: { markRead: true } } },
          },
        }),
      },
    },
    components: {
      schemas: {
        ExtensionDiscoverRequest: discoverRequest,
        ExtensionRegisterRequest: registerRequest,
        ExtensionCallRequest: callRequest,
        ExtensionToolInput: toolInput,
        ExtensionSpec: extensionSpec,
        ExtensionAnnotations: extensionAnnotations,
        ExtensionHandler: extensionHandler,
        JsonObjectSchema: jsonObjectSchema,
        JsonSchemaProperty: jsonSchemaProperty,
        ToolResponse: responseSchema,
        Error: errorSchema,
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'LocalTerminal-Lite-token' },
      },
    },
  };
  return document;
}
