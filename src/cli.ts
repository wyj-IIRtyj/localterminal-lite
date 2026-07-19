#!/usr/bin/env bun
import {
  createDefaultSettings,
  loadLiteConfig,
  maskCredential,
  readLiteSettings,
  saveLiteSettings,
  settingsPath,
} from './config.js';
import { LiteRuntime } from './server.js';
import path from 'node:path';
import { describePortOwner, findAvailablePort, isWorkspaceRecordActive, readWorkspaceRegistry, terminatePortOwner } from './instances.js';
import type { RuntimeReconfigure } from './tui/state.js';
import type { LiteSettings } from './types.js';

function help(): void {
  console.log(`LocalTerminal Lite v1.0.1

Usage:
  bun run dev                 Start the TUI (includes first-run setup)
  bun run start               Start the built TUI
  bun run dist/cli.js --headless Start after TUI setup, without terminal controls

The TUI manages workspace, network, limits, and connection credentials.
Optional environment overrides for automation:
  LITE_WORKSPACE_DIR, LITE_HOST, LITE_PORT, LITE_PUBLIC_BASE_URL,
  LITE_ACTIONS_TOKEN, LITE_CONNECTOR_KEY, LITE_MAX_OUTPUT_CHARS,
  LITE_COMMAND_TIMEOUT_SEC
`);
}

const RUNTIME_OVERRIDE_KEYS = [
  'LITE_WORKSPACE_DIR', 'LITE_HOST', 'LITE_PORT', 'LITE_PUBLIC_BASE_URL',
  'LITE_ACTIONS_TOKEN', 'LITE_CONNECTOR_KEY', 'LITE_MAX_OUTPUT_CHARS',
  'LITE_COMMAND_TIMEOUT_SEC',
] as const;

function effectiveEnvironment(headless: boolean): NodeJS.ProcessEnv {
  if (headless) return process.env;
  const env = { ...process.env };
  for (const key of RUNTIME_OVERRIDE_KEYS) delete env[key];
  return env;
}

async function ensureSettings(headless: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (readLiteSettings(env)) return;
  } catch (error) {
    if (headless) throw error;
  }
  if (headless) {
    throw new Error('Lite has not been configured. Run `bun run dev` once and complete the TUI setup.');
  }
  const defaults = createDefaultSettings();
  const { runSetupTui } = await import('./tui/index.js');
  const configured = await runSetupTui(defaults);
  saveLiteSettings(configured, env);
}


async function chooseWorkspace(env: NodeJS.ProcessEnv): Promise<void> {
  const current = readLiteSettings(env);
  if (!current) return;
  const records = readWorkspaceRegistry(path.dirname(settingsPath(env)));
  if (!records.length) return;
  const { runWorkspaceChooserTui } = await import('./tui/index.js');
  const available = records.filter((record) => !isWorkspaceRecordActive(record));
  if (!available.length) throw new Error('Every registered workspace is already active in another LocalTerminal Lite process.');
  const selected = await runWorkspaceChooserTui(available, current.workspaceDir, current.uiLanguage === 'zh-CN');
  const active = records.find((record) => path.resolve(record.workspaceDir) === path.resolve(selected) && isWorkspaceRecordActive(record));
  if (active) throw new Error(`Workspace is already active in PID ${active.lastPid}: ${active.workspaceDir}`);
  saveLiteSettings({ ...current, workspaceDir: selected }, env);
}

async function startRuntime(env: NodeJS.ProcessEnv, interactive = false): Promise<LiteRuntime> {
  for (;;) {
    const runtime = new LiteRuntime(loadLiteConfig(env));
    try {
      await runtime.start();
      return runtime;
    } catch (error) {
      const detail = error as Error & { code?: string; port?: number; host?: string };
      if (!interactive || detail.code !== 'EADDRINUSE' || !detail.port) throw error;
      const owner = describePortOwner(detail.port);
      const { runChoiceTui } = await import('./tui/index.js');
      const answer = (await runChoiceTui(
        { label: `Port ${detail.port} is occupied by ${owner}`, fallback: 'cancel', options: ['kill', 'next', 'cancel'] },
        ['Choose how LocalTerminal Lite should continue.'],
        false,
      )).trim().toLowerCase();
      if (answer === 'k' || answer === 'kill') {
        await terminatePortOwner(detail.port);
        continue;
      }
      if (answer === 'n' || answer === 'next') {
        const current = readLiteSettings(env);
        if (!current) throw error;
        const port = await findAvailablePort(detail.host || current.host, detail.port);
        saveLiteSettings({ ...current, port }, env);
        console.log(`Using available port ${port}.`);
        continue;
      }
      throw error;
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  const headless = process.argv.includes('--headless') || !process.stdin.isTTY || !process.stdout.isTTY;
  const env = effectiveEnvironment(headless);
  await ensureSettings(headless, env);
  if (!headless) await chooseWorkspace(env);
  let runtime = await startRuntime(env, !headless);
  if (!headless) {
    const { LiteTui } = await import('./tui/index.js');
    const reconfigure: RuntimeReconfigure = async (next: LiteSettings) => {
      const previous = readLiteSettings(env);
      if (!previous) return { runtime, error: 'Persistent settings were not found.' };
      await runtime.close();
      saveLiteSettings(next, env);
      try {
        runtime = await startRuntime(env);
        return { runtime };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        saveLiteSettings(previous, env);
        runtime = await startRuntime(env);
        return { runtime, error: `New settings could not start; previous settings restored. ${message}` };
      }
    };
    await new LiteTui(runtime, reconfigure).run();
    // OpenTUI and platform input monitors may retain handles after a clean shutdown.
    // At this point runtime.close() and all session resource cleanup have completed.
    process.exit(0);
  }
  console.log(JSON.stringify({
    status: 'ready',
    bind: `${runtime.config.host}:${runtime.port}`,
    workspace: runtime.config.workspaceDir,
    appsMcpUrl: runtime.appsUrl,
    actionsOpenApiUrl: runtime.openApiUrl,
    actionsToken: maskCredential(runtime.config.actionsToken),
    settings: settingsPath(env),
    exposedTools: ['extension_discover', 'extension_register', 'extension_call'],
  }, null, 2));
  const stop = async () => { await runtime.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function fatalErrorReport(error: unknown): string {
  if (!(error instanceof Error)) return `LocalTerminal Lite failed to start.\nReason: ${String(error)}`;
  const detail = error as Error & { code?: string; host?: string; port?: number; syscall?: string };
  const lines = [
    'LocalTerminal Lite failed to start.',
    `Reason: ${detail.message || error.name}`,
  ];
  if (detail.code) lines.push(`Code: ${detail.code}`);
  if (detail.host !== undefined || detail.port !== undefined) lines.push(`Bind: ${detail.host ?? '?'}:${detail.port ?? '?'}`);
  if (detail.syscall) lines.push(`Operation: ${detail.syscall}`);
  if (error.cause instanceof Error && error.cause.message && error.cause.message !== detail.message) {
    lines.push(`Cause: ${error.cause.message}`);
  }
  if (error.stack) lines.push('', 'Stack trace:', error.stack);
  return lines.join('\n');
}

main().catch((error) => {
  if (error instanceof Error && error.message === 'Setup cancelled.') return;
  console.error(fatalErrorReport(error));
  process.exit(1);
});
