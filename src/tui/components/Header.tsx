import type { LiteRuntime } from '../../server.js';
import type { Theme } from '../state.js';

export function Header({ runtime, theme, pending, zh }: { runtime: LiteRuntime; theme: Theme; pending: number; zh: boolean }) {
  const topology = runtime.processTopology();
  const role = topology.role === 'leader' ? (zh ? '主进程' : 'leader') : (zh ? '成员进程' : 'member');
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}><b>LocalTerminal Lite</b></text>
        <text fg={theme.good}>● {zh ? '运行中' : 'running'} · {topology.memberCount} {zh ? '个终端进程共用' : 'terminal process(es) share'} :{topology.sharedPort} · {role} · PID {topology.pid}</text>
        <text fg={theme.muted}>v1.0.1</text>
      </box>
      {pending > 0 ? (
        <box backgroundColor={theme.bad} paddingLeft={1} paddingRight={1}>
          <text fg="#ffffff" wrapMode="word"><b>! {pending} {zh ? '个 session 等待接管' : 'session(s) need a controller'}</b></text>
        </box>
      ) : null}
    </box>
  );
}
