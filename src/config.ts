import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LiteConfig, LiteConfigFile } from './types.js';

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function readConfigFile(configPath: string): LiteConfigFile | undefined {
  if (!existsSync(configPath)) return undefined;
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<LiteConfigFile>;
  if (parsed.schemaVersion !== 1 || typeof parsed.connectorKey !== 'string' || typeof parsed.actionsToken !== 'string') {
    throw new Error(`Invalid Lite config: ${configPath}`);
  }
  return parsed as LiteConfigFile;
}

export function loadLiteConfig(env: NodeJS.ProcessEnv = process.env): LiteConfig {
  const requestedWorkspace = path.resolve(env.LITE_WORKSPACE_DIR || process.cwd());
  if (!existsSync(requestedWorkspace) || !statSync(requestedWorkspace).isDirectory()) {
    throw new Error(`LITE_WORKSPACE_DIR is not a directory: ${requestedWorkspace}`);
  }
  const workspaceDir = realpathSync(requestedWorkspace);
  const stateDir = path.join(workspaceDir, '.localterminal-lite');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(stateDir, 'config.json');
  const stored = readConfigFile(configPath);
  const connectorKey = env.LITE_CONNECTOR_KEY || stored?.connectorKey || randomBytes(24).toString('hex');
  const actionsToken = env.LITE_ACTIONS_TOKEN || stored?.actionsToken || randomBytes(32).toString('hex');
  if (connectorKey.length < 24 || actionsToken.length < 24) {
    throw new Error('Lite connector and Actions credentials must contain at least 24 characters.');
  }
  const publicBaseUrl = (env.LITE_PUBLIC_BASE_URL || stored?.publicBaseUrl || `http://127.0.0.1:${env.LITE_PORT || 3210}`).replace(/\/$/, '');
  const file: LiteConfigFile = { schemaVersion: 1, connectorKey, actionsToken, publicBaseUrl };
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return {
    workspaceDir,
    stateDir,
    host: env.LITE_HOST || '127.0.0.1',
    port: boundedInteger(env.LITE_PORT, 3210, 0, 65535),
    connectorKey,
    actionsToken,
    publicBaseUrl,
    maxOutputChars: boundedInteger(env.LITE_MAX_OUTPUT_CHARS, 120_000, 4_000, 1_000_000),
    commandTimeoutSec: boundedInteger(env.LITE_COMMAND_TIMEOUT_SEC, 60, 1, 3600),
  };
}

export function maskCredential(value: string): string {
  if (value.length < 12) return '••••••••';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
