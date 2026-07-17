import type { LiteRuntime, RuntimeLog } from '../../server.js';
import type { Theme } from '../state.js';
import { Heading, Line } from './shared.js';

export function Logs({ runtime, logs, theme, zh, showAudit }: { runtime: LiteRuntime; logs: RuntimeLog[]; theme: Theme; zh: boolean; showAudit: boolean }) {
  const entries: Array<{ at: string; level: 'info' | 'error' | 'fact'; text: string }> = logs.map((entry) => ({ at: entry.at, level: entry.level, text: `${entry.at} ${entry.level.toUpperCase()} ${entry.message}` }));
  if (showAudit) for (const fact of runtime.store.auditFacts(2000)) entries.push({ at: fact.at, level: 'fact', text: `${fact.at} FACT ${fact.sessionName} · ${fact.tool} · ${fact.ok ? 'OK' : fact.errorCode || 'ERROR'} · ${fact.durationMs}ms  ${JSON.stringify(fact.args)}` });
  entries.sort((a, b) => b.at.localeCompare(a.at));
  return (
    <box flexDirection="column" width="100%" padding={1}>
      <box flexDirection="row" gap={2} flexWrap="wrap"><Heading theme={theme}>{zh ? '运行日志' : 'Runtime logs'}</Heading><text fg={showAudit ? theme.good : theme.muted}>{showAudit ? (zh ? '事实调用 已开启' : 'audit facts ON') : (zh ? '事实调用 已关闭' : 'audit facts OFF')}</text></box>
      {entries.map((entry, index) => <Line key={`${entry.at}-${index}`} color={entry.level === 'error' ? theme.bad : entry.level === 'fact' ? theme.accent : theme.muted}>{entry.text}</Line>)}
    </box>
  );
}
