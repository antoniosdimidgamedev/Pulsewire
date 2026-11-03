import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type ColorMode = "auto" | "truecolor" | "ansi256" | "none";

export interface DemoConfig {
  connectDelayMs: number;
  replyDelayMs: number;
  ambientIntervalMs: number;
}

export interface AppConfig {
  provider: string;
  displayName: string;
  configPath: string;
  dataDir: string;
  dataPath: string;
  simulateActivity: boolean;
  ascii: boolean;
  color: ColorMode;
  platform: string;
  demo: DemoConfig;
}

export interface PathContext {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  home?: string;
  cwd?: string;
  readTextFile?: (path: string) => Promise<string>;
}

interface FileConfig {
  provider?: string;
  displayName?: string;
  dataDir?: string;
  simulateActivity?: boolean;
  ascii?: boolean;
  color?: ColorMode;
  demo?: Partial<DemoConfig>;
}

export class ConfigError extends Error {
  readonly path?: string;

  constructor(message: string, options?: { path?: string; cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
    this.path = options?.path;
  }
}

const APP_DIR_UNIX = "pulsewire";
const APP_DIR_WINDOWS = "Pulsewire";
const DEMO_FILE = "demo.json";

const DEFAULTS: Omit<AppConfig, "configPath" | "dataDir" | "dataPath" | "platform"> = {
  provider: "demo",
  displayName: "You",
  simulateActivity: true,
  ascii: false,
  color: "auto",
  demo: {
    connectDelayMs: 450,
    replyDelayMs: 1800,
    ambientIntervalMs: 75_000,
  },
};

/** Path helpers are selected explicitly so platform behavior can be tested anywhere. */
export function pathFor(platform: string) {
  return platform === "windows" ? win32 : posix;
}

export function defaultConfigPath(ctx: PathContext): string {
  const path = pathFor(ctx.platform);
  if (ctx.platform === "windows") {
    const base = firstNonEmpty(
      ctx.env.APPDATA,
      path.join(ctx.home, "AppData", "Roaming"),
    );
    return path.join(base, APP_DIR_WINDOWS, "config.json");
  }
  if (ctx.platform === "darwin") {
    return path.join(ctx.home, "Library", "Application Support", "Pulsewire", "config.json");
  }
  const base = firstNonEmpty(
    ctx.env.XDG_CONFIG_HOME,
    path.join(ctx.home, ".config"),
  );
  return path.join(base, APP_DIR_UNIX, "config.json");
}

export function defaultDataDir(ctx: PathContext): string {
  const path = pathFor(ctx.platform);
  if (ctx.platform === "windows") {
    const base = firstNonEmpty(
      ctx.env.LOCALAPPDATA,
      ctx.env.APPDATA,
      path.join(ctx.home, "AppData", "Local"),
    );
    return path.join(base, APP_DIR_WINDOWS);
  }
  if (ctx.platform === "darwin") {
    return path.join(ctx.home, "Library", "Application Support", "Pulsewire");
  }
  const base = firstNonEmpty(
    ctx.env.XDG_DATA_HOME,
    path.join(ctx.home, ".local", "share"),
  );
  return path.join(base, APP_DIR_UNIX);
}

export function demoDataPath(dataDir: string, platform: string): string {
  return pathFor(platform).join(dataDir, DEMO_FILE);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const env = options.env ?? Deno.env.toObject();
  const platform = options.platform ?? Deno.build.os;
  const home = options.home ?? safeHome();
  const cwd = options.cwd ?? safeCwd();
  const path = pathFor(platform);
  const readTextFile = options.readTextFile ??
    ((filePath: string) => Deno.readTextFile(filePath));

  const configPath = resolveConfiguredPath(
    env.PULSEWIRE_CONFIG,
    defaultConfigPath({ platform, env, home }),
    path,
    cwd,
  );

  let fileConfig: FileConfig = {};
  let rawConfig: string | undefined;
  try {
    rawConfig = await readTextFile(configPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new ConfigError(
        `Could not read the configuration file at ${configPath}: ${messageOf(error)}`,
        { path: configPath, cause: error },
      );
    }
  }

  if (rawConfig !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConfig);
    } catch (error) {
      throw new ConfigError(
        `The configuration file is not valid JSON: ${configPath}`,
        { path: configPath, cause: error },
      );
    }
    fileConfig = validateFileConfig(parsed, configPath);
  }

  const provider = (env.PULSEWIRE_PROVIDER ?? fileConfig.provider ?? DEFAULTS.provider).trim();
  if (!provider) {
    throw new ConfigError("The provider name cannot be empty.", { path: configPath });
  }

  const displayName = validateDisplayName(
    env.PULSEWIRE_DISPLAY_NAME ?? fileConfig.displayName ?? DEFAULTS.displayName,
  );

  const configuredDataDir = env.PULSEWIRE_DATA_DIR ?? fileConfig.dataDir;
  const dataDir = configuredDataDir === undefined
    ? defaultDataDir({ platform, env, home })
    : resolveDataDir(
      configuredDataDir,
      env.PULSEWIRE_DATA_DIR !== undefined,
      configPath,
      path,
      cwd,
    );

  const simulateActivity = env.PULSEWIRE_SIMULATE_ACTIVITY !== undefined
    ? parseBoolean(env.PULSEWIRE_SIMULATE_ACTIVITY, "PULSEWIRE_SIMULATE_ACTIVITY")
    : fileConfig.simulateActivity ?? DEFAULTS.simulateActivity;

  const ascii = env.PULSEWIRE_ASCII !== undefined
    ? parseBoolean(env.PULSEWIRE_ASCII, "PULSEWIRE_ASCII")
    : fileConfig.ascii ?? DEFAULTS.ascii;

  let color = parseColorMode(
    env.PULSEWIRE_COLOR ?? fileConfig.color ?? DEFAULTS.color,
    env.PULSEWIRE_COLOR !== undefined ? "PULSEWIRE_COLOR" : "config color",
  );
  if (color === "auto" && env.NO_COLOR !== undefined) color = "none";

  const demo = {
    connectDelayMs: env.PULSEWIRE_DEMO_CONNECT_DELAY_MS !== undefined
      ? parseNonNegativeInt(
        env.PULSEWIRE_DEMO_CONNECT_DELAY_MS,
        "PULSEWIRE_DEMO_CONNECT_DELAY_MS",
      )
      : validateDelay(
        fileConfig.demo?.connectDelayMs,
        DEFAULTS.demo.connectDelayMs,
        "connectDelayMs",
      ),
    replyDelayMs: env.PULSEWIRE_DEMO_REPLY_DELAY_MS !== undefined
      ? parseNonNegativeInt(env.PULSEWIRE_DEMO_REPLY_DELAY_MS, "PULSEWIRE_DEMO_REPLY_DELAY_MS")
      : validateDelay(fileConfig.demo?.replyDelayMs, DEFAULTS.demo.replyDelayMs, "replyDelayMs"),
    ambientIntervalMs: env.PULSEWIRE_DEMO_AMBIENT_INTERVAL_MS !== undefined
      ? parseNonNegativeInt(
        env.PULSEWIRE_DEMO_AMBIENT_INTERVAL_MS,
        "PULSEWIRE_DEMO_AMBIENT_INTERVAL_MS",
      )
      : validateDelay(
        fileConfig.demo?.ambientIntervalMs,
        DEFAULTS.demo.ambientIntervalMs,
        "ambientIntervalMs",
      ),
  };

  return {
    provider,
    displayName,
    configPath,
    dataDir,
    dataPath: demoDataPath(dataDir, platform),
    simulateActivity,
    ascii,
    color,
    platform,
    demo,
  };
}

/** A redacted view suitable for `--print-config`; no secrets are ever loaded. */
export function printableConfig(config: AppConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    displayName: config.displayName,
    configPath: config.configPath,
    dataDir: config.dataDir,
    dataPath: config.dataPath,
    simulateActivity: config.simulateActivity,
    ascii: config.ascii,
    color: config.color,
    platform: config.platform,
    demo: config.demo,
  };
}

export function validateDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new ConfigError("displayName must not be empty.");
  if (name.length > 40) throw new ConfigError("displayName must be 40 characters or fewer.");
  // Control characters can corrupt terminal output and JSON logs.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ConfigError("displayName must not contain control characters.");
  }
  return name;
}

function validateFileConfig(value: unknown, configPath: string): FileConfig {
  if (!isRecord(value)) {
    throw new ConfigError("The configuration file must contain a JSON object.", {
      path: configPath,
    });
  }

  const allowed = new Set([
    "provider",
    "displayName",
    "dataDir",
    "simulateActivity",
    "ascii",
    "color",
    "demo",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`Unknown configuration key "${key}".`, { path: configPath });
    }
  }

  const config: FileConfig = {};
  if (value.provider !== undefined) {
    if (typeof value.provider !== "string" || !value.provider.trim()) {
      throw new ConfigError(`"provider" must be a non-empty string.`, { path: configPath });
    }
    config.provider = value.provider;
  }
  if (value.displayName !== undefined) {
    if (typeof value.displayName !== "string") {
      throw new ConfigError(`"displayName" must be a string.`, { path: configPath });
    }
    config.displayName = value.displayName;
  }
  if (value.dataDir !== undefined) {
    if (typeof value.dataDir !== "string" || !value.dataDir.trim()) {
      throw new ConfigError(`"dataDir" must be a non-empty string.`, { path: configPath });
    }
    config.dataDir = value.dataDir;
  }
  if (value.simulateActivity !== undefined) {
    if (typeof value.simulateActivity !== "boolean") {
      throw new ConfigError(`"simulateActivity" must be true or false.`, { path: configPath });
    }
    config.simulateActivity = value.simulateActivity;
  }
  if (value.ascii !== undefined) {
    if (typeof value.ascii !== "boolean") {
      throw new ConfigError(`"ascii" must be true or false.`, { path: configPath });
    }
    config.ascii = value.ascii;
  }
  if (value.color !== undefined) {
    config.color = parseColorMode(value.color, `"color"`, configPath);
  }
  if (value.demo !== undefined) {
    if (!isRecord(value.demo)) {
      throw new ConfigError(`"demo" must be an object.`, { path: configPath });
    }
    const allowedDemo = new Set(["connectDelayMs", "replyDelayMs", "ambientIntervalMs"]);
    for (const key of Object.keys(value.demo)) {
      if (!allowedDemo.has(key)) {
        throw new ConfigError(`Unknown demo configuration key "${key}".`, { path: configPath });
      }
    }
    config.demo = {};
    for (const key of allowedDemo) {
      const field = value.demo[key];
      if (field === undefined) continue;
      if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
        throw new ConfigError(`"demo.${key}" must be a non-negative integer.`, {
          path: configPath,
        });
      }
      config.demo[key as keyof DemoConfig] = field;
    }
  }
  return config;
}

function resolveConfiguredPath(
  value: string | undefined,
  fallback: string,
  path: typeof posix,
  cwd: string,
): string {
  if (!value) return fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

function resolveDataDir(
  value: string,
  fromEnvironment: boolean,
  configPath: string,
  path: typeof posix,
  cwd: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ConfigError("dataDir must not be empty.");
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  const base = fromEnvironment ? cwd : path.dirname(configPath);
  return path.resolve(base, trimmed);
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be true/false, yes/no, on/off, or 1/0.`);
}

function parseColorMode(value: unknown, name: string, configPath?: string): ColorMode {
  if (value === "auto" || value === "truecolor" || value === "ansi256" || value === "none") {
    return value;
  }
  throw new ConfigError(
    `${name} must be one of: auto, truecolor, ansi256, none.`,
    configPath ? { path: configPath } : undefined,
  );
}

function parseNonNegativeInt(value: string, name: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function validateDelay(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`demo.${name} must be a non-negative integer.`);
  }
  return value;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) return value;
  }
  return values[values.length - 1] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeHome(): string {
  try {
    return homedir();
  } catch {
    return ".";
  }
}

function safeCwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return ".";
  }
}
