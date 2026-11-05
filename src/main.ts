import { createGoogleSession, createProvider } from "./chat/factory.ts";
import { errorMessage, isChatError } from "./chat/errors.ts";
import { applyOverrides } from "./cli.ts";
import type { RunOverrides } from "./cli.ts";
import { helpText, parseArgs, VERSION } from "./cli.ts";
import { runClientCommand } from "./client/commands.ts";
import { type AppConfig, ConfigError, loadConfig, printableConfig } from "./config.ts";
import { GoogleOAuthSession } from "./google/oauth.ts";
import {
  describeGoogleChat,
  GOOGLE_CHAT_SCOPES,
  loadGoogleChatSettings,
} from "./google/settings.ts";
import { loadServerSettings, startServer } from "./server/main.ts";
import { PulsewireApp } from "./ui/app.ts";
import { resolveColorMode, Theme } from "./ui/theme.ts";
import { Terminal, TerminalUnavailableError } from "./ui/terminal.ts";

export async function main(argv: string[]): Promise<number> {
  const command = parseArgs(argv);
  switch (command.kind) {
    case "help":
      console.log(helpText());
      return 0;
    case "version":
      console.log(`Pulsewire ${VERSION}`);
      return 0;
    case "error":
      console.error(`pulsewire: ${command.message}`);
      console.error("Run `pulsewire --help` for usage.");
      return 2;
    case "run":
      return await runApp(command.overrides);
    case "print-config":
      return await printConfig(command.overrides);
    case "reset-demo":
      return await resetDemo(command.overrides, command.yes);
    case "auth-google":
      return await authGoogle(command.overrides, !command.noBrowser);
    case "auth-status":
      return await authStatus(command.overrides);
    case "serve":
      return await serve(command.overrides, {
        ...(command.host !== undefined ? { host: command.host } : {}),
        ...(command.port !== undefined ? { port: command.port } : {}),
        ...(command.dbPath !== undefined ? { dbPath: command.dbPath } : {}),
      });
    case "register":
    case "login":
    case "logout":
    case "whoami":
    case "profile":
    case "conversations":
    case "history":
    case "send":
    case "search":
    case "new-dm":
    case "new-group":
    case "members":
    case "invite":
    case "remove-member":
    case "leave":
    case "read": {
      const config = await load(command.overrides);
      return await runClientCommand(command, config);
    }
  }
}

async function load(overrides: RunOverrides): Promise<AppConfig> {
  const env = Deno.env.toObject();
  if (overrides.configPath) env.PULSEWIRE_CONFIG = overrides.configPath;
  if (overrides.dataDir) env.PULSEWIRE_DATA_DIR = overrides.dataDir;
  if (overrides.serverUrl) env.PULSEWIRE_SERVER_URL = overrides.serverUrl;
  const config = await loadConfig({ env });
  return applyOverrides(config, overrides);
}

async function serve(
  overrides: RunOverrides,
  options: { host?: string; port?: number; dbPath?: string },
): Promise<number> {
  const config = await load(overrides);
  const env = Deno.env.toObject();
  const settings = loadServerSettings(env, config.dataDir, options);
  const running = await startServer(settings);

  console.log(`Pulsewire server listening on ${running.url}`);
  console.log(`Database: ${running.dbPath}`);
  console.log(`Dashboard: ${running.url}/admin`);
  console.log("The first registered account becomes an administrator.");
  if (settings.host === "127.0.0.1" || settings.host === "localhost" || settings.host === "::1") {
    console.log("This server accepts connections from this machine only.");
  } else {
    console.log("Listening on a non-loopback address. Put it behind TLS before exposing it.");
  }
  console.log("Press Ctrl+C to stop.");

  const stop = Promise.withResolvers<void>();
  const onSignal = () => stop.resolve();
  try {
    Deno.addSignalListener("SIGINT", onSignal);
    Deno.addSignalListener("SIGTERM", onSignal);
  } catch {
    // SIGTERM is not supported on every platform; Ctrl+C still works.
  }
  try {
    await stop.promise;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSignal);
    } catch {
      // Ignore.
    }
    try {
      Deno.removeSignalListener("SIGTERM", onSignal);
    } catch {
      // Ignore.
    }
    await running.shutdown();
  }
  console.log("Pulsewire server stopped.");
  return 0;
}

async function runApp(overrides: RunOverrides): Promise<number> {
  if (!Terminal.isSupported()) {
    console.error(
      "pulsewire: this command needs an interactive terminal (stdin and stdout must be a TTY).",
    );
    return 2;
  }

  const config = await load(overrides);
  const provider = await createProvider(config);
  const env = Deno.env.toObject();
  const theme = new Theme(resolveColorMode(config.color, env), config.ascii);
  const app = new PulsewireApp({ provider, theme });
  await app.run();
  return 0;
}

async function printConfig(overrides: RunOverrides): Promise<number> {
  const config = await load(overrides);
  const printable = printableConfig(config);
  try {
    const settings = loadServerSettings(Deno.env.toObject(), config.dataDir);
    printable.serverSettings = {
      host: settings.host,
      port: settings.port,
      dbPath: settings.dbPath,
      sessionTtlMs: settings.sessionTtlMs,
      passwordIterations: settings.passwordIterations,
      adminHandle: settings.adminHandle ?? null,
    };
  } catch (error) {
    printable.serverSettings = { error: errorMessage(error) };
  }
  if (config.provider === "googlechat") {
    try {
      const settings = await loadGoogleChatSettings({
        dataDir: config.dataDir,
        env: Deno.env.toObject(),
      });
      printable.googleChat = describeGoogleChat(settings);
    } catch (error) {
      printable.googleChat = { error: errorMessage(error) };
    }
  }
  console.log(JSON.stringify(printable, null, 2));
  return 0;
}

async function resetDemo(overrides: RunOverrides, yes: boolean): Promise<number> {
  const config = await load(overrides);
  let exists = true;
  try {
    await Deno.stat(config.dataPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) exists = false;
    else throw error;
  }
  if (!exists) {
    console.log(`No demo data found at ${config.dataPath}.`);
    return 0;
  }

  if (!yes) {
    if (!Deno.stdin.isTerminal()) {
      console.error(
        `pulsewire: refusing to delete ${config.dataPath} without confirmation. ` +
          "Re-run with `--yes` for non-interactive use.",
      );
      return 2;
    }
    const answer = await readAnswer(
      `Delete local demo data at ${config.dataPath}? This cannot be undone. [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer)) {
      console.log("Cancelled.");
      return 0;
    }
  }

  await Deno.remove(config.dataPath);
  console.log(`Removed demo data at ${config.dataPath}.`);
  return 0;
}

async function authGoogle(overrides: RunOverrides, openBrowser: boolean): Promise<number> {
  const config = await load(overrides);
  const settings = await loadGoogleChatSettings({
    dataDir: config.dataDir,
    env: Deno.env.toObject(),
  });

  console.log("Pulsewire · Google Chat authorization");
  console.log("");
  console.log(`Token cache: ${settings.tokenPath}`);
  if (settings.accessToken) {
    console.log(
      "GOOGLE_CHAT_ACCESS_TOKEN is set, so no interactive login is required. " +
        "Unset it to use a refreshable OAuth session.",
    );
    return 0;
  }
  if (!settings.clientId || !settings.clientSecret) {
    console.error(
      "pulsewire: Google OAuth client credentials are missing.\n" +
        "Set GOOGLE_CHAT_CREDENTIALS_FILE to a Desktop app client JSON, or set\n" +
        "GOOGLE_CHAT_CLIENT_ID and GOOGLE_CHAT_CLIENT_SECRET. See README.md.",
    );
    return 2;
  }

  console.log(`OAuth client: ${settings.credentialsFile ?? "environment variables"}`);
  console.log("");
  console.log("Requested scopes:");
  for (const scope of GOOGLE_CHAT_SCOPES) console.log(`  · ${scope}`);
  console.log("");
  console.log("Opening the consent page. If a browser does not open, visit the URL below.");
  console.log("");

  const session = createGoogleSession(settings, config.configPath);
  if (!(session instanceof GoogleOAuthSession)) {
    console.error("pulsewire: this session cannot start an interactive login.");
    return 2;
  }
  try {
    const user = await session.authorizeInteractive({
      onUrl: (url) => {
        console.log(url);
        console.log("");
      },
      openBrowser,
      timeoutMs: 300_000,
    });
    console.log(`Signed in as ${user.displayName} (@${user.handle}).`);
    console.log(`Refresh token saved to ${settings.tokenPath}.`);
    return 0;
  } catch (error) {
    console.error(`pulsewire: ${errorMessage(error)}`);
    return 1;
  }
}

async function authStatus(overrides: RunOverrides): Promise<number> {
  const config = await load(overrides);
  const settings = await loadGoogleChatSettings({
    dataDir: config.dataDir,
    env: Deno.env.toObject(),
  });
  const session = createGoogleSession(settings, config.configPath);
  try {
    const user = await session.getUser();
    console.log(`Signed in as ${user.displayName} (@${user.handle})`);
    console.log(`Provider: ${config.provider === "googlechat" ? "googlechat" : config.provider}`);
    console.log(`Token cache: ${settings.tokenPath}`);
    console.log(`Read state: ${settings.readStatePath}`);
    console.log(`Poll interval: ${settings.pollIntervalMs} ms`);
    return 0;
  } catch (error) {
    console.error(`pulsewire: ${errorMessage(error)}`);
    if (isChatError(error) && error.code === "auth_required") {
      console.error("Run `pulsewire auth google` to sign in.");
    }
    return 1;
  }
}

async function readAnswer(question: string): Promise<string> {
  const encoder = new TextEncoder();
  await Deno.stdout.write(encoder.encode(question));
  const buffer = new Uint8Array(256);
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const read = await Deno.stdin.read(buffer);
    if (read === null) break;
    text += decoder.decode(buffer.subarray(0, read), { stream: true });
    if (text.includes("\n") || text.includes("\r")) break;
  }
  return text.split(/[\r\n]/)[0]?.trim() ?? "";
}

function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || isChatError(error)) return error.message;
  return errorMessage(error);
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (error) {
    console.error(`pulsewire: ${describeFailure(error)}`);
    if (error instanceof TerminalUnavailableError) {
      console.error("Run Pulsewire directly inside a terminal window.");
    } else if (isChatError(error) && error.code === "auth_required") {
      console.error("Run `pulsewire login <handle>` to sign in again, or `pulsewire auth google`.");
    } else if (error instanceof ConfigError) {
      console.error("Run `pulsewire --print-config` to inspect resolved paths.");
    }
    Deno.exitCode = 1;
  }
}
