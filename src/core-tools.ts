import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LiteConfig } from './types.js';
import { LiteError, publicSession, type LiteStore } from './store.js';
import { resolveWorkspacePath } from './security.js';
import type { JsonObject, TaskPackage, ToolDefinition } from './types.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.localterminal-lite', 'node_modules', 'dist', 'coverage', '.next', '.turbo']);

type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
};

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boundedOutput(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}\n… output truncated …`, truncated: true };
}

async function runCommand(args: {
  executable: string;
  argv?: string[];
  cwd: string;
  timeoutSec: number;
  maxOutputChars: number;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  const child = spawn(args.executable, args.argv ?? [], {
    cwd: args.cwd,
    env: args.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const captureLimit = args.maxOutputChars * 2;
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < captureLimit) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < captureLimit) stderr += chunk.toString('utf8'); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1_500).unref();
  }, args.timeoutSec * 1000);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => clearTimeout(timer));
  const boundedStdout = boundedOutput(stdout, args.maxOutputChars);
  const boundedStderr = boundedOutput(stderr, args.maxOutputChars);
  return {
    command: [args.executable, ...(args.argv ?? [])].join(' '),
    cwd: args.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    stdout: boundedStdout.text,
    stderr: boundedStderr.text,
    truncated: boundedStdout.truncated || boundedStderr.truncated,
    durationMs: Date.now() - startedAt,
  };
}

function relative(config: LiteConfig, absolute: string): string {
  return path.relative(config.workspaceDir, absolute) || '.';
}

async function walkFiles(config: LiteConfig, start: string, limit: number): Promise<string[]> {
  const root = resolveWorkspacePath(config.workspaceDir, config.stateDir, start);
  const files: string[] = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
      if (files.length >= limit) break;
    }
  }
  return files;
}

export function createBuiltinTools(config: LiteConfig, store: LiteStore): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const add = (definition: ToolDefinition) => tools.set(definition.name, definition);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const mutating = { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false };
  const actor = (context: Parameters<ToolDefinition['invoke']>[1]) => {
    if (!context.authenticatedSession) throw new LiteError('IDENTITY_REQUIRED', 'Register or inherit a Lite session before calling this tool.');
    return context.authenticatedSession;
  };

  add({
    name: 'workspace_info', title: 'Workspace info', description: 'Inspect the single authorized workspace and Lite runtime.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    invoke: async () => ({ workspaceDir: config.workspaceDir, platform: process.platform, node: process.version, stateRevision: store.snapshot().revision }),
  });
  add({
    name: 'list_dir', title: 'List directory', description: 'List one directory inside the authorized workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' } }, additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const directory = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.path) || '.');
      const entries = await readdir(directory, { withFileTypes: true });
      return { path: relative(config, directory), entries: entries.filter((entry) => !IGNORED_DIRECTORIES.has(entry.name)).slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: entries.length > 500 };
    },
  });
  add({
    name: 'find_files', title: 'Find files', description: 'Find files by case-insensitive path substring.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', default: '.' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const query = asString(input.query, 'query').toLowerCase();
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(500, input.limit)) : 100;
      const files = await walkFiles(config, asOptionalString(input.path) || '.', 10_000);
      const matches = files.map((file) => relative(config, file)).filter((file) => file.toLowerCase().includes(query)).slice(0, limit);
      return { matches, truncated: matches.length === limit };
    },
  });
  add({
    name: 'search_text', title: 'Search text', description: 'Search bounded UTF-8 files for text or a regular expression.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string', default: '.' }, regex: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const query = asString(input.query, 'query');
      const matcher = input.regex ? new RegExp(query, 'i') : undefined;
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(500, input.limit)) : 100;
      const files = await walkFiles(config, asOptionalString(input.path) || '.', 2_000);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of files) {
        if (matches.length >= limit) break;
        const fileStat = await stat(file);
        if (fileStat.size > 1_000_000) continue;
        let text: string;
        try { text = await readFile(file, 'utf8'); } catch { continue; }
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: relative(config, file), line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= limit) break;
        }
      }
      return { matches, truncated: matches.length >= limit };
    },
  });
  add({
    name: 'read_file', title: 'Read file', description: 'Read a bounded UTF-8 file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: 1_000_000 } }, required: ['path'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      const maxBytes = typeof input.maxBytes === 'number' ? Math.min(1_000_000, input.maxBytes) : 256_000;
      const buffer = await readFile(file);
      const content = buffer.subarray(0, maxBytes).toString('utf8');
      return { path: relative(config, file), content, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, truncated: buffer.length > maxBytes };
    },
  });
  add({
    name: 'read_file_range', title: 'Read file lines', description: 'Read a line range with a content hash.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path', 'startLine', 'endLine'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      const content = await readFile(file, 'utf8');
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, Number(input.startLine));
      const end = Math.max(start, Math.min(lines.length, Number(input.endLine)));
      return { path: relative(config, file), startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n'), sha256: createHash('sha256').update(content).digest('hex') };
    },
  });
  add({
    name: 'write_file', title: 'Write file', description: 'Create or replace one UTF-8 file inside the workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, expectedSha256: { type: 'string' }, createParents: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false }, annotations: mutating,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      if (input.expectedSha256) {
        const current = await readFile(file);
        const actual = createHash('sha256').update(current).digest('hex');
        if (actual !== input.expectedSha256) throw new Error(`File changed: expected ${input.expectedSha256}, got ${actual}`);
      }
      if (input.createParents) await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, asString(input.content, 'content'), 'utf8');
      return { path: relative(config, file), bytes: Buffer.byteLength(String(input.content)), sha256: createHash('sha256').update(String(input.content)).digest('hex') };
    },
  });
  add({
    name: 'apply_patch', title: 'Apply exact patch', description: 'Apply exact text replacements with optional SHA protection.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, expectedSha256: { type: 'string' }, replacements: { type: 'array', minItems: 1, items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['oldText', 'newText'], additionalProperties: false } } }, required: ['path', 'replacements'], additionalProperties: false }, annotations: mutating,
    invoke: async (input) => {
      const file = resolveWorkspacePath(config.workspaceDir, config.stateDir, asString(input.path, 'path'));
      let content = await readFile(file, 'utf8');
      const beforeHash = createHash('sha256').update(content).digest('hex');
      if (input.expectedSha256 && input.expectedSha256 !== beforeHash) throw new Error(`File changed: expected ${input.expectedSha256}, got ${beforeHash}`);
      for (const replacement of input.replacements as Array<JsonObject>) {
        const oldText = asString(replacement.oldText, 'oldText');
        const newText = asString(replacement.newText, 'newText');
        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) throw new Error('Patch oldText was not found.');
        if (occurrences > 1 && !replacement.replaceAll) throw new Error('Patch oldText matched more than once; set replaceAll=true explicitly.');
        content = replacement.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      }
      await writeFile(file, content, 'utf8');
      return { path: relative(config, file), beforeSha256: beforeHash, afterSha256: createHash('sha256').update(content).digest('hex') };
    },
  });
  add({
    name: 'execute_cli', title: 'Execute command', description: 'Execute one bounded shell command in the workspace.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 20_000 }, cwd: { type: 'string' }, timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 } }, required: ['command'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    invoke: async (input) => {
      const cwd = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.');
      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const argv = process.platform === 'win32' ? ['/d', '/s', '/c', asString(input.command, 'command')] : ['-lc', asString(input.command, 'command')];
      return await runCommand({ executable: shell, argv, cwd, timeoutSec: typeof input.timeoutSec === 'number' ? input.timeoutSec : config.commandTimeoutSec, maxOutputChars: config.maxOutputChars }) as unknown as JsonObject;
    },
  });

  for (const gitTool of [
    ['git_status', ['status', '--short', '--branch']],
    ['git_diff', ['diff']],
    ['git_log', ['log', '--oneline', '-n', '30']],
  ] as const) {
    add({
      name: gitTool[0], title: gitTool[0].replace('_', ' '), description: `Run bounded ${gitTool[0]} in the workspace.`,
      inputSchema: { type: 'object', properties: { cwd: { type: 'string' } }, additionalProperties: false }, annotations: readOnly,
      invoke: async (input) => await runCommand({ executable: 'git', argv: [...gitTool[1]], cwd: resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.'), timeoutSec: 30, maxOutputChars: config.maxOutputChars }) as unknown as JsonObject,
    });
  }
  add({
    name: 'git_show', title: 'Git show', description: 'Show one bounded Git revision or object.',
    inputSchema: { type: 'object', properties: { revision: { type: 'string', minLength: 1 }, cwd: { type: 'string' } }, required: ['revision'], additionalProperties: false }, annotations: readOnly,
    invoke: async (input) => {
      const revision = asString(input.revision, 'revision');
      if (!/^[A-Za-z0-9_./~^{}:@+-]+$/.test(revision)) throw new Error('Unsafe Git revision syntax.');
      return await runCommand({ executable: 'git', argv: ['show', '--stat', '--oneline', revision], cwd: resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.'), timeoutSec: 30, maxOutputChars: config.maxOutputChars }) as unknown as JsonObject;
    },
  });
  add({
    name: 'run_checks', title: 'Run project checks', description: 'Run declared typecheck, build, and test package scripts in order.',
    inputSchema: { type: 'object', properties: { includeTest: { type: 'boolean', default: true }, cwd: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    invoke: async (input) => {
      const cwd = resolveWorkspacePath(config.workspaceDir, config.stateDir, asOptionalString(input.cwd) || '.');
      const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const names = ['typecheck', 'build', ...(input.includeTest === false ? [] : ['test'])].filter((name) => pkg.scripts?.[name]);
      const results: JsonObject[] = [];
      for (const name of names) {
        const result = await runCommand({ executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', argv: ['run', name], cwd, timeoutSec: Math.max(config.commandTimeoutSec, 300), maxOutputChars: config.maxOutputChars });
        results.push({ name, ...result });
        if (result.exitCode !== 0) break;
      }
      return { scripts: names, results, passed: results.length === names.length && results.every((result) => result.exitCode === 0) };
    },
  });

  const stringList = { type: 'array', items: { type: 'string' }, maxItems: 100 } as const;
  const taskProperties = {
    objective: { type: 'string', minLength: 1, maxLength: 4000 }, background: { type: 'string', minLength: 1, maxLength: 4000 },
    deliverables: { ...stringList, minItems: 1 }, acceptanceCriteria: { ...stringList, minItems: 1 }, constraints: { ...stringList, minItems: 1 },
  };
  add({
    name: 'session_register', title: 'Register session', description: 'Create and claim a root session, or delegate one direct child from an authenticated root.',
    inputSchema: {
      type: 'object', properties: {
        mode: { type: 'string', enum: ['root', 'delegate'], default: 'root' }, name: { type: 'string', minLength: 1, maxLength: 80 }, role: { type: 'string', maxLength: 80 },
        continuesSessionId: { type: 'string' }, task: { type: 'object', properties: taskProperties, required: ['objective', 'background', 'deliverables', 'acceptanceCriteria', 'constraints'], additionalProperties: false },
      }, required: ['mode', 'name'], additionalProperties: false,
    }, annotations: mutating,
    invoke: async (input, context) => {
      const mode = input.mode === 'delegate' ? 'delegate' : 'root';
      if (mode === 'root') {
        const result = store.registerRoot({ name: asString(input.name, 'name'), role: asOptionalString(input.role), continuesSessionId: asOptionalString(input.continuesSessionId) });
        return { session: publicSession(result.session), identity: result.identity, context: store.context(result.session.id) };
      }
      const current = actor(context);
      if (!input.task || typeof input.task !== 'object' || Array.isArray(input.task)) throw new LiteError('INVALID_INPUT', 'task is required for delegate mode.');
      const result = store.registerDelegate(current.id, { name: asString(input.name, 'name'), role: asOptionalString(input.role), task: input.task as TaskPackage, continuesSessionId: asOptionalString(input.continuesSessionId) });
      return { session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt };
    },
  });
  add({
    name: 'session_inherit', title: 'Inherit session', description: 'Claim a pending, stale, released, or TUI-revoked session with its one-time claim code.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1 }, claimCode: { type: 'string', minLength: 1 } }, required: ['sessionId', 'claimCode'], additionalProperties: false }, annotations: mutating,
    invoke: async (input) => {
      const result = store.inherit(asString(input.sessionId, 'sessionId'), asString(input.claimCode, 'claimCode'));
      return { session: publicSession(result.session), identity: result.identity, context: result.context };
    },
  });
  add({
    name: 'session_list', title: 'List sessions', description: 'List the audited session hierarchy, phases, presence, and continuation links.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    invoke: async (_input, context) => { actor(context); return { sessions: store.listSessions().map(publicSession) }; },
  });
  add({
    name: 'session_checkpoint', title: 'Checkpoint session', description: 'Record the required end-of-turn summary and phase; completion is immutable.',
    inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: ['pending', 'working', 'waiting', 'blocked', 'completed', 'cancelled'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, nextSteps: stringList, blockers: stringList, artifacts: stringList, milestone: { type: 'string', maxLength: 1000 }, tags: stringList }, required: ['phase', 'summary'], additionalProperties: false }, annotations: mutating,
    invoke: async (input, context) => ({ session: publicSession(store.checkpoint(actor(context).id, input)) }),
  });
  add({
    name: 'session_context', title: 'Read session context', description: 'Return the bounded 16K context projection for the authenticated session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly,
    invoke: async (_input, context) => ({ context: store.context(actor(context).id) }),
  });
  add({
    name: 'session_release', title: 'Release session', description: 'Release the current controller and issue a new one-time handoff code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: mutating,
    invoke: async (_input, context) => { const result = store.release(actor(context).id); return { session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt }; },
  });
  add({
    name: 'session_unregister', title: 'Release session (deprecated)', description: 'Compatibility alias for session_release. It never deletes history.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false }, annotations: mutating,
    invoke: async (_input, context) => { const result = store.release(actor(context).id); return { deprecated: true, replacement: 'session_release', removed: false, session: publicSession(result.session), claimCode: result.claimCode, handoffPrompt: result.handoffPrompt }; },
  });
  add({
    name: 'session_tag', title: 'Tag session', description: 'Append audit-friendly tags to the authenticated session.',
    inputSchema: { type: 'object', properties: { tags: { ...stringList, minItems: 1 } }, required: ['tags'], additionalProperties: false }, annotations: mutating,
    invoke: async (input, context) => ({ session: publicSession(store.tag(actor(context).id, input.tags as string[])) }),
  });
  add({
    name: 'session_subscribe', title: 'Subscribe to session', description: 'Subscribe the authenticated session to another session’s key progress.',
    inputSchema: { type: 'object', properties: { targetSessionId: { type: 'string', minLength: 1 } }, required: ['targetSessionId'], additionalProperties: false }, annotations: mutating,
    invoke: async (input, context) => { const current = actor(context); store.subscribe(current.id, asString(input.targetSessionId, 'targetSessionId')); return { subscribed: true, subscriberSessionId: current.id, targetSessionId: input.targetSessionId }; },
  });
  add({
    name: 'session_events_ack', title: 'Acknowledge events', description: 'Acknowledge delivered event IDs; history remains permanent.',
    inputSchema: { type: 'object', properties: { eventIds: { ...stringList, minItems: 1, maxItems: 100 } }, required: ['eventIds'], additionalProperties: false }, annotations: mutating,
    invoke: async (input, context) => ({ acknowledged: store.acknowledgeEvents(actor(context).id, input.eventIds as string[]) }),
  });
  add({
    name: 'message_send', title: 'Send session message', description: 'Send a durable message as the authenticated session; sender cannot be overridden.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1, maxLength: 20_000 } }, required: ['to', 'body'], additionalProperties: false }, annotations: mutating,
    invoke: async (input, context) => ({ message: store.sendMessage(actor(context).id, asString(input.to, 'to'), asString(input.body, 'body')) }),
  });
  add({
    name: 'message_inbox', title: 'Read session inbox', description: 'Read only the authenticated session’s durable inbox.',
    inputSchema: { type: 'object', properties: { markRead: { type: 'boolean', default: false } }, additionalProperties: false }, annotations: { ...readOnly, readOnlyHint: false },
    invoke: async (input, context) => { const current = actor(context); return { session: publicSession(current), messages: store.inbox(current.id, input.markRead === true) }; },
  });
  add({
    name: 'message_list', title: 'List own collaboration messages', description: 'Compatibility view of the authenticated session inbox only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false }, annotations: readOnly,
    invoke: async (input, context) => { const current = actor(context); const messages = store.inbox(current.id); return { messages: messages.slice(-(typeof input.limit === 'number' ? input.limit : 100)) }; },
  });
  return tools;
}

export type { CommandResult };
export { runCommand };
