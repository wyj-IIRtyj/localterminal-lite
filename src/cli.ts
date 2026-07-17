#!/usr/bin/env node
import 'dotenv/config';
import { loadLiteConfig, maskCredential } from './config.js';
import { LiteRuntime } from './server.js';
import { LiteTui } from './tui.js';

function help(): void {
  console.log(`LocalTerminal Lite v0.1.0

Usage:
  npm run dev                 Start the interactive TUI
  npm run start               Start the built interactive TUI
  node dist/cli.js --headless Start service mode without terminal controls

Environment:
  LITE_WORKSPACE_DIR, LITE_HOST, LITE_PORT, LITE_PUBLIC_BASE_URL,
  LITE_ACTIONS_TOKEN, LITE_CONNECTOR_KEY, LITE_MAX_OUTPUT_CHARS,
  LITE_COMMAND_TIMEOUT_SEC
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  const runtime = new LiteRuntime(loadLiteConfig());
  await runtime.start();
  const headless = process.argv.includes('--headless') || !process.stdin.isTTY || !process.stdout.isTTY;
  if (!headless) {
    await new LiteTui(runtime).run();
    return;
  }
  console.log(JSON.stringify({
    status: 'ready',
    bind: `${runtime.config.host}:${runtime.port}`,
    workspace: runtime.config.workspaceDir,
    appsMcpUrl: runtime.appsUrl,
    actionsOpenApiUrl: runtime.openApiUrl,
    actionsToken: maskCredential(runtime.config.actionsToken),
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
