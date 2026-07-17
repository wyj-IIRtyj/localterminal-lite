import type { DiffSnapshot } from '../../diff.js';
import type { Theme } from '../state.js';
import { Heading, Line } from './shared.js';

function colorFor(line: string, theme: Theme): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return theme.good;
  if (line.startsWith('-') && !line.startsWith('---')) return theme.bad;
  if (line.startsWith('@@')) return theme.accent;
  if (line.startsWith('diff --git')) return theme.warn;
  return theme.text;
}

export function DiffScreen({ snapshot, theme, zh }: { snapshot: DiffSnapshot; theme: Theme; zh: boolean }) {
  return (
    <box flexDirection="column" width="100%" padding={1}>
      <Heading theme={theme}>{zh ? '工作区未提交 Diff' : 'Uncommitted workspace diff'}</Heading>
      <Line color={theme.muted}>{`${snapshot.updatedAt || ''}${snapshot.loading ? ` · ${zh ? '刷新中' : 'refreshing'}` : ''}`}</Line>
      {snapshot.error ? <Line color={theme.bad}>{snapshot.error}</Line> : null}
      {!snapshot.error && !snapshot.lines.length ? <Line color={theme.muted}>{zh ? '工作区没有未提交更改。' : 'Working tree is clean.'}</Line> : null}
      {snapshot.lines.map((line, index) => <Line key={`${index}-${line.slice(0, 30)}`} color={colorFor(line, theme)} bold={line.startsWith('diff --git')}>{line || ' '}</Line>)}
      {snapshot.truncated ? <Line color={theme.warn}>{zh ? 'Diff 已达到安全上限并截断。' : 'Diff capture truncated at safety limit.'}</Line> : null}
    </box>
  );
}
