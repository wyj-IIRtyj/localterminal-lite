import type { Theme } from '../state.js';

export function Header({ theme, pending, zh }: { theme: Theme; pending: number; zh: boolean }) {
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.background}>
      <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}><b>LocalTerminal Lite</b></text>
        <text fg={theme.good}>● {zh ? '运行中' : 'running'}</text>
        <text fg={theme.muted}>v0.5.0</text>
      </box>
      {pending > 0 ? (
        <box backgroundColor={theme.bad} paddingLeft={1} paddingRight={1}>
          <text fg="#ffffff" wrapMode="word"><b>! {pending} {zh ? '个 session 等待接管' : 'session(s) need a controller'}</b></text>
        </box>
      ) : null}
    </box>
  );
}
