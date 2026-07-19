import path from 'node:path';
import { useTerminalDimensions } from '@opentui/react';
import { useState } from 'react';
import { settingsPath, validateSettings, validateSettingsFeasibility } from '../config.js';
import { describePortOwner, findAvailablePort, readWorkspaceRegistry, resolveWorkspaceInput, terminatePortOwner, workspaceChoiceHint } from '../instances.js';
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
  const [pendingConflict, setPendingConflict] = useState<{ candidate: LiteSettings; message: string }>();
  const [feedback, setFeedback] = useState<string[]>([
    'LocalTerminal Lite · 首次设置 / First-run setup',
    '所有配置都保存在 TUI 中，不需要手动编辑配置文件。',
  ]);
  const theme = themeFor(defaults.uiTheme);
  const knownWorkspaces = readWorkspaceRegistry(path.dirname(settingsPath()));
  const workspaceHint = workspaceChoiceHint(knownWorkspaces);
  const questions: FormQuestion[] = pendingConflict ? [
    { label: `端口被非 LocalTerminal 程序占用 / Port occupied · ${describePortOwner(pendingConflict.candidate.port)} · kill|next|cancel`, fallback: 'cancel', validate: (value) => ['kill', 'next', 'cancel'].includes(value.toLowerCase()) ? undefined : 'Use kill, next, or cancel.' },
  ] : [
    { label: '界面语言 / UI language zh-CN|en', fallback: defaults.uiLanguage },
    { label: '界面主题 / UI theme dark|light', fallback: defaults.uiTheme },
    { label: `工作区路径或编号 / Workspace path or number${workspaceHint ? ` · ${workspaceHint}` : ''}`, fallback: defaults.workspaceDir, validate: (value) => { const selected = resolveWorkspaceInput(value, knownWorkspaces); try { return path.resolve(selected) ? undefined : 'Invalid workspace.'; } catch { return 'Invalid workspace.'; } } },
    { label: '监听地址 / Host', fallback: defaults.host },
    { label: '端口 / Port', fallback: String(defaults.port), validate: (value) => { const port = Number(value); return Number.isInteger(port) && port >= 0 && port <= 65535 ? undefined : 'Port must be 0-65535.'; } },
    { label: '公网 HTTPS URL / Public URL (optional)', fallback: defaults.publicBaseUrl },
    { label: '最大输出字符 / Max output', fallback: String(defaults.maxOutputChars) },
    { label: '命令超时秒数 / Timeout', fallback: String(defaults.commandTimeoutSec) },
    { label: '保存并启动 / Save and start? yes|no', fallback: 'yes' },
  ];

  const submit = async (answers: string[]) => {
    if (pendingConflict) {
      const policy = answers[0].toLowerCase();
      try {
        if (policy === 'kill') await terminatePortOwner(pendingConflict.candidate.port);
        else if (policy === 'next') pendingConflict.candidate.port = await findAvailablePort(pendingConflict.candidate.host, pendingConflict.candidate.port);
        else { setPendingConflict(undefined); setFeedback(['端口冲突处理已取消 / Port conflict handling cancelled']); setAttempt((value) => value + 1); return; }
        onComplete(pendingConflict.candidate);
      } catch (error) {
        setPendingConflict(undefined);
        setFeedback(['端口处理失败 / Port handling failed', error instanceof Error ? error.message : String(error)]);
        setAttempt((value) => value + 1);
      }
      return;
    }
    if (!['yes', 'y'].includes(answers[8].toLowerCase())) { setAttempt((value) => value + 1); return; }
    const candidate: LiteSettings = {
      ...defaults,
      uiLanguage: answers[0] as LiteSettings['uiLanguage'],
      uiTheme: answers[1] as LiteSettings['uiTheme'],
      workspaceDir: resolveWorkspaceInput(answers[2], knownWorkspaces),
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
    const feasibility = await validateSettingsFeasibility(candidate);
    const portConflict = feasibility.find((error) => error.includes('already in use'));
    if (portConflict) {
      setPendingConflict({ candidate, message: portConflict });
      setFeedback(['端口被其他程序占用 / Port occupied by another program', portConflict]);
      setAttempt((value) => value + 1);
      return;
    }
    if (feasibility.length) { setFeedback(['设置不可用 / Settings are not feasible', ...feasibility]); setAttempt((value) => value + 1); return; }
    onComplete(candidate);
  };

  return (
    <box width={width} height={height} backgroundColor={theme.background}>
      <FormDialog key={attempt} questions={questions} preamble={feedback} theme={theme} width={width} height={height} zh={defaults.uiLanguage === 'zh-CN'} onComplete={submit} onCancel={onCancel} />
    </box>
  );
}
