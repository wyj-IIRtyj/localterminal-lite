import wrapAnsi from 'wrap-ansi';

export function wrapTerminalLine(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return value.replace(/\r/g, '').split('\n').flatMap((line) => {
    if (!line) return [''];
    return wrapAnsi(line, safeWidth, { hard: true, wordWrap: false, trim: false }).split('\n');
  });
}

export function wrapTerminalLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => wrapTerminalLine(line, width));
}

export function terminalFrame(lines: string[], width: number): { signature: string; output: string } {
  const rows = lines.map((line) => wrapTerminalLine(line, width)[0] || '');
  return { signature: rows.join('\n'), output: `\u001b[H${rows.map((row) => `${row}\u001b[K`).join('\n')}\u001b[J` };
}
