import type { LiteConfig } from './types.js';
import { LiteError, type LiteStore } from './store.js';
import { renderTemplate, resolveWorkspacePath, validateJsonSchema } from './security.js';
import { runCommand } from './core-tools.js';
import type { CustomExtensionSpec, InvocationContext, JsonObject, SessionIdentity, ToolDefinition, ToolResponse } from './types.js';

const EXTENSION_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const RESERVED_NAMES = new Set(['extension_discover', 'extension_register', 'extension_call']);
const CONTROL_TOOLS = new Set(['session_checkpoint', 'session_release', 'session_unregister', 'session_events_ack', 'session_inherit']);

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiteError('INVALID_INPUT', `${label} must be an object.`);
  return value as JsonObject;
}

function jsonObjectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== 'string') return objectValue(value, label);
  try { return objectValue(JSON.parse(value), label); }
  catch (error) { if (error instanceof SyntaxError) throw new LiteError('INVALID_INPUT', `${label} must contain a valid JSON object.`); throw error; }
}

function callArguments(input: JsonObject): JsonObject {
  const legacy = input.arguments === undefined ? {} : jsonObjectValue(input.arguments, 'arguments');
  const fallback = input.inputJson === undefined ? {} : jsonObjectValue(input.inputJson, 'inputJson');
  const preferred = input.input === undefined ? {} : jsonObjectValue(input.input, 'input');
  return { ...legacy, ...fallback, ...preferred };
}

function validateSpec(value: unknown, builtins: Map<string, ToolDefinition>): CustomExtensionSpec {
  const spec = objectValue(value, 'spec') as unknown as CustomExtensionSpec;
  if (typeof spec.name !== 'string' || !EXTENSION_NAME.test(spec.name) || RESERVED_NAMES.has(spec.name)) throw new LiteError('INVALID_INPUT', 'Extension name must match [a-z][a-z0-9_]{2,63} and cannot use a facade name.');
  if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 100) throw new LiteError('INVALID_INPUT', 'Extension title must contain 1-100 characters.');
  if (typeof spec.description !== 'string' || spec.description.length < 10 || spec.description.length > 800) throw new LiteError('INVALID_INPUT', 'Extension description must contain 10-800 characters.');
  if (!spec.inputSchema || spec.inputSchema.type !== 'object' || spec.inputSchema.additionalProperties !== false) throw new LiteError('INVALID_INPUT', 'inputSchema must be an object schema with additionalProperties=false.');
  if (!spec.annotations || typeof spec.annotations.readOnlyHint !== 'boolean' || typeof spec.annotations.destructiveHint !== 'boolean' || typeof spec.annotations.openWorldHint !== 'boolean') throw new LiteError('INVALID_INPUT', 'annotations must declare readOnlyHint, destructiveHint, and openWorldHint.');
  if (!spec.handler || (spec.handler.kind !== 'builtin' && spec.handler.kind !== 'command')) throw new LiteError('INVALID_INPUT', 'handler.kind must be builtin or command.');
  if (spec.handler.kind === 'builtin') {
    if (!builtins.has(spec.handler.target)) throw new LiteError('INVALID_INPUT', `Unknown builtin target: ${spec.handler.target}`);
  } else {
    if (typeof spec.handler.executable !== 'string' || !spec.handler.executable.trim() || spec.handler.executable.includes('\0') || spec.handler.executable.includes('{{')) throw new LiteError('INVALID_INPUT', 'Command extension requires a fixed executable name without templates.');
    if (spec.handler.args && (!Array.isArray(spec.handler.args) || spec.handler.args.length > 100 || spec.handler.args.some((item) => typeof item !== 'string' || item.length > 10_000))) throw new LiteError('INVALID_INPUT', 'Command args must be an array of at most 100 strings.');
    if (spec.handler.timeoutSec !== undefined && (!Number.isInteger(spec.handler.timeoutSec) || spec.handler.timeoutSec < 1 || spec.handler.timeoutSec > 3600)) throw new LiteError('INVALID_INPUT', 'timeoutSec must be an integer from 1 to 3600.');
  }
  return structuredClone(spec);
}

function failure(error: unknown): ToolResponse {
  if (error instanceof LiteError) return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } };
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('required') || message.includes('must') ? 'INVALID_INPUT' : 'EXTENSION_ERROR';
  return { ok: false, error: { code, message, retryable: false } };
}

function explicitIdentity(input: JsonObject): SessionIdentity | undefined {
  if (input.identity === undefined) return undefined;
  const identity = objectValue(input.identity, 'identity');
  if (typeof identity.sessionId !== 'string' || typeof identity.sessionToken !== 'string') throw new LiteError('INVALID_INPUT', 'identity requires sessionId and sessionToken.');
  return { sessionId: identity.sessionId, sessionToken: identity.sessionToken };
}

export class ExtensionService {
  constructor(private readonly config: LiteConfig, private readonly store: LiteStore, private readonly builtins: Map<string, ToolDefinition>) {}

  async discover(input: JsonObject = {}, context: InvocationContext = { transport: 'test' }): Promise<ToolResponse> {
    try {
      const authenticated = this.authenticate(input, context, true);
      if (!authenticated) {
        return { ok: true, data: {
          identityRequired: true,
          instructions: {
            root: 'Call extension_call with tool=session_register and input={mode:"root",name:"..."}. Save the returned sessionId + sessionToken.',
            inherit: 'To take over assigned work, call extension_call with tool=session_inherit and input={sessionId,claimCode}.',
            next: 'After identity is established, pass identity={sessionId,sessionToken} on every Actions facade call. Apps may omit it only after a verified openai/session binding exists.',
          },
          bootstrapTools: ['session_register(mode=root)', 'session_inherit(sessionId,claimCode)'],
        } };
      }
      this.store.touchControl(authenticated.id);
      const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
      const includeSchemas = input.includeSchemas !== false;
      const builtins = [...this.builtins.values()].map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, kind: 'builtin', annotations: tool.annotations, ...(includeSchemas ? { inputSchema: tool.inputSchema } : {}) }));
      const custom = this.store.snapshot().extensions.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, kind: 'custom', annotations: tool.annotations, handlerKind: tool.handler.kind, ...(includeSchemas ? { inputSchema: tool.inputSchema } : {}) }));
      const catalog = [...builtins, ...custom];
      const matches = catalog.filter((tool) => !query || `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(query));
      const tools = query && matches.length === 0 ? catalog : matches;
      const response: ToolResponse = { ok: true, data: {
        tools, total: tools.length,
        instructions: {
          identity: 'Every concrete call and registry change belongs to the authenticated Lite session. Never use openai/session as Lite identity.',
          discover: 'Call extension_discover when you need the exact capability or input schema.',
          register: 'Call extension_register with action=validate before action=upsert.',
          call: 'Call extension_call with exact tool name, identity, and input. End each work turn with session_checkpoint.',
          collaboration: 'Roots delegate direct children with a structured task. Children claim via session_inherit, exchange messages, checkpoint, and complete.',
        },
        registrationSchema: {
          name: 'lower_snake_case, 3-64 characters', title: 'human-readable title', description: 'when to use the tool and what it changes',
          inputSchema: 'JSON Schema object with additionalProperties=false',
          annotations: { readOnlyHint: 'boolean', destructiveHint: 'boolean', openWorldHint: 'boolean', idempotentHint: 'optional boolean' },
          handlers: [{ kind: 'builtin', target: 'existing builtin name', defaults: 'optional object' }, { kind: 'command', executable: 'binary name', args: ['literal', '{{input.field}}'], cwd: 'optional workspace-relative directory', timeoutSec: '1-3600' }],
        },
        query: query ? { value: query, matched: matches.length, usedFullCatalogFallback: matches.length === 0 } : undefined,
      } };
      return this.attachEvents(response, authenticated.id);
    } catch (error) { return failure(error); }
  }

  async register(input: JsonObject, context: InvocationContext = { transport: 'test' }): Promise<ToolResponse> {
    let sessionId: string | undefined;
    const started = Date.now();
    try {
      const authenticated = this.authenticate(input, context, false)!; sessionId = authenticated.id;
      this.store.beforeOrdinaryCall(sessionId);
      const action = typeof input.action === 'string' ? input.action : '';
      let data: JsonObject;
      if (action === 'remove') {
        if (typeof input.name !== 'string') throw new LiteError('INVALID_INPUT', 'name is required for remove.');
        this.store.removeExtension(input.name); data = { action, name: input.name, removed: true };
      } else {
        if (action !== 'validate' && action !== 'upsert') throw new LiteError('INVALID_INPUT', 'action must be validate, upsert, or remove.');
        const rawSpec = input.spec ?? input.specJson;
        const spec = validateSpec(typeof rawSpec === 'string' ? jsonObjectValue(rawSpec, 'specJson') : rawSpec, this.builtins);
        if (action === 'upsert') this.store.upsertExtension(spec);
        data = { action, valid: true, registered: action === 'upsert', spec };
      }
      this.store.audit(sessionId, { tool: 'extension_register', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ok: true, args: input });
      return this.attachEvents({ ok: true, data }, sessionId);
    } catch (error) {
      if (sessionId) this.store.audit(sessionId, { tool: 'extension_register', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ok: false, errorCode: error instanceof LiteError ? error.code : 'EXTENSION_ERROR', args: input });
      return this.attachEvents(failure(error), sessionId);
    }
  }

  async registerFromTui(input: JsonObject): Promise<ToolResponse> {
    try {
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'remove') {
        if (typeof input.name !== 'string') throw new LiteError('INVALID_INPUT', 'name is required for remove.');
        this.store.removeExtension(input.name);
        return { ok: true, data: { action, name: input.name, removed: true } };
      }
      if (action !== 'validate' && action !== 'upsert') throw new LiteError('INVALID_INPUT', 'action must be validate, upsert, or remove.');
      const rawSpec = input.spec ?? input.specJson;
      const spec = validateSpec(typeof rawSpec === 'string' ? jsonObjectValue(rawSpec, 'specJson') : rawSpec, this.builtins);
      if (action === 'upsert') this.store.upsertExtension(spec);
      return { ok: true, data: { action, valid: true, registered: action === 'upsert', spec } };
    } catch (error) { return failure(error); }
  }

  async call(input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
    let sessionId: string | undefined;
    const started = Date.now();
    try {
      if (typeof input.tool !== 'string') throw new LiteError('INVALID_INPUT', 'tool is required.');
      const args = callArguments(input);
      const bootstrapRoot = input.tool === 'session_register' && args.mode !== 'delegate';
      const bootstrapInherit = input.tool === 'session_inherit';
      const authenticated = bootstrapRoot || bootstrapInherit ? undefined : this.authenticate(input, context, false)!;
      sessionId = authenticated?.id;
      const invocationContext: InvocationContext = { ...context, identity: explicitIdentity(input), authenticatedSession: authenticated };
      if (authenticated) {
        if (!CONTROL_TOOLS.has(input.tool)) this.store.beforeOrdinaryCall(authenticated.id); else this.store.touchControl(authenticated.id);
      }
      const result = await this.invokeTool(input.tool, args, invocationContext);
      if (!sessionId && result.identity && typeof result.identity === 'object') sessionId = String((result.identity as JsonObject).sessionId || '');
      if (sessionId) this.store.audit(sessionId, { tool: input.tool, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ok: true, args });
      return this.attachEvents({ ok: true, data: { tool: input.tool, result } }, sessionId);
    } catch (error) {
      if (sessionId) this.store.audit(sessionId, { tool: typeof input.tool === 'string' ? input.tool : 'extension_call', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ok: false, errorCode: error instanceof LiteError ? error.code : 'EXTENSION_ERROR', args: input });
      return this.attachEvents(failure(error), sessionId);
    }
  }

  private authenticate(input: JsonObject, context: InvocationContext, allowMissing: boolean) {
    const identity = explicitIdentity(input);
    if (identity) {
      const session = this.store.authenticate(identity);
      if (context.transport === 'apps' && context.clientSessionKey) this.store.bindApp(context.clientSessionKey, session.id);
      return session;
    }
    if (context.transport === 'apps' && context.clientSessionKey) {
      const bound = this.store.resolveAppBinding(context.clientSessionKey);
      if (bound) return bound;
    }
    if (allowMissing) return undefined;
    throw new LiteError('IDENTITY_REQUIRED', 'This operation requires identity={sessionId,sessionToken}. Register or inherit a session first.');
  }

  private async invokeTool(name: string, args: JsonObject, context: InvocationContext): Promise<JsonObject> {
    const builtin = this.builtins.get(name);
    if (builtin) {
      const errors = validateJsonSchema(builtin.inputSchema, args); if (errors.length) throw new LiteError('INVALID_INPUT', errors.join('; '));
      return await builtin.invoke(args, context);
    }
    const custom = this.store.snapshot().extensions.find((item) => item.name === name);
    if (!custom) throw new LiteError('NOT_FOUND', `Extension not found: ${name}`);
    const errors = validateJsonSchema(custom.inputSchema, args); if (errors.length) throw new LiteError('INVALID_INPUT', errors.join('; '));
    if (custom.handler.kind === 'builtin') {
      const target = this.builtins.get(custom.handler.target)!; const merged = { ...(custom.handler.defaults ?? {}), ...args };
      const targetErrors = validateJsonSchema(target.inputSchema, merged); if (targetErrors.length) throw new LiteError('INVALID_INPUT', targetErrors.join('; '));
      return { target: target.name, result: await target.invoke(merged, context) };
    }
    const cwd = resolveWorkspacePath(this.config.workspaceDir, this.config.stateDir, custom.handler.cwd || '.');
    return await runCommand({ executable: renderTemplate(custom.handler.executable, args), argv: (custom.handler.args ?? []).map((arg) => renderTemplate(arg, args)), cwd, timeoutSec: custom.handler.timeoutSec ?? this.config.commandTimeoutSec, maxOutputChars: this.config.maxOutputChars }) as unknown as JsonObject;
  }

  private attachEvents(response: ToolResponse, sessionId?: string): ToolResponse {
    if (!sessionId) return response;
    const events = this.store.pendingEvents(sessionId, 5);
    return events.length ? { ...response, events } : response;
  }
}
