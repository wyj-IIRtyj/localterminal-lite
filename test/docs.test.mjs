import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ['.git', 'dist', 'node_modules'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test('bilingual documentation links resolve and private archive data is not published', () => {
  const markdown = walk(root).filter((file) => file.endsWith('.md'));
  assert.ok(markdown.some((file) => file.endsWith('README.zh-CN.md')));
  for (const file of markdown) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\/wyj|Actions-Tutorial|ChatGPT-GPTHomePage/, file);
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      assert.ok(fs.existsSync(resolved), `${path.relative(root, file)} -> ${target}`);
    }
  }
  const publishedAssets = walk(path.join(root, 'docs', 'assets'));
  assert.equal(publishedAssets.some((file) => /\.(html|css|js)$/i.test(file)), false);
  assert.equal(publishedAssets.filter((file) => file.endsWith('.jpg')).length, 8);
  assert.equal(publishedAssets.filter((file) => file.endsWith('.svg')).length, 6);
  for (const file of publishedAssets.filter((item) => item.endsWith('.jpg'))) {
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], file);
  }
});

test('stable release metadata and zero-environment installers stay pinned to v1.0.1', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.1');
  assert.equal(pkg.license, 'Apache-2.0');
  for (const file of ['README.md', 'README.zh-CN.md', 'scripts/install-macos.sh', 'scripts/install-windows.ps1']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /v1\.0\.1/);
  }
});

test('both READMEs explain Chat mode purpose and repeat-launch commands', () => {
  const english = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const chinese = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
  assert.match(english, /normal chat mode a controlled way to work on your local computer/);
  assert.match(chinese, /普通 Chat 对话模式也能以可控方式在本地电脑上工作/);
  assert.match(english, /Start it again later/);
  assert.match(chinese, /第二次及以后快速启动/);
  assert.match(english, /register the global `localterminal-lite` command/);
  assert.match(chinese, /把 `localterminal-lite` 注册成当前用户的全局命令/);
  assert.match(english, /```text\r?\nlocalterminal-lite\r?\n```/);
  assert.match(chinese, /```text\r?\nlocalterminal-lite\r?\n```/);
});

test('installers persist a global launcher that records actual Bun and install paths', () => {
  const mac = fs.readFileSync(path.join(root, 'scripts', 'install-macos.sh'), 'utf8');
  const windows = fs.readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8');
  assert.match(mac, /launcher_path="\$launcher_dir\/localterminal-lite"/);
  assert.match(mac, /exec %q run src\/cli\.ts/);
  assert.match(mac, /add_launcher_to_path/);
  assert.match(windows, /localterminal-lite\.cmd/);
  assert.match(windows, /SetEnvironmentVariable\("Path", \$NewUserPath, "User"\)/);
  assert.match(windows, /run src\/cli\.ts @args/);
});
