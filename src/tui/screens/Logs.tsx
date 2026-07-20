import path from 'node:path';
import type { LiteRuntime, RuntimeLog } from '../../server.js';
import { readWorkspaceLogs, workspaceId } from '../../instances.js';
import type { Theme } from '../state.js';
import { Heading } from './shared.js';

type DisplayEntry = {
  at: string;
  kind: 'runtime' | 'audit';
  level: 'info' | 'error' | 'ok';
  operation: string;
  subject?: string;
  workspace?: string;
  detail: string;
  duration?: number;
};

function timeOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString([], { hour12: false });
}

function runtimeOperation(message: string): string {
  if (/listening/i.test(message)) return 'SERVER';
  if (/settings|configured|restored/i.test(message)) return 'CONFIG';
  if (/session/i.test(message)) return 'SESSION';
  if (/extension/i.test(message)) return 'EXTENSION';
  if (/clipboard|handoff/i.test(message)) return 'HANDOFF';
  return 'RUNTIME';
}

function RuntimeRow({ entry, theme }: { entry: DisplayEntry; theme: Theme }) {
  const statusColor = entry.level === 'error' ? theme.bad : entry.level === 'ok' ? theme.good : theme.accent;
  return (
    <box flexDirection="row" gap={1} width="100%">
      <text fg={theme.muted}>{timeOf(entry.at)}</text>
      <text fg={statusColor}><b>{entry.level === 'error' ? 'ERR ' : entry.level === 'ok' ? 'OK  ' : 'INFO'}</b></text>
      <text fg={theme.warn}><b>{entry.operation.padEnd(10)}</b></text>
      {entry.workspace ? <text fg={theme.muted}>[{entry.workspace}]</text> : null}
      {entry.subject ? <text fg={theme.accent}>{entry.subject}</text> : null}
      <text fg={theme.text} wrapMode="word" flexGrow={1}>{entry.detail}</text>
      {entry.duration !== undefined ? <text fg={theme.muted}>{entry.duration}ms</text> : null}
    </box>
  );
}

const PAGE_SIZE = 100;

export function Logs({ runtime, logs, theme, zh, showAudit, page, anchorAt }: { runtime: LiteRuntime; logs: RuntimeLog[]; theme: Theme; zh: boolean; showAudit: boolean; page: number; anchorAt?: string }) {
  const anchoredLogs = anchorAt ? logs.filter((entry) => entry.at <= anchorAt) : logs;
  const localEnd = Math.max(0, anchoredLogs.length - page * PAGE_SIZE);
  const localStart = Math.max(0, localEnd - PAGE_SIZE);
  const entries: DisplayEntry[] = anchoredLogs.slice(localStart, localEnd).map((entry) => ({
    at: entry.at,
    kind: 'runtime',
    level: entry.level,
    operation: runtimeOperation(entry.message),
    detail: entry.message,
  }));
  const currentWorkspaceId = workspaceId(runtime.config.workspaceDir);
  try {
    for (const group of readWorkspaceLogs(path.dirname(runtime.config.settingsPath), PAGE_SIZE, page * PAGE_SIZE, anchorAt)) {
      if (group.workspace.id === currentWorkspaceId) continue;
      if (group.workspace.lastHost !== runtime.config.host || group.workspace.lastPort !== runtime.config.port) continue;
      const label = group.workspace.label || path.basename(group.workspace.workspaceDir) || group.workspace.id;
      for (const raw of group.entries) {
        const entry = raw as RuntimeLog;
        if (!entry?.at || !entry?.message) continue;
        entries.push({ at: entry.at, kind: 'runtime', level: entry.level || 'info', operation: runtimeOperation(entry.message), workspace: label, detail: entry.message });
      }
    }
  } catch { /* cross-workspace logs are best effort */ }
  if (showAudit) {
    const audit = runtime.store.auditFacts(PAGE_SIZE * (page + 1) + 5000).filter((fact) => !anchorAt || fact.at <= anchorAt);
    for (const fact of audit.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)) entries.push({
    at: fact.at,
    kind: 'audit',
    level: fact.ok ? 'ok' : 'error',
    operation: fact.tool,
    subject: fact.sessionName,
    detail: fact.ok ? JSON.stringify(fact.args) : `${fact.errorCode || 'ERROR'} · ${JSON.stringify(fact.args)}`,
      duration: fact.durationMs,
    });
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const visibleEntries = entries.slice(0, PAGE_SIZE);
  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      <box flexDirection="row" gap={2} flexWrap="wrap" marginBottom={1}>
        <Heading theme={theme}>{zh ? '本机工作区日志' : 'Local workspace logs'}</Heading>
        <text fg={showAudit ? theme.good : theme.muted}>{showAudit ? (zh ? '调用审计：开启' : 'audit: ON') : (zh ? '调用审计：关闭' : 'audit: OFF')}</text>
        <text fg={theme.muted}>{zh ? `第 ${page + 1} 页 · PgUp/PgDn 翻页` : `Page ${page + 1} · PgUp/PgDn`}</text>
      </box>
      <box flexDirection="row" gap={1} marginBottom={1}>
        <text fg={theme.muted}>{zh ? '时间' : 'TIME'}</text>
        <text fg={theme.muted}>{zh ? '状态' : 'STAT'}</text>
        <text fg={theme.muted}>{zh ? '操作 / 会话 / 内容' : 'OPERATION / SESSION / DETAIL'}</text>
      </box>
      {visibleEntries.length ? visibleEntries.map((entry, index) => <RuntimeRow key={`${entry.at}-${entry.kind}-${index}`} entry={entry} theme={theme} />)
        : <text fg={theme.muted}>{zh ? '暂无日志。' : 'No log entries.'}</text>}
    </box>
  );
}
