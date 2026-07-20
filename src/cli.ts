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
import { describePortOwner, findAvailablePort, isWorkspaceRecordActive, terminatePortOwner } from './instances.js';
import { WorkspaceCatalog } from './workspace-catalog.js';
import type { RuntimeReconfigure } from './tui/state.js';
import type { LiteSettings } from './types.js';
import { CURRENT_VERSION } from './version.js';
import { verifyRuntimeResources } from './session-resources.js';

function help(): void {
  console.log(`LocalTerminal Lite v${CURRENT_VERSION}

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
  // Invalid or temporarily unreadable settings must never fall through to first-run
  // defaults, because doing so would silently replace stable credentials.
  if (readLiteSettings(env)) return;
  if (headless) {
    throw new Error('Lite has not been configured. Run `bun run dev` once and complete the TUI setup.');
  }
  const defaults = createDefaultSettings();
  const { runSetupTui } = await import('./tui/index.js');
  const catalog = new WorkspaceCatalog(path.dirname(settingsPath(env)));
  const configured = await runSetupTui(defaults, catalog.snapshot());
  saveLiteSettings(configured, env);
}


class StartupCancelled extends Error {
  constructor() { super('Startup cancelled.'); this.name = 'StartupCancelled'; }
}

async function chooseWorkspace(env: NodeJS.ProcessEnv): Promise<boolean> {
  const current = readLiteSettings(env);
  if (!current) return true;
  const records = new WorkspaceCatalog(path.dirname(settingsPath(env))).snapshot();
  if (!records.length) return true;
  const { runWorkspaceChooserTui } = await import('./tui/index.js');
  const selected = await runWorkspaceChooserTui(records, current.workspaceDir, current.uiLanguage === 'zh-CN');
  if (!selected) return false;
  const active = records.find((record) => path.resolve(record.workspaceDir) === path.resolve(selected) && isWorkspaceRecordActive(record));
  if (active) throw new Error(`Workspace is already active in PID ${active.lastPid}: ${active.workspaceDir}`);
  saveLiteSettings({ ...current, workspaceDir: selected }, env);
  return true;
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
      throw new StartupCancelled();
    }
  }
}

let activeRuntime: LiteRuntime | undefined;
let fatalShutdown: Promise<void> | undefined;

async function safeFatalShutdown(error: unknown): Promise<void> {
  if (fatalShutdown) return fatalShutdown;
  fatalShutdown = (async () => {
    try {
      activeRuntime?.log(`Fatal process error: ${error instanceof Error ? error.stack || error.message : String(error)}`, 'error');
      await activeRuntime?.close();
    } catch (shutdownError) {
      console.error(`Safe shutdown failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`);
    } finally { process.exitCode = 1; }
  })();
  return fatalShutdown;
}

async function main(): Promise<void> {
  if (process.argv.includes('--verify-installation')) {
    console.log(JSON.stringify(verifyRuntimeResources()));
    return;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  const headless = process.argv.includes('--headless') || !process.stdin.isTTY || !process.stdout.isTTY;
  const env = effectiveEnvironment(headless);
  await ensureSettings(headless, env);
  if (!headless && !(await chooseWorkspace(env))) return;
  let runtime = await startRuntime(env, !headless);
  activeRuntime = runtime;
  if (!headless) {
    const { LiteTui } = await import('./tui/index.js');
    const reconfigure: RuntimeReconfigure = async (next: LiteSettings) => {
      const previous = readLiteSettings(env);
      if (!previous) return { runtime, error: 'Persistent settings were not found.' };
      await runtime.close();
      saveLiteSettings(next, env);
      try {
        runtime = await startRuntime(env);
        activeRuntime = runtime;
        return { runtime };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        saveLiteSettings(previous, env);
        runtime = await startRuntime(env);
        activeRuntime = runtime;
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
  const stop = async () => { await runtime.close(); activeRuntime = undefined; process.exit(0); };
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

process.on('unhandledRejection', (error) => {
  console.error(fatalErrorReport(error));
  void safeFatalShutdown(error).finally(() => process.exit(1));
});
process.on('uncaughtException', (error) => {
  console.error(fatalErrorReport(error));
  void safeFatalShutdown(error).finally(() => process.exit(1));
});

main().catch((error) => {
  if (error instanceof StartupCancelled || (error instanceof Error && error.message === 'Setup cancelled.')) return;
  console.error(fatalErrorReport(error));
  process.exit(1);
});
