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

export type TerminalMouseInput = { isMouse: boolean; wheelDelta: number };

export function terminalMouseInput(input: string): TerminalMouseInput {
  let isMouse = false; let wheelDelta = 0;
  for (const match of input.matchAll(/\u001b\[<(\d+);\d+;\d+[Mm]/g)) {
    isMouse = true; const button = Number.parseInt(match[1], 10);
    if ((button & 64) !== 0) wheelDelta += (button & 1) === 0 ? -3 : 3;
  }
  if (/\u001b\[M[\s\S]{3}/.test(input)) isMouse = true;
  return { isMouse, wheelDelta };
}

export function mouseWheelDelta(input: string): number {
  return terminalMouseInput(input).wheelDelta;
}
