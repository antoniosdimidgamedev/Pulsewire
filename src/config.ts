import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type ColorMode = "auto" | "truecolor" | "ansi256" | "none";

export interface DemoAiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  history: number;
}

export interface DemoConfig {
  connectDelayMs: number;
  replyDelayMs: number;
  ambientIntervalMs: number;
  ai: DemoAiConfig;
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

interface FileDemoConfig {
  connectDelayMs?: number;
  replyDelayMs?: number;
  ambientIntervalMs?: number;
  ai?: Partial<DemoAiConfig>;
}

interface FileConfig {
  provider?: string;
  displayName?: string;
  dataDir?: string;
  simulateActivity?: boolean;
  ascii?: boolean;
  color?: ColorMode;
  demo?: FileDemoConfig;
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
    ai: {
      enabled: false,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:0.5b",
      temperature: 0.8,
      maxTokens: 96,
      timeoutMs: 20_000,
      history: 12,
    },
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

  const fileAi = fileConfig.demo?.ai;
  const aiEnabled = env.PULSEWIRE_AI !== undefined
    ? parseBoolean(env.PULSEWIRE_AI, "PULSEWIRE_AI")
    : fileAi?.enabled ?? DEFAULTS.demo.ai.enabled;
  const aiBaseUrl = validateAiBaseUrl(
    env.PULSEWIRE_AI_BASE_URL ?? fileAi?.baseUrl ?? DEFAULTS.demo.ai.baseUrl,
    env.PULSEWIRE_AI_BASE_URL !== undefined ? "PULSEWIRE_AI_BASE_URL" : "demo.ai.baseUrl",
  );
  const aiModel = validateAiModel(
    env.PULSEWIRE_AI_MODEL ?? fileAi?.model ?? DEFAULTS.demo.ai.model,
    env.PULSEWIRE_AI_MODEL !== undefined ? "PULSEWIRE_AI_MODEL" : "demo.ai.model",
  );

  const demo: DemoConfig = {
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
    ai: {
      enabled: aiEnabled,
      baseUrl: aiBaseUrl,
      model: aiModel,
      temperature: fileAi?.temperature ?? DEFAULTS.demo.ai.temperature,
      maxTokens: fileAi?.maxTokens ?? DEFAULTS.demo.ai.maxTokens,
      timeoutMs: env.PULSEWIRE_AI_TIMEOUT_MS !== undefined
        ? parseBoundedInt(env.PULSEWIRE_AI_TIMEOUT_MS, "PULSEWIRE_AI_TIMEOUT_MS", 500, 120_000)
        : fileAi?.timeoutMs ?? DEFAULTS.demo.ai.timeoutMs,
      history: fileAi?.history ?? DEFAULTS.demo.ai.history,
    },
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
    const allowedDemo = new Set([
      "connectDelayMs",
      "replyDelayMs",
      "ambientIntervalMs",
      "ai",
    ]);
    for (const key of Object.keys(value.demo)) {
      if (!allowedDemo.has(key)) {
        throw new ConfigError(`Unknown demo configuration key "${key}".`, { path: configPath });
      }
    }
    const demo: FileDemoConfig = {};
    for (const key of ["connectDelayMs", "replyDelayMs", "ambientIntervalMs"] as const) {
      const field = value.demo[key];
      if (field === undefined) continue;
      if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
        throw new ConfigError(`"demo.${key}" must be a non-negative integer.`, {
          path: configPath,
        });
      }
      demo[key] = field;
    }
    if (value.demo.ai !== undefined) {
      demo.ai = validateAiFileConfig(value.demo.ai, configPath);
    }
    config.demo = demo;
  }
  return config;
}

function validateAiFileConfig(
  value: unknown,
  configPath: string,
): Partial<DemoAiConfig> {
  if (!isRecord(value)) {
    throw new ConfigError(`"demo.ai" must be an object.`, { path: configPath });
  }
  const allowed = new Set([
    "enabled",
    "baseUrl",
    "model",
    "temperature",
    "maxTokens",
    "timeoutMs",
    "history",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`Unknown demo.ai configuration key "${key}".`, {
        path: configPath,
      });
    }
  }

  const ai: Partial<DemoAiConfig> = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new ConfigError(`"demo.ai.enabled" must be true or false.`, { path: configPath });
    }
    ai.enabled = value.enabled;
  }
  if (value.baseUrl !== undefined) {
    ai.baseUrl = validateAiBaseUrl(value.baseUrl, `"demo.ai.baseUrl"`, configPath);
  }
  if (value.model !== undefined) {
    ai.model = validateAiModel(value.model, `"demo.ai.model"`, configPath);
  }
  if (value.temperature !== undefined) {
    ai.temperature = validateAiNumber(
      value.temperature,
      `"demo.ai.temperature"`,
      0,
      2,
      configPath,
      false,
    );
  }
  if (value.maxTokens !== undefined) {
    ai.maxTokens = validateAiNumber(
      value.maxTokens,
      `"demo.ai.maxTokens"`,
      1,
      512,
      configPath,
      true,
    );
  }
  if (value.timeoutMs !== undefined) {
    ai.timeoutMs = validateAiNumber(
      value.timeoutMs,
      `"demo.ai.timeoutMs"`,
      500,
      120_000,
      configPath,
      true,
    );
  }
  if (value.history !== undefined) {
    ai.history = validateAiNumber(
      value.history,
      `"demo.ai.history"`,
      1,
      50,
      configPath,
      true,
    );
  }
  return ai;
}

function validateAiBaseUrl(value: unknown, name: string, configPath?: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`${name} must be a non-empty http(s) URL.`, { path: configPath });
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ConfigError(`${name} must be a valid http(s) URL.`, { path: configPath });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https.`, { path: configPath });
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError(`${name} must not contain credentials.`, { path: configPath });
  }
  return value.trim();
}

function validateAiModel(value: unknown, name: string, configPath?: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`${name} must be a non-empty model name.`, { path: configPath });
  }
  const model = value.trim();
  if (model.length > 100) {
    throw new ConfigError(`${name} must be 100 characters or fewer.`, { path: configPath });
  }
  return model;
}

function validateAiNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  configPath: string | undefined,
  integer: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${name} must be a number.`, { path: configPath });
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer.`, { path: configPath });
  }
  if (value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}.`, {
      path: configPath,
    });
  }
  return value;
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

function parseBoundedInt(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
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
