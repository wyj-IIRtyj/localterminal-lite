import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { KeymapProvider } from '@opentui/keymap/react';
import { createRoot, type Root } from '@opentui/react';
import { createElement } from 'react';
import type { LiteRuntime } from '../server.js';
import type { LiteSettings } from '../types.js';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { TuiController, type RuntimeReconfigure } from './state.js';

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

export async function runSetupTui(defaults: LiteSettings): Promise<LiteSettings> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('First launch requires the TUI. Run `bun run dev` in an interactive terminal.');
  const renderer = await createRenderer();
  let root: Root | undefined;
  try {
    return await new Promise<LiteSettings>((resolve, reject) => {
      root = renderWithKeymap(renderer, createElement(Setup, {
        defaults,
        onComplete: resolve,
        onCancel: () => reject(new Error('Setup cancelled.')),
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
