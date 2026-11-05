import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { type CommandIO, runClientCommand } from "../src/client/commands.ts";
import { loadSession, saveSession } from "../src/client/session.ts";
import { parseArgs } from "../src/cli.ts";
import type { AppConfig } from "../src/config.ts";
import { startServer } from "../src/server/main.ts";

const PASSWORD = "correct horse battery";

function configFor(baseUrl: string, dataDir: string): AppConfig {
  return {
    provider: "server",
    displayName: "Test User",
    configPath: `${dataDir}/config.json`,
    dataDir,
    dataPath: `${dataDir}/demo.json`,
    sessionPath: `${dataDir}/session.json`,
    simulateActivity: true,
    ascii: true,
    color: "none",
    platform: Deno.build.os,
    server: {
      baseUrl,
      pollIntervalMs: 100,
      requestTimeoutMs: 2_000,
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

function capture(): { io: CommandIO; out: string[]; errors: string[] } {
  const out: string[] = [];
  const errors: string[] = [];
  return {
    io: { out: (line) => out.push(line), error: (line) => errors.push(line) },
    out,
    errors,
  };
}

async function run(
  args: string[],
  config: AppConfig,
  io: CommandIO,
  password = PASSWORD,
): Promise<number> {
  return await runClientCommand(parseArgs(args), config, {
    io,
    readPassword: () => Promise.resolve(password),
  });
}

Deno.test("CLI commands: account, group, send, history, search, and sign-out", async () => {
  const running = await startServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    sessionTtlMs: 60 * 60 * 1_000,
    passwordIterations: 1_000,
  }, { quiet: true });
  const root = await Deno.makeTempDir();
  try {
    const aliceConfig = configFor(running.url, `${root}/alice`);
    const bobConfig = configFor(running.url, `${root}/bob`);
    await Deno.mkdir(aliceConfig.dataDir, { recursive: true });
    await Deno.mkdir(bobConfig.dataDir, { recursive: true });

    const alice = capture();
    strictEqual(
      await run(["register", "alice", "--name", "Alice"], aliceConfig, alice.io),
      0,
      alice.errors.join("\n"),
    );
    strictEqual(alice.out.some((line) => line.includes("Created account @alice")), true);
    const aliceSession = await loadSession(aliceConfig.sessionPath, running.url);
    strictEqual(aliceSession?.handle, "alice");
    if (Deno.build.os !== "windows") {
      const stat = await Deno.stat(aliceConfig.sessionPath);
      strictEqual(stat.mode! & 0o777, 0o600);
    }

    const bob = capture();
    strictEqual(
      await run(["register", "bob", "--name", "Bob"], bobConfig, bob.io),
      0,
      bob.errors.join("\n"),
    );

    const group = capture();
    strictEqual(
      await run(["new-group", "Release", "bob"], aliceConfig, group.io),
      0,
      group.errors.join("\n"),
    );
    const conversationId = group.out[0]!.split(" · ")[1]!;

    const sent = capture();
    strictEqual(
      await run(["send", conversationId, "Ship", "it"], aliceConfig, sent.io),
      0,
      sent.errors.join("\n"),
    );
    strictEqual(sent.out[0]!.includes("Ship it"), true);

    const bobHistory = capture();
    strictEqual(
      await run(["history", "Release"], bobConfig, bobHistory.io),
      0,
      bobHistory.errors.join("\n"),
    );
    strictEqual(bobHistory.out.some((line) => line.includes("Ship it")), true);

    const search = capture();
    strictEqual(await run(["search", "Ship"], bobConfig, search.io), 0, search.errors.join("\n"));
    strictEqual(search.out.some((line) => line.includes("Ship it")), true);

    const members = capture();
    strictEqual(
      await run(["members", conversationId], aliceConfig, members.io),
      0,
      members.errors.join("\n"),
    );
    strictEqual(members.out.some((line) => line.includes("@alice")), true);
    strictEqual(members.out.some((line) => line.includes("@bob")), true);

    const read = capture();
    strictEqual(await run(["read", conversationId], bobConfig, read.io), 0, read.errors.join("\n"));

    const whoami = capture();
    strictEqual(await run(["whoami"], bobConfig, whoami.io), 0, whoami.errors.join("\n"));
    strictEqual(whoami.out[0], "Bob (@bob)");

    const profile = capture();
    strictEqual(
      await run(["profile", "--name", "Robert"], bobConfig, profile.io),
      0,
      profile.errors.join("\n"),
    );
    strictEqual(profile.out[0]!.includes("Robert (@bob)"), true);

    const logout = capture();
    strictEqual(await run(["logout"], bobConfig, logout.io), 0, logout.errors.join("\n"));
    strictEqual(await loadSession(bobConfig.sessionPath, running.url), null);

    const afterLogout = capture();
    strictEqual(await run(["whoami"], bobConfig, afterLogout.io), 1);
    deepStrictEqual(
      afterLogout.errors.some((line) => line.includes("Not signed in")),
      true,
    );
  } finally {
    await running.shutdown();
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("CLI commands: a failed send reports a recoverable network error", async () => {
  const root = await Deno.makeTempDir();
  try {
    const config = configFor("http://127.0.0.1:1", root);
    await saveSession(config.sessionPath, {
      baseUrl: config.server.baseUrl,
      token: "test-token",
      userId: "u_test",
      handle: "alice",
      displayName: "Alice",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      savedAt: new Date().toISOString(),
    });
    const io = capture();
    const code = await run(["send", "anything", "hello"], config, io.io);
    strictEqual(code, 1);
    strictEqual(io.errors.length > 0, true);
    strictEqual(io.errors[0]!.includes("Could not reach the Pulsewire server"), true);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
