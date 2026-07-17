import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { CustomExtensionSpec, SessionStatus } from './types.js';
import type { LiteRuntime } from './server.js';
import { maskCredential } from './config.js';

const ESC = '\u001b[';
const clear = `${ESC}2J${ESC}H`;
const dim = `${ESC}2m`;
const bold = `${ESC}1m`;
const cyan = `${ESC}36m`;
const green = `${ESC}32m`;
const yellow = `${ESC}33m`;
const red = `${ESC}31m`;
const reset = `${ESC}0m`;

type Tab = 'Overview' | 'Sessions' | 'Messages' | 'Extensions' | 'Logs';
const TABS: Tab[] = ['Overview', 'Sessions', 'Messages', 'Extensions', 'Logs'];

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function line(char = '─'): string {
  return char.repeat(Math.max(20, Math.min(120, stdout.columns || 100)));
}

export class LiteTui {
  private tab = 0;
  private timer?: NodeJS.Timeout;
  private prompting = false;
  private stopped = false;

  constructor(private readonly runtime: LiteRuntime) {}

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
      if (key.name && /^[1-5]$/.test(key.name)) this.tab = Number(key.name) - 1;
      else if (key.name === 'tab' || key.name === 'right') this.tab = (this.tab + 1) % TABS.length;
      else if (key.name === 'left') this.tab = (this.tab + TABS.length - 1) % TABS.length;
      else if (key.name === 'n') await this.promptNewSession();
      else if (key.name === 'm') await this.promptMessage();
      else if (key.name === 'u') await this.promptSessionUpdate();
      else if (key.name === 'e') await this.promptExtension();
      else if (key.name === 'x') await this.promptExtensionRemove();
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
    if (this.tab === 4) output.push(...this.renderLogs());
    output.push(line(), `${dim}Keys: 1-5/tab switch  n new session  u update  m message  e register extension  x remove  q quit${reset}`);
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

  private renderLogs(): string[] {
    const rows = [`${bold}Runtime logs${reset}`];
    for (const entry of this.runtime.logs.slice(-25).reverse()) rows.push(`  ${entry.level === 'error' ? red : dim}${entry.at} ${entry.level.toUpperCase()}${reset} ${truncate(entry.message, 90)}`);
    return rows;
  }

  private async ask(questions: Array<{ label: string; fallback?: string }>): Promise<string[]> {
    this.prompting = true;
    stdin.off('keypress', this.onKeypress);
    stdin.setRawMode(false);
    stdout.write(`${ESC}?25h${ESC}?1049l\n`);
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
      stdin.on('keypress', this.onKeypress);
      stdout.write(`${ESC}?1049h${ESC}?25l`);
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
