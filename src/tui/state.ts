import { spawn } from 'node:child_process';
import path from 'node:path';
import { WorkspaceDiffTracker, type DiffSnapshot } from '../diff.js';
import { logicalSessionGroups } from '../tui-model.js';
import type { LiteRuntime, RuntimeLog } from '../server.js';
import type { CustomExtensionSpec, LiteSession, LiteSettings, SessionPhase, StoredState, TaskPackage } from '../types.js';
import { maskCredential, readLiteSettings, rotateLiteCredentials, validateSettings } from '../config.js';

export const TABS = ['Overview', 'Sessions', 'Messages', 'Diff', 'Extensions', 'Settings', 'Logs'] as const;
export type Tab = (typeof TABS)[number];
export type Detail = { kind: 'session'; id: string } | { kind: 'conversation'; id: string };
export type RuntimeReconfigureResult = { runtime: LiteRuntime; error?: string };
export type RuntimeReconfigure = (settings: LiteSettings) => Promise<RuntimeReconfigureResult>;
export type FormQuestion = { label: string; fallback?: string; multiline?: boolean; sensitive?: boolean };
export type Ask = (questions: FormQuestion[], preamble?: string[]) => Promise<string[] | undefined>;

export type Theme = {
  background: string;
  panel: string;
  panelAlt: string;
  selected: string;
  selectedText: string;
  text: string;
  muted: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  border: string;
};

export function themeFor(name: LiteSettings['uiTheme']): Theme {
  if (name === 'light') return {
    background: '#f6f5f2', panel: '#ffffff', panelAlt: '#eceae5', selected: '#c9e8ff', selectedText: '#10212d',
    text: '#242424', muted: '#6b6b6b', accent: '#1261a0', good: '#198038', warn: '#8a5a00', bad: '#b42318', border: '#9a9a9a',
  };
  return {
    background: '#171717', panel: '#202020', panelAlt: '#292929', selected: '#075985', selectedText: '#f8fafc',
    text: '#f2f2f2', muted: '#9a9a9a', accent: '#22d3ee', good: '#4ade80', warn: '#facc15', bad: '#fb7185', border: '#565656',
  };
}

export function phaseColor(theme: Theme, phase: SessionPhase): string {
  if (phase === 'completed') return theme.good;
  if (phase === 'working') return theme.accent;
  if (phase === 'blocked' || phase === 'cancelled') return theme.bad;
  return theme.warn;
}

export function presenceColor(theme: Theme, session: LiteSession): string {
  if (session.presence === 'claimed') return theme.good;
  if (session.presence === 'stale') return theme.bad;
  return theme.warn;
}

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function runWithInput(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

export async function copyToHostClipboard(text: string): Promise<boolean> {
  const commands = process.platform === 'darwin'
    ? [['pbcopy', []] as const]
    : process.platform === 'win32'
      ? [['clip', []] as const]
      : [['wl-copy', []] as const, ['xclip', ['-selection', 'clipboard']] as const];
  for (const [command, args] of commands) if (await runWithInput(command, [...args], text)) return true;
  return false;
}

function bestEffortSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'ignore', shell: false });
  child.on('error', () => undefined);
}

function playAttentionSound(): void {
  if (process.platform === 'darwin') bestEffortSpawn('afplay', ['/System/Library/Sounds/Ping.aiff']);
  else if (process.platform === 'win32') bestEffortSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[console]::beep(880,180)']);
  else bestEffortSpawn('canberra-gtk-play', ['--id=dialog-warning']);
}

function notifySystem(title: string, message: string): void {
  if (process.platform === 'darwin') bestEffortSpawn('osascript', ['-e', `display notification "${message.replace(/["\\]/g, '')}" with title "${title.replace(/["\\]/g, '')}"`]);
  else if (process.platform === 'linux') bestEffortSpawn('notify-send', [title, message]);
  else if (process.platform === 'win32') bestEffortSpawn('msg.exe', ['*', `${title}: ${message}`]);
}

export type TuiSnapshot = {
  state: StoredState;
  diff: DiffSnapshot;
  logs: RuntimeLog[];
  runtime: LiteRuntime;
};

export class TuiController {
  private diff: WorkspaceDiffTracker;
  private readonly handoffs = new Map<string, string>();
  private readonly remindedAt = new Map<string, { sound: number; notification: number }>();
  private stopped = false;

  constructor(private currentRuntime: LiteRuntime, private readonly reconfigure: RuntimeReconfigure) {
    this.diff = new WorkspaceDiffTracker(currentRuntime.config);
  }

  get runtime(): LiteRuntime { return this.currentRuntime; }
  get zh(): boolean { return this.currentRuntime.config.uiLanguage === 'zh-CN'; }
  text(en: string, zh: string): string { return this.zh ? zh : en; }

  start(): void { this.diff.start(); }

  snapshot(): TuiSnapshot {
    return { state: this.currentRuntime.store.snapshot(), diff: this.diff.snapshot(), logs: [...this.currentRuntime.logs], runtime: this.currentRuntime };
  }

  async refreshDiff(): Promise<void> { await this.diff.refresh(); }

  tickReminders(): void {
    this.currentRuntime.store.refreshTemporalStates();
    const now = Date.now();
    const pending = this.currentRuntime.store.pendingUnclaimed();
    const ids = new Set(pending.map((session) => session.id));
    for (const id of this.remindedAt.keys()) if (!ids.has(id)) { this.remindedAt.delete(id); this.handoffs.delete(id); }
    for (const session of pending) {
      if (!this.handoffs.has(session.id)) {
        const prompt = this.currentRuntime.store.handoffForTui(session.id);
        if (prompt) void this.rememberAndCopy(session.id, prompt);
      }
      const times = this.remindedAt.get(session.id) || { sound: now, notification: now };
      if (now - times.sound >= 60_000) { playAttentionSound(); times.sound = now; }
      if (now - times.notification >= 300_000) {
        notifySystem('LocalTerminal Lite', `${session.name} ${this.text('still needs a controller.', '仍等待 ChatGPT 接管。')}`);
        times.notification = now;
      }
      this.remindedAt.set(session.id, times);
    }
  }

  async createSession(ask: Ask): Promise<void> {
    const roots = this.currentRuntime.store.listSessions().filter((session) => !session.parentSessionId && !['completed', 'cancelled'].includes(session.phase));
    const first = await ask([{ label: this.text('Create root or child', '创建 root 或 child'), fallback: roots.length ? 'child' : 'root' }]);
    if (!first) return;
    if (first[0] === 'root') {
      const answers = await ask([{ label: this.text('Root session name', 'Root session 名称') }, { label: this.text('Role', '角色'), fallback: 'lead' }]);
      if (!answers?.[0]) return;
      const created = this.currentRuntime.store.createTuiRoot({ name: answers[0], role: answers[1] });
      await this.rememberAndCopy(created.session.id, created.handoffPrompt);
      this.currentRuntime.log(`Prepared root session ${answers[0]}; handoff copied.`);
      return;
    }
    const answers = await ask([
      { label: this.text('Root session name or ID', 'Root session 名称或 ID'), fallback: roots[0]?.id },
      { label: this.text('Child session name', '子 session 名称') },
      { label: this.text('Role', '角色'), fallback: 'developer' },
      { label: this.text('Objective', '目标'), multiline: true },
      { label: this.text('Background', '背景'), multiline: true },
      { label: this.text('Deliverables (semicolon separated)', '交付物（分号分隔）'), multiline: true },
      { label: this.text('Acceptance criteria (semicolon separated)', '验收标准（分号分隔）'), multiline: true },
      { label: this.text('Constraints (semicolon separated)', '约束（分号分隔）'), fallback: this.text('Stay within scope', '保持在任务范围内'), multiline: true },
    ]);
    if (!answers?.[0] || !answers[1]) return;
    const split = (value: string) => value.split(';').map((item) => item.trim()).filter(Boolean);
    const task: TaskPackage = { objective: answers[3], background: answers[4], deliverables: split(answers[5]), acceptanceCriteria: split(answers[6]), constraints: split(answers[7]) };
    const result = this.currentRuntime.store.createTuiDelegate(answers[0], { name: answers[1], role: answers[2], task });
    await this.rememberAndCopy(result.session.id, result.handoffPrompt);
    this.currentRuntime.log(`Created child ${answers[1]}; handoff copied.`);
  }

  async sessionAction(session: LiteSession, ask: Ask): Promise<Detail | undefined> {
    const terminal = ['completed', 'cancelled'].includes(session.phase);
    const answers = await ask([{ label: `${this.text('Action', '操作')} ${terminal ? 'context|delete|continue' : 'copy|revoke|cancel|context|delete'}`, fallback: 'context' }], [
      `${session.name}  ${session.phase}/${session.presence}`,
      session.id,
      session.latestCheckpoint?.summary || this.text('No checkpoint summary.', '暂无 checkpoint 总结。'),
    ]);
    if (!answers) return;
    const action = answers[0].toLowerCase();
    if (action === 'copy') {
      const prompt = this.handoffs.get(session.id) || this.currentRuntime.store.handoffForTui(session.id);
      if (!prompt) { this.currentRuntime.log(`No passive handoff exists for ${session.name}; use revoke explicitly.`); return; }
      await this.rememberAndCopy(session.id, prompt);
      this.currentRuntime.log(`Handoff copied for ${session.name}.`);
    } else if (action === 'revoke') {
      if (terminal) { this.currentRuntime.log(`${session.name} is terminal; create a continuation instead.`); return; }
      const result = this.currentRuntime.store.revokeFromTui(session.id);
      await this.rememberAndCopy(session.id, result.handoffPrompt);
      this.currentRuntime.log(`Controller revoked for ${session.name}.`);
    } else if (action === 'cancel') {
      this.currentRuntime.store.cancelFromTui(session.id);
      this.handoffs.delete(session.id); this.remindedAt.delete(session.id);
      this.currentRuntime.log(`Cancelled session ${session.name}.`);
    } else if (action === 'delete') {
      await this.deleteSession(session, ask);
    } else if (action === 'continue') {
      if (!terminal || session.parentSessionId) { this.currentRuntime.log('Only a terminal root can be continued here.'); return; }
      const continuation = await ask([{ label: this.text('Continuation name', '续作名称'), fallback: `${session.name}-next` }]);
      if (!continuation?.[0]) return;
      const created = this.currentRuntime.store.createTuiRoot({ name: continuation[0], role: session.role, continuesSessionId: session.id });
      await this.rememberAndCopy(created.session.id, created.handoffPrompt);
      this.currentRuntime.log(`Created continuation ${continuation[0]}.`);
    } else if (action === 'context') {
      const group = logicalSessionGroups(this.currentRuntime.store.listSessions()).find((item) => item.sessions.some((item) => item.id === session.id));
      if (group) return { kind: 'session', id: group.id };
    }
  }

  async sendMessage(ask: Ask): Promise<void> {
    const sessions = this.currentRuntime.store.listSessions();
    const answers = await ask([
      { label: this.text('From session name or ID', '发送方 session 名称或 ID'), fallback: sessions[0]?.name },
      { label: this.text('To session name or ID', '接收方 session 名称或 ID'), fallback: sessions[1]?.name },
      { label: this.text('Message', '消息'), multiline: true },
    ]);
    if (answers?.[0] && answers[1] && answers[2]) this.currentRuntime.store.sendMessage(answers[0], answers[1], answers[2]);
  }

  async addExtension(ask: Ask): Promise<void> {
    const first = await ask([{ label: 'Extension name (lower_snake_case)' }, { label: this.text('Title', '标题') }, { label: this.text('Description', '说明'), multiline: true }, { label: 'Handler builtin|command', fallback: 'builtin' }]);
    if (!first?.[0]) return;
    const base = { name: first[0], title: first[1] || first[0], description: first[2] || 'Custom declarative extension registered from the Lite TUI.' };
    let spec: CustomExtensionSpec;
    if (first[3] === 'command') {
      const values = await ask([{ label: 'Executable' }, { label: 'Argument templates JSON', fallback: '[]', multiline: true }, { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}', multiline: true }, { label: 'Read-only yes|no', fallback: 'no' }]);
      if (!values) return;
      spec = { ...base, inputSchema: JSON.parse(values[2]), annotations: { readOnlyHint: values[3] === 'yes', destructiveHint: values[3] !== 'yes', openWorldHint: true, idempotentHint: values[3] === 'yes' }, handler: { kind: 'command', executable: values[0], args: JSON.parse(values[1]) } };
    } else {
      const values = await ask([{ label: 'Builtin target', fallback: 'run_checks' }, { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}', multiline: true }]);
      if (!values) return;
      spec = { ...base, inputSchema: JSON.parse(values[1]), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false }, handler: { kind: 'builtin', target: values[0] } };
    }
    const result = await this.currentRuntime.extensions.registerFromTui({ action: 'upsert', spec });
    this.currentRuntime.log(result.ok ? `Registered extension ${first[0]}` : result.error?.message || 'Extension registration failed', result.ok ? 'info' : 'error');
  }

  async removeExtension(name: string | undefined, ask: Ask): Promise<void> {
    const answers = await ask([{ label: this.text('Extension name to remove', '要删除的扩展名称'), fallback: name }]);
    if (!answers?.[0]) return;
    const result = await this.currentRuntime.extensions.registerFromTui({ action: 'remove', name: answers[0] });
    this.currentRuntime.log(result.ok ? `Removed extension ${answers[0]}` : result.error?.message || 'Extension removal failed', result.ok ? 'info' : 'error');
  }

  async editSettings(ask: Ask): Promise<void> {
    const config = this.currentRuntime.config;
    const current = readLiteSettings() || { schemaVersion: 1 as const, workspaceDir: config.workspaceDir, host: config.host, port: config.port, connectorKey: config.connectorKey, actionsToken: config.actionsToken, publicBaseUrl: '', maxOutputChars: config.maxOutputChars, commandTimeoutSec: config.commandTimeoutSec, uiLanguage: config.uiLanguage, uiTheme: config.uiTheme };
    const answers = await ask([
      { label: 'UI language zh-CN|en', fallback: current.uiLanguage }, { label: 'UI theme dark|light', fallback: current.uiTheme },
      { label: this.text('Workspace directory', '工作区目录'), fallback: current.workspaceDir }, { label: this.text('Listen host', '监听地址'), fallback: current.host },
      { label: this.text('Listen port', '监听端口'), fallback: String(current.port) }, { label: this.text('Public HTTPS URL (local clears)', '公网 HTTPS URL（local 清空）'), fallback: current.publicBaseUrl || 'local' },
      { label: this.text('Maximum output characters', '最大输出字符'), fallback: String(current.maxOutputChars) }, { label: this.text('Command timeout seconds', '命令超时秒数'), fallback: String(current.commandTimeoutSec) },
    ]);
    if (!answers) return;
    const next: LiteSettings = { ...current, uiLanguage: answers[0] as LiteSettings['uiLanguage'], uiTheme: answers[1] as LiteSettings['uiTheme'], workspaceDir: path.resolve(answers[2]), host: answers[3], port: integer(answers[4], current.port), publicBaseUrl: answers[5].toLowerCase() === 'local' ? '' : answers[5].replace(/\/$/, ''), maxOutputChars: integer(answers[6], current.maxOutputChars), commandTimeoutSec: integer(answers[7], current.commandTimeoutSec) };
    const errors = validateSettings(next);
    if (errors.length) { this.currentRuntime.log(errors.join(' '), 'error'); return; }
    await this.applySettings(next);
  }

  async rotateCredentials(ask: Ask): Promise<void> {
    const answers = await ask([{ label: this.text('Rotate Apps and Actions credentials? yes|no', '轮换 Apps 与 Actions 凭据？yes|no'), fallback: 'no' }]);
    if (answers?.[0].toLowerCase() !== 'yes') return;
    const current = readLiteSettings();
    if (!current) { this.currentRuntime.log('Persistent settings unavailable.', 'error'); return; }
    await this.applySettings(rotateLiteCredentials(current));
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.diff.stop();
    await this.currentRuntime.close();
  }

  private async applySettings(next: LiteSettings): Promise<void> {
    const previousDiff = this.diff;
    previousDiff.stop();
    try {
      const result = await this.reconfigure(next);
      this.currentRuntime = result.runtime;
      this.diff = new WorkspaceDiffTracker(this.currentRuntime.config);
      this.diff.start();
      this.currentRuntime.log(result.error || 'Runtime settings applied from TUI.', result.error ? 'error' : 'info');
    } catch (error) {
      previousDiff.start();
      throw error;
    }
  }

  private async deleteSession(session: LiteSession, ask: Ask): Promise<void> {
    const descendants = this.currentRuntime.store.listSessions().filter((item) => item.parentSessionId === session.id);
    const historyCount = this.currentRuntime.store.historiesForTui([session.id, ...descendants.map((item) => item.id)]).length;
    const messages = this.currentRuntime.store.messagesForSession(session.id, 1000).length;
    const phrase = `DELETE ${session.id}`;
    const answer = await ask([{ label: `${this.text('Type to confirm', '输入确认短语')} “${phrase}”` }], [
      this.text('DELETE SESSION — review before confirming', '删除 SESSION — 请确认具体内容'),
      `${this.text('Name', '名称')}: ${session.name}`,
      `ID: ${session.id}`,
      `${this.text('State', '状态')}: ${session.phase}/${session.presence}`,
      `${this.text('Objective', '目标')}: ${session.task?.objective || '-'}`,
      `${this.text('Latest checkpoint', '最近 checkpoint')}: ${session.latestCheckpoint?.summary || '-'}`,
      `${this.text('Final summary', '最终总结')}: ${session.finalSummary || '-'}`,
      `${this.text('Children', '子 Sessions')}: ${descendants.map((item) => item.name).join(', ') || '-'}`,
      `${this.text('Permanent history entries', '永久历史条目')}: ${historyCount}`,
      `${this.text('Related messages', '相关消息')}: ${messages}`,
      this.text('This removes the session, descendants, and their history.', '这会删除该 session、其子项及永久历史。'),
    ]);
    if (!answer) return;
    const result = this.currentRuntime.store.deleteFromTui(session.id, answer[0]);
    this.currentRuntime.log(`Deleted ${result.deleted.length} session record(s) and histories.`);
  }

  private async rememberAndCopy(sessionId: string, prompt: string): Promise<void> {
    this.handoffs.set(sessionId, prompt);
    this.remindedAt.set(sessionId, { sound: Date.now(), notification: Date.now() });
    if (!await copyToHostClipboard(prompt)) this.currentRuntime.log(`Clipboard unavailable. Handoff: ${prompt}`, 'error');
  }
}

export function hiddenAppsUrl(runtime: LiteRuntime, reveal: boolean): string {
  return reveal ? runtime.appsUrl : runtime.appsUrl.replace(runtime.config.connectorKey, '••••••••');
}

export function visibleActionsToken(runtime: LiteRuntime, reveal: boolean): string {
  return reveal ? runtime.config.actionsToken : maskCredential(runtime.config.actionsToken);
}
