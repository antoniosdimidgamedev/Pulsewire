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
});

Deno.test("help text documents providers, setup, and shortcuts", () => {
  const text = helpText();
  strictEqual(text.includes("Pulsewire"), true);
  strictEqual(text.includes("auth google"), true);
  strictEqual(text.includes("googlechat"), true);
  strictEqual(text.includes("--print-config"), true);
  strictEqual(text.includes("Ctrl+C"), true);
  strictEqual(text.includes("Search"), true);
  strictEqual(text.includes("demo provider never contacts the network"), true);
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
    simulateActivity: true,
    ascii: false,
    color: "auto",
    platform: "linux",
    demo: { connectDelayMs: 0, replyDelayMs: 0, ambientIntervalMs: 0 },
  };
}
