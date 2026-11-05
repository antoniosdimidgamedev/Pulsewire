import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { applyOverrides, type Command, helpText, isColorMode, parseArgs } from "../src/cli.ts";
import type { AppConfig } from "../src/config.ts";

Deno.test("parseArgs defaults to running the TUI", () => {
  deepStrictEqual(parseArgs([]), { kind: "run", overrides: {} });
  deepStrictEqual(parseArgs(["--demo"]), { kind: "run", overrides: { demo: true } });
  deepStrictEqual(parseArgs(["--provider", "googlechat"]), {
    kind: "run",
    overrides: { provider: "googlechat" },
  });
});

Deno.test("parseArgs supports every documented flag", () => {
  deepStrictEqual(
    parseArgs([
      "--provider",
      "googlechat",
      "--config",
      "config.json",
      "--data-dir",
      "state",
      "--ascii",
      "--color",
      "ansi256",
    ]),
    {
      kind: "run",
      overrides: {
        provider: "googlechat",
        configPath: "config.json",
        dataDir: "state",
        ascii: true,
        color: "ansi256",
      },
    },
  );
  deepStrictEqual(parseArgs(["--no-color"]), { kind: "run", overrides: { color: "none" } });
  deepStrictEqual(parseArgs(["--ai"]), { kind: "run", overrides: { ai: true } });
  deepStrictEqual(parseArgs(["--no-ai"]), { kind: "run", overrides: { ai: false } });
  deepStrictEqual(parseArgs(["--ai-model", "qwen3:0.6b"]), {
    kind: "run",
    overrides: { aiModel: "qwen3:0.6b", ai: true },
  });
});

Deno.test("parseArgs recognizes metadata and maintenance commands", () => {
  deepStrictEqual(parseArgs(["--help"]), { kind: "help" });
  deepStrictEqual(parseArgs(["-h"]), { kind: "help" });
  deepStrictEqual(parseArgs(["--version"]), { kind: "version" });
  deepStrictEqual(parseArgs(["-V"]), { kind: "version" });
  deepStrictEqual(parseArgs(["--print-config"]), { kind: "print-config", overrides: {} });
  deepStrictEqual(parseArgs(["--reset-demo"]), {
    kind: "reset-demo",
    overrides: {},
    yes: false,
  });
  deepStrictEqual(parseArgs(["--reset-demo", "--yes"]), {
    kind: "reset-demo",
    overrides: {},
    yes: true,
  });
});

Deno.test("parseArgs routes auth subcommands", () => {
  deepStrictEqual(parseArgs(["auth", "google"]), {
    kind: "auth-google",
    overrides: {},
    noBrowser: false,
  });
  deepStrictEqual(parseArgs(["auth", "google", "--no-browser"]), {
    kind: "auth-google",
    overrides: {},
    noBrowser: true,
  });
  deepStrictEqual(parseArgs(["auth", "status"]), {
    kind: "auth-status",
    overrides: {},
  });
});

Deno.test("parseArgs rejects unknown or incomplete input", () => {
  assertError(parseArgs(["--wat"]), "Unknown option");
  assertError(parseArgs(["--provider"]), "--provider needs a value");
  assertError(parseArgs(["--config"]), "--config needs a file path");
  assertError(parseArgs(["--data-dir"]), "--data-dir needs a directory");
  assertError(parseArgs(["--ai-model"]), "--ai-model needs a model name");
  assertError(parseArgs(["--color", "rainbow"]), "must be one of");
  assertError(parseArgs(["auth"]), "requires");
  assertError(parseArgs(["auth", "slack"]), "requires");
  assertError(parseArgs(["auth", "google", "extra"]), "Too many arguments");
  assertError(parseArgs(["deploy"]), "Unknown command");
});

Deno.test("applyOverrides keeps provider precedence explicit", () => {
  const base = config();
  const demo = applyOverrides(config(), { provider: "googlechat", demo: true });
  strictEqual(demo.provider, "demo");
  const google = applyOverrides(base, { provider: " googlechat " });
  strictEqual(google.provider, "googlechat");
  const styled = applyOverrides(config(), { ascii: true, color: "none" });
  strictEqual(styled.ascii, true);
  strictEqual(styled.color, "none");
  const ai = applyOverrides(config(), { ai: true });
  strictEqual(ai.demo.ai.enabled, true);
  const model = applyOverrides(config(), { aiModel: " qwen3:0.6b " });
  strictEqual(model.demo.ai.enabled, true);
  strictEqual(model.demo.ai.model, "qwen3:0.6b");
  const off = applyOverrides(applyOverrides(config(), { ai: true }), { ai: false });
  strictEqual(off.demo.ai.enabled, false);
  const server = applyOverrides(config(), { serverUrl: " https://chat.example.test/ " });
  strictEqual(server.server.baseUrl, "https://chat.example.test");
});

Deno.test("parseArgs routes server, account, and messaging commands", () => {
  deepStrictEqual(parseArgs(["register", "alice", "--name", "Alice"]), {
    kind: "register",
    overrides: {},
    handle: "alice",
    displayName: "Alice",
    passwordStdin: false,
  });
  deepStrictEqual(parseArgs(["login", "@alice", "--password-stdin"]), {
    kind: "login",
    overrides: {},
    handle: "@alice",
    passwordStdin: true,
  });
  deepStrictEqual(parseArgs(["logout"]), { kind: "logout", overrides: {} });
  deepStrictEqual(parseArgs(["whoami"]), { kind: "whoami", overrides: {} });
  deepStrictEqual(parseArgs(["profile", "--name", "Alice A."]), {
    kind: "profile",
    overrides: {},
    displayName: "Alice A.",
  });
  deepStrictEqual(parseArgs(["conversations", "--server", "http://127.0.0.1:9000"]), {
    kind: "conversations",
    overrides: { serverUrl: "http://127.0.0.1:9000" },
  });
  deepStrictEqual(parseArgs(["history", "c_1", "--limit", "20", "--before", "42"]), {
    kind: "history",
    overrides: {},
    conversation: "c_1",
    limit: 20,
    before: 42,
  });
  deepStrictEqual(parseArgs(["send", "c_1", "hello", "world", "--reply-to", "m_1"]), {
    kind: "send",
    overrides: {},
    conversation: "c_1",
    body: "hello world",
    replyTo: "m_1",
  });
  deepStrictEqual(parseArgs(["search", "release", "notes"]), {
    kind: "search",
    overrides: {},
    query: "release notes",
  });
  deepStrictEqual(parseArgs(["new-dm", "@bob"]), {
    kind: "new-dm",
    overrides: {},
    handle: "@bob",
  });
  deepStrictEqual(parseArgs(["new-group", "Team", "bob", "carol"]), {
    kind: "new-group",
    overrides: {},
    name: "Team",
    members: ["bob", "carol"],
  });
  deepStrictEqual(parseArgs(["invite", "c_1", "bob"]), {
    kind: "invite",
    overrides: {},
    conversation: "c_1",
    handle: "bob",
  });
  deepStrictEqual(parseArgs(["remove-member", "c_1", "@bob"]), {
    kind: "remove-member",
    overrides: {},
    conversation: "c_1",
    member: "@bob",
  });
  deepStrictEqual(parseArgs(["leave", "c_1"]), {
    kind: "leave",
    overrides: {},
    conversation: "c_1",
  });
  deepStrictEqual(parseArgs(["read", "c_1"]), {
    kind: "read",
    overrides: {},
    conversation: "c_1",
  });
  deepStrictEqual(
    parseArgs(["serve", "--host", "0.0.0.0", "--port", "9000", "--db", "db.sqlite"]),
    {
      kind: "serve",
      overrides: {},
      host: "0.0.0.0",
      port: 9000,
      dbPath: "db.sqlite",
    },
  );
  deepStrictEqual(parseArgs(["send", "c_1", "hello", "--demo"]), {
    kind: "send",
    overrides: { demo: true },
    conversation: "c_1",
    body: "hello",
  });
  assertError(parseArgs(["register"]), "needs a handle");
  assertError(parseArgs(["send", "c_1"]), "needs a message body");
  assertError(parseArgs(["new-group", "Team"]), "needs at least one member");
  assertError(parseArgs(["profile"]), "needs --name");
  assertError(parseArgs(["serve", "--port", "surprise"]), "must be an integer");
  assertError(parseArgs(["history", "c_1", "--limit", "0"]), "between 1 and 100");
  assertError(parseArgs(["--server"]), "--server needs a URL");
});

Deno.test("help text documents providers, setup, and shortcuts", () => {
  const text = helpText();
  strictEqual(text.includes("Pulsewire"), true);
  strictEqual(text.includes("auth google"), true);
  strictEqual(text.includes("googlechat"), true);
  strictEqual(text.includes("--print-config"), true);
  strictEqual(text.includes("--ai"), true);
  strictEqual(text.includes("Ctrl+C"), true);
  strictEqual(text.includes("Search"), true);
  strictEqual(text.includes("offline demo"), true);
  strictEqual(text.includes("serve"), true);
  strictEqual(text.includes("register"), true);
});

Deno.test("color mode validation matches config values", () => {
  for (const value of ["auto", "truecolor", "ansi256", "none"]) {
    strictEqual(isColorMode(value), true);
  }
  strictEqual(isColorMode("256"), false);
});

function assertError(command: Command, message: string): void {
  strictEqual(command.kind, "error");
  if (command.kind !== "error") return;
  strictEqual(command.message.includes(message), true, command.message);
}

function config(): AppConfig {
  return {
    provider: "demo",
    displayName: "Alex Rivera",
    configPath: "/config.json",
    dataDir: "/data",
    dataPath: "/data/demo.json",
    sessionPath: "/data/session.json",
    simulateActivity: true,
    ascii: false,
    color: "auto",
    platform: "linux",
    server: {
      baseUrl: "http://127.0.0.1:8787",
      pollIntervalMs: 1_500,
      requestTimeoutMs: 15_000,
    },
    demo: {
      connectDelayMs: 0,
      replyDelayMs: 0,
      ambientIntervalMs: 0,
      ai: {
        enabled: false,
        baseUrl: "http://127.0.0.1:9931/v1",
        model: "qwen3:0.6b",
        temperature: 0.8,
        maxTokens: 96,
        timeoutMs: 20_000,
        history: 12,
      },
    },
  };
}
