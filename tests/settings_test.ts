import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  describeGoogleChat,
  GOOGLE_CHAT_SCOPES,
  loadGoogleChatSettings,
  readOAuthClient,
} from "../src/google/settings.ts";
import { ConfigError } from "../src/config.ts";

Deno.test("Google settings default to local dataDir paths and sane limits", async () => {
  const settings = await loadGoogleChatSettings({
    dataDir: "/data/pulsewire",
    env: {},
    cwd: "/work",
  });
  strictEqual(settings.tokenPath, resolve("/work", "/data/pulsewire/googlechat-token.json"));
  strictEqual(
    settings.readStatePath,
    resolve("/work", "/data/pulsewire/googlechat-readstate.json"),
  );
  strictEqual(settings.pollIntervalMs, 20_000);
  strictEqual(settings.maxSpaces, 30);
  strictEqual(settings.clientId, undefined);
  strictEqual(describeGoogleChat(settings).credentialsSource, "missing");
});

Deno.test("client id and secret come from the environment", async () => {
  const settings = await loadGoogleChatSettings({
    dataDir: "/data/pulsewire",
    env: {
      GOOGLE_CHAT_CLIENT_ID: " client-id ",
      GOOGLE_CHAT_CLIENT_SECRET: " secret ",
      GOOGLE_CHAT_USER_RESOURCE: "12345",
      GOOGLE_CHAT_POLL_INTERVAL_MS: "5000",
      GOOGLE_CHAT_MAX_SPACES: "12",
    },
    cwd: "/work",
  });
  strictEqual(settings.clientId, "client-id");
  strictEqual(settings.clientSecret, "secret");
  strictEqual(settings.userResource, "users/12345");
  strictEqual(settings.pollIntervalMs, 5_000);
  strictEqual(settings.maxSpaces, 12);
  const description = describeGoogleChat(settings);
  strictEqual(description.credentialsSource, "environment");
  strictEqual(description.userResource, "users/12345");
});

Deno.test("a Desktop app credentials file supplies the OAuth client", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  try {
    const credentialsPath = join(dir, "client.json");
    await Deno.writeTextFile(
      credentialsPath,
      JSON.stringify({
        installed: {
          client_id: "file-client",
          client_secret: "file-secret",
          redirect_uris: ["http://127.0.0.1"],
        },
      }),
    );
    const settings = await loadGoogleChatSettings({
      dataDir: join(dir, "data"),
      env: { GOOGLE_CHAT_CREDENTIALS_FILE: "client.json" },
      cwd: dir,
    });
    strictEqual(settings.clientId, "file-client");
    strictEqual(settings.clientSecret, "file-secret");
    strictEqual(settings.credentialsFile, credentialsPath);
    strictEqual(describeGoogleChat(settings).credentialsSource, "credentials-file");

    const web = join(dir, "web.json");
    await Deno.writeTextFile(
      web,
      JSON.stringify({ web: { client_id: "web-id", client_secret: "web-secret" } }),
    );
    deepStrictEqual(await readOAuthClient(web), {
      clientId: "web-id",
      clientSecret: "web-secret",
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("access tokens take precedence over interactive credentials", async () => {
  const settings = await loadGoogleChatSettings({
    dataDir: "/data/pulsewire",
    env: {
      GOOGLE_CHAT_ACCESS_TOKEN: "token",
      GOOGLE_CHAT_CLIENT_ID: "id",
      GOOGLE_CHAT_CLIENT_SECRET: "secret",
    },
    cwd: "/work",
  });
  strictEqual(describeGoogleChat(settings).credentialsSource, "access-token");
  strictEqual(settings.accessToken, "token");
});

Deno.test("token file overrides resolve relative to the working directory", async () => {
  const settings = await loadGoogleChatSettings({
    dataDir: "/data/pulsewire",
    env: { GOOGLE_CHAT_TOKEN_FILE: "secrets/token.json" },
    cwd: "/work",
  });
  strictEqual(settings.tokenPath, resolve("/work", "secrets/token.json"));
});

Deno.test("bad Google settings are rejected", async () => {
  await rejects(
    loadGoogleChatSettings({
      dataDir: "/data",
      env: { GOOGLE_CHAT_POLL_INTERVAL_MS: "soon" },
    }),
    /non-negative integer/,
  );
  await rejects(
    loadGoogleChatSettings({
      dataDir: "/data",
      env: { GOOGLE_CHAT_MAX_SPACES: "500" },
    }),
    /between 1 and 100/,
  );
  await rejects(
    loadGoogleChatSettings({
      dataDir: "/data",
      env: { GOOGLE_CHAT_MAX_SPACES: "0" },
    }),
    /between 1 and 100/,
  );
});

Deno.test("credentials files must be valid Desktop client JSON", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  try {
    const missing = join(dir, "missing.json");
    await rejects(
      readOAuthClient(missing),
      (error: unknown) => error instanceof ConfigError && /Could not read/.test(error.message),
    );

    const malformed = join(dir, "bad.json");
    await Deno.writeTextFile(malformed, "{nope");
    await rejects(readOAuthClient(malformed), /not valid JSON/);

    const incomplete = join(dir, "incomplete.json");
    await Deno.writeTextFile(incomplete, JSON.stringify({ installed: { client_id: "x" } }));
    await rejects(readOAuthClient(incomplete), /client_secret/);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("declared Google Chat scopes are read and write but not admin", () => {
  strictEqual(GOOGLE_CHAT_SCOPES.includes("https://www.googleapis.com/auth/chat.messages"), true);
  strictEqual(
    GOOGLE_CHAT_SCOPES.includes("https://www.googleapis.com/auth/chat.spaces.readonly"),
    true,
  );
  strictEqual(GOOGLE_CHAT_SCOPES.some((scope) => scope.includes("admin")), false);
});
