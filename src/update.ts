import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_VERSION } from './version.js';

export { CURRENT_VERSION } from './version.js';
const REPOSITORY = 'wyj-IIRtyj/localterminal-lite';

export type UpdateStatus = {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  checking: boolean;
  error?: string;
  restartRequired?: boolean;
  runningClusterVersions?: string[];
};

function versionParts(value: string): number[] {
  return value.replace(/^v/, '').split('.').map((item) => Number.parseInt(item, 10) || 0);
}

export function isNewerVersion(latest: string, current = CURRENT_VERSION): boolean {
  const left = versionParts(latest);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return false;
}

export async function checkForUpdate(fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `localterminal-lite/${CURRENT_VERSION}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
    const data = await response.json() as { tag_name?: string };
    if (!data.tag_name) throw new Error('Latest GitHub release did not contain a tag name.');
    return { currentVersion: CURRENT_VERSION, latestVersion: data.tag_name.replace(/^v/, ''), updateAvailable: isNewerVersion(data.tag_name), checkedAt: new Date().toISOString(), checking: false };
  } catch (error) {
    return { currentVersion: CURRENT_VERSION, updateAvailable: false, checkedAt: new Date().toISOString(), checking: false, error: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timeout); }
}

export function installationRoot(): string {
  if (process.env.LOCALTERMINAL_LITE_HOME) return path.resolve(process.env.LOCALTERMINAL_LITE_HOME);
  const executableName = path.basename(process.execPath).toLowerCase();
  if (executableName === 'localterminal-lite' || executableName === 'localterminal-lite.exe') {
    const releaseDir = path.dirname(process.execPath);
    const releasesDir = path.dirname(releaseDir);
    if (path.basename(releasesDir) === 'releases') return path.dirname(releasesDir);
    return releaseDir;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function installedVersion(root = installationRoot()): string | undefined {
  try {
    const current = readFileSync(path.join(root, 'current'), 'utf8').trim();
    return current.replace(/^v/, '') || undefined;
  } catch { return undefined; }
}

export function isSourceCheckout(packageRoot = installationRoot()): boolean {
  return existsSync(path.join(packageRoot, '.git'));
}

export async function installUpdate(tag: string): Promise<void> {
  const normalized = tag.startsWith('v') ? tag : `v${tag}`;
  const rawBase = `https://raw.githubusercontent.com/${REPOSITORY}/${normalized}/scripts`;
  const script = process.platform === 'win32'
    ? 'install-windows.ps1'
    : process.platform === 'linux' ? 'install-linux.sh' : 'install-macos.sh';
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$env:LOCALTERMINAL_LITE_INSTALL_ONLY='1'; irm '${rawBase}/${script}' | iex`]
    : ['-lc', `export LOCALTERMINAL_LITE_INSTALL_ONLY=1; curl -fsSL '${rawBase}/${script}' | /bin/bash`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, LOCALTERMINAL_LITE_HOME: installationRoot() },
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Updater exited with code ${code ?? 'unknown'}.`)));
  });
}
