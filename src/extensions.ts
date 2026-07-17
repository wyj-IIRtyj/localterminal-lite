import type { LiteConfig } from './types.js';
import type { LiteStore } from './store.js';
import { renderTemplate, resolveWorkspacePath, validateJsonSchema } from './security.js';
import { runCommand } from './core-tools.js';
import type { CustomExtensionSpec, InvocationContext, JsonObject, ToolDefinition, ToolResponse } from './types.js';

const EXTENSION_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const RESERVED_NAMES = new Set(['extension_discover', 'extension_register', 'extension_call']);

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

function jsonObjectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== 'string') return objectValue(value, label);
  try {
    return objectValue(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must contain a valid JSON object.`);
    throw error;
  }
}

function callArguments(input: JsonObject): JsonObject {
  const legacy = input.arguments === undefined ? {} : jsonObjectValue(input.arguments, 'arguments');
  const fallback = input.inputJson === undefined ? {} : jsonObjectValue(input.inputJson, 'inputJson');
  const preferred = input.input === undefined ? {} : jsonObjectValue(input.input, 'input');
  return { ...legacy, ...fallback, ...preferred };
}

function validateSpec(value: unknown, builtins: Map<string, ToolDefinition>): CustomExtensionSpec {
  const spec = objectValue(value, 'spec') as unknown as CustomExtensionSpec;
  if (typeof spec.name !== 'string' || !EXTENSION_NAME.test(spec.name) || RESERVED_NAMES.has(spec.name)) throw new Error('Extension name must match [a-z][a-z0-9_]{2,63} and cannot use a facade name.');
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 100) throw new Error('Extension title must contain 1-100 characters.');
  if (typeof spec.description !== 'string' || spec.description.length < 10 || spec.description.length > 800) throw new Error('Extension description must contain 10-800 characters.');
  if (!spec.inputSchema || spec.inputSchema.type !== 'object' || spec.inputSchema.additionalProperties !== false) throw new Error('inputSchema must be an object schema with additionalProperties=false.');
  if (!spec.annotations || typeof spec.annotations.readOnlyHint !== 'boolean' || typeof spec.annotations.destructiveHint !== 'boolean' || typeof spec.annotations.openWorldHint !== 'boolean') {
    throw new Error('annotations must declare readOnlyHint, destructiveHint, and openWorldHint.');
  }
  if (!spec.handler || (spec.handler.kind !== 'builtin' && spec.handler.kind !== 'command')) throw new Error('handler.kind must be builtin or command.');
  if (spec.handler.kind === 'builtin') {
    if (!builtins.has(spec.handler.target)) throw new Error(`Unknown builtin target: ${spec.handler.target}`);
  } else {
    if (typeof spec.handler.executable !== 'string' || !spec.handler.executable.trim() || spec.handler.executable.includes('\0') || spec.handler.executable.includes('{{')) throw new Error('Command extension requires a fixed executable name without templates.');
    if (spec.handler.args && (!Array.isArray(spec.handler.args) || spec.handler.args.length > 100 || spec.handler.args.some((item) => typeof item !== 'string' || item.length > 10_000))) throw new Error('Command args must be an array of at most 100 strings.');
    if (spec.handler.timeoutSec !== undefined && (!Number.isInteger(spec.handler.timeoutSec) || spec.handler.timeoutSec < 1 || spec.handler.timeoutSec > 3600)) throw new Error('timeoutSec must be an integer from 1 to 3600.');
  }
  return structuredClone(spec);
}

function failure(error: unknown): ToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: message.includes('not found') ? 'NOT_FOUND' : message.includes('required') || message.includes('must') ? 'INVALID_INPUT' : 'EXTENSION_ERROR', message, retryable: false } };
}

export class ExtensionService {
  constructor(
    private readonly config: LiteConfig,
    private readonly store: LiteStore,
    private readonly builtins: Map<string, ToolDefinition>,
  ) {}

  async discover(input: JsonObject = {}): Promise<ToolResponse> {
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
    const includeSchemas = input.includeSchemas !== false;
    const builtins = [...this.builtins.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      kind: 'builtin',
      annotations: tool.annotations,
      ...(includeSchemas ? { inputSchema: tool.inputSchema } : {}),
    }));
    const custom = this.store.snapshot().extensions.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      kind: 'custom',
      annotations: tool.annotations,
      handlerKind: tool.handler.kind,
      ...(includeSchemas ? { inputSchema: tool.inputSchema } : {}),
    }));
    const catalog = [...builtins, ...custom];
    const matches = catalog.filter((tool) => !query || `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(query));
    const tools = query && matches.length === 0 ? catalog : matches;
    return {
      ok: true,
      data: {
        tools,
        total: tools.length,
        instructions: {
          discover: 'Call extension_discover first when you do not know the available capability or its exact input schema.',
          register: 'Call extension_register with action=validate before action=upsert. Custom tools use either a builtin alias or an executable plus argument templates such as {{input.path}}.',
          call: 'Call extension_call with the exact tool name and an input object matching its schema. The legacy arguments object is also accepted. Include sessionId when coordinating multiple ChatGPT sessions.',
          collaboration: 'Register each worker with session_register, exchange work and review notes with message_send/message_inbox, and keep session status current.',
        },
        registrationSchema: {
          name: 'lower_snake_case, 3-64 characters',
          title: 'human-readable title',
          description: 'when to use the tool and what it changes',
          inputSchema: 'JSON Schema object with additionalProperties=false',
          annotations: { readOnlyHint: 'boolean', destructiveHint: 'boolean', openWorldHint: 'boolean', idempotentHint: 'optional boolean' },
          handlers: [
            { kind: 'builtin', target: 'existing builtin name', defaults: 'optional object merged before call arguments' },
            { kind: 'command', executable: 'binary name', args: ['literal', '{{input.field}}'], cwd: 'optional workspace-relative directory', timeoutSec: '1-3600' },
          ],
        },
        query: query ? { value: query, matched: matches.length, usedFullCatalogFallback: matches.length === 0 } : undefined,
      },
    };
  }

  async register(input: JsonObject): Promise<ToolResponse> {
    try {
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'remove') {
        if (typeof input.name !== 'string') throw new Error('name is required for remove.');
        this.store.removeExtension(input.name);
        return { ok: true, data: { action, name: input.name, removed: true } };
      }
      if (action !== 'validate' && action !== 'upsert') throw new Error('action must be validate, upsert, or remove.');
      const rawSpec = input.spec ?? input.specJson;
      const spec = validateSpec(typeof rawSpec === 'string' ? jsonObjectValue(rawSpec, 'specJson') : rawSpec, this.builtins);
      if (action === 'upsert') this.store.upsertExtension(spec);
      return { ok: true, data: { action, valid: true, registered: action === 'upsert', spec } };
    } catch (error) {
      return failure(error);
    }
  }

  async call(input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
    try {
      if (typeof input.tool !== 'string') throw new Error('tool is required.');
      const args = callArguments(input);
      const invocationContext: InvocationContext = { ...context, sessionId: typeof input.sessionId === 'string' ? input.sessionId : context.sessionId };
      const builtin = this.builtins.get(input.tool);
      if (builtin) {
        const errors = validateJsonSchema(builtin.inputSchema, args);
        if (errors.length) throw new Error(errors.join('; '));
        return { ok: true, data: { tool: input.tool, result: await builtin.invoke(args, invocationContext) } };
      }
      const custom = this.store.snapshot().extensions.find((item) => item.name === input.tool);
      if (!custom) throw new Error(`Extension not found: ${input.tool}`);
      const errors = validateJsonSchema(custom.inputSchema, args);
      if (errors.length) throw new Error(errors.join('; '));
      if (custom.handler.kind === 'builtin') {
        const target = this.builtins.get(custom.handler.target)!;
        const merged = { ...(custom.handler.defaults ?? {}), ...args };
        const targetErrors = validateJsonSchema(target.inputSchema, merged);
        if (targetErrors.length) throw new Error(targetErrors.join('; '));
        return { ok: true, data: { tool: custom.name, target: target.name, result: await target.invoke(merged, invocationContext) } };
      }
      const cwd = resolveWorkspacePath(this.config.workspaceDir, this.config.stateDir, custom.handler.cwd || '.');
      const result = await runCommand({
        executable: renderTemplate(custom.handler.executable, args),
        argv: (custom.handler.args ?? []).map((arg) => renderTemplate(arg, args)),
        cwd,
        timeoutSec: custom.handler.timeoutSec ?? this.config.commandTimeoutSec,
        maxOutputChars: this.config.maxOutputChars,
      });
      return { ok: true, data: { tool: custom.name, result } };
    } catch (error) {
      return failure(error);
    }
  }
}
