import type { AppConfig } from "../config.ts";
import { ConfigError } from "../config.ts";
import { loadSession } from "../client/session.ts";
import { GoogleOAuthSession, type GoogleSession, StaticGoogleSession } from "../google/oauth.ts";
import { GoogleChatProvider } from "../google/provider.ts";
import { type GoogleChatSettings, loadGoogleChatSettings } from "../google/settings.ts";
import { createAiResponder } from "./ai.ts";
import { DemoProvider } from "./demo-provider.ts";
import { PulsewireProvider } from "./server-provider.ts";
import type { ChatProvider } from "./types.ts";

/**
 * Provider selection lives here. New providers only need to implement
 * ChatProvider and be registered below; the UI does not change.
 */
export async function createProvider(config: AppConfig): Promise<ChatProvider> {
  switch (config.provider) {
    case "server":
      return await createServerProvider(config);
    case "demo":
      return new DemoProvider({
        dataPath: config.dataPath,
        displayName: config.displayName,
        simulateActivity: config.simulateActivity,
        connectDelayMs: config.demo.connectDelayMs,
        replyDelayMs: config.demo.replyDelayMs,
        ambientIntervalMs: config.demo.ambientIntervalMs,
        ...(config.demo.ai.enabled ? { ai: createAiResponder(config.demo.ai) } : {}),
      });
    case "googlechat":
      return await createGoogleProvider(config);
    default:
      throw new ConfigError(
        `Provider "${config.provider}" is not bundled with Pulsewire. ` +
          "Available providers: server, demo, googlechat. See README.md for setup details.",
        { path: config.configPath },
      );
  }
}

export async function createServerProvider(config: AppConfig): Promise<PulsewireProvider> {
  const session = await loadSession(config.sessionPath, config.server.baseUrl);
  if (!session) {
    throw new ConfigError(
      `Not signed in to the Pulsewire server at ${config.server.baseUrl}.\n` +
        "Run `pulsewire register <handle>` to create an account or " +
        "`pulsewire login <handle>` to sign in. Use `pulsewire --demo` for the offline demo.",
      { path: config.sessionPath },
    );
  }
  return new PulsewireProvider({
    baseUrl: config.server.baseUrl,
    token: session.token,
    pollIntervalMs: config.server.pollIntervalMs,
    requestTimeoutMs: config.server.requestTimeoutMs,
  });
}

export async function createGoogleProvider(config: AppConfig): Promise<GoogleChatProvider> {
  const settings = await loadGoogleChatSettings({ dataDir: config.dataDir });
  const session = createGoogleSession(settings, config.configPath);

  return new GoogleChatProvider({
    session,
    dataDir: config.dataDir,
    readStatePath: settings.readStatePath,
    pollIntervalMs: settings.pollIntervalMs,
    maxSpaces: settings.maxSpaces,
  });
}

export function createGoogleSession(
  settings: GoogleChatSettings,
  configPath?: string,
): GoogleSession {
  if (settings.accessToken) {
    return new StaticGoogleSession({
      accessToken: settings.accessToken,
      ...(settings.userResource ? { userResource: settings.userResource } : {}),
    });
  }
  if (settings.clientId && settings.clientSecret) {
    return new GoogleOAuthSession({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      tokenPath: settings.tokenPath,
      ...(settings.userResource ? { userResource: settings.userResource } : {}),
    });
  }
  throw new ConfigError(
    "Google Chat needs OAuth credentials. Run `pulsewire auth google` with " +
      "GOOGLE_CHAT_CREDENTIALS_FILE set (or GOOGLE_CHAT_CLIENT_ID and " +
      "GOOGLE_CHAT_CLIENT_SECRET). See README.md for the Google Cloud setup.",
    configPath ? { path: configPath } : undefined,
  );
}
