import path from 'node:path';
import { useTerminalDimensions } from '@opentui/react';
import { useState } from 'react';
import { validateSettings } from '../config.js';
import type { LiteSettings } from '../types.js';
import { themeFor, type FormQuestion } from './state.js';
import { FormDialog } from './components/FormDialog.js';

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function Setup({ defaults, onComplete, onCancel }: { defaults: LiteSettings; onComplete: (settings: LiteSettings) => void; onCancel: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [attempt, setAttempt] = useState(0);
  const [feedback, setFeedback] = useState<string[]>([
    'LocalTerminal Lite · 首次设置 / First-run setup',
    '所有配置都保存在 TUI 中，不需要手动编辑配置文件。',
  ]);
  const theme = themeFor(defaults.uiTheme);
  const questions: FormQuestion[] = [
    { label: '界面语言 / UI language zh-CN|en', fallback: defaults.uiLanguage },
    { label: '界面主题 / UI theme dark|light', fallback: defaults.uiTheme },
    { label: '工作区 / Workspace', fallback: defaults.workspaceDir },
    { label: '监听地址 / Host', fallback: defaults.host },
    { label: '端口 / Port', fallback: String(defaults.port) },
    { label: '公网 HTTPS URL / Public URL (optional)', fallback: defaults.publicBaseUrl },
    { label: '最大输出字符 / Max output', fallback: String(defaults.maxOutputChars) },
    { label: '命令超时秒数 / Timeout', fallback: String(defaults.commandTimeoutSec) },
    { label: '保存并启动 / Save and start? yes|no', fallback: 'yes' },
  ];

  const submit = (answers: string[]) => {
    if (!['yes', 'y'].includes(answers[8].toLowerCase())) { setAttempt((value) => value + 1); return; }
    const candidate: LiteSettings = {
      ...defaults,
      uiLanguage: answers[0] as LiteSettings['uiLanguage'],
      uiTheme: answers[1] as LiteSettings['uiTheme'],
      workspaceDir: path.resolve(answers[2]),
      host: answers[3],
      port: integer(answers[4], defaults.port),
      publicBaseUrl: answers[5].replace(/\/$/, ''),
      maxOutputChars: integer(answers[6], defaults.maxOutputChars),
      commandTimeoutSec: integer(answers[7], defaults.commandTimeoutSec),
    };
    const errors = validateSettings(candidate);
    if (errors.length) {
      setFeedback(['设置无效 / Invalid settings', ...errors]);
      setAttempt((value) => value + 1);
      return;
    }
    onComplete(candidate);
  };

  return (
    <box width={width} height={height} backgroundColor={theme.background}>
      <FormDialog key={attempt} questions={questions} preamble={feedback} theme={theme} width={width} height={height} zh={defaults.uiLanguage === 'zh-CN'} onComplete={submit} onCancel={onCancel} />
    </box>
  );
}
