import type { LiteRuntime } from '../server.js';
import type { LiteSettings } from '../types.js';

/** Presentation-only navigation target. Domain state remains in LiteStore. */
export type Detail = { kind: 'session'; id: string } | { kind: 'conversation'; id: string };

export type RuntimeReconfigureResult = { runtime: LiteRuntime; error?: string };
export type RuntimeReconfigure = (settings: LiteSettings) => Promise<RuntimeReconfigureResult>;

/** Declarative form contract shared by Setup, Settings, and modal forms. */
export type FormQuestion = {
  label: string | ((previous: string[]) => string);
  fallback?: string;
  multiline?: boolean;
  sensitive?: boolean;
  options?: string[];
  optionLabels?: string[];
  optionDescriptions?: string[];
  optionBadges?: Array<{ label: string; tone?: 'good' | 'warn' | 'muted' }>;
  optionDisabled?: boolean[];
  optionsLayout?: 'row' | 'column';
  multiSelect?: boolean;
  validate?: (value: string, previous: string[]) => string | undefined | Promise<string | undefined>;
};

export type Ask = (questions: FormQuestion[], preamble?: string[]) => Promise<string[] | undefined>;
