#!/usr/bin/env node
import {
  createDefaultSettings,
  loadLiteConfig,
  maskCredential,
  readLiteSettings,
  saveLiteSettings,
  settingsPath,
} from './config.js';
import { LiteRuntime } from './server.js';
import { LiteTui, runSetupTui, type RuntimeReconfigure } from './tui.js';
import type { LiteSettings } from './types.js';

function help(): void {
  console.log(`LocalTerminal Lite v0.2.0

Usage:
  npm run dev                 Start the TUI (includes first-run setup)
  npm run start               Start the built TUI
  node dist/cli.js --headless Start after TUI setup, without terminal controls

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
    throw new Error('Lite has not been configured. Run `npm run dev` once and complete the TUI setup.');
  }
  const defaults = createDefaultSettings();
  const configured = await runSetupTui(defaults);
  saveLiteSettings(configured, env);
}

async function startRuntime(env: NodeJS.ProcessEnv): Promise<LiteRuntime> {
  const runtime = new LiteRuntime(loadLiteConfig(env));
  await runtime.start();
  return runtime;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  const headless = process.argv.includes('--headless') || !process.stdin.isTTY || !process.stdout.isTTY;
  const env = effectiveEnvironment(headless);
  await ensureSettings(headless, env);
  let runtime = await startRuntime(env);
  if (!headless) {
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
    return;
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
