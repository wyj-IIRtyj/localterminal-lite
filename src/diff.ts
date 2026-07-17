import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LiteConfig } from './types.js';

export type DiffSnapshot = { lines: string[]; updatedAt?: string; loading: boolean; truncated: boolean; error?: string };

async function capture(args: string[], cwd: string, maxChars: number): Promise<{ text: string; exitCode: number; truncated: boolean }> {
  const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; let stderr = ''; let truncated = false;
  child.stdout.on('data', (chunk: Buffer) => { if (text.length < maxChars) text += chunk.toString('utf8'); else truncated = true; });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 20_000) stderr += chunk.toString('utf8'); });
  const exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
  if (exitCode !== 0) throw new Error(stderr.trim() || `git exited with ${exitCode}`);
  return { text: text.slice(0, maxChars), exitCode, truncated };
}

export class WorkspaceDiffTracker {
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private value: DiffSnapshot = { lines: [], loading: true, truncated: false };

  constructor(private readonly config: LiteConfig, private readonly intervalMs = 2000, private readonly maxChars = 5_000_000) {}

  start(): void {
    void this.refresh();
    this.timer ||= setInterval(() => void this.refresh(), this.intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  snapshot(): DiffSnapshot { return { ...this.value, lines: [...this.value.lines] }; }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true; this.value = { ...this.value, loading: true };
    try {
      const [diff, status] = await Promise.all([
        capture(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--unified=3', '--', '.'], this.config.workspaceDir, this.maxChars),
        capture(['status', '--porcelain=v1', '-z', '--untracked-files=all'], this.config.workspaceDir, 1_000_000),
      ]);
      const lines = diff.text.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1);
      let used = diff.text.length; let truncated = diff.truncated;
      const untracked = status.text.split('\0').filter((record) => record.startsWith('?? ')).map((record) => record.slice(3));
      for (const relative of untracked) {
        if (used >= this.maxChars) { truncated = true; break; }
        const absolute = path.resolve(this.config.workspaceDir, relative);
        if (!absolute.startsWith(`${this.config.workspaceDir}${path.sep}`) || absolute.startsWith(`${this.config.stateDir}${path.sep}`)) continue;
        try {
          const info = await stat(absolute); if (!info.isFile()) continue;
          const buffer = await readFile(absolute); const allowance = Math.min(buffer.length, 256_000, this.maxChars - used);
          if (buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0)) {
            lines.push(`diff --git a/${relative} b/${relative}`, 'new file mode 100644', `Binary file ${relative} is untracked`); used += relative.length + 80; continue;
          }
          const content = buffer.subarray(0, allowance).toString('utf8'); const contentLines = content.split(/\r?\n/);
          lines.push(`diff --git a/${relative} b/${relative}`, 'new file mode 100644', '--- /dev/null', `+++ b/${relative}`, `@@ -0,0 +1,${contentLines.length} @@`, ...contentLines.map((line) => `+${line}`));
          used += content.length; if (allowance < buffer.length) { lines.push(`+… ${buffer.length - allowance} bytes omitted …`); truncated = true; }
        } catch { lines.push(`diff --git a/${relative} b/${relative}`, `untracked file unavailable: ${relative}`); }
      }
      this.value = { lines, updatedAt: new Date().toISOString(), loading: false, truncated };
    } catch (error) {
      this.value = { lines: [], updatedAt: new Date().toISOString(), loading: false, truncated: false, error: error instanceof Error ? error.message : String(error) };
    } finally { this.refreshing = false; }
  }
}
