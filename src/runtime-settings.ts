import type { LiteRuntime } from './server.js';
import type { LiteSettings } from './types.js';

export function runtimeSettingsSnapshot(runtime: LiteRuntime, persisted?: LiteSettings): LiteSettings {
  const config = runtime.config;
  return {
    schemaVersion: 1,
    workspaceDir: config.workspaceDir,
    host: config.host,
    port: runtime.port,
    connectorKey: config.connectorKey,
    actionsToken: config.actionsToken,
    publicBaseUrl: config.publicBaseUrl,
    maxOutputChars: config.maxOutputChars,
    commandTimeoutSec: config.commandTimeoutSec,
    uiLanguage: config.uiLanguage,
    uiTheme: config.uiTheme,
    passiveLockEnabled: persisted?.passiveLockEnabled ?? config.passiveLockEnabled,
  };
}
