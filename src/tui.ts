import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CustomExtensionSpec, LiteSession, LiteSettings, TaskPackage } from './types.js';
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
  private readonly handoffs = new Map<string, string>();
  private readonly remindedAt = new Map<string, { bell: number; notification: number }>();

  constructor(private runtime: LiteRuntime, private readonly reconfigure: RuntimeReconfigure) {}

  async run(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive TUI requires a TTY. Use --headless for service mode.');
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(`${ESC}?1049h${ESC}?25l`);
    stdin.on('keypress', this.onKeypress);
    this.timer = setInterval(() => { this.tickReminders(); if (!this.prompting) this.render(); }, 1000);
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
      else if (key.name === 'u') await this.promptSessionAction();
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
    const pending = state.sessions.filter((session) => !['completed', 'cancelled'].includes(session.phase) && session.presence !== 'claimed');
    const output: string[] = [
      clear,
      `${bold}${cyan}LocalTerminal Lite${reset}  ${green}● running${reset}  ${dim}v0.2.0${reset}`,
      ...(pending.length ? [`${red}${bold} ATTENTION: ${pending.length} session(s) need a ChatGPT controller — press u to copy/reissue/cancel ${reset}`] : []),
      tabs,
      line(),
    ];
    if (this.tab === 0) output.push(...this.renderOverview(state));
    if (this.tab === 1) output.push(...this.renderSessions(state));
    if (this.tab === 2) output.push(...this.renderMessages(state));
    if (this.tab === 3) output.push(...this.renderExtensions(state));
    if (this.tab === 4) output.push(...this.renderSettings());
    if (this.tab === 5) output.push(...this.renderLogs());
    output.push(line(), `${dim}Keys: 1-6/tab switch  n create/delegate  u session actions  m message  e extension  x remove  c configure  v credentials  k rotate  q quit${reset}`);
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
      `  Unacknowledged events ${state.events.filter((event) => !event.acknowledgedAt).length}`,
      `  Custom extensions     ${state.extensions.length}`,
      `  Persistent revision   ${state.revision}`,
      '',
      `${yellow}ChatGPT sees only 3 tools:${reset} extension_discover, extension_register, extension_call`,
    ];
  }

  private renderSessions(state: ReturnType<LiteRuntime['store']['snapshot']>): string[] {
    const rows = [`${bold}Sessions${reset}`];
    if (!state.sessions.length) rows.push(`${dim}No sessions. A model can bootstrap a root, or press n to prepare one from TUI.${reset}`);
    const roots = state.sessions.filter((session) => !session.parentSessionId);
    for (const root of roots.slice(-20)) {
      rows.push(...this.sessionRows(root, '', state.sessions));
      for (const child of state.sessions.filter((session) => session.parentSessionId === root.id)) rows.push(...this.sessionRows(child, '  └─ ', state.sessions));
    }
    return rows;
  }

  private sessionRows(session: LiteSession, prefix: string, sessions: LiteSession[]): string[] {
    const predecessor = session.continuesSessionId ? sessions.find((item) => item.id === session.continuesSessionId) : undefined;
    const relation = session.continuesSessionId ? `  ← ${predecessor?.name || (session.predecessorDeleted ? 'deleted predecessor' : session.continuesSessionId)}` : '';
    const controllerAge = session.controller ? `${Math.max(0, Math.floor((Date.now() - Date.parse(session.controller.claimedAt)) / 60_000))}m` : '-';
    const checkpoint = session.checkpointStartedAt ? `${Math.floor((Date.now() - Date.parse(session.checkpointStartedAt)) / 60_000)}m` : '-';
    const pendingEvents = this.runtime.store.snapshot().events.filter((event) => event.recipientSessionId === session.id && !event.acknowledgedAt).length;
    const color = session.phase === 'completed' ? green : session.phase === 'blocked' || session.phase === 'pending' ? red : yellow;
    return [
      `${prefix}${color}${session.phase.padEnd(10)}${reset} ${session.presence.padEnd(9)} ${truncate(session.name, 20).padEnd(21)} ${dim}${session.id}${reset}${relation}`,
      `${prefix}   ${dim}role=${truncate(session.role, 14)} control=${controllerAge} checkpoint=${checkpoint} events=${pendingEvents}${reset}`,
      ...(session.latestCheckpoint ? [`${prefix}   ${dim}${truncate(session.latestCheckpoint.summary.replace(/\s+/g, ' '), 84)}${reset}`] : []),
    ];
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
    const roots = this.runtime.store.listSessions().filter((session) => !session.parentSessionId && !['completed', 'cancelled'].includes(session.phase));
    const [mode] = await this.ask([{ label: 'Create root or child', fallback: roots.length ? 'child' : 'root' }]);
    if (mode === 'root') {
      const [name, role] = await this.ask([{ label: 'Root session name' }, { label: 'Role', fallback: 'lead' }]);
      if (!name) return;
      const created = this.runtime.store.createTuiRoot({ name, role });
      await this.rememberAndCopy(created.session.id, created.handoffPrompt);
      this.runtime.log(`Prepared root session ${name}; handoff prompt copied.`);
      return;
    }
    const [rootId, name, role, objective, background, deliverables, criteria, constraints] = await this.ask([
      { label: 'Root session name or id', fallback: roots[0]?.id }, { label: 'Child session name' }, { label: 'Role', fallback: 'developer' },
      { label: 'Objective' }, { label: 'Background' }, { label: 'Deliverables (semicolon separated)' },
      { label: 'Acceptance criteria (semicolon separated)' }, { label: 'Constraints (semicolon separated)', fallback: 'Stay within the assigned scope' },
    ]);
    if (!rootId || !name) return;
    const split = (value: string) => value.split(';').map((item) => item.trim()).filter(Boolean);
    const task: TaskPackage = { objective, background, deliverables: split(deliverables), acceptanceCriteria: split(criteria), constraints: split(constraints) };
    const result = this.runtime.store.createTuiDelegate(rootId, { name, role, task });
    await this.rememberAndCopy(result.session.id, result.handoffPrompt);
    this.runtime.log(`Created child ${name}; handoff prompt copied. Reminders stay active until claimed or cancelled.`);
  }

  private async promptSessionAction(): Promise<void> {
    const sessions = this.runtime.store.listSessions();
    const [sessionId, action] = await this.ask([
      { label: 'Session name or id', fallback: sessions.find((item) => !['completed', 'cancelled'].includes(item.phase) && item.presence !== 'claimed')?.id || sessions[0]?.id },
      { label: 'Action copy|revoke|cancel|delete|context', fallback: 'copy' },
    ]);
    if (!sessionId) return;
    const session = this.runtime.store.session(sessionId);
    if (action === 'copy') {
      let prompt = this.handoffs.get(session.id);
      if (!prompt) {
        const issued = this.runtime.store.revokeFromTui(session.id);
        prompt = issued.handoffPrompt;
      }
      await this.rememberAndCopy(session.id, prompt);
      this.runtime.log(`Handoff prompt copied for ${session.name}.`);
    } else if (action === 'revoke') {
      const result = this.runtime.store.revokeFromTui(session.id);
      await this.rememberAndCopy(session.id, result.handoffPrompt);
      this.runtime.log(`Controller revoked and a new claim code issued for ${session.name}.`);
    } else if (action === 'cancel') {
      this.runtime.store.cancelFromTui(session.id); this.handoffs.delete(session.id); this.remindedAt.delete(session.id);
      this.runtime.log(`Cancelled session ${session.name}.`);
    } else if (action === 'delete') {
      const [confirmation] = await this.ask([{ label: `Confirmation (type DELETE ${session.id})` }]);
      const result = this.runtime.store.deleteFromTui(session.id, confirmation);
      this.runtime.log(`Deleted ${result.deleted.length} session record(s) and histories.`);
    } else if (action === 'context') {
      this.runtime.log(`Context ${session.name}: ${JSON.stringify(this.runtime.store.context(session.id))}`);
    }
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
    const result = await this.runtime.extensions.registerFromTui({ action: 'upsert', spec });
    this.runtime.log(result.ok ? `Registered extension ${name}` : result.error?.message || 'Extension registration failed', result.ok ? 'info' : 'error');
  }

  private async promptExtensionRemove(): Promise<void> {
    const [name] = await this.ask([{ label: 'Custom extension name to remove' }]);
    if (!name) return;
    const result = await this.runtime.extensions.registerFromTui({ action: 'remove', name });
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

  private tickReminders(): void {
    this.runtime.store.refreshTemporalStates();
    const now = Date.now();
    const pending = this.runtime.store.pendingUnclaimed();
    const pendingIds = new Set(pending.map((session) => session.id));
    for (const id of this.remindedAt.keys()) if (!pendingIds.has(id)) { this.remindedAt.delete(id); this.handoffs.delete(id); }
    for (const session of pending) {
      if (!this.handoffs.has(session.id)) {
        const prompt = this.runtime.store.handoffForTui(session.id);
        if (prompt) void this.rememberAndCopy(session.id, prompt);
      }
      const times = this.remindedAt.get(session.id) || { bell: now, notification: now };
      if (now - times.bell >= 60_000) { stdout.write('\u0007'); times.bell = now; }
      if (now - times.notification >= 5 * 60_000) {
        this.notifySystem('LocalTerminal Lite', `${session.name} is still waiting for a ChatGPT session to inherit it.`);
        times.notification = now;
      }
      this.remindedAt.set(session.id, times);
    }
  }

  private async rememberAndCopy(sessionId: string, prompt: string): Promise<void> {
    this.handoffs.set(sessionId, prompt);
    this.remindedAt.set(sessionId, { bell: Date.now(), notification: Date.now() });
    const copied = await this.copyToClipboard(prompt);
    if (!copied) this.runtime.log(`Clipboard integration unavailable. Handoff: ${prompt}`, 'error');
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    const commands = process.platform === 'darwin'
      ? [['pbcopy', []] as const]
      : process.platform === 'win32'
        ? [['clip', []] as const]
        : [['wl-copy', []] as const, ['xclip', ['-selection', 'clipboard']] as const];
    for (const [command, args] of commands) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
        child.once('error', () => resolve(false)); child.once('close', (code) => resolve(code === 0));
        child.stdin.end(text);
      });
      if (ok) return true;
    }
    return false;
  }

  private notifySystem(title: string, message: string): void {
    if (process.platform === 'darwin') {
      const escapedTitle = title.replace(/["\\]/g, ''); const escapedMessage = message.replace(/["\\]/g, '');
      spawn('osascript', ['-e', `display notification "${escapedMessage}" with title "${escapedTitle}"`], { stdio: 'ignore', shell: false }).on('error', () => undefined);
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, message], { stdio: 'ignore', shell: false }).on('error', () => undefined);
    } else if (process.platform === 'win32') {
      spawn('msg.exe', ['*', `${title}: ${message}`], { stdio: 'ignore', shell: false }).on('error', () => undefined);
    }
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
