import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider } from '@opentui/keymap/react';
import { createRoot, type Root } from '@opentui/react';
import { createElement } from 'react';
import type { LiteRuntime } from '../server.js';
import type { WorkspaceRecord } from '../instances.js';
import { selectedWorkspace } from '../workspace-selection.js';
import type { LiteSettings } from '../types.js';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { themeFor, TuiController, type FormQuestion, type RuntimeReconfigure } from './state.js';
import { FormDialog } from './components/FormDialog.js';
import { buildWorkspaceSelectorModel } from './workspace-selector.js';

export type { RuntimeReconfigure, RuntimeReconfigureResult } from './state.js';

async function createRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    targetFps: 60,
    exitOnCtrlC: false,
    clearOnShutdown: true,
    screenMode: 'alternate-screen',
    useMouse: true,
    autoFocus: true,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  });
}

function renderWithKeymap(renderer: CliRenderer, node: ReturnType<typeof createElement>): Root {
  const keymap = createDefaultOpenTuiKeymap(renderer);
  const root = createRoot(renderer);
  root.render(createElement(KeymapProvider, { keymap }, node));
  return root;
}

export async function runSetupTui(defaults: LiteSettings, records: WorkspaceRecord[] = []): Promise<LiteSettings> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('First launch requires the TUI. Run `bun run dev` in an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  try {
    return await new Promise<LiteSettings>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(Setup, {
        defaults,
        records,
        onComplete: resolve,
        onCancel: () => reject(new Error('Setup cancelled.')),
      }));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export async function runWorkspaceChooserTui(records: WorkspaceRecord[], currentWorkspaceDir: string, zh = true): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Workspace selection requires an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  const { items, question } = buildWorkspaceSelectorModel({
    label: zh ? '选择工作区' : 'Select workspace',
    records,
    currentWorkspaceDir,
    zh,
  });
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(FormDialog, {
        questions: [question],
        preamble: [zh ? '使用方向键或鼠标选择工作区。' : 'Choose a workspace with arrow keys or the mouse.'],
        theme: themeFor('dark'),
        width: renderer.width,
        height: renderer.height,
        zh,
        onComplete: (answers: string[]) => {
          const selected = selectedWorkspace(items, answers[0]);
          if (!selected) reject(new Error('Invalid workspace selection.'));
          else if (selected.disabled) reject(new Error(`Workspace is already active: ${selected.workspaceDir}`));
          else resolve(selected.workspaceDir);
        },
        onCancel: () => resolve(undefined),
      }));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export async function runChoiceTui(question: FormQuestion, preamble: string[], zh = true): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Choice requires an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(FormDialog, {
        questions: [question],
        preamble,
        theme: themeFor('dark'),
        width: renderer.width,
        height: renderer.height,
        zh,
        onComplete: (answers: string[]) => resolve(answers[0] || question.fallback || ''),
        onCancel: () => resolve('cancel'),
      }));
    });
  } finally {
    root?.unmount();
    renderer.destroy();
  }
}

export class LiteTui {
  constructor(private readonly runtime: LiteRuntime, private readonly reconfigure: RuntimeReconfigure) {}

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive TUI requires a TTY. Use --headless for service mode.');
    const controller = new TuiController(this.runtime, this.reconfigure);
    controller.start();
    const renderer = await createRenderer();
    let root: Root | undefined;
    try {
      await new Promise<void>((resolve) => {
        root = renderWithKeymap(renderer, createElement(App, { controller, onExit: resolve }));
      });
    } finally {
      root?.unmount();
      await controller.shutdown();
      renderer.destroy();
    }
  }
}
