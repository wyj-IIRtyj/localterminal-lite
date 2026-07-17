import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { LiteRuntime } from '../dist/server.js';
import { LiteStore, SESSION_TIMING } from '../dist/store.js';
import { WorkspaceDiffTracker } from '../dist/diff.js';
import { conversationGroups, logicalSessionGroups, selectedViewport } from '../dist/tui-model.js';
import { phaseColor, presenceColor, themeFor } from '../dist/tui/state.js';
import { createDefaultSettings, loadLiteConfig, readLiteSettings, saveLiteSettings, settingsPath } from '../dist/config.js';

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
  const runtime = new LiteRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'test-settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark' });
  await runtime.start();
  return { runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`, async close() { await runtime.close(); fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); } };
}

function actionsHeaders() { return { authorization: `Bearer ${ACTIONS_TOKEN}`, 'content-type': 'application/json' }; }
async function action(server, endpoint, body) {
  const response = await fetch(`${server.baseUrl}/actions/extensions/${endpoint}`, { method: 'POST', headers: actionsHeaders(), body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function call(server, tool, input = {}, identity) { return action(server, 'call', { tool, input, ...(identity ? { identity } : {}) }); }
async function root(server, name = 'main', continuesSessionId) {
  const response = await call(server, 'session_register', { mode: 'root', name, role: 'lead', ...(continuesSessionId ? { continuesSessionId } : {}) });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.ok, true);
  return response.body.data.result;
}
const task = { objective: 'Implement the assigned slice.', background: 'The root session delegated bounded work.', deliverables: ['Code and summary'], acceptanceCriteria: ['Checks pass'], constraints: ['Stay within scope'] };

test('OpenTUI theme and structured session status colors stay deterministic', () => {
  const theme = themeFor('dark');
  assert.equal(phaseColor(theme, 'completed'), theme.good);
  assert.equal(phaseColor(theme, 'blocked'), theme.bad);
  assert.equal(presenceColor(theme, { presence: 'claimed' }), theme.good);
  assert.equal(presenceColor(theme, { presence: 'stale' }), theme.bad);
});

test('OpenTUI ScrollBox owns wheel scrolling and renderer selection without click leakage', async () => {
  let mouseUps = 0;
  const lines = Array.from({ length: 30 }, (_, index) => createElement('text', { key: index, wrapMode: 'word' }, `row ${String(index).padStart(2, '0')} selectable content`));
  const ui = createElement('box', { width: 36, height: 8, onMouseUp: () => { mouseUps += 1; } },
    createElement('scrollbox', { width: 36, height: 8, focused: true, viewportCulling: true },
      createElement('box', { width: '100%', flexDirection: 'column' }, ...lines)));
  let setup;
  await act(async () => { setup = await testRender(ui, { width: 36, height: 8, useMouse: true, autoFocus: true }); await setup.flush(); });
  try {
    const before = setup.captureCharFrame();
    await act(async () => { await setup.mockMouse.scroll(8, 4, 'down'); await setup.flush(); });
    assert.notEqual(setup.captureCharFrame(), before);
    await act(async () => { await setup.mockMouse.drag(2, 2, 16, 2); await setup.flush(); });
    assert.equal(mouseUps, 1);
    assert.equal(setup.renderer.hasSelection, true);
    assert.ok(setup.renderer.getSelection()?.getSelectedText());
  } finally {
    await act(async () => { setup.renderer.destroy(); });
  }
});

function parseEventStreamJson(text) {
  const dataLine = text.split('\n').find((line) => line.startsWith('data: ')); assert.ok(dataLine, text); return JSON.parse(dataLine.slice(6));
}
async function rpcPost(url, payload, sessionId) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }; if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) }); const text = await response.text();
  return { response, text, data: response.headers.get('content-type')?.includes('text/event-stream') ? parseEventStreamJson(text) : JSON.parse(text), sessionId: response.headers.get('mcp-session-id') };
}

test('TUI settings persist outside workspace and placeholder environment values are ignored', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-config-workspace-')); const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-user-config-'));
  const env = { LITE_CONFIG_DIR: configDir, LITE_WORKSPACE_DIR: '/absolute/path/to/project', LITE_PUBLIC_BASE_URL: 'https://replace-with-your-tunnel.example' };
  try {
    const settings = createDefaultSettings(workspaceDir); saveLiteSettings(settings, env);
    assert.deepEqual(readLiteSettings(env), { ...settings, workspaceDir: fs.realpathSync(workspaceDir) });
    const config = loadLiteConfig(env); assert.equal(config.workspaceDir, fs.realpathSync(workspaceDir)); assert.equal(config.publicBaseUrl, 'http://127.0.0.1:3210');
    assert.equal(settingsPath(env), path.join(configDir, 'config.json')); assert.equal(fs.existsSync(path.join(workspaceDir, '.localterminal-lite', 'config.json')), false);
    const legacy = { ...settings }; delete legacy.uiLanguage; delete legacy.uiTheme; fs.writeFileSync(settingsPath(env), JSON.stringify(legacy));
    assert.equal(readLiteSettings(env).uiLanguage, 'zh-CN'); assert.equal(readLiteSettings(env).uiTheme, 'dark');
  } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true }); }
});

test('OpenAPI 3.1 exposes exactly three facade operations and concrete identity schemas', async () => {
  const server = await createRuntime();
  try {
    const schema = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
    assert.equal(schema.openapi, '3.1.0'); assert.equal(typeof schema.components.schemas, 'object'); assert.equal(Array.isArray(schema.components.schemas), false);
    assert.deepEqual(Object.keys(schema.paths).sort(), ['/actions/extensions/call', '/actions/extensions/discover', '/actions/extensions/register']);
    assert.deepEqual(Object.values(schema.paths).map((item) => item.post.operationId).sort(), ['extensionCall', 'extensionDiscover', 'extensionRegister']);
    assert.deepEqual(schema.components.schemas.SessionIdentity.required, ['sessionId', 'sessionToken']);
    assert.equal(schema.components.schemas.ExtensionCallRequest.properties.identity.$ref, '#/components/schemas/SessionIdentity');
    assert.equal(schema.components.schemas.ExtensionRegisterRequest.properties.spec.$ref, '#/components/schemas/ExtensionSpec');
    assert.equal(schema.components.schemas.ToolResponse.properties.events.maxItems, 5);
    assert.deepEqual(await (await fetch(`${server.baseUrl}/openapi-3.1.json`)).json(), schema);
  } finally { await server.close(); }
});

test('Actions identity, delegation, messages, ACK, completion audit, and continuation form a full loop', async () => {
  const server = await createRuntime();
  try {
    const anonymous = await action(server, 'discover', { includeSchemas: false });
    assert.equal(anonymous.body.data.identityRequired, true); assert.equal(anonymous.body.data.tools, undefined);
    const main = await root(server); const mainIdentity = main.identity;
    const wrong = await call(server, 'workspace_info', {}, { sessionId: mainIdentity.sessionId, sessionToken: 'wrong' });
    assert.equal(wrong.status, 401); assert.equal(wrong.body.error.code, 'INVALID_IDENTITY');
    const delegate = await call(server, 'session_register', { mode: 'delegate', name: 'worker', role: 'developer', task }, mainIdentity);
    assert.equal(delegate.status, 200, JSON.stringify(delegate.body)); const childInfo = delegate.body.data.result;
    assert.equal(childInfo.session.phase, 'pending'); assert.equal(childInfo.session.presence, 'unclaimed'); assert.ok(childInfo.handoffPrompt.includes('session_inherit'));
    const child = await call(server, 'session_inherit', { sessionId: childInfo.session.id, claimCode: childInfo.claimCode });
    assert.equal(child.status, 200, JSON.stringify(child.body)); const childIdentity = child.body.data.result.identity;
    assert.equal(child.body.data.result.context.parentContext.session.id, main.session.id); assert.equal(child.body.data.result.context.objective, task.objective);
    const secondClaim = await call(server, 'session_inherit', { sessionId: childInfo.session.id, claimCode: childInfo.claimCode });
    assert.equal(secondClaim.body.error.code, 'SESSION_ALREADY_CLAIMED');
    const sent = await call(server, 'message_send', { to: main.session.id, body: 'Child progress is ready.' }, childIdentity);
    assert.equal(sent.body.ok, true);
    const reply = await call(server, 'message_send', { to: 'worker', body: 'Root acknowledges the update.' }, mainIdentity); assert.equal(reply.body.ok, true);
    const messageList = await call(server, 'message_list', {}, childIdentity); assert.deepEqual(messageList.body.data.result.messages.map((message) => message.body), ['Child progress is ready.', 'Root acknowledges the update.']);
    const conversation = await call(server, 'message_conversation', { with: 'main' }, childIdentity); assert.equal(conversation.body.data.result.conversation.messages.length, 2);
    const rootContext1 = await call(server, 'session_context', {}, mainIdentity);
    const rootEvents = rootContext1.body.events; assert.ok(rootEvents.length <= 5); assert.ok(rootEvents.some((event) => event.kind === 'message'));
    const rootContext2 = await call(server, 'session_context', {}, mainIdentity);
    assert.deepEqual(rootContext2.body.events.map((event) => event.id), rootEvents.map((event) => event.id));
    const ack = await call(server, 'session_events_ack', { eventIds: rootEvents.map((event) => event.id) }, mainIdentity); assert.equal(ack.body.ok, true);
    const afterAck = await call(server, 'session_context', {}, mainIdentity);
    assert.equal((afterAck.body.events || []).some((event) => rootEvents.some((old) => old.id === event.id)), false);
    const premature = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Root thinks it is done.' }, mainIdentity);
    assert.equal(premature.body.error.code, 'CHILD_REVIEW_REQUIRED'); assert.equal(premature.body.error.details.children.length, 1);
    const childDone = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Implemented and verified the delegated slice.', milestone: 'child-complete' }, childIdentity);
    assert.equal(childDone.body.data.result.session.phase, 'completed'); assert.equal(childDone.body.data.result.session.controller, undefined);
    const rootDone = await call(server, 'session_checkpoint', { phase: 'completed', summary: 'Reviewed all child work and completed the root objective.' }, mainIdentity);
    assert.equal(rootDone.body.data.result.session.phase, 'completed');
    const immutable = await call(server, 'session_checkpoint', { phase: 'working', summary: 'Reopen.' }, mainIdentity); assert.equal(immutable.body.error.code, 'INVALID_IDENTITY');
    const continuation = await root(server, 'main-followup', main.session.id);
    assert.equal(continuation.session.continuesSessionId, main.session.id); assert.equal(continuation.session.parentSessionId, undefined);
    assert.equal(continuation.context.inheritedFrom.id, main.session.id); assert.equal(continuation.context.inheritedFrom.finalSummary, 'Reviewed all child work and completed the root objective.');
    const permanentHistory = await call(server, 'session_history', { limit: 500, includeAncestors: true }, continuation.identity);
    assert.ok(permanentHistory.body.data.result.history.entries.some((entry) => entry.sessionId === main.session.id && entry.type === 'checkpoint'));
  } finally { await server.close(); }
});

test('TUI model collapses continuation records and groups two-way conversations with stable scrolling', () => {
  const dirs = tempWorkspace(); const store = new LiteStore(dirs.stateDir);
  try {
    const first = store.registerRoot({ name: 'logical-a' }); store.checkpoint(first.session.id, { phase: 'completed', summary: 'first complete' });
    const continuation = store.registerRoot({ name: 'logical-a-next', continuesSessionId: first.session.id }); const independent = store.registerRoot({ name: 'logical-b' });
    store.sendMessage(continuation.session.id, independent.session.id, 'one'); store.sendMessage(independent.session.id, continuation.session.id, 'two');
    const groups = logicalSessionGroups(store.listSessions()); assert.equal(groups.length, 2);
    const chain = groups.find((group) => group.id === first.session.id); assert.equal(chain.sessions.length, 2); assert.equal(chain.current.id, continuation.session.id);
    const conversations = conversationGroups(store.snapshot().messages); assert.equal(conversations.length, 1); assert.equal(conversations[0].messages.length, 2);
    assert.deepEqual(selectedViewport(['a', 'b', 'c', 'd'], 3, 2), { selected: 3, start: 2, visible: ['c', 'd'] });
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('workspace diff tracker includes tracked and untracked changes while excluding Lite state', async () => {
  const dirs = tempWorkspace();
  try {
    execFileSync('git', ['init'], { cwd: dirs.workspaceDir }); execFileSync('git', ['config', 'user.email', 'lite@example.test'], { cwd: dirs.workspaceDir }); execFileSync('git', ['config', 'user.name', 'Lite Test'], { cwd: dirs.workspaceDir });
    execFileSync('git', ['add', 'hello.txt'], { cwd: dirs.workspaceDir }); execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dirs.workspaceDir });
    fs.writeFileSync(path.join(dirs.workspaceDir, 'hello.txt'), 'changed lite\n'); fs.writeFileSync(path.join(dirs.workspaceDir, 'new.txt'), 'new line\n'); fs.writeFileSync(path.join(dirs.stateDir, 'internal.txt'), 'hidden\n');
    const tracker = new WorkspaceDiffTracker({ ...dirs, settingsPath: '', host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: '', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'en', uiTheme: 'dark' });
    await tracker.refresh(); const diff = tracker.snapshot(); const text = diff.lines.join('\n');
    assert.match(text, /-hello lite/); assert.match(text, /\+changed lite/); assert.match(text, /diff --git a\/new.txt b\/new.txt/); assert.doesNotMatch(text, /internal.txt/);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('only roots delegate, multiple children coexist, and TUI revoke invalidates old controller', async () => {
  const server = await createRuntime();
  try {
    const main = await root(server); const identity = main.identity;
    const first = await call(server, 'session_register', { mode: 'delegate', name: 'one', task }, identity);
    const second = await call(server, 'session_register', { mode: 'delegate', name: 'two', task }, identity);
    assert.equal(first.body.ok, true); assert.equal(second.body.ok, true);
    const claimed = await call(server, 'session_inherit', { sessionId: first.body.data.result.session.id, claimCode: first.body.data.result.claimCode }); const childIdentity = claimed.body.data.result.identity;
    const grandchild = await call(server, 'session_register', { mode: 'delegate', name: 'grandchild', task }, childIdentity);
    assert.equal(grandchild.body.error.code, 'MAX_SESSION_DEPTH');
    const revoked = server.runtime.store.revokeFromTui(first.body.data.result.session.id);
    const oldRejected = await call(server, 'workspace_info', {}, childIdentity); assert.equal(oldRejected.body.error.code, 'INVALID_IDENTITY');
    const reclaimed = await call(server, 'session_inherit', { sessionId: revoked.session.id, claimCode: revoked.claimCode }); assert.equal(reclaimed.body.ok, true);
  } finally { await server.close(); }
});

test('checkpoint reminder, block, and stale transitions use fixed non-resetting deadlines', () => {
  const dirs = tempWorkspace(); let now = Date.parse('2026-01-01T00:00:00.000Z'); const store = new LiteStore(dirs.stateDir, () => now);
  try {
    const created = store.registerRoot({ name: 'clock' }); store.beforeOrdinaryCall(created.session.id);
    const started = store.session(created.session.id).checkpointStartedAt; now += 60_000; store.beforeOrdinaryCall(created.session.id); assert.equal(store.session(created.session.id).checkpointStartedAt, started);
    now = Date.parse(started) + SESSION_TIMING.CHECKPOINT_REMINDER_MS; store.refreshTemporalStates(); assert.ok(store.pendingEvents(created.session.id).some((event) => event.kind === 'checkpoint_due'));
    now = Date.parse(started) + SESSION_TIMING.CHECKPOINT_BLOCK_MS;
    assert.throws(() => store.beforeOrdinaryCall(created.session.id), (error) => error.code === 'CHECKPOINT_REQUIRED');
    store.checkpoint(created.session.id, { phase: 'working', summary: 'Checkpoint resets the work window.' }); assert.equal(store.session(created.session.id).checkpointStartedAt, undefined);
    store.beforeOrdinaryCall(created.session.id); const activity = Date.parse(store.session(created.session.id).controller.lastActivityAt); now = activity + SESSION_TIMING.STALE_MS; store.refreshTemporalStates();
    assert.equal(store.session(created.session.id).presence, 'stale');
    const recoveryPrompt = store.handoffForTui(created.session.id); assert.ok(recoveryPrompt);
    const recoveryCode = recoveryPrompt.match(/"claimCode":"([a-f0-9]+)"/)[1]; const recovered = store.inherit(created.session.id, recoveryCode);
    assert.equal(recovered.session.presence, 'claimed'); assert.notEqual(recovered.identity.sessionToken, created.identity.sessionToken);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('extension registry and workspace tools require identity and audit redacts bounded arguments', async () => {
  const server = await createRuntime();
  try {
    const denied = await call(server, 'read_file', { path: 'hello.txt' }); assert.equal(denied.body.error.code, 'IDENTITY_REQUIRED');
    const main = await root(server); const identity = main.identity;
    const valid = await call(server, 'read_file', { path: 'hello.txt' }, identity); assert.equal(valid.body.data.result.content, 'hello lite\n');
    const protectedState = await call(server, 'read_file', { path: '.localterminal-lite/state.json' }, identity); assert.equal(protectedState.body.ok, false);
    const spec = { name: 'echo_value', title: 'Echo value', description: 'Echo a supplied value through a bounded executable.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, handler: { kind: 'command', executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', '{{input.value}}'] } };
    const deniedRegistry = await action(server, 'register', { action: 'validate', spec }); assert.equal(deniedRegistry.body.error.code, 'IDENTITY_REQUIRED');
    for (const actionName of ['validate', 'upsert']) { const response = await action(server, 'register', { action: actionName, spec, identity }); assert.equal(response.body.ok, true, JSON.stringify(response.body)); }
    const custom = await call(server, 'echo_value', { value: 'custom-ok' }, identity); assert.equal(custom.body.data.result.stdout, 'custom-ok');
    await call(server, 'message_send', { to: main.session.id, body: 'sensitive body' }, identity);
    const history = fs.readFileSync(path.join(server.dirs.stateDir, 'history', `${main.session.id}.jsonl`), 'utf8');
    assert.equal(history.includes(identity.sessionToken), false); assert.ok(history.includes('[REDACTED'));
    for (const line of history.trim().split('\n').map(JSON.parse).filter((entry) => entry.type === 'tool_audit')) assert.ok(JSON.stringify(line.data.args).length <= 4000);
  } finally { await server.close(); }
});

test('events cap at five, persist until ACK, subscriptions deliver milestones, and messages are never pruned', () => {
  const dirs = tempWorkspace(); const store = new LiteStore(dirs.stateDir);
  try {
    const rootSession = store.registerRoot({ name: 'root' }); const observer = store.registerRoot({ name: 'observer' }); store.subscribe(observer.session.id, rootSession.session.id);
    for (let i = 0; i < 8; i += 1) store.sendMessage(rootSession.session.id, observer.session.id, `message-${i}`);
    assert.equal(store.pendingEvents(observer.session.id).length, 5); const first = store.pendingEvents(observer.session.id); assert.deepEqual(store.pendingEvents(observer.session.id).map((event) => event.id), first.map((event) => event.id));
    store.acknowledgeEvents(observer.session.id, first.map((event) => event.id)); assert.equal(store.pendingEvents(observer.session.id).length, 3);
    store.checkpoint(rootSession.session.id, { phase: 'working', summary: 'Reached a milestone.', milestone: 'api-ready' });
    assert.ok(store.pendingEvents(observer.session.id).some((event) => event.kind === 'milestone'));
    for (let i = 8; i < 5100; i += 1) store.sendMessage(rootSession.session.id, observer.session.id, `message-${i}`);
    assert.equal(store.snapshot().messages.length, 5100);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('v1 state migrates to v2 with stale roots and durable history; context stays under 16K', () => {
  const dirs = tempWorkspace();
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dirs.stateDir, 'state.json'), JSON.stringify({ schemaVersion: 1, revision: 4, sessions: [{ id: 'ses_old', name: 'old', role: 'developer', status: 'active', note: 'legacy note', clientSessionKey: 'ignored', createdAt: now, updatedAt: now }], messages: [{ id: 'msg_old', from: 'ses_old', to: 'ses_old', body: 'legacy message', createdAt: now }], extensions: [] }));
    const store = new LiteStore(dirs.stateDir); const migrated = store.snapshot(); assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.sessions[0].phase, 'working'); assert.equal(migrated.sessions[0].presence, 'stale'); assert.equal(migrated.sessions[0].clientSessionKey, undefined);
    assert.ok(fs.readFileSync(path.join(dirs.stateDir, 'history', 'ses_old.jsonl'), 'utf8').includes('migration_v1'));
    assert.ok(JSON.stringify(store.context('ses_old')).length <= 16_000);
    assert.throws(() => store.deleteFromTui('ses_old'), (error) => error.code === 'DELETE_CONFIRMATION_REQUIRED');
    assert.deepEqual(store.deleteFromTui('ses_old', 'DELETE ses_old').deleted, ['ses_old']);
  } finally { fs.rmSync(dirs.workspaceDir, { recursive: true, force: true }); }
});

test('Apps exposes only three tools and binds openai/session only after explicit verified identity', async () => {
  const server = await createRuntime();
  try {
    const url = `${server.baseUrl}/mcp/${CONNECTOR_KEY}`;
    const init = await rpcPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lite-test', version: '0.5.0' } } });
    assert.match(init.data.result.instructions, /Do not use session_inherit to continue completed work/); assert.match(init.data.result.instructions, /message_conversation/);
    const listed = await rpcPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sessionId);
    assert.deepEqual(listed.data.result.tools.map((tool) => tool.name).sort(), ['extension_call', 'extension_discover', 'extension_register']);
    const anonymous = await rpcPost(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'extension_discover', arguments: {}, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.equal(anonymous.data.result.structuredContent.data.identityRequired, true);
    const created = await rpcPost(url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'extension_call', arguments: { tool: 'session_register', input: { mode: 'root', name: 'apps-root' } }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    const identity = created.data.result.structuredContent.data.result.identity;
    const verified = await rpcPost(url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'extension_discover', arguments: { identity, includeSchemas: false }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.ok(verified.data.result.structuredContent.data.tools.length > 20);
    const bound = await rpcPost(url, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'extension_discover', arguments: { includeSchemas: false }, _meta: { 'openai/session': 'chat-a' } } }, init.sessionId);
    assert.ok(bound.data.result.structuredContent.data.tools.length > 20);
    const differentChat = await rpcPost(url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'extension_discover', arguments: {}, _meta: { 'openai/session': 'chat-b' } } }, init.sessionId);
    assert.equal(differentChat.data.result.structuredContent.data.identityRequired, true);
  } finally { await server.close(); }
});
