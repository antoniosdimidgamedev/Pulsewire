import type { AppConfig, ColorMode } from "./config.ts";

export const VERSION = "0.1.0";

export interface RunOverrides {
  provider?: string;
  demo?: boolean;
  ascii?: boolean;
  color?: ColorMode;
  configPath?: string;
  dataDir?: string;
  ai?: boolean;
  aiModel?: string;
}

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; overrides: RunOverrides }
  | { kind: "print-config"; overrides: RunOverrides }
  | { kind: "reset-demo"; overrides: RunOverrides; yes: boolean }
  | { kind: "auth-google"; overrides: RunOverrides; noBrowser: boolean }
  | { kind: "auth-status"; overrides: RunOverrides }
  | { kind: "error"; message: string };

/**
 * Parse CLI arguments without touching global state.
 *
 * Keeping this pure makes the command surface testable on both platforms.
 */
export function parseArgs(argv: string[]): Command {
  const overrides: RunOverrides = {};
  let command: Command["kind"] = "run";
  let authSubcommand: string | undefined;
  let noBrowser = false;
  let yes = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case "-h":
      case "--help":
        command = "help";
        break;
      case "-V":
      case "--version":
        command = "version";
        break;
      case "--print-config":
        command = "print-config";
        break;
      case "--reset-demo":
        command = "reset-demo";
        break;
      case "--demo":
        overrides.demo = true;
        break;
      case "--ai":
        overrides.ai = true;
        break;
      case "--no-ai":
        overrides.ai = false;
        break;
      case "--ai-model": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--ai-model needs a model name." };
        }
        const model = value.trim();
        if (model.length > 100) {
          return { kind: "error", message: "--ai-model must be 100 characters or fewer." };
        }
        overrides.aiModel = model;
        overrides.ai = true;
        break;
      }
      case "--ascii":
        overrides.ascii = true;
        break;
      case "--no-color":
        overrides.color = "none";
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      case "--no-browser":
        noBrowser = true;
        break;
      case "--provider": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--provider needs a value." };
        overrides.provider = value;
        break;
      }
      case "--color": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--color needs a value." };
        if (!isColorMode(value)) {
          return {
            kind: "error",
            message: "--color must be one of: auto, truecolor, ansi256, none.",
          };
        }
        overrides.color = value;
        break;
      }
      case "--config": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--config needs a file path." };
        overrides.configPath = value;
        break;
      }
      case "--data-dir": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--data-dir needs a directory." };
        overrides.dataDir = value;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          return { kind: "error", message: `Unknown option "${arg}".` };
        }
        positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    if (positionals[0] === "auth") {
      authSubcommand = positionals[1];
      if (positionals.length > 2) {
        return { kind: "error", message: "Too many arguments for `auth`." };
      }
      if (authSubcommand === "google") command = "auth-google";
      else if (authSubcommand === "status") command = "auth-status";
      else {
        return {
          kind: "error",
          message: "`auth` requires `google` or `status`. Try `pulsewire auth google`.",
        };
      }
    } else {
      return {
        kind: "error",
        message: `Unknown command "${positionals[0]}". Try \`pulsewire --help\`.`,
      };
    }
  }

  const normalized = command;
  switch (normalized) {
    case "help":
      return { kind: "help" };
    case "version":
      return { kind: "version" };
    case "print-config":
      return { kind: "print-config", overrides };
    case "reset-demo":
      return { kind: "reset-demo", overrides, yes };
    case "auth-google":
      return { kind: "auth-google", overrides, noBrowser };
    case "auth-status":
      return { kind: "auth-status", overrides };
    default:
      return { kind: "run", overrides };
  }
}

export function helpText(): string {
  return `Pulsewire ${VERSION} — a terminal team chat client

Usage:
  pulsewire                      Start the TUI (demo workspace by default)
  pulsewire auth google          Sign in to Google Chat with OAuth
  pulsewire auth status          Show the signed-in Google account
  pulsewire --print-config       Print resolved configuration (secrets redacted)
  pulsewire --reset-demo         Delete local demo data and start fresh

Options:
  --demo                         Force the local demo provider
  --ai                           Enable local AI replies in the demo
  --ai-model <name>              Enable AI replies with a specific model
  --no-ai                        Disable AI replies from the config file
  --provider <name>              demo (default) or googlechat
  --config <file>                Use a specific config.json
  --data-dir <dir>               Override the local data directory
  --ascii                        Use ASCII glyphs instead of box drawing
  --color <mode>                 auto, truecolor, ansi256, none
  --no-color                     Same as --color none
  --no-browser                   Do not open a browser during auth
  --reset-demo --yes             Reset demo data without asking
  -h, --help                     Show this help
  -V, --version                  Show the version

Environment:
  PULSEWIRE_CONFIG, PULSEWIRE_PROVIDER, PULSEWIRE_DISPLAY_NAME,
  PULSEWIRE_DATA_DIR, PULSEWIRE_COLOR, PULSEWIRE_ASCII,
  PULSEWIRE_SIMULATE_ACTIVITY
  PULSEWIRE_AI, PULSEWIRE_AI_BASE_URL, PULSEWIRE_AI_MODEL,
  PULSEWIRE_AI_TIMEOUT_MS
  GOOGLE_CHAT_CREDENTIALS_FILE, GOOGLE_CHAT_CLIENT_ID,
  GOOGLE_CHAT_CLIENT_SECRET, GOOGLE_CHAT_TOKEN_FILE,
  GOOGLE_CHAT_ACCESS_TOKEN, GOOGLE_CHAT_USER_RESOURCE,
  GOOGLE_CHAT_POLL_INTERVAL_MS, GOOGLE_CHAT_MAX_SPACES

Shortcuts:
  Tab / Shift+Tab  Move focus       ? / F1  Help       Ctrl+C  Quit
  ↑↓               Navigate         Enter   Open/send   Esc     Back
  r  Reply thread   t  Open thread   e  Edit message   d  Delete
  s or /  Search    g / G  Top/bottom                [ ]  Prev/next chat

Google Chat is optional. The demo provider contacts nothing unless --ai is
enabled, and then it only calls the local model endpoint you configure.
`;
}

export function isColorMode(value: string): value is ColorMode {
  return value === "auto" || value === "truecolor" || value === "ansi256" || value === "none";
}

/** Apply command-line overrides without introducing a second config type. */
export function applyOverrides(config: AppConfig, overrides: RunOverrides): AppConfig {
  if (overrides.demo) config.provider = "demo";
  else if (overrides.provider) config.provider = overrides.provider.trim();
  if (overrides.ascii) config.ascii = true;
  if (overrides.color) config.color = overrides.color;
  if (overrides.ai !== undefined) config.demo.ai.enabled = overrides.ai;
  if (overrides.aiModel) {
    config.demo.ai.model = overrides.aiModel.trim();
    config.demo.ai.enabled = true;
  }
  return config;
}
