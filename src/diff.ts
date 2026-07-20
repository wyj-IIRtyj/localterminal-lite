import { spawn } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LiteConfig } from './types.js';

export type DiffSnapshot = { lines: string[]; updatedAt?: string; loading: boolean; truncated: boolean; error?: string; unavailableReason?: 'not-git-repository' | 'git-unavailable' };

async function capture(args: string[], cwd: string, maxChars: number, timeoutMs = 8_000): Promise<{ text: string; exitCode: number; truncated: boolean }> {
  const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; let stderr = ''; let truncated = false;
  let settled = false;
  const timer = setTimeout(() => {
    truncated = true;
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 500).unref();
  }, timeoutMs);
  timer.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, maxChars - text.length);
    if (remaining > 0) text += chunk.subarray(0, remaining).toString('utf8');
    if (chunk.length > remaining) truncated = true;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, 20_000 - stderr.length);
    if (remaining > 0) stderr += chunk.subarray(0, remaining).toString('utf8');
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
    child.once('close', (code) => { if (!settled) { settled = true; resolve(code ?? 1); } });
  }).finally(() => clearTimeout(timer));
  if (exitCode !== 0 && !truncated) throw new Error(stderr.trim() || `git exited with ${exitCode}`);
  return { text, exitCode, truncated };
}

async function sampleUntrackedFile(file: string, maxBytes: number): Promise<{ bytes: Buffer; size: number }> {
  const info = await stat(file);
  if (!info.isFile()) return { bytes: Buffer.alloc(0), size: 0 };
  const length = Math.min(info.size, maxBytes);
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return { bytes: bytes.subarray(0, bytesRead), size: info.size };
  } finally { await handle.close(); }
}

/**
 * Optional Git capability adapter for the TUI.
 *
 * The tracker is deliberately isolated from core runtime availability: Git may
 * be absent, a workspace may not be a repository, subprocesses may stall, and
 * files may be binary or arbitrarily large. Every boundary is therefore
 * fail-soft, time-bounded, output-bounded, and file-sampling only.
 */
export class WorkspaceDiffTracker {
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private repositoryState: 'unknown' | 'available' | 'not-git-repository' | 'git-unavailable' = 'unknown';
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
      if (this.repositoryState === 'unknown') {
        try {
          const probe = await capture(['rev-parse', '--is-inside-work-tree'], this.config.workspaceDir, 1000);
          this.repositoryState = probe.text.trim() === 'true' ? 'available' : 'not-git-repository';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.repositoryState = /ENOENT|not found|cannot find/i.test(message) ? 'git-unavailable' : 'not-git-repository';
        }
      }
      if (this.repositoryState !== 'available') {
        this.value = {
          lines: [],
          updatedAt: new Date().toISOString(),
          loading: false,
          truncated: false,
          unavailableReason: this.repositoryState,
        };
        return;
      }
      const [diff, status] = await Promise.all([
        capture(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--', '.'], this.config.workspaceDir, this.maxChars),
        capture(['status', '--porcelain=v1', '-z', '--untracked-files=all'], this.config.workspaceDir, 1_000_000),
      ]);
      const lines = diff.text.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1);
      let used = diff.text.length; let truncated = diff.truncated;
      const untracked = status.text.split('\0').filter((record) => record.startsWith('?? ')).map((record) => record.slice(3));
      const workspaceRoot = await realpath(this.config.workspaceDir);
      const stateRoot = await realpath(this.config.stateDir).catch(() => path.resolve(this.config.stateDir));
      for (const relative of untracked) {
        if (used >= this.maxChars) { truncated = true; break; }
        const absolute = path.resolve(workspaceRoot, relative);
        const lexical = path.relative(workspaceRoot, absolute);
        if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) continue;
        try {
          const resolved = await realpath(absolute);
          const workspaceRelative = path.relative(workspaceRoot, resolved);
          const stateRelative = path.relative(stateRoot, resolved);
          if (workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)) continue;
          if (!stateRelative.startsWith('..') && !path.isAbsolute(stateRelative)) continue;
          const allowance = Math.min(256_000, this.maxChars - used);
          const sample = await sampleUntrackedFile(resolved, Math.max(8_000, allowance));
          if (!sample.size) continue;
          const binaryProbe = sample.bytes.subarray(0, Math.min(sample.bytes.length, 8000));
          if (binaryProbe.includes(0)) {
            lines.push(`diff --git a/${relative} b/${relative}`, 'new file mode 100644', `Binary file ${relative} is untracked (${sample.size} bytes)`); used += relative.length + 96; continue;
          }
          const content = sample.bytes.subarray(0, allowance).toString('utf8'); const contentLines = content.split(/\r?\n/);
          lines.push(`diff --git a/${relative} b/${relative}`, 'new file mode 100644', '--- /dev/null', `+++ b/${relative}`, `@@ -0,0 +1,${contentLines.length} @@`, ...contentLines.map((line) => `+${line}`));
          used += content.length; if (sample.size > allowance) { lines.push(`+… ${sample.size - allowance} bytes omitted …`); truncated = true; }
        } catch { lines.push(`diff --git a/${relative} b/${relative}`, `untracked file unavailable: ${relative}`); }
      }
      this.value = { lines, updatedAt: new Date().toISOString(), loading: false, truncated, unavailableReason: undefined };
    } catch (error) {
      this.value = { lines: [], updatedAt: new Date().toISOString(), loading: false, truncated: false, error: error instanceof Error ? error.message : String(error) };
    } finally { this.refreshing = false; }
  }
}
