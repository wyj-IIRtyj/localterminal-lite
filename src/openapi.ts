import type { LiteConfig } from './types.js';

function objectSchema(properties: Record<string, unknown>, required: string[] = [], additionalProperties = false) {
  return { type: 'object', properties, required, additionalProperties };
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

function operation(args: { operationId: string; summary: string; description: string; requestSchemaRef: string; consequential: boolean }) {
  return {
    operationId: args.operationId,
    summary: args.summary,
    description: args.description,
    'x-openai-isConsequential': args.consequential,
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: args.requestSchemaRef } } },
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
  const jsonSchema = { type: 'object', additionalProperties: true };
  const discoverRequest = objectSchema({
    query: { type: 'string', minLength: 1, maxLength: 200 },
    includeSchemas: { type: 'boolean', default: true },
    sessionId: { type: 'string', maxLength: 120 },
  });
  const registerRequest = objectSchema({
    action: { type: 'string', enum: ['validate', 'upsert', 'remove'] },
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' },
    spec: jsonSchema,
    sessionId: { type: 'string', maxLength: 120 },
  }, ['action']);
  const callRequest = objectSchema({
    tool: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' },
    arguments: jsonSchema,
    sessionId: { type: 'string', maxLength: 120 },
  }, ['tool', 'arguments']);
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
        }),
      },
      '/actions/extensions/register': {
        post: operation({
          operationId: 'extensionRegister',
          summary: 'Validate, register, edit, or remove an extension tool',
          description: 'Use validate before upsert. Registration is declarative and supports aliases to builtins or an executable with argument templates. Removing or replacing a tool is consequential.',
          consequential: true,
          requestSchemaRef: '#/components/schemas/ExtensionRegisterRequest',
        }),
      },
      '/actions/extensions/call': {
        post: operation({
          operationId: 'extensionCall',
          summary: 'Invoke one concrete extension tool',
          description: 'Invoke a builtin or registered custom tool by exact name. Discover its schema first. Include sessionId for multi-session messaging and attribution.',
          consequential: true,
          requestSchemaRef: '#/components/schemas/ExtensionCallRequest',
        }),
      },
    },
    components: {
      schemas: {
        ExtensionDiscoverRequest: discoverRequest,
        ExtensionRegisterRequest: registerRequest,
        ExtensionCallRequest: callRequest,
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
