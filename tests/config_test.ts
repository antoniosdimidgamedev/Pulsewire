// deno-lint-ignore-file require-await
import { deepStrictEqual, match, rejects, strictEqual, throws } from "node:assert/strict";
import {
  ConfigError,
  defaultConfigPath,
  defaultDataDir,
  demoDataPath,
  loadConfig,
  type LoadConfigOptions,
  printableConfig,
  validateDisplayName,
} from "../src/config.ts";

function ctx(
  platform: string,
  env: Record<string, string | undefined> = {},
  home = platform === "windows" ? "C:\\Users\\alex" : "/home/alex",
) {
  return { platform, env, home };
}

function notFound(): Promise<string> {
  return Promise.reject(new Deno.errors.NotFound("missing"));
}

async function load(options: LoadConfigOptions) {
  return await loadConfig({
    readTextFile: notFound,
    cwd: "/work",
    ...options,
  });
}

Deno.test("default paths follow Linux, macOS, and Windows conventions", () => {
  strictEqual(
    defaultConfigPath(ctx("linux")),
    "/home/alex/.config/pulsewire/config.json",
  );
  strictEqual(
    defaultDataDir(ctx("linux")),
    "/home/alex/.local/share/pulsewire",
  );
  strictEqual(
    defaultConfigPath(ctx("linux", { XDG_CONFIG_HOME: "/custom/config" })),
    "/custom/config/pulsewire/config.json",
  );
  strictEqual(
    defaultDataDir(ctx("linux", { XDG_DATA_HOME: "/custom/data" })),
    "/custom/data/pulsewire",
  );

  strictEqual(
    defaultConfigPath(ctx("darwin")),
    "/home/alex/Library/Application Support/Pulsewire/config.json",
  );
  strictEqual(
    defaultDataDir(ctx("darwin")),
    "/home/alex/Library/Application Support/Pulsewire",
  );

  strictEqual(
    defaultConfigPath(ctx("windows")),
    "C:\\Users\\alex\\AppData\\Roaming\\Pulsewire\\config.json",
  );
  strictEqual(
    defaultDataDir(ctx("windows")),
    "C:\\Users\\alex\\AppData\\Local\\Pulsewire",
  );
  strictEqual(
    defaultConfigPath(ctx("windows", { APPDATA: "D:\\Roaming" })),
    "D:\\Roaming\\Pulsewire\\config.json",
  );
  strictEqual(
    defaultDataDir(ctx("windows", { LOCALAPPDATA: "D:\\Local" })),
    "D:\\Local\\Pulsewire",
  );
  strictEqual(
    demoDataPath("C:\\Data\\Pulsewire", "windows"),
    "C:\\Data\\Pulsewire\\demo.json",
  );
});

Deno.test("loadConfig returns local demo defaults without a config file", async () => {
  const config = await load({ platform: "linux", env: {}, home: "/home/alex" });
  strictEqual(config.provider, "demo");
  strictEqual(config.displayName, "You");
  strictEqual(config.configPath, "/home/alex/.config/pulsewire/config.json");
  strictEqual(config.dataDir, "/home/alex/.local/share/pulsewire");
  strictEqual(config.dataPath, "/home/alex/.local/share/pulsewire/demo.json");
  strictEqual(config.simulateActivity, true);
  strictEqual(config.color, "auto");
  strictEqual(config.demo.replyDelayMs, 1_800);
});

Deno.test("environment variables override the config file", async () => {
  const config = await load({
    platform: "linux",
    env: {
      PULSEWIRE_CONFIG: "/tmp/pulsewire.json",
      PULSEWIRE_PROVIDER: "googlechat",
      PULSEWIRE_DISPLAY_NAME: "  Ada   Lovelace  ",
      PULSEWIRE_DATA_DIR: "/tmp/pulse-data",
      PULSEWIRE_SIMULATE_ACTIVITY: "off",
      PULSEWIRE_ASCII: "yes",
      PULSEWIRE_COLOR: "ansi256",
      PULSEWIRE_DEMO_REPLY_DELAY_MS: "10",
    },
    readTextFile: async () =>
      JSON.stringify({
        provider: "demo",
        displayName: "File user",
        simulateActivity: true,
        color: "truecolor",
      }),
  });
  strictEqual(config.provider, "googlechat");
  strictEqual(config.displayName, "Ada Lovelace");
  strictEqual(config.dataDir, "/tmp/pulse-data");
  strictEqual(config.simulateActivity, false);
  strictEqual(config.ascii, true);
  strictEqual(config.color, "ansi256");
  strictEqual(config.demo.replyDelayMs, 10);
});

Deno.test("NO_COLOR disables auto color without overriding an explicit mode", async () => {
  const automatic = await load({ platform: "linux", env: { NO_COLOR: "1" } });
  strictEqual(automatic.color, "none");
  const explicit = await load({
    platform: "linux",
    env: { NO_COLOR: "1", PULSEWIRE_COLOR: "truecolor" },
  });
  strictEqual(explicit.color, "truecolor");
});

Deno.test("relative dataDir resolves against the config file or working directory", async () => {
  const fromFile = await load({
    platform: "linux",
    env: { PULSEWIRE_CONFIG: "/etc/pulsewire/config.json" },
    readTextFile: async () => JSON.stringify({ dataDir: "state" }),
  });
  strictEqual(fromFile.dataDir, "/etc/pulsewire/state");
  strictEqual(fromFile.dataPath, "/etc/pulsewire/state/demo.json");

  const fromEnv = await load({
    platform: "linux",
    env: { PULSEWIRE_DATA_DIR: "local-state" },
    cwd: "/work",
  });
  strictEqual(fromEnv.dataDir, "/work/local-state");
});

Deno.test("invalid configuration values are rejected with helpful errors", async () => {
  await rejects(
    load({
      platform: "linux",
      readTextFile: async () => JSON.stringify({ unknown: true }),
    }),
    (error: unknown) =>
      error instanceof ConfigError && /Unknown configuration key/.test(error.message),
  );
  await rejects(
    load({ platform: "linux", readTextFile: async () => "{not json" }),
    /not valid JSON/,
  );
  await rejects(
    load({ platform: "linux", env: { PULSEWIRE_COLOR: "rainbow" } }),
    /must be one of/,
  );
  await rejects(
    load({ platform: "linux", env: { PULSEWIRE_SIMULATE_ACTIVITY: "sometimes" } }),
    /must be true\/false/,
  );
  await rejects(
    load({ platform: "linux", env: { PULSEWIRE_DEMO_REPLY_DELAY_MS: "-1" } }),
    /non-negative integer/,
  );
});

Deno.test("display names are trimmed, collapsed, and bounded", () => {
  strictEqual(validateDisplayName("  Alex   Rivera "), "Alex Rivera");
  throws(() => validateDisplayName("   "), /must not be empty/);
  throws(() => validateDisplayName("x".repeat(41)), /40 characters/);
  throws(() => validateDisplayName("bad\u0007name"), /control characters/);
});

Deno.test("printable config exposes no secrets", async () => {
  const config = await load({
    platform: "linux",
    env: {
      GOOGLE_CHAT_CLIENT_SECRET: "super-secret",
      GOOGLE_CHAT_ACCESS_TOKEN: "token-value",
    },
  });
  const printed = printableConfig(config);
  strictEqual(printed.provider, "demo");
  strictEqual(printed.configPath, config.configPath);
  const serialized = JSON.stringify(printed);
  strictEqual(serialized.includes("super-secret"), false);
  strictEqual(serialized.includes("token-value"), false);
  match(serialized, /"dataPath"/);
});

Deno.test("Windows config paths are parsed with win32 semantics", async () => {
  const config = await load({
    platform: "windows",
    env: {
      USERPROFILE: "C:\\Users\\alex",
      PULSEWIRE_DATA_DIR: "C:\\PulsewireData",
    },
    home: "C:\\Users\\alex",
    cwd: "C:\\work",
  });
  strictEqual(config.dataPath, "C:\\PulsewireData\\demo.json");
  deepStrictEqual(config.demo, {
    connectDelayMs: 450,
    replyDelayMs: 1_800,
    ambientIntervalMs: 75_000,
  });
});
