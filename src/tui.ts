import { spawn } from 'node:child_process';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { WorkspaceDiffTracker } from './diff.js';
import { conversationGroups, logicalSessionGroups } from './tui-model.js';
import { mouseWheelDelta, wrapTerminalLine, wrapTerminalLines } from './tui-layout.js';
import type { CustomExtensionSpec, LiteSession, LiteSettings, SessionPhase, TaskPackage } from './types.js';
import type { LiteRuntime } from './server.js';
import { maskCredential, readLiteSettings, rotateLiteCredentials, validateSettings } from './config.js';

const ESC = '\u001b[';
const clear = `${ESC}2J${ESC}H`;
const reset = `${ESC}0m`;
const bold = `${ESC}1m`;
const inverse = `${ESC}7m`;
const noWrap = `${ESC}?7l`;
const wrap = `${ESC}?7h`;
const mouseOn = `${ESC}?1000h${ESC}?1006h`;
const mouseOff = `${ESC}?1000l${ESC}?1006l`;

type Tab = 'Overview' | 'Sessions' | 'Messages' | 'Diff' | 'Extensions' | 'Settings' | 'Logs';
const TABS: Tab[] = ['Overview', 'Sessions', 'Messages', 'Diff', 'Extensions', 'Settings', 'Logs'];
type Detail = { kind: 'session'; id: string } | { kind: 'conversation'; id: string };

export type RuntimeReconfigureResult = { runtime: LiteRuntime; error?: string };
export type RuntimeReconfigure = (settings: LiteSettings) => Promise<RuntimeReconfigureResult>;

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? parsed : fallback;
}

function fit(value: string, width: number): string {
  return wrapTerminalLine(value, width)[0] || '';
}

export async function runSetupTui(defaults: LiteSettings): Promise<LiteSettings> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('First launch requires the TUI. Run `npm run dev` in an interactive terminal.');
  stdout.write(`${ESC}?1049h${noWrap}${ESC}?25h${clear}`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    let feedback = '';
    while (true) {
      stdout.write(`${clear}${bold}LocalTerminal Lite · 首次设置 / First-run setup${reset}\n${'─'.repeat(Math.max(40, stdout.columns || 80))}\n`);
      if (feedback) stdout.write(`\u001b[31m${feedback}${reset}\n`);
      const language = (await rl.question(`界面语言 / UI language zh-CN|en [${defaults.uiLanguage}]: `)).trim() || defaults.uiLanguage;
      const theme = (await rl.question(`界面主题 / UI theme dark|light [${defaults.uiTheme}]: `)).trim() || defaults.uiTheme;
      const workspace = (await rl.question(`工作区 / Workspace [${defaults.workspaceDir}]: `)).trim() || defaults.workspaceDir;
      const host = (await rl.question(`监听地址 / Host [${defaults.host}]: `)).trim() || defaults.host;
      const portAnswer = (await rl.question(`端口 / Port [${defaults.port}]: `)).trim();
      const publicUrl = (await rl.question('公网 HTTPS URL / Public URL (optional): ')).trim();
      const outputAnswer = (await rl.question(`最大输出字符 / Max output [${defaults.maxOutputChars}]: `)).trim();
      const timeoutAnswer = (await rl.question(`命令超时秒数 / Timeout [${defaults.commandTimeoutSec}]: `)).trim();
      const candidate: LiteSettings = { ...defaults, uiLanguage: language as LiteSettings['uiLanguage'], uiTheme: theme as LiteSettings['uiTheme'], workspaceDir: path.resolve(workspace), host, port: integer(portAnswer, defaults.port), publicBaseUrl: publicUrl.replace(/\/$/, ''), maxOutputChars: integer(outputAnswer, defaults.maxOutputChars), commandTimeoutSec: integer(timeoutAnswer, defaults.commandTimeoutSec) };
      const errors = validateSettings(candidate); if (errors.length) { feedback = errors.join(' '); continue; }
      const confirm = (await rl.question('\n保存并启动 / Save and start? [Y/n]: ')).trim().toLowerCase();
      if (!confirm || confirm === 'y' || confirm === 'yes') return candidate;
    }
  } finally { rl.close(); stdout.write(`${wrap}${ESC}?25h${ESC}?1049l`); }
}

export class LiteTui {
  private tab = 0;
  private timer?: NodeJS.Timeout;
  private prompting = false;
  private stopped = false;
  private revealCredentials = false;
  private showAuditFacts = false;
  private suppressMouseKeypress = false;
  private detail?: Detail;
  private readonly selected = Array(TABS.length).fill(0) as number[];
  private readonly scroll = Array(TABS.length).fill(0) as number[];
  private readonly handoffs = new Map<string, string>();
  private readonly remindedAt = new Map<string, { bell: number; notification: number }>();
  private diff: WorkspaceDiffTracker;

  constructor(private runtime: LiteRuntime, private readonly reconfigure: RuntimeReconfigure) { this.diff = new WorkspaceDiffTracker(runtime.config); }

  private get zh(): boolean { return this.runtime.config.uiLanguage === 'zh-CN'; }
  private text(en: string, zh: string): string { return this.zh ? zh : en; }
  private get colors() {
    return this.runtime.config.uiTheme === 'light'
      ? { accent: '\u001b[34m', good: '\u001b[32m', warn: '\u001b[35m', bad: '\u001b[31m', muted: '\u001b[90m', selected: '\u001b[48;5;153m\u001b[30m' }
      : { accent: '\u001b[36m', good: '\u001b[32m', warn: '\u001b[33m', bad: '\u001b[31m', muted: '\u001b[90m', selected: '\u001b[48;5;24m\u001b[97m' };
  }

  async run(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive TUI requires a TTY. Use --headless for service mode.');
    emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
    stdout.write(`${ESC}?1049h${noWrap}${mouseOn}${ESC}?25l${clear}`); stdin.on('keypress', this.onKeypress); stdin.prependListener('data', this.onRawInput); this.diff.start();
    this.timer = setInterval(() => { this.tickReminders(); if (!this.prompting) this.render(); }, 500); this.render();
    await new Promise<void>((resolve) => { const poll = setInterval(() => { if (this.stopped) { clearInterval(poll); resolve(); } }, 50); });
  }

  private readonly onKeypress = async (_text: string, key: { name?: string; ctrl?: boolean }): Promise<void> => {
    if (this.prompting || this.suppressMouseKeypress) return;
    try {
      if ((key.ctrl && key.name === 'c') || key.name === 'q') { await this.shutdown(); return; }
      if (key.name === 'escape' && this.detail) { this.detail = undefined; this.scroll[this.tab] = 0; }
      else if (key.name && /^[1-7]$/.test(key.name)) { this.detail = undefined; this.tab = Number(key.name) - 1; }
      else if (!this.detail && (key.name === 'tab' || key.name === 'right')) this.tab = (this.tab + 1) % TABS.length;
      else if (!this.detail && key.name === 'left') this.tab = (this.tab + TABS.length - 1) % TABS.length;
      else if (key.name === 'up' || (key.name === 'k' && (Boolean(this.detail) || this.tab === 3 || this.tab === 6))) this.move(-1);
      else if (key.name === 'down' || (key.name === 'j' && (Boolean(this.detail) || this.tab === 3 || this.tab === 6))) this.move(1);
      else if (key.name === 'pageup') this.move(-Math.max(5, (stdout.rows || 30) - 8));
      else if (key.name === 'pagedown') this.move(Math.max(5, (stdout.rows || 30) - 8));
      else if (key.name === 'return') this.openFocused();
      else if (key.name === 'n' && this.tab === 1) await this.promptNewSession();
      else if (key.name === 'u' && this.tab === 1) await this.promptSessionAction();
      else if (key.name === 'm' && this.tab === 2) await this.promptMessage();
      else if (key.name === 'r' && this.tab === 3) await this.diff.refresh();
      else if (key.name === 'e' && this.tab === 4) await this.promptExtension();
      else if (key.name === 'x' && this.tab === 4) await this.promptExtensionRemove();
      else if (key.name === 'c' && (this.tab === 0 || this.tab === 5)) await this.promptSettings();
      else if (key.name === 'k' && this.tab === 5) await this.promptCredentialRotation();
      else if (key.name === 'v' && (this.tab === 0 || this.tab === 5)) this.revealCredentials = !this.revealCredentials;
      else if (key.name === 'a' && this.tab === 6) { this.showAuditFacts = !this.showAuditFacts; this.scroll[this.tab] = 0; }
    } catch (error) { this.runtime.log(error instanceof Error ? error.message : String(error), 'error'); }
    this.render();
  };

  private readonly onRawInput = (chunk: Buffer | string): void => {
    if (this.prompting) return;
    const delta = mouseWheelDelta(chunk.toString());
    if (!delta) return;
    this.suppressMouseKeypress = true;
    queueMicrotask(() => { this.suppressMouseKeypress = false; });
    this.move(this.detail || [0, 3, 5, 6].includes(this.tab) ? delta : Math.sign(delta));
    this.render();
  };

  private move(delta: number): void {
    if (this.detail || [0, 3, 5, 6].includes(this.tab)) { this.scroll[this.tab] = Math.max(0, this.scroll[this.tab] + delta); return; }
    const count = this.tab === 1 ? logicalSessionGroups(this.runtime.store.listSessions()).length
      : this.tab === 2 ? conversationGroups(this.runtime.store.snapshot().messages).length
        : this.tab === 4 ? this.runtime.store.snapshot().extensions.length : 0;
    this.selected[this.tab] = Math.max(0, Math.min(Math.max(0, count - 1), this.selected[this.tab] + delta));
  }

  private openFocused(): void {
    if (this.detail) return;
    if (this.tab === 1) { const group = logicalSessionGroups(this.runtime.store.listSessions())[this.selected[this.tab]]; if (group) { this.detail = { kind: 'session', id: group.id }; this.scroll[this.tab] = 0; } }
    if (this.tab === 2) { const group = conversationGroups(this.runtime.store.snapshot().messages)[this.selected[this.tab]]; if (group) { this.detail = { kind: 'conversation', id: group.id }; this.scroll[this.tab] = Number.MAX_SAFE_INTEGER; } }
  }

  private render(): void {
    const width = Math.max(40, stdout.columns || 100); const height = Math.max(12, stdout.rows || 35); const c = this.colors;
    const state = this.runtime.store.snapshot(); const attention = state.sessions.filter((session) => !['completed', 'cancelled'].includes(session.phase) && session.presence !== 'claimed');
    const tabNames = this.zh ? ['概览', '会话', '消息', '差异', '扩展', '设置', '日志'] : TABS;
    const tabs = tabNames.map((name, index) => index === this.tab ? `${c.selected}${bold} ${index + 1} ${name} ${reset}` : `${c.muted} ${index + 1} ${name} ${reset}`).join(' ');
    const header = [
      ...wrapTerminalLine(`${bold}${c.accent}LocalTerminal Lite${reset}  ${c.good}● ${this.text('running', '运行中')}${reset}  ${c.muted}v0.4.0${reset}`, width),
      ...(attention.length ? wrapTerminalLine(`${c.bad}${bold} ! ${attention.length} ${this.text('session(s) need a controller', '个 session 等待接管')} ${reset}`, width) : []),
      ...wrapTerminalLine(tabs, width), '─'.repeat(width),
    ];
    const footerHints = wrapTerminalLine(` ${this.keyHints()} `, width);
    const footer = ['─'.repeat(width), ...footerHints.map((line) => `${inverse}${bold}${line}${reset}`)];
    const contentHeight = Math.max(1, height - header.length - footer.length);
    let content: string[];
    if (this.detail?.kind === 'session') content = this.renderSessionDetail(this.detail.id, contentHeight, width);
    else if (this.detail?.kind === 'conversation') content = this.renderConversationDetail(this.detail.id, contentHeight, width);
    else if (this.tab === 0) content = this.scrolled(this.renderOverview(state), contentHeight, width);
    else if (this.tab === 1) content = this.renderSessions(state, contentHeight, width);
    else if (this.tab === 2) content = this.renderMessages(state, contentHeight, width);
    else if (this.tab === 3) content = this.renderDiff(contentHeight, width);
    else if (this.tab === 4) content = this.renderExtensions(state, contentHeight, width);
    else if (this.tab === 5) content = this.scrolled(this.renderSettings(), contentHeight, width);
    else content = this.renderLogs(contentHeight, width);
    const rows = [...header, ...content.slice(0, contentHeight), ...Array(Math.max(0, contentHeight - content.length)).fill(''), ...footer].slice(0, height);
    stdout.write(`${clear}${rows.map((row) => fit(row, width)).join('\n')}`);
  }

  private keyHints(): string {
    if (this.detail) return this.text('↑↓/wheel scroll  PgUp/PgDn page  Esc back  q quit', '↑↓/滚轮 滚动  PgUp/PgDn 翻页  Esc 返回  q 退出');
    const common = this.text('1-7/Tab page', '1-7/Tab 页面');
    if (this.tab === 0) return `${common}  ↑↓/${this.text('wheel scroll', '滚轮 滚动')}  c ${this.text('configure', '配置')}  v ${this.text('credentials', '凭据')}  q ${this.text('quit', '退出')}`;
    if (this.tab === 1) return `↑↓/${this.text('wheel focus', '滚轮 选择')}  Enter ${this.text('open', '打开')}  n ${this.text('new/delegate', '新建/委派')}  u ${this.text('actions', '操作')}  q ${this.text('quit', '退出')}`;
    if (this.tab === 2) return `↑↓/${this.text('wheel focus', '滚轮 选择')}  Enter ${this.text('conversation', '完整对话')}  m ${this.text('send', '发送')}  q ${this.text('quit', '退出')}`;
    if (this.tab === 3) return `↑↓/${this.text('wheel scroll', '滚轮 滚动')}  PgUp/PgDn ${this.text('page', '翻页')}  r ${this.text('refresh', '刷新')}  q ${this.text('quit', '退出')}`;
    if (this.tab === 4) return `↑↓/${this.text('wheel focus', '滚轮 选择')}  e ${this.text('add', '新增')}  x ${this.text('remove', '删除')}  q ${this.text('quit', '退出')}`;
    if (this.tab === 5) return `↑↓/${this.text('wheel scroll', '滚轮 滚动')}  c ${this.text('configure', '修改配置')}  v ${this.text('reveal', '显示凭据')}  k ${this.text('rotate', '轮换凭据')}  q ${this.text('quit', '退出')}`;
    return `↑↓/${this.text('wheel scroll', '滚轮 滚动')}  a ${this.text('audit facts on/off', '事实调用 开/关')}  q ${this.text('quit', '退出')}`;
  }

  private renderOverview(state: ReturnType<LiteRuntime['store']['snapshot']>): string[] {
    const hiddenAppsUrl = this.revealCredentials ? this.runtime.appsUrl : this.runtime.appsUrl.replace(this.runtime.config.connectorKey, '••••••••');
    return [
      `${bold}${this.text('Server', '服务')}${reset}`, `  ${this.text('Bind', '监听')}             ${this.runtime.config.host}:${this.runtime.port}`,
      `  ${this.text('Workspace', '工作区')}        ${this.runtime.config.workspaceDir}`, `  Apps MCP URL     ${hiddenAppsUrl}`,
      `  Actions OpenAPI  ${this.runtime.openApiUrl}`, `  Actions token    ${this.revealCredentials ? this.runtime.config.actionsToken : maskCredential(this.runtime.config.actionsToken)}`, '',
      `${bold}${this.text('Live state', '实时状态')}${reset}`, `  ${this.text('Logical sessions', '逻辑会话')}       ${logicalSessionGroups(state.sessions).length}`,
      `  ${this.text('Work records', '工作记录')}       ${state.sessions.length}`, `  MCP transports  ${this.runtime.activeMcpSessions()}`,
      `  ${this.text('Messages', '消息')}           ${state.messages.length}`, `  ${this.text('Unacked events', '未确认事件')}     ${state.events.filter((event) => !event.acknowledgedAt).length}`,
      '', `${this.colors.warn}${this.text('Only three facade tools are model-visible.', '模型侧始终只暴露三个 facade 工具。')}${reset}`,
    ];
  }

  private phaseColor(phase: SessionPhase): string {
    if (phase === 'completed') return this.colors.good;
    if (phase === 'working') return this.colors.accent;
    if (phase === 'blocked' || phase === 'cancelled') return this.colors.bad;
    return this.colors.warn;
  }

  private status(session: LiteSession): string {
    const presenceColor = session.presence === 'claimed' ? this.colors.good : session.presence === 'stale' ? this.colors.bad : this.colors.warn;
    return `${this.phaseColor(session.phase)}● ${session.phase}${reset}  ${presenceColor}○ ${session.presence}${reset}`;
  }

  private renderSessions(state: ReturnType<LiteRuntime['store']['snapshot']>, height: number, width: number): string[] {
    const groups = logicalSessionGroups(state.sessions); if (!groups.length) return [this.text('No sessions. Press n to create one.', '暂无 session，按 n 新建。')];
    this.selected[this.tab] = Math.max(0, Math.min(groups.length - 1, this.selected[this.tab]));
    const cards = groups.map((group, index) => {
      const current = group.current; const selected = index === this.selected[this.tab]; const summary = current.latestCheckpoint?.summary || current.finalSummary || this.text('No checkpoint summary yet.', '暂无 checkpoint 总结。');
      const lines = [`${selected ? `${this.colors.selected}> ◆ ${group.title} ${reset}` : `  ${this.colors.accent}◆${reset} ${bold}${group.title}${reset}`}`,
        `    ├─ ${this.text('status', '状态')}  ${this.status(current)}`,
        `    ├─ ${this.text('work records', '工作记录')}  ${group.sessions.length}`];
      for (const [recordIndex, session] of group.sessions.entries()) {
        const last = recordIndex === group.sessions.length - 1;
        lines.push(`    │  ${last ? '└─' : '├─'} ${session.name}  ${this.status(session)}`);
      }
      lines.push(`    ├─ ${this.text('child sessions', '子会话')}  ${group.children.length}`);
      for (const [childIndex, child] of group.children.entries()) {
        const last = childIndex === group.children.length - 1;
        lines.push(`    │  ${last ? '└─' : '├─'} 📁 ${child.name}  ${this.status(child)}`);
        const childSummary = child.latestCheckpoint?.summary || child.task?.objective;
        if (childSummary) lines.push(`    │     ${last ? ' ' : '│'}  ${this.colors.muted}${childSummary}${reset}`);
      }
      lines.push(`    └─ ${this.text('summary', '总结')}`, `       ${this.colors.muted}${summary}${reset}`, '');
      return wrapTerminalLines(lines, width);
    });
    return this.cardViewport(cards, this.selected[this.tab], height);
  }

  private renderSessionDetail(groupId: string, height: number, width: number): string[] {
    const group = logicalSessionGroups(this.runtime.store.listSessions()).find((item) => item.id === groupId);
    if (!group) return [this.text('Session no longer exists. Press Esc.', 'Session 已不存在，按 Esc 返回。')];
    const ids = [...group.sessions, ...group.children].map((session) => session.id); const history = this.runtime.store.historiesForTui(ids);
    const lines = [`${bold}${group.title}${reset}  ${this.colors.muted}${group.id}${reset}`, `${this.text('Continuation records', '继承/续作记录')}: ${group.sessions.length}  ${this.text('Child sessions', '子 Sessions')}: ${group.children.length}`, ''];
    for (const session of group.sessions) lines.push(`${this.colors.accent}◆ ${session.name}${reset}  ${this.status(session)}  ${session.id}`, `  ${this.text('Created', '创建')}: ${session.createdAt}  ${this.text('Updated', '更新')}: ${session.updatedAt}`, ...(session.task ? [`  Objective: ${session.task.objective}`] : []), ...(session.latestCheckpoint ? [`  Checkpoint: ${session.latestCheckpoint.summary}`] : []), '');
    if (group.children.length) { lines.push(`${bold}${this.text('Collaborating children', '协作子会话')}${reset}`); for (const child of group.children) lines.push(`  └─ 📁 ${child.name}  ${this.status(child)}  ${child.id}`); lines.push(''); }
    lines.push(`${bold}${this.text('Permanent structured history', '永久结构化历史')}${reset}`);
    for (const item of history) {
      lines.push(`${this.colors.muted}${item.entry.at}${reset} ${this.colors.accent}${item.sessionName}${reset} ${bold}${item.entry.type}${reset}`);
      const rendered = JSON.stringify(item.entry.data, null, 2); for (const row of rendered.split('\n')) lines.push(`    ${row}`);
    }
    return this.scrolled(lines, height, width);
  }

  private renderMessages(state: ReturnType<LiteRuntime['store']['snapshot']>, height: number, width: number): string[] {
    const groups = conversationGroups(state.messages); if (!groups.length) return [this.text('No conversations. Press m to send a message.', '暂无对话，按 m 发送消息。')];
    const names = new Map(state.sessions.map((session) => [session.id, session.name])); this.selected[this.tab] = Math.max(0, Math.min(groups.length - 1, this.selected[this.tab]));
    const cards = groups.map((group, index) => {
      const [a, b] = group.sessionIds; const title = `${names.get(a) || a} ↔ ${names.get(b) || b}`;
      return wrapTerminalLines([`${index === this.selected[this.tab] ? `${this.colors.selected}> ${title} ${reset}` : `  ${bold}${title}${reset}`}  ${this.colors.accent}${group.messages.length} ${this.text('messages', '条消息')}${reset}`, `    ${this.colors.muted}${group.lastMessage.body}${reset}`, ''], width);
    });
    return this.cardViewport(cards, this.selected[this.tab], height);
  }

  private renderConversationDetail(id: string, height: number, width: number): string[] {
    const state = this.runtime.store.snapshot(); const group = conversationGroups(state.messages).find((item) => item.id === id);
    if (!group) return [this.text('Conversation no longer exists. Press Esc.', '对话已不存在，按 Esc 返回。')];
    const names = new Map(state.sessions.map((session) => [session.id, session.name])); const [a, b] = group.sessionIds;
    const lines = [`${bold}${names.get(a) || a} ↔ ${names.get(b) || b}${reset}`, `${this.text('Complete durable conversation', '完整永久对话')} · ${group.messages.length} ${this.text('messages', '条消息')}`, ''];
    for (const message of group.messages) {
      const sender = names.get(message.from) || message.from; lines.push(`${this.colors.accent}${sender}${reset}  ${this.colors.muted}${message.createdAt}${message.readAt ? ` · ${this.text('read', '已读')}` : ''}${reset}`);
      lines.push(`  ${message.body}`, '');
    }
    return this.scrolled(lines, height, width);
  }

  private renderDiff(height: number, width: number): string[] {
    const snapshot = this.diff.snapshot(); const lines = [`${bold}${this.text('Uncommitted workspace diff', '工作区未提交 Diff')}${reset}  ${this.colors.muted}${snapshot.updatedAt || ''}${snapshot.loading ? ` · ${this.text('refreshing', '刷新中')}` : ''}${reset}`];
    if (snapshot.error) lines.push(`${this.colors.bad}${snapshot.error}${reset}`);
    else if (!snapshot.lines.length) lines.push(this.text('Working tree is clean.', '工作区没有未提交更改。'));
    else for (const row of snapshot.lines) lines.push(row.startsWith('+') && !row.startsWith('+++') ? `${this.colors.good}${row}${reset}` : row.startsWith('-') && !row.startsWith('---') ? `${this.colors.bad}${row}${reset}` : row.startsWith('@@') ? `${this.colors.accent}${row}${reset}` : row.startsWith('diff --git') ? `${bold}${row}${reset}` : row);
    if (snapshot.truncated) lines.push(`${this.colors.warn}${this.text('Diff capture truncated at safety limit.', 'Diff 已达到安全上限并截断。')}${reset}`);
    return this.scrolled(lines, height, width);
  }

  private renderExtensions(state: ReturnType<LiteRuntime['store']['snapshot']>, height: number, width: number): string[] {
    if (!state.extensions.length) return [`${bold}${this.text('Custom extensions', '自定义扩展')}${reset}`, this.text('No custom extensions. Press e to add one.', '暂无自定义扩展，按 e 新增。')];
    this.selected[this.tab] = Math.max(0, Math.min(state.extensions.length - 1, this.selected[this.tab]));
    const cards = state.extensions.map((extension, index) => wrapTerminalLines([
      `${index === this.selected[this.tab] ? `${this.colors.selected}> ${extension.name} ${reset}` : `  ${bold}${extension.name}${reset}`}  ${this.colors.accent}${extension.handler.kind}${reset}`,
      `    ${extension.title}`,
      `    ${this.colors.muted}${extension.description}${reset}`, '',
    ], width));
    return this.cardViewport(cards, this.selected[this.tab], height);
  }

  private renderSettings(): string[] {
    const config = this.runtime.config;
    return [`${bold}${this.text('Runtime settings', '运行设置')}${reset}`, `  ${this.text('Language', '界面语言')}          ${config.uiLanguage}`, `  ${this.text('Theme', '界面主题')}             ${config.uiTheme}`,
      `  ${this.text('Settings file', '配置文件')}     ${config.settingsPath}`, `  ${this.text('Workspace', '工作区')}           ${config.workspaceDir}`, `  ${this.text('Listen', '监听地址')}              ${config.host}:${this.runtime.port}`,
      `  ${this.text('Public URL', '公网 URL')}         ${config.publicBaseUrl}`, `  ${this.text('Max output', '最大输出')}         ${config.maxOutputChars}`, `  ${this.text('Timeout', '命令超时')}            ${config.commandTimeoutSec}s`, '',
      `${bold}${this.text('Connection credentials', '连接凭据')}${reset}`, `  Apps connector     ${this.revealCredentials ? config.connectorKey : '••••••••'}`, `  Actions token      ${this.revealCredentials ? config.actionsToken : maskCredential(config.actionsToken)}`,
      '', `${this.colors.warn}${this.text('Rotating credentials disconnects existing Apps and Actions clients.', '轮换凭据会使现有 Apps 与 Actions 连接失效。')}${reset}`];
  }

  private renderLogs(height: number, width: number): string[] {
    const lines = [`${bold}${this.text('Runtime logs', '运行日志')}${reset}  ${this.showAuditFacts ? `${this.colors.good}${this.text('audit facts ON', '事实调用 已开启')}${reset}` : `${this.colors.muted}${this.text('audit facts OFF', '事实调用 已关闭')}${reset}`}`];
    const entries = this.runtime.logs.map((entry) => ({ at: entry.at, line: `${entry.level === 'error' ? this.colors.bad : this.colors.muted}${entry.at} ${entry.level.toUpperCase()}${reset} ${entry.message}` }));
    if (this.showAuditFacts) for (const fact of this.runtime.store.auditFacts(2000)) entries.push({ at: fact.at, line: `${this.colors.accent}${fact.at} FACT${reset} ${fact.sessionName} · ${fact.tool} · ${fact.ok ? 'OK' : fact.errorCode || 'ERROR'} · ${fact.durationMs}ms  ${JSON.stringify(fact.args)}` });
    lines.push(...entries.sort((a, b) => b.at.localeCompare(a.at)).map((entry) => entry.line));
    return this.scrolled(lines, height, width);
  }

  private scrolled(lines: string[], height: number, width: number): string[] {
    const wrapped = wrapTerminalLines(lines, width); const max = Math.max(0, wrapped.length - height);
    this.scroll[this.tab] = Math.min(max, Math.max(0, this.scroll[this.tab]));
    return wrapped.slice(this.scroll[this.tab], this.scroll[this.tab] + height);
  }

  private cardViewport(cards: string[][], selected: number, height: number): string[] {
    const offsets: number[] = []; let total = 0;
    for (const card of cards) { offsets.push(total); total += card.length; }
    const start = offsets[selected] || 0; const end = start + (cards[selected]?.length || 1);
    let scroll = Math.min(Math.max(0, total - height), Math.max(0, this.scroll[this.tab]));
    if (start < scroll) scroll = start;
    else if (end > scroll + height) scroll = Math.min(start, Math.max(0, end - height));
    this.scroll[this.tab] = scroll;
    return cards.flat().slice(scroll, scroll + height);
  }

  private async ask(questions: Array<{ label: string; fallback?: string }>, preamble: string[] = []): Promise<string[]> {
    this.prompting = true; stdin.off('keypress', this.onKeypress); stdin.off('data', this.onRawInput); stdin.setRawMode(false); stdout.write(`${mouseOff}${wrap}${ESC}?25h${clear}${bold}LocalTerminal Lite · ${this.text('Input', '输入')}${reset}\n${'─'.repeat(Math.max(40, stdout.columns || 80))}\n`);
    if (preamble.length) stdout.write(`${wrapTerminalLines(preamble, Math.max(40, stdout.columns || 80)).join('\n')}\n${'─'.repeat(Math.max(40, stdout.columns || 80))}\n`);
    const rl = createInterface({ input: stdin, output: stdout }); const answers: string[] = [];
    try { for (const question of questions) { const answer = await rl.question(`${question.label}${question.fallback ? ` [${question.fallback}]` : ''}: `); answers.push(answer.trim() || question.fallback || ''); } }
    finally { rl.close(); emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume(); stdin.on('keypress', this.onKeypress); stdin.prependListener('data', this.onRawInput); stdout.write(`${noWrap}${mouseOn}${ESC}?25l${clear}`); this.prompting = false; }
    return answers;
  }

  private focusedSession(): LiteSession | undefined {
    const group = logicalSessionGroups(this.runtime.store.listSessions()).find((item) => item.id === (this.detail?.kind === 'session' ? this.detail.id : undefined)) || logicalSessionGroups(this.runtime.store.listSessions())[this.selected[1]];
    return group?.current;
  }

  private async promptNewSession(): Promise<void> {
    const roots = this.runtime.store.listSessions().filter((session) => !session.parentSessionId && !['completed', 'cancelled'].includes(session.phase));
    const [mode] = await this.ask([{ label: this.text('Create root or child', '创建 root 或 child'), fallback: roots.length ? 'child' : 'root' }]);
    if (mode === 'root') {
      const [name, role] = await this.ask([{ label: this.text('Root session name', 'Root session 名称') }, { label: this.text('Role', '角色'), fallback: 'lead' }]); if (!name) return;
      const created = this.runtime.store.createTuiRoot({ name, role }); await this.rememberAndCopy(created.session.id, created.handoffPrompt); this.runtime.log(`Prepared root session ${name}; handoff copied.`); return;
    }
    const [rootId, name, role, objective, background, deliverables, criteria, constraints] = await this.ask([
      { label: this.text('Root session name or ID', 'Root session 名称或 ID'), fallback: roots[0]?.id }, { label: this.text('Child session name', '子 session 名称') }, { label: this.text('Role', '角色'), fallback: 'developer' },
      { label: this.text('Objective', '目标') }, { label: this.text('Background', '背景') }, { label: this.text('Deliverables (semicolon separated)', '交付物（分号分隔）') },
      { label: this.text('Acceptance criteria (semicolon separated)', '验收标准（分号分隔）') }, { label: this.text('Constraints (semicolon separated)', '约束（分号分隔）'), fallback: this.text('Stay within scope', '保持在任务范围内') },
    ]); if (!rootId || !name) return;
    const split = (value: string) => value.split(';').map((item) => item.trim()).filter(Boolean); const task: TaskPackage = { objective, background, deliverables: split(deliverables), acceptanceCriteria: split(criteria), constraints: split(constraints) };
    const result = this.runtime.store.createTuiDelegate(rootId, { name, role, task }); await this.rememberAndCopy(result.session.id, result.handoffPrompt); this.runtime.log(`Created child ${name}; handoff copied.`);
  }

  private async promptSessionAction(): Promise<void> {
    const session = this.focusedSession(); if (!session) return;
    const terminal = ['completed', 'cancelled'].includes(session.phase);
    const [action] = await this.ask([{ label: this.text('Action', '操作') + (terminal ? ' context|delete|continue' : ' copy|revoke|cancel|context|delete'), fallback: terminal ? 'context' : 'context' }], [
      `${bold}${session.name}${reset}  ${session.phase}/${session.presence}`, session.id,
      session.latestCheckpoint?.summary || this.text('No checkpoint summary.', '暂无 checkpoint 总结。'),
    ]);
    if (action === 'copy') {
      const prompt = this.handoffs.get(session.id) || this.runtime.store.handoffForTui(session.id);
      if (!prompt) { this.runtime.log(`No passive handoff exists for ${session.name}; use revoke explicitly.`, 'info'); return; }
      await this.rememberAndCopy(session.id, prompt); this.runtime.log(`Handoff copied for ${session.name}.`);
    } else if (action === 'revoke') {
      if (terminal) { this.runtime.log(`${session.name} is terminal; create a continuation instead.`, 'info'); return; }
      const result = this.runtime.store.revokeFromTui(session.id); await this.rememberAndCopy(session.id, result.handoffPrompt); this.runtime.log(`Controller revoked for ${session.name}.`);
    } else if (action === 'cancel') {
      this.runtime.store.cancelFromTui(session.id); this.handoffs.delete(session.id); this.remindedAt.delete(session.id); this.runtime.log(`Cancelled session ${session.name}.`);
    } else if (action === 'delete') await this.promptDeleteSession(session);
    else if (action === 'continue') {
      if (!terminal || session.parentSessionId) { this.runtime.log('Only a terminal root can be continued here.', 'info'); return; }
      const [name] = await this.ask([{ label: this.text('Continuation name', '续作名称'), fallback: `${session.name}-next` }]);
      const created = this.runtime.store.createTuiRoot({ name, role: session.role, continuesSessionId: session.id }); await this.rememberAndCopy(created.session.id, created.handoffPrompt); this.runtime.log(`Created continuation ${name}.`);
    } else if (action === 'context') { const group = logicalSessionGroups(this.runtime.store.listSessions()).find((item) => item.sessions.some((item) => item.id === session.id)); if (group) { this.detail = { kind: 'session', id: group.id }; this.scroll[1] = 0; } }
  }

  private async promptDeleteSession(session: LiteSession): Promise<void> {
    const descendants = this.runtime.store.listSessions().filter((item) => item.parentSessionId === session.id); const historyCount = this.runtime.store.historiesForTui([session.id, ...descendants.map((item) => item.id)]).length;
    const messages = this.runtime.store.messagesForSession(session.id, 1000).length; const phrase = `DELETE ${session.id}`;
    const summary = [
      `${bold}${this.text('DELETE SESSION — review before confirming', '删除 SESSION — 请确认具体内容')}${reset}`,
      `${this.text('Name', '名称')}: ${session.name}`, `ID: ${session.id}`, `${this.text('State', '状态')}: ${session.phase}/${session.presence}`,
      `${this.text('Created', '创建')}: ${session.createdAt}`, `${this.text('Updated', '更新')}: ${session.updatedAt}`,
      `${this.text('Objective', '目标')}: ${session.task?.objective || '-'}`, `${this.text('Latest checkpoint', '最近 checkpoint')}: ${session.latestCheckpoint?.summary || '-'}`,
      `${this.text('Final summary', '最终总结')}: ${session.finalSummary || '-'}`, `${this.text('Children', '子 Sessions')}: ${descendants.map((item) => item.name).join(', ') || '-'}`,
      `${this.text('Permanent history entries', '永久历史条目')}: ${historyCount}`, `${this.text('Related messages', '相关消息')}: ${messages}`,
      `${this.colors.bad}${this.text('This removes the session, descendants, and their history.', '这会删除该 session、其子项及永久历史。')}${reset}`,
    ];
    const [confirmation] = await this.ask([{ label: `${this.text('Type to confirm', '输入确认短语')} “${phrase}”` }], summary);
    const result = this.runtime.store.deleteFromTui(session.id, confirmation); this.detail = undefined; this.runtime.log(`Deleted ${result.deleted.length} session record(s) and histories.`);
  }

  private async promptMessage(): Promise<void> {
    const sessions = this.runtime.store.listSessions(); const [from, to, body] = await this.ask([{ label: this.text('From session name or ID', '发送方 session 名称或 ID'), fallback: sessions[0]?.name }, { label: this.text('To session name or ID', '接收方 session 名称或 ID'), fallback: sessions[1]?.name }, { label: this.text('Message', '消息') }]);
    if (from && to && body) this.runtime.store.sendMessage(from, to, body);
  }

  private async promptExtension(): Promise<void> {
    const [name, title, description, kind] = await this.ask([{ label: 'Extension name (lower_snake_case)' }, { label: this.text('Title', '标题') }, { label: this.text('Description', '说明') }, { label: 'Handler builtin|command', fallback: 'builtin' }]); if (!name) return;
    const base = { name, title: title || name, description: description || 'Custom declarative extension registered from the Lite TUI.' }; let spec: CustomExtensionSpec;
    if (kind === 'command') {
      const [executable, argsJson, schemaJson, readOnlyAnswer] = await this.ask([{ label: 'Executable' }, { label: 'Argument templates JSON', fallback: '[]' }, { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}' }, { label: 'Read-only yes|no', fallback: 'no' }]);
      spec = { ...base, inputSchema: JSON.parse(schemaJson), annotations: { readOnlyHint: readOnlyAnswer === 'yes', destructiveHint: readOnlyAnswer !== 'yes', openWorldHint: true, idempotentHint: readOnlyAnswer === 'yes' }, handler: { kind: 'command', executable, args: JSON.parse(argsJson) } };
    } else {
      const [target, schemaJson] = await this.ask([{ label: 'Builtin target', fallback: 'run_checks' }, { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}' }]);
      spec = { ...base, inputSchema: JSON.parse(schemaJson), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false }, handler: { kind: 'builtin', target } };
    }
    const result = await this.runtime.extensions.registerFromTui({ action: 'upsert', spec }); this.runtime.log(result.ok ? `Registered extension ${name}` : result.error?.message || 'Extension registration failed', result.ok ? 'info' : 'error');
  }

  private async promptExtensionRemove(): Promise<void> {
    const extension = this.runtime.store.snapshot().extensions[this.selected[4]]; const [name] = await this.ask([{ label: this.text('Extension name to remove', '要删除的扩展名称'), fallback: extension?.name }]); if (!name) return;
    const result = await this.runtime.extensions.registerFromTui({ action: 'remove', name }); this.runtime.log(result.ok ? `Removed extension ${name}` : result.error?.message || 'Extension removal failed', result.ok ? 'info' : 'error');
  }

  private async promptSettings(): Promise<void> {
    const current = readLiteSettings() || { schemaVersion: 1 as const, workspaceDir: this.runtime.config.workspaceDir, host: this.runtime.config.host, port: this.runtime.config.port, connectorKey: this.runtime.config.connectorKey, actionsToken: this.runtime.config.actionsToken, publicBaseUrl: '', maxOutputChars: this.runtime.config.maxOutputChars, commandTimeoutSec: this.runtime.config.commandTimeoutSec, uiLanguage: this.runtime.config.uiLanguage, uiTheme: this.runtime.config.uiTheme };
    const [language, theme, workspace, host, port, publicUrl, maxOutput, timeout] = await this.ask([
      { label: 'UI language zh-CN|en', fallback: current.uiLanguage }, { label: 'UI theme dark|light', fallback: current.uiTheme }, { label: this.text('Workspace directory', '工作区目录'), fallback: current.workspaceDir },
      { label: this.text('Listen host', '监听地址'), fallback: current.host }, { label: this.text('Listen port', '监听端口'), fallback: String(current.port) }, { label: this.text('Public HTTPS URL (local clears)', '公网 HTTPS URL（local 清空）'), fallback: current.publicBaseUrl || 'local' },
      { label: this.text('Maximum output characters', '最大输出字符'), fallback: String(current.maxOutputChars) }, { label: this.text('Command timeout seconds', '命令超时秒数'), fallback: String(current.commandTimeoutSec) },
    ]);
    const next: LiteSettings = { ...current, uiLanguage: language as LiteSettings['uiLanguage'], uiTheme: theme as LiteSettings['uiTheme'], workspaceDir: path.resolve(workspace), host, port: integer(port, current.port), publicBaseUrl: publicUrl.toLowerCase() === 'local' ? '' : publicUrl.replace(/\/$/, ''), maxOutputChars: integer(maxOutput, current.maxOutputChars), commandTimeoutSec: integer(timeout, current.commandTimeoutSec) };
    const errors = validateSettings(next); if (errors.length) { this.runtime.log(errors.join(' '), 'error'); return; }
    this.diff.stop(); const result = await this.reconfigure(next); this.runtime = result.runtime; this.diff = new WorkspaceDiffTracker(this.runtime.config); this.diff.start(); this.runtime.log(result.error || 'Runtime settings applied from TUI.', result.error ? 'error' : 'info');
  }

  private async promptCredentialRotation(): Promise<void> {
    const [answer] = await this.ask([{ label: this.text('Rotate Apps and Actions credentials? yes|no', '轮换 Apps 与 Actions 凭据？yes|no'), fallback: 'no' }]); if (answer.toLowerCase() !== 'yes') return;
    const current = readLiteSettings(); if (!current) { this.runtime.log('Persistent settings unavailable.', 'error'); return; }
    this.diff.stop(); const result = await this.reconfigure(rotateLiteCredentials(current)); this.runtime = result.runtime; this.diff = new WorkspaceDiffTracker(this.runtime.config); this.diff.start(); this.revealCredentials = true; this.runtime.log(result.error || 'Connection credentials rotated.', result.error ? 'error' : 'info');
  }

  private tickReminders(): void {
    this.runtime.store.refreshTemporalStates(); const now = Date.now(); const pending = this.runtime.store.pendingUnclaimed(); const ids = new Set(pending.map((session) => session.id));
    for (const id of this.remindedAt.keys()) if (!ids.has(id)) { this.remindedAt.delete(id); this.handoffs.delete(id); }
    for (const session of pending) {
      if (!this.handoffs.has(session.id)) { const prompt = this.runtime.store.handoffForTui(session.id); if (prompt) void this.rememberAndCopy(session.id, prompt); }
      const times = this.remindedAt.get(session.id) || { bell: now, notification: now };
      if (now - times.bell >= 60_000) { stdout.write('\u0007'); times.bell = now; }
      if (now - times.notification >= 300_000) { this.notifySystem('LocalTerminal Lite', `${session.name} ${this.text('still needs a controller.', '仍等待 ChatGPT 接管。')}`); times.notification = now; }
      this.remindedAt.set(session.id, times);
    }
  }

  private async rememberAndCopy(sessionId: string, prompt: string): Promise<void> {
    this.handoffs.set(sessionId, prompt); this.remindedAt.set(sessionId, { bell: Date.now(), notification: Date.now() }); const copied = await this.copyToClipboard(prompt);
    if (!copied) this.runtime.log(`Clipboard unavailable. Handoff: ${prompt}`, 'error');
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    const commands = process.platform === 'darwin' ? [['pbcopy', []] as const] : process.platform === 'win32' ? [['clip', []] as const] : [['wl-copy', []] as const, ['xclip', ['-selection', 'clipboard']] as const];
    for (const [command, args] of commands) {
      const ok = await new Promise<boolean>((resolve) => { const child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'], shell: false }); child.once('error', () => resolve(false)); child.once('close', (code) => resolve(code === 0)); child.stdin.end(text); }); if (ok) return true;
    }
    return false;
  }

  private notifySystem(title: string, message: string): void {
    if (process.platform === 'darwin') spawn('osascript', ['-e', `display notification "${message.replace(/["\\]/g, '')}" with title "${title.replace(/["\\]/g, '')}"`], { stdio: 'ignore', shell: false }).on('error', () => undefined);
    else if (process.platform === 'linux') spawn('notify-send', [title, message], { stdio: 'ignore', shell: false }).on('error', () => undefined);
    else if (process.platform === 'win32') spawn('msg.exe', ['*', `${title}: ${message}`], { stdio: 'ignore', shell: false }).on('error', () => undefined);
  }

  private async shutdown(): Promise<void> {
    if (this.stopped) return; this.stopped = true; if (this.timer) clearInterval(this.timer); this.diff.stop(); stdin.off('keypress', this.onKeypress); stdin.off('data', this.onRawInput); stdin.setRawMode(false); stdin.pause(); stdout.write(`${mouseOff}${wrap}${ESC}?25h${ESC}?1049l`); await this.runtime.close();
  }
}
