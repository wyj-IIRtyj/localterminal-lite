import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { describePortOwner, portOwner, upsertWorkspaceRecord, workspaceId, workspaceStateDir } from './instances.js';
import { migrateWorkspaceState } from './migration.js';
import os from 'node:os';
import path from 'node:path';
import type { LiteConfig, LiteSettings } from './types.js';

const WORKSPACE_PLACEHOLDERS = new Set(['/absolute/path/to/project']);
const PUBLIC_URL_PLACEHOLDERS = new Set(['https://replace-with-your-tunnel.example']);

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function optionalEnv(value: string | undefined, placeholders: Set<string> = new Set()): string | undefined {
  const candidate = value?.trim();
  return candidate && !placeholders.has(candidate) ? candidate : undefined;
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = optionalEnv(env.LITE_CONFIG_DIR);
  const base = configured
    ? path.resolve(configured)
    : path.join(optionalEnv(env.XDG_CONFIG_HOME) || path.join(os.homedir(), '.config'), 'localterminal-lite');
  return path.join(base, 'config.json');
}

export function defaultWorkspaceForCwd(cwd = process.cwd()): string {
  const resolved = path.resolve(cwd);
  if (path.basename(resolved) === 'lite') {
    const parent = path.dirname(resolved);
    if (existsSync(path.join(parent, 'package.json'))) return realpathSync(parent);
  }
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function isDirectory(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isDirectory();
}

export function isValidPublicBaseUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname));
  } catch {
    return false;
  }
}

export function createDefaultSettings(workspaceDir = defaultWorkspaceForCwd()): LiteSettings {
  return {
    schemaVersion: 1,
    workspaceDir,
    host: '127.0.0.1',
    port: 3210,
    connectorKey: randomBytes(24).toString('hex'),
    actionsToken: randomBytes(32).toString('hex'),
    publicBaseUrl: '',
    maxOutputChars: 120_000,
    commandTimeoutSec: 60,
    uiLanguage: 'zh-CN',
    uiTheme: 'dark',
    passiveLockEnabled: false,
  };
}


export function validateSettings(settings: LiteSettings): string[] {
  const errors: string[] = [];
  if (typeof settings.workspaceDir !== 'string' || !isDirectory(settings.workspaceDir)) errors.push(`Workspace is not a directory: ${settings.workspaceDir || '(empty)'}`);
  if (typeof settings.host !== 'string' || !settings.host.trim()) errors.push('Host cannot be empty.');
  if (!Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) errors.push('Port must be an integer from 0 to 65535.');
  if (typeof settings.publicBaseUrl !== 'string' || !isValidPublicBaseUrl(settings.publicBaseUrl)) errors.push('Public URL must use HTTPS (localhost may use HTTP).');
  if (typeof settings.connectorKey !== 'string' || typeof settings.actionsToken !== 'string' || settings.connectorKey.length < 24 || settings.actionsToken.length < 24) errors.push('Connector and Actions credentials must contain at least 24 characters.');
  if (!Number.isInteger(settings.maxOutputChars) || settings.maxOutputChars < 4_000 || settings.maxOutputChars > 1_000_000) errors.push('Maximum output must be from 4000 to 1000000 characters.');
  if (!Number.isInteger(settings.commandTimeoutSec) || settings.commandTimeoutSec < 1 || settings.commandTimeoutSec > 3600) errors.push('Command timeout must be from 1 to 3600 seconds.');
  if (!['en', 'zh-CN'].includes(settings.uiLanguage)) errors.push('UI language must be en or zh-CN.');
  if (!['dark', 'light'].includes(settings.uiTheme)) errors.push('UI theme must be dark or light.');
  if (typeof settings.passiveLockEnabled !== 'boolean') errors.push('Passive lock enabled must be boolean.');
  return errors;
}


export async function validateSettingsFeasibility(settings: LiteSettings, current?: { host: string; port: number }): Promise<string[]> {
  const errors = validateSettings(settings);
  if (errors.length || settings.port === 0 || (current && current.host === settings.host && current.port === settings.port)) return errors;
  const portError = await new Promise<string | undefined>((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        const owner = portOwner(settings.port);
        if (owner?.pid === process.pid) { resolve(undefined); return; }
        const request = http.get({ host: settings.host, port: settings.port, path: '/health', timeout: 1000 }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            try {
              const health = JSON.parse(body) as { product?: string; clustered?: boolean };
              if (response.statusCode === 200 && health.product === 'localterminal-lite' && health.clustered === true) { resolve(undefined); return; }
            } catch { /* unrelated service */ }
            resolve(`Port ${settings.port} is already in use on ${settings.host} (${describePortOwner(settings.port)}).`);
          });
        });
        request.once('timeout', () => request.destroy());
        request.once('error', () => resolve(`Port ${settings.port} is already in use on ${settings.host} (${describePortOwner(settings.port)}).`));
        return;
      }
      resolve(`Cannot listen on ${settings.host}:${settings.port}: ${error.message}`);
    });
    probe.listen(settings.port, settings.host, () => probe.close(() => resolve(undefined)));
  });
  return portError ? [...errors, portError] : errors;
}

export function readLiteSettings(env: NodeJS.ProcessEnv = process.env): LiteSettings | undefined {
  const configPath = settingsPath(env);
  if (!existsSync(configPath)) return undefined;
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<LiteSettings>;
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported Lite settings format: ${configPath}`);
  const settings = { uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, ...parsed } as LiteSettings;
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(`Invalid Lite settings: ${errors.join(' ')}`);
  return settings;
}

export function saveLiteSettings(settings: LiteSettings, env: NodeJS.ProcessEnv = process.env): void {
  const normalized: LiteSettings = {
    ...settings,
    workspaceDir: realpathSync(path.resolve(settings.workspaceDir)),
    host: settings.host.trim(),
    publicBaseUrl: settings.publicBaseUrl.trim().replace(/\/$/, ''),
  };
  const errors = validateSettings(normalized);
  if (errors.length) throw new Error(errors.join(' '));
  const configPath = settingsPath(env);
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export function rotateLiteCredentials(settings: LiteSettings): LiteSettings {
  return {
    ...settings,
    connectorKey: randomBytes(24).toString('hex'),
    actionsToken: randomBytes(32).toString('hex'),
  };
}

function envWorkspace(env: NodeJS.ProcessEnv): string | undefined {
  return optionalEnv(env.LITE_WORKSPACE_DIR, WORKSPACE_PLACEHOLDERS);
}

export function settingsWithEnvironment(settings: LiteSettings, env: NodeJS.ProcessEnv = process.env): LiteSettings {
  return {
    ...settings,
    workspaceDir: path.resolve(envWorkspace(env) || settings.workspaceDir),
    host: optionalEnv(env.LITE_HOST) || settings.host,
    port: boundedInteger(env.LITE_PORT, settings.port, 0, 65535),
    publicBaseUrl: optionalEnv(env.LITE_PUBLIC_BASE_URL, PUBLIC_URL_PLACEHOLDERS) ?? settings.publicBaseUrl,
    actionsToken: optionalEnv(env.LITE_ACTIONS_TOKEN) || settings.actionsToken,
    connectorKey: optionalEnv(env.LITE_CONNECTOR_KEY) || settings.connectorKey,
    maxOutputChars: boundedInteger(env.LITE_MAX_OUTPUT_CHARS, settings.maxOutputChars, 4_000, 1_000_000),
    commandTimeoutSec: boundedInteger(env.LITE_COMMAND_TIMEOUT_SEC, settings.commandTimeoutSec, 1, 3600),
  };
}

export function loadLiteConfig(env: NodeJS.ProcessEnv = process.env): LiteConfig {
  const stored = readLiteSettings(env);
  const base = stored || createDefaultSettings(path.resolve(envWorkspace(env) || defaultWorkspaceForCwd()));
  const settings = settingsWithEnvironment(base, env);
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(errors.join(' '));
  const workspaceDir = realpathSync(settings.workspaceDir);
  const configDir = path.dirname(settingsPath(env));
  const stateDir = workspaceStateDir(configDir, workspaceDir);
  const legacyGlobalStateDir = path.join(configDir, 'state');
  const migratedGlobalStateDir = path.join(configDir, 'state.migrated');
  const legacyStateDir = path.join(workspaceDir, '.localterminal-lite');
  migrateWorkspaceState(stateDir, [legacyGlobalStateDir, migratedGlobalStateDir, legacyStateDir]);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  upsertWorkspaceRecord(configDir, { id: workspaceId(workspaceDir), workspaceDir, stateDir, lastHost: settings.host, lastPort: settings.port, lastSeenAt: new Date().toISOString() });
  const publicBaseUrl = settings.publicBaseUrl || `http://${settings.host}:${settings.port}`;
  return {
    settingsPath: settingsPath(env),
    workspaceDir,
    stateDir,
    host: settings.host,
    port: settings.port,
    connectorKey: settings.connectorKey,
    actionsToken: settings.actionsToken,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
    maxOutputChars: settings.maxOutputChars,
    commandTimeoutSec: settings.commandTimeoutSec,
    uiLanguage: settings.uiLanguage,
    uiTheme: settings.uiTheme,
    passiveLockEnabled: settings.passiveLockEnabled,
  };
}

export function maskCredential(value: string): string {
  if (value.length < 12) return '••••••••';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
