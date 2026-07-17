import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiteRuntime } from '../dist/server.js';
import {
  createDefaultSettings,
  loadLiteConfig,
  readLiteSettings,
  saveLiteSettings,
  settingsPath,
} from '../dist/config.js';

const CONNECTOR_KEY = 'test-connector-key-1234567890';
const ACTIONS_TOKEN = 'test-actions-token-12345678901234567890';

function tempWorkspace() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localterminal-lite-'));
  const stateDir = path.join(workspaceDir, '.localterminal-lite');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello lite\n');
  return { workspaceDir, stateDir };
}

async function createRuntime() {
  const dirs = tempWorkspace();
  const runtime = new LiteRuntime({
    ...dirs,
    settingsPath: path.join(dirs.stateDir, 'test-settings.json'),
    host: '127.0.0.1',
    port: 0,
    connectorKey: CONNECTOR_KEY,
    actionsToken: ACTIONS_TOKEN,
    publicBaseUrl: 'http://127.0.0.1:0',
    maxOutputChars: 20_000,
    commandTimeoutSec: 10,
  });
  await runtime.start();
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() {
      await runtime.close();
      fs.rmSync(dirs.workspaceDir, { recursive: true, force: true });
    },
  };
}

function actionsHeaders() {
  return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' };
}

function parseEventStreamJson(text) {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, text);
  return JSON.parse(dataLine.slice(6));
}

test('TUI settings persist outside the workspace and template placeholders are ignored', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localterminal-lite-config-workspace-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localterminal-lite-user-config-'));
  const env = {
    LITE_CONFIG_DIR: configDir,
    LITE_WORKSPACE_DIR: '/absolute/path/to/project',
    LITE_PUBLIC_BASE_URL: 'https://replace-with-your-tunnel.example',
  };
  try {
    const settings = createDefaultSettings(workspaceDir);
    saveLiteSettings(settings, env);
    assert.deepEqual(readLiteSettings(env), { ...settings, workspaceDir: fs.realpathSync(workspaceDir) });
    const config = loadLiteConfig(env);
    assert.equal(config.workspaceDir, fs.realpathSync(workspaceDir));
    assert.equal(config.publicBaseUrl, 'http://127.0.0.1:3210');
    assert.equal(settingsPath(env), path.join(configDir, 'config.json'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(settingsPath(env)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(workspaceDir, '.localterminal-lite', 'config.json')), false);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

async function rpcPost(url, payload, sessionId) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await response.text();
  return {
    response,
    text,
    data: response.headers.get('content-type')?.includes('text/event-stream') ? parseEventStreamJson(text) : JSON.parse(text),
    sessionId: response.headers.get('mcp-session-id'),
  };
}

test('Actions OpenAPI 3.1 document exposes three operations and concrete component schemas', async () => {
  const server = await createRuntime();
  try {
    const response = await fetch(`${server.baseUrl}/openapi.json`);
    assert.equal(response.status, 200);
    const schema = await response.json();
    assert.equal(schema.openapi, '3.1.0');
    assert.equal(typeof schema.components, 'object');
    assert.equal(Array.isArray(schema.components.schemas), false);
    assert.equal(typeof schema.components.schemas, 'object');
    assert.deepEqual(Object.keys(schema.components.schemas).sort(), [
      'Error',
      'ExtensionCallRequest',
      'ExtensionDiscoverRequest',
      'ExtensionRegisterRequest',
      'ToolResponse',
    ]);
    assert.deepEqual(Object.keys(schema.paths).sort(), [
      '/actions/extensions/call',
      '/actions/extensions/discover',
      '/actions/extensions/register',
    ]);
    assert.deepEqual(Object.values(schema.paths).map((item) => item.post.operationId).sort(), ['extensionCall', 'extensionDiscover', 'extensionRegister']);
    assert.equal(schema.servers[0].url, server.baseUrl);
    for (const pathItem of Object.values(schema.paths)) {
      const requestRef = pathItem.post.requestBody.content['application/json'].schema.$ref;
      const responseRef = pathItem.post.responses['200'].content['application/json'].schema.$ref;
      assert.ok(schema.components.schemas[requestRef.split('/').at(-1)]);
      assert.ok(schema.components.schemas[responseRef.split('/').at(-1)]);
    }
    const aliasResponse = await fetch(`${server.baseUrl}/openapi-3.1.json`);
    assert.deepEqual(await aliasResponse.json(), schema);
  } finally {
    await server.close();
  }
});

test('Actions auth, sessions, and durable messages work through the three-tool facade', async () => {
  const server = await createRuntime();
  try {
    const denied = await fetch(`${server.baseUrl}/actions/extensions/discover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);

    const call = async (tool, args, sessionId) => {
      const response = await fetch(`${server.baseUrl}/actions/extensions/call`, {
        method: 'POST', headers: actionsHeaders(), body: JSON.stringify({ tool, arguments: args, sessionId }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const first = await call('session_register', { name: 'builder', role: 'implementation' });
    const second = await call('session_register', { name: 'reviewer', role: 'review' });
    const builderId = first.data.result.session.id;
    const reviewerId = second.data.result.session.id;
    const sent = await call('message_send', { to: reviewerId, body: 'Please review the Lite transport.' }, builderId);
    assert.equal(sent.ok, true);
    const inbox = await call('message_inbox', { markRead: true }, reviewerId);
    assert.equal(inbox.data.result.messages.length, 1);
    assert.equal(inbox.data.result.messages[0].body, 'Please review the Lite transport.');
    assert.ok(server.runtime.store.snapshot().messages[0].readAt);
  } finally {
    await server.close();
  }
});

test('models can validate, register, and invoke a custom declarative command tool', async () => {
  const server = await createRuntime();
  try {
    const spec = {
      name: 'echo_value',
      title: 'Echo value',
      description: 'Echo one supplied value through a bounded executable without using a shell.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['value'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      handler: { kind: 'command', executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '{{input.value}}'] },
    };
    for (const action of ['validate', 'upsert']) {
      const response = await fetch(`${server.baseUrl}/actions/extensions/register`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify({ action, spec }) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(JSON.parse(text).ok, true);
    }
    const response = await fetch(`${server.baseUrl}/actions/extensions/call`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify({ tool: 'echo_value', arguments: { value: 'custom-ok' } }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.data.result.stdout, 'custom-ok');
  } finally {
    await server.close();
  }
});

test('Apps MCP advertises only the three facade tools', async () => {
  const server = await createRuntime();
  try {
    const mcpUrl = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(mcpUrl, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lite-test', version: '0.1.0' } },
    });
    assert.equal(init.response.status, 200, init.text);
    assert.ok(init.sessionId);
    assert.equal(init.data.result.serverInfo.name, 'localterminal-lite');
    const listed = await rpcPost(mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId);
    assert.equal(listed.response.status, 200, listed.text);
    assert.deepEqual(listed.data.result.tools.map((tool) => tool.name).sort(), ['extension_call', 'extension_discover', 'extension_register']);
    const discovered = await rpcPost(mcpUrl, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_discover', arguments: { query: 'session', includeSchemas: false } } }, init.sessionId);
    assert.equal(discovered.response.status, 200, discovered.text);
    assert.equal(discovered.data.result.structuredContent.ok, true);
    assert.ok(discovered.data.result.structuredContent.data.tools.some((tool) => tool.name === 'session_register'));
  } finally {
    await server.close();
  }
});

test('workspace path protection rejects state reads and parent traversal', async () => {
  const server = await createRuntime();
  try {
    const invoke = async (filePath) => {
      const response = await fetch(`${server.baseUrl}/actions/extensions/call`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify({ tool: 'read_file', arguments: { path: filePath } }) });
      return response.json();
    };
    assert.equal((await invoke('.localterminal-lite/state.json')).ok, false);
    assert.equal((await invoke('../outside.txt')).ok, false);
    const valid = await invoke('hello.txt');
    assert.equal(valid.ok, true, JSON.stringify(valid));
    assert.equal(valid.data.result.content, 'hello lite\n');
  } finally {
    await server.close();
  }
});
