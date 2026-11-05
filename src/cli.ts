import type { AppConfig, ColorMode } from "./config.ts";

export const VERSION = "0.1.0";

export interface RunOverrides {
  provider?: string;
  demo?: boolean;
  ascii?: boolean;
  color?: ColorMode;
  configPath?: string;
  dataDir?: string;
  serverUrl?: string;
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
  | {
    kind: "register";
    overrides: RunOverrides;
    handle: string;
    displayName?: string;
    passwordStdin: boolean;
  }
  | { kind: "login"; overrides: RunOverrides; handle: string; passwordStdin: boolean }
  | { kind: "logout"; overrides: RunOverrides }
  | { kind: "whoami"; overrides: RunOverrides }
  | {
    kind: "profile";
    overrides: RunOverrides;
    displayName?: string;
    handle?: string;
  }
  | { kind: "conversations"; overrides: RunOverrides }
  | {
    kind: "history";
    overrides: RunOverrides;
    conversation: string;
    limit?: number;
    before?: number;
  }
  | {
    kind: "send";
    overrides: RunOverrides;
    conversation: string;
    body: string;
    replyTo?: string;
  }
  | { kind: "search"; overrides: RunOverrides; query: string }
  | { kind: "new-dm"; overrides: RunOverrides; handle: string }
  | {
    kind: "new-group";
    overrides: RunOverrides;
    name: string;
    members: string[];
  }
  | { kind: "members"; overrides: RunOverrides; conversation: string }
  | { kind: "invite"; overrides: RunOverrides; conversation: string; handle: string }
  | {
    kind: "remove-member";
    overrides: RunOverrides;
    conversation: string;
    member: string;
  }
  | { kind: "leave"; overrides: RunOverrides; conversation: string }
  | { kind: "read"; overrides: RunOverrides; conversation: string }
  | {
    kind: "serve";
    overrides: RunOverrides;
    host?: string;
    port?: number;
    dbPath?: string;
  }
  | { kind: "error"; message: string };

interface ParsedFlags {
  overrides: RunOverrides;
  command: Command["kind"];
  noBrowser: boolean;
  yes: boolean;
  passwordStdin: boolean;
  name?: string;
  handle?: string;
  host?: string;
  port?: number;
  dbPath?: string;
  limit?: number;
  before?: number;
  replyTo?: string;
}

/**
 * Parse CLI arguments without touching global state.
 *
 * Keeping this pure makes the command surface testable on both platforms.
 */
export function parseArgs(argv: string[]): Command {
  const flags = parseFlags(argv);
  if (flags.kind === "error") return flags;
  const positionals = flags.positionals;

  if (positionals.length > 0 && flags.command === "run") {
    return routeCommand(positionals, flags);
  }
  if (positionals.length > 0) {
    return { kind: "error", message: `Unexpected argument "${positionals[0]}".` };
  }

  switch (flags.command) {
    case "help":
      return { kind: "help" };
    case "version":
      return { kind: "version" };
    case "print-config":
      return { kind: "print-config", overrides: flags.overrides };
    case "reset-demo":
      return { kind: "reset-demo", overrides: flags.overrides, yes: flags.yes };
    case "auth-google":
      return { kind: "auth-google", overrides: flags.overrides, noBrowser: flags.noBrowser };
    case "auth-status":
      return { kind: "auth-status", overrides: flags.overrides };
    default:
      return { kind: "run", overrides: flags.overrides };
  }
}

interface FlagsResult {
  kind: "flags";
  positionals: string[];
  overrides: RunOverrides;
  command: Command["kind"];
  noBrowser: boolean;
  yes: boolean;
  passwordStdin: boolean;
  name?: string;
  handle?: string;
  host?: string;
  port?: number;
  dbPath?: string;
  limit?: number;
  before?: number;
  replyTo?: string;
}

function parseFlags(argv: string[]): FlagsResult | { kind: "error"; message: string } {
  const overrides: RunOverrides = {};
  let command: Command["kind"] = "run";
  let noBrowser = false;
  let yes = false;
  let passwordStdin = false;
  let name: string | undefined;
  let handle: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let dbPath: string | undefined;
  let limit: number | undefined;
  let before: number | undefined;
  let replyTo: string | undefined;
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
      case "--password-stdin":
        passwordStdin = true;
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
      case "--name": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--name needs a display name." };
        }
        name = value.trim();
        break;
      }
      case "--handle": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--handle needs a handle." };
        }
        handle = value.trim();
        break;
      }
      case "--host": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--host needs a value." };
        }
        host = value.trim();
        break;
      }
      case "--port": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--port needs a number." };
        const parsed = parseIntegerFlag(value, "--port", 1, 65_535);
        if (typeof parsed !== "number") return parsed;
        port = parsed;
        break;
      }
      case "--db": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--db needs a file path." };
        }
        dbPath = value.trim();
        break;
      }
      case "--limit": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--limit needs a number." };
        const parsed = parseIntegerFlag(value, "--limit", 1, 100);
        if (typeof parsed !== "number") return parsed;
        limit = parsed;
        break;
      }
      case "--before": {
        const value = argv[++index];
        if (!value) return { kind: "error", message: "--before needs a message sequence." };
        const parsed = parseIntegerFlag(value, "--before", 0, Number.MAX_SAFE_INTEGER);
        if (typeof parsed !== "number") return parsed;
        before = parsed;
        break;
      }
      case "--reply-to": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--reply-to needs a message id." };
        }
        replyTo = value.trim();
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
      case "--server": {
        const value = argv[++index];
        if (!value || !value.trim()) {
          return { kind: "error", message: "--server needs a URL." };
        }
        overrides.serverUrl = value.trim();
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

  return {
    kind: "flags",
    positionals,
    overrides,
    command,
    noBrowser,
    yes,
    passwordStdin,
    ...(name !== undefined ? { name } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(dbPath !== undefined ? { dbPath } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

function routeCommand(
  positionals: string[],
  flags: FlagsResult,
): Command {
  const [name, ...rest] = positionals;
  const overrides = flags.overrides;
  switch (name) {
    case "auth":
      if (rest.length > 1) {
        return { kind: "error", message: "Too many arguments for `auth`." };
      }
      if (rest[0] === "google") {
        return { kind: "auth-google", overrides, noBrowser: flags.noBrowser };
      }
      if (rest[0] === "status") return { kind: "auth-status", overrides };
      return {
        kind: "error",
        message: "`auth` requires `google` or `status`. Try `pulsewire auth google`.",
      };
    case "register": {
      const handle = rest[0];
      if (!handle) return { kind: "error", message: "`register` needs a handle." };
      if (rest.length > 1) {
        return { kind: "error", message: "Too many arguments for `register`." };
      }
      return {
        kind: "register",
        overrides,
        handle,
        passwordStdin: flags.passwordStdin,
        ...(flags.name !== undefined ? { displayName: flags.name } : {}),
      };
    }
    case "login": {
      const handle = rest[0];
      if (!handle) return { kind: "error", message: "`login` needs a handle." };
      if (rest.length > 1) {
        return { kind: "error", message: "Too many arguments for `login`." };
      }
      return { kind: "login", overrides, handle, passwordStdin: flags.passwordStdin };
    }
    case "logout":
      if (rest.length > 0) return { kind: "error", message: "`logout` takes no arguments." };
      return { kind: "logout", overrides };
    case "whoami":
      if (rest.length > 0) return { kind: "error", message: "`whoami` takes no arguments." };
      return { kind: "whoami", overrides };
    case "profile":
      if (rest.length > 0) return { kind: "error", message: "`profile` takes no arguments." };
      if (flags.name === undefined && flags.handle === undefined) {
        return {
          kind: "error",
          message: "`profile` needs --name and/or --handle to update.",
        };
      }
      return {
        kind: "profile",
        overrides,
        ...(flags.name !== undefined ? { displayName: flags.name } : {}),
        ...(flags.handle !== undefined ? { handle: flags.handle } : {}),
      };
    case "conversations":
      if (rest.length > 0) {
        return { kind: "error", message: "`conversations` takes no arguments." };
      }
      return { kind: "conversations", overrides };
    case "history": {
      const conversation = rest[0];
      if (!conversation) return { kind: "error", message: "`history` needs a conversation." };
      if (rest.length > 1) return { kind: "error", message: "Too many arguments for `history`." };
      return {
        kind: "history",
        overrides,
        conversation,
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        ...(flags.before !== undefined ? { before: flags.before } : {}),
      };
    }
    case "send": {
      const conversation = rest[0];
      const body = rest.slice(1).join(" ").trim();
      if (!conversation) return { kind: "error", message: "`send` needs a conversation." };
      if (!body) return { kind: "error", message: "`send` needs a message body." };
      return {
        kind: "send",
        overrides,
        conversation,
        body,
        ...(flags.replyTo !== undefined ? { replyTo: flags.replyTo } : {}),
      };
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) return { kind: "error", message: "`search` needs a query." };
      return { kind: "search", overrides, query };
    }
    case "new-dm": {
      const handle = rest[0];
      if (!handle) return { kind: "error", message: "`new-dm` needs a handle." };
      if (rest.length > 1) return { kind: "error", message: "Too many arguments for `new-dm`." };
      return { kind: "new-dm", overrides, handle };
    }
    case "new-group": {
      const groupName = rest[0];
      const members = rest.slice(1);
      if (!groupName) return { kind: "error", message: "`new-group` needs a name." };
      if (members.length === 0) {
        return { kind: "error", message: "`new-group` needs at least one member handle." };
      }
      return { kind: "new-group", overrides, name: groupName, members };
    }
    case "members": {
      const conversation = rest[0];
      if (!conversation) return { kind: "error", message: "`members` needs a conversation." };
      if (rest.length > 1) return { kind: "error", message: "Too many arguments for `members`." };
      return { kind: "members", overrides, conversation };
    }
    case "invite": {
      const conversation = rest[0];
      const memberHandle = rest[1];
      if (!conversation || !memberHandle) {
        return { kind: "error", message: "`invite` needs a conversation and a handle." };
      }
      if (rest.length > 2) return { kind: "error", message: "Too many arguments for `invite`." };
      return {
        kind: "invite",
        overrides,
        conversation,
        handle: memberHandle,
      };
    }
    case "remove-member": {
      const conversation = rest[0];
      const member = rest[1];
      if (!conversation || !member) {
        return {
          kind: "error",
          message: "`remove-member` needs a conversation and a member.",
        };
      }
      if (rest.length > 2) {
        return { kind: "error", message: "Too many arguments for `remove-member`." };
      }
      return { kind: "remove-member", overrides, conversation, member };
    }
    case "leave":
    case "read": {
      const conversation = rest[0];
      if (!conversation) return { kind: "error", message: `\`${name}\` needs a conversation.` };
      if (rest.length > 1) return { kind: "error", message: `Too many arguments for \`${name}\`.` };
      return { kind: name, overrides, conversation } as Command;
    }
    case "serve":
      if (rest.length > 0) return { kind: "error", message: "`serve` takes no arguments." };
      return {
        kind: "serve",
        overrides,
        ...(flags.host !== undefined ? { host: flags.host } : {}),
        ...(flags.port !== undefined ? { port: flags.port } : {}),
        ...(flags.dbPath !== undefined ? { dbPath: flags.dbPath } : {}),
      };
    default:
      return {
        kind: "error",
        message: `Unknown command "${name}". Try \`pulsewire --help\`.`,
      };
  }
}

function parseIntegerFlag(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number | { kind: "error"; message: string } {
  if (!/^\d+$/.test(value.trim())) {
    return { kind: "error", message: `${name} must be an integer.` };
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    return { kind: "error", message: `${name} must be between ${minimum} and ${maximum}.` };
  }
  return parsed;
}

export function helpText(): string {
  return `Pulsewire ${VERSION} — an original terminal messaging app

Usage:
  pulsewire                         Start the TUI (Pulsewire server by default)
  pulsewire --demo                  Start the offline demo workspace
  pulsewire serve                   Run the self-hosted API server
  pulsewire register <handle>       Create an account on the server
  pulsewire login <handle>          Sign in and save a session token
  pulsewire logout                  Sign out and delete the local token
  pulsewire whoami                  Show the signed-in account
  pulsewire profile --name <name>   Update your display name or handle
  pulsewire conversations           List your conversations
  pulsewire history <conversation>  Show recent messages
  pulsewire send <conversation> <text...>
  pulsewire search <query...>       Search messages you can read
  pulsewire new-dm <handle>         Start a direct message
  pulsewire new-group <name> <handle...>
  pulsewire members <conversation>  List participants
  pulsewire invite <conversation> <handle>
  pulsewire remove-member <conversation> <handle-or-id>
  pulsewire leave <conversation>    Leave a group conversation
  pulsewire read <conversation>     Mark a conversation as read
  pulsewire auth google             Sign in to Google Chat with OAuth
  pulsewire auth status             Show the signed-in Google account

Server and account options:
  --server <url>                 Server base URL (default http://127.0.0.1:8787)
  --name <display name>          Display name for register/profile
  --handle <handle>              New handle for profile
  --password-stdin               Read the password from stdin (no prompt)
  --reply-to <message-id>        Send a threaded reply
  --limit <n>                    History page size (1-100, default 50)
  --before <seq>                 Page backwards from a message sequence

Server options:
  --host <host>                  Bind address (default 127.0.0.1)
  --port <port>                  Bind port (default 8787)
  --db <path>                    SQLite database path

Other options:
  --demo                         Force the offline demo provider
  --provider <name>              server (default), demo, or googlechat
  --config <file>                Use a specific config.json
  --data-dir <dir>               Override the local data directory
  --ai                           Enable local AI replies in the demo
  --ai-model <name>              Model name to request (default qwen3:0.6b)
  --no-ai                        Disable AI replies from the config file
  --ascii                        Use ASCII glyphs instead of box drawing
  --color <mode>                 auto, truecolor, ansi256, none
  --no-color                     Same as --color none
  --no-browser                   Do not open a browser during auth
  --print-config                 Print resolved configuration (secrets redacted)
  --reset-demo [--yes]           Delete local demo data and start fresh
  -h, --help                     Show this help
  -V, --version                  Show the version

Environment:
  PULSEWIRE_CONFIG, PULSEWIRE_PROVIDER, PULSEWIRE_DISPLAY_NAME,
  PULSEWIRE_DATA_DIR, PULSEWIRE_COLOR, PULSEWIRE_ASCII,
  PULSEWIRE_SIMULATE_ACTIVITY, PULSEWIRE_SERVER_URL,
  PULSEWIRE_SERVER_POLL_MS, PULSEWIRE_SERVER_TIMEOUT_MS
  PULSEWIRE_SERVER_HOST, PULSEWIRE_SERVER_PORT, PULSEWIRE_SERVER_DB,
  PULSEWIRE_SESSION_TTL_DAYS, PULSEWIRE_PBKDF2_ITERATIONS
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

The self-hosted server stores accounts and messages in SQLite. The offline demo
provider contacts nothing unless --ai is enabled, and then it only calls the
local model endpoint you configure. Google Chat remains an optional legacy
integration.
`;
}

export function isColorMode(value: string): value is ColorMode {
  return value === "auto" || value === "truecolor" || value === "ansi256" || value === "none";
}

/** Apply command-line overrides without introducing a second config type. */
export function applyOverrides(config: AppConfig, overrides: RunOverrides): AppConfig {
  if (overrides.demo) config.provider = "demo";
  else if (overrides.provider) config.provider = overrides.provider.trim();
  if (overrides.serverUrl) {
    config.server.baseUrl = overrides.serverUrl.trim().replace(/\/+$/, "");
  }
  if (overrides.ascii) config.ascii = true;
  if (overrides.color) config.color = overrides.color;
  if (overrides.ai !== undefined) config.demo.ai.enabled = overrides.ai;
  if (overrides.aiModel) {
    config.demo.ai.model = overrides.aiModel.trim();
    config.demo.ai.enabled = true;
  }
  return config;
}
