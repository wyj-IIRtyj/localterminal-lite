import type { LiteRuntime } from '../../server.js';
import { maskCredential } from '../../config.js';
import type { Theme } from '../state.js';
import { Heading, Line } from './shared.js';

export function Settings({ runtime, theme, zh, reveal }: { runtime: LiteRuntime; theme: Theme; zh: boolean; reveal: boolean }) {
  const config = runtime.config;
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      <Heading theme={theme}>{zh ? '运行设置' : 'Runtime settings'}</Heading>
      <Line color={theme.text}>{`${zh ? '界面语言' : 'Language'}: ${config.uiLanguage}`}</Line>
      <Line color={theme.text}>{`${zh ? '界面主题' : 'Theme'}: ${config.uiTheme}`}</Line>
      <Line color={theme.text}>{`${zh ? '配置文件' : 'Settings file'}: ${config.settingsPath}`}</Line>
      <Line color={theme.text}>{`${zh ? '工作区' : 'Workspace'}: ${config.workspaceDir}`}</Line>
      <Line color={theme.text}>{`${zh ? '监听地址' : 'Listen'}: ${config.host}:${runtime.port}`}</Line>
      <Line color={theme.text}>{`${zh ? '公网 URL' : 'Public URL'}: ${config.publicBaseUrl}`}</Line>
      <Line color={theme.text}>{`${zh ? '最大输出' : 'Max output'}: ${config.maxOutputChars}`}</Line>
      <Line color={theme.text}>{`${zh ? '命令超时' : 'Timeout'}: ${config.commandTimeoutSec}s`}</Line>
      <text> </text>
      <Heading theme={theme}>{zh ? '连接凭据' : 'Connection credentials'}</Heading>
      <Line color={theme.text}>{`Apps connector: ${reveal ? config.connectorKey : '••••••••'}`}</Line>
      <Line color={theme.text}>{`Actions token: ${reveal ? config.actionsToken : maskCredential(config.actionsToken)}`}</Line>
      <Line color={theme.warn}>{zh ? '轮换凭据会使现有 Apps 与 Actions 连接失效。' : 'Rotating credentials disconnects existing Apps and Actions clients.'}</Line>
    </box>
  );
}
