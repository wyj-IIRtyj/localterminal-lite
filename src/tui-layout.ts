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

export function mouseWheelDelta(input: string): number {
  let delta = 0;
  for (const match of input.matchAll(/\u001b\[<(64|65);\d+;\d+[Mm]/g)) delta += match[1] === '64' ? -3 : 3;
  return delta;
}
