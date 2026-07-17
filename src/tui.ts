import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import type { CustomExtensionSpec, LiteSettings, SessionStatus } from './types.js';
import type { LiteRuntime } from './server.js';
import { maskCredential, readLiteSettings, rotateLiteCredentials, validateSettings } from './config.js';

const ESC = '\u001b[';
const clear = `${ESC}2J${ESC}H`;
const dim = `${ESC}2m`;
const bold = `${ESC}1m`;
const cyan = `${ESC}36m`;
const green = `${ESC}32m`;
const yellow = `${ESC}33m`;
const red = `${ESC}31m`;
const reset = `${ESC}0m`;

type Tab = 'Overview' | 'Sessions' | 'Messages' | 'Extensions' | 'Settings' | 'Logs';
const TABS: Tab[] = ['Overview', 'Sessions', 'Messages', 'Extensions', 'Settings', 'Logs'];

export type RuntimeReconfigureResult = { runtime: LiteRuntime; error?: string };
export type RuntimeReconfigure = (settings: LiteSettings) => Promise<RuntimeReconfigureResult>;

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function line(char = '─'): string {
  return char.repeat(Math.max(20, Math.min(120, stdout.columns || 100)));
}

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function runSetupTui(defaults: LiteSettings): Promise<LiteSettings> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('First launch requires the TUI. Run `npm run dev` in an interactive terminal.');
  stdout.write(`${ESC}?1049h${ESC}?25h${clear}`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    let feedback = '';
    while (true) {
      stdout.write(`${clear}${bold}${cyan}LocalTerminal Lite · First-run setup${reset}\n${line()}\n`);
      stdout.write('Configure the complete runtime here. Press Enter to accept each default.\n');
      stdout.write('A public URL is optional until you connect an HTTPS tunnel. Credentials are generated automatically.\n');
      if (feedback) stdout.write(`${red}${feedback}${reset}\n`);
      stdout.write('\n');
      const workspace = (await rl.question(`Workspace directory [${defaults.workspaceDir}]: `)).trim() || defaults.workspaceDir;
      const host = (await rl.question(`Listen host [${defaults.host}]: `)).trim() || defaults.host;
      const portAnswer = (await rl.question(`Listen port [${defaults.port}]: `)).trim();
      const publicUrl = (await rl.question('Public HTTPS base URL (optional): ')).trim();
      const outputAnswer = (await rl.question(`Maximum command output characters [${defaults.maxOutputChars}]: `)).trim();
      const timeoutAnswer = (await rl.question(`Command timeout seconds [${defaults.commandTimeoutSec}]: `)).trim();
      const candidate: LiteSettings = {
        ...defaults,
        workspaceDir: path.resolve(workspace),
        host,
        port: integer(portAnswer, defaults.port),
        publicBaseUrl: publicUrl.replace(/\/$/, ''),
        maxOutputChars: integer(outputAnswer, defaults.maxOutputChars),
        commandTimeoutSec: integer(timeoutAnswer, defaults.commandTimeoutSec),
      };
      const errors = validateSettings(candidate);
      if (errors.length) {
        feedback = errors.join(' ');
        continue;
      }
      const confirm = (await rl.question('\nSave and start? [Y/n]: ')).trim().toLowerCase();
      if (!confirm || confirm === 'y' || confirm === 'yes') return candidate;
      feedback = 'Setup was not saved. Update the values below.';
    }
  } finally {
    rl.close();
    stdout.write(`${ESC}?25h${ESC}?1049l`);
  }
}

export class LiteTui {
  private tab = 0;
  private timer?: NodeJS.Timeout;
  private prompting = false;
  private stopped = false;
  private revealCredentials = false;

  constructor(private runtime: LiteRuntime, private readonly reconfigure: RuntimeReconfigure) {}

  async run(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive TUI requires a TTY. Use --headless for service mode.');
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(`${ESC}?1049h${ESC}?25l`);
    stdin.on('keypress', this.onKeypress);
    this.timer = setInterval(() => { if (!this.prompting) this.render(); }, 1000);
    this.render();
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (this.stopped) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  }

  private readonly onKeypress = async (_text: string, key: { name?: string; ctrl?: boolean }): Promise<void> => {
    if (this.prompting) return;
    try {
      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        await this.shutdown();
        return;
      }
      if (key.name && /^[1-6]$/.test(key.name)) this.tab = Number(key.name) - 1;
      else if (key.name === 'tab' || key.name === 'right') this.tab = (this.tab + 1) % TABS.length;
      else if (key.name === 'left') this.tab = (this.tab + TABS.length - 1) % TABS.length;
      else if (key.name === 'n') await this.promptNewSession();
      else if (key.name === 'm') await this.promptMessage();
      else if (key.name === 'u') await this.promptSessionUpdate();
      else if (key.name === 'e') await this.promptExtension();
      else if (key.name === 'x') await this.promptExtensionRemove();
      else if (key.name === 'c') await this.promptSettings();
      else if (key.name === 'k') await this.promptCredentialRotation();
      else if (key.name === 'v') this.revealCredentials = !this.revealCredentials;
    } catch (error) {
      this.runtime.log(error instanceof Error ? error.message : String(error), 'error');
    }
    this.render();
  };

  private render(): void {
    const width = Math.max(60, Math.min(120, stdout.columns || 100));
    const state = this.runtime.store.snapshot();
    const tabs = TABS.map((tab, index) => index === this.tab ? `${cyan}${bold}[${index + 1} ${tab}]${reset}` : `${dim}${index + 1} ${tab}${reset}`).join('  ');
    const output: string[] = [
      clear,
      `${bold}${cyan}LocalTerminal Lite${reset}  ${green}● running${reset}  ${dim}v0.1.0${reset}`,
      tabs,
      line(),
    ];
    if (this.tab === 0) output.push(...this.renderOverview(state));
    if (this.tab === 1) output.push(...this.renderSessions(state));
    if (this.tab === 2) output.push(...this.renderMessages(state));
    if (this.tab === 3) output.push(...this.renderExtensions(state));
    if (this.tab === 4) output.push(...this.renderSettings());
    if (this.tab === 5) output.push(...this.renderLogs());
    output.push(line(), `${dim}Keys: 1-6/tab switch  n session  u update  m message  e extension  x remove  c configure  v credentials  k rotate  q quit${reset}`);
    const maxRows = Math.max(10, (stdout.rows || 35) - 1);
    stdout.write(output.slice(0, maxRows).map((item) => truncate(item, width + 40)).join('\n'));
  }

  private renderOverview(state: ReturnType<LiteRuntime['store']['snapshot']>): string[] {
    return [
      `${bold}Server${reset}`,
      `  Bind             ${this.runtime.config.host}:${this.runtime.port}`,
      `  Workspace        ${this.runtime.config.workspaceDir}`,
      `  Apps MCP URL     ${this.runtime.appsUrl}`,
      `  Actions OpenAPI  ${this.runtime.openApiUrl}`,
      `  Actions token    ${maskCredential(this.runtime.config.actionsToken)}`,
      '',
      `${bold}Live state${reset}`,
      `  Registered sessions   ${state.sessions.length}`,
      `  Active MCP transports ${this.runtime.activeMcpSessions()}`,
      `  Messages              ${state.messages.length}`,
      `  Custom extensions     ${state.extensions.length}`,
      `  Persistent revision   ${state.revision}`,
      '',
      `${yellow}ChatGPT sees only 3 tools:${reset} extension_discover, extension_register, extension_call`,
    ];
  }

  private renderSessions(state: ReturnType<LiteRuntime['store']['snapshot']>): string[] {
    const rows = [`${bold}Sessions${reset}`];
    if (!state.sessions.length) rows.push(`${dim}No sessions. Press n to register the first worker.${reset}`);
    for (const session of state.sessions.slice(-20)) rows.push(`  ${session.status === 'active' ? green : yellow}${session.status.padEnd(9)}${reset} ${truncate(session.name, 22).padEnd(23)} ${truncate(session.role, 16).padEnd(17)} ${dim}${session.id}${reset}`, session.note ? `             ${dim}${truncate(session.note, 80)}${reset}` : '');
    return rows;
  }

  private renderMessages(state: ReturnType<LiteRuntime['store']['snapshot']>): string[] {
    const names = new Map(state.sessions.map((session) => [session.id, session.name]));
    const rows = [`${bold}Recent messages${reset}`];
    if (!state.messages.length) rows.push(`${dim}No messages. Press m after registering two sessions.${reset}`);
    for (const message of state.messages.slice(-20).reverse()) rows.push(`  ${message.readAt ? dim : yellow}${names.get(message.from) || message.from} → ${names.get(message.to) || message.to}${reset}  ${truncate(message.body.replace(/\s+/g, ' '), 75)}`, `      ${dim}${message.createdAt}${message.readAt ? '  read' : '  unread'}${reset}`);
    return rows;
  }

  private renderExtensions(state: ReturnType<LiteRuntime['store']['snapshot']>): string[] {
    const rows = [`${bold}Extensions${reset}`, `  ${dim}21 builtins are available behind the three-tool facade.${reset}`];
    if (!state.extensions.length) rows.push(`${dim}No custom extensions. Press e to register one declaratively.${reset}`);
    for (const extension of state.extensions) rows.push(`  ${cyan}${extension.name}${reset}  ${truncate(extension.title, 28)}  ${dim}${extension.handler.kind}${reset}`, `      ${truncate(extension.description, 90)}`);
    return rows;
  }

  private renderSettings(): string[] {
    const config = this.runtime.config;
    return [
      `${bold}Runtime settings${reset}`,
      `  Settings file       ${config.settingsPath}`,
      `  Workspace           ${config.workspaceDir}`,
      `  Listen address      ${config.host}:${this.runtime.port}`,
      `  Public base URL     ${config.publicBaseUrl}`,
      `  Max output chars    ${config.maxOutputChars}`,
      `  Command timeout     ${config.commandTimeoutSec}s`,
      '',
      `${bold}Connection credentials${reset}`,
      `  Apps connector key  ${this.revealCredentials ? config.connectorKey : maskCredential(config.connectorKey)}`,
      `  Actions token       ${this.revealCredentials ? config.actionsToken : maskCredential(config.actionsToken)}`,
      '',
      `${dim}c edits and applies settings immediately. v reveals credentials. k rotates both credentials.${reset}`,
      `${yellow}Rotating credentials invalidates existing Apps and Actions connections.${reset}`,
    ];
  }

  private renderLogs(): string[] {
    const rows = [`${bold}Runtime logs${reset}`];
    for (const entry of this.runtime.logs.slice(-25).reverse()) rows.push(`  ${entry.level === 'error' ? red : dim}${entry.at} ${entry.level.toUpperCase()}${reset} ${truncate(entry.message, 90)}`);
    return rows;
  }

  private async ask(questions: Array<{ label: string; fallback?: string }>): Promise<string[]> {
    this.prompting = true;
    stdin.off('keypress', this.onKeypress);
    stdin.setRawMode(false);
    stdout.write(`${ESC}?25h${clear}${bold}${cyan}LocalTerminal Lite · Input${reset}\n${line()}\n\n`);
    const rl = createInterface({ input: stdin, output: stdout });
    const answers: string[] = [];
    try {
      for (const question of questions) {
        const answer = await rl.question(`${question.label}${question.fallback ? ` [${question.fallback}]` : ''}: `);
        answers.push(answer.trim() || question.fallback || '');
      }
    } finally {
      rl.close();
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', this.onKeypress);
      stdout.write(`${ESC}?25l${clear}`);
      this.prompting = false;
    }
    return answers;
  }

  private async promptNewSession(): Promise<void> {
    const [name, role] = await this.ask([{ label: 'Session name' }, { label: 'Role', fallback: 'developer' }]);
    if (name) this.runtime.store.registerSession({ name, role });
  }

  private async promptSessionUpdate(): Promise<void> {
    const [session, status, note] = await this.ask([{ label: 'Session name or id' }, { label: 'Status active|idle|blocked|completed', fallback: 'active' }, { label: 'Note', fallback: '' }]);
    if (session) this.runtime.store.updateSession(session, { status: status as SessionStatus, note });
  }

  private async promptMessage(): Promise<void> {
    const sessions = this.runtime.store.listSessions();
    const [from, to, body] = await this.ask([{ label: 'From session', fallback: sessions[0]?.name }, { label: 'To session', fallback: sessions[1]?.name }, { label: 'Message' }]);
    if (from && to && body) this.runtime.store.sendMessage(from, to, body);
  }

  private async promptExtension(): Promise<void> {
    const [name, title, description, kind] = await this.ask([
      { label: 'Extension name (lower_snake_case)' },
      { label: 'Title' },
      { label: 'Description' },
      { label: 'Handler kind builtin|command', fallback: 'builtin' },
    ]);
    if (!name) return;
    const base = {
      name,
      title: title || name,
      description: description || 'Custom declarative extension registered from the Lite terminal UI.',
    };
    let spec: CustomExtensionSpec;
    if (kind === 'command') {
      const [executable, argsJson, schemaJson, readOnlyAnswer] = await this.ask([
        { label: 'Executable' },
        { label: 'Argument templates JSON array', fallback: '[]' },
        { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}' },
        { label: 'Read-only yes|no', fallback: 'no' },
      ]);
      spec = {
        ...base,
        inputSchema: JSON.parse(schemaJson),
        annotations: { readOnlyHint: readOnlyAnswer === 'yes', destructiveHint: readOnlyAnswer !== 'yes', openWorldHint: true, idempotentHint: readOnlyAnswer === 'yes' },
        handler: { kind: 'command', executable, args: JSON.parse(argsJson) },
      };
    } else {
      const [target, schemaJson] = await this.ask([
        { label: 'Builtin target', fallback: 'run_checks' },
        { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}' },
      ]);
      spec = {
        ...base,
        inputSchema: JSON.parse(schemaJson),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
        handler: { kind: 'builtin', target },
      };
    }
    const result = await this.runtime.extensions.register({ action: 'upsert', spec });
    this.runtime.log(result.ok ? `Registered extension ${name}` : result.error?.message || 'Extension registration failed', result.ok ? 'info' : 'error');
  }

  private async promptExtensionRemove(): Promise<void> {
    const [name] = await this.ask([{ label: 'Custom extension name to remove' }]);
    if (!name) return;
    const result = await this.runtime.extensions.register({ action: 'remove', name });
    this.runtime.log(result.ok ? `Removed extension ${name}` : result.error?.message || 'Extension removal failed', result.ok ? 'info' : 'error');
  }

  private async promptSettings(): Promise<void> {
    const current = readLiteSettings() || {
      schemaVersion: 1 as const,
      workspaceDir: this.runtime.config.workspaceDir,
      host: this.runtime.config.host,
      port: this.runtime.config.port,
      connectorKey: this.runtime.config.connectorKey,
      actionsToken: this.runtime.config.actionsToken,
      publicBaseUrl: '',
      maxOutputChars: this.runtime.config.maxOutputChars,
      commandTimeoutSec: this.runtime.config.commandTimeoutSec,
    };
    const [workspace, host, port, publicUrl, maxOutput, timeout] = await this.ask([
      { label: 'Workspace directory', fallback: current.workspaceDir },
      { label: 'Listen host', fallback: current.host },
      { label: 'Listen port', fallback: String(current.port) },
      { label: 'Public HTTPS URL (enter "local" to clear)', fallback: current.publicBaseUrl || 'local' },
      { label: 'Maximum output characters', fallback: String(current.maxOutputChars) },
      { label: 'Command timeout seconds', fallback: String(current.commandTimeoutSec) },
    ]);
    const next: LiteSettings = {
      ...current,
      workspaceDir: path.resolve(workspace),
      host,
      port: integer(port, current.port),
      publicBaseUrl: publicUrl.toLowerCase() === 'local' ? '' : publicUrl.replace(/\/$/, ''),
      maxOutputChars: integer(maxOutput, current.maxOutputChars),
      commandTimeoutSec: integer(timeout, current.commandTimeoutSec),
    };
    const errors = validateSettings(next);
    if (errors.length) {
      this.runtime.log(errors.join(' '), 'error');
      return;
    }
    const result = await this.reconfigure(next);
    this.runtime = result.runtime;
    this.runtime.log(result.error || 'Runtime settings applied from TUI.', result.error ? 'error' : 'info');
  }

  private async promptCredentialRotation(): Promise<void> {
    const [answer] = await this.ask([{ label: 'Rotate Apps and Actions credentials? yes|no', fallback: 'no' }]);
    if (answer.toLowerCase() !== 'yes') return;
    const current = readLiteSettings();
    if (!current) {
      this.runtime.log('Persistent settings are not available.', 'error');
      return;
    }
    const result = await this.reconfigure(rotateLiteCredentials(current));
    this.runtime = result.runtime;
    this.revealCredentials = true;
    this.runtime.log(result.error || 'Connection credentials rotated. Update Apps and Actions connections.', result.error ? 'error' : 'info');
  }

  private async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    stdin.off('keypress', this.onKeypress);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(`${ESC}?25h${ESC}?1049l`);
    await this.runtime.close();
  }
}
