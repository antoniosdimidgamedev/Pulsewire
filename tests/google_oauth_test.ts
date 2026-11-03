import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { ChatError } from "../src/chat/errors.ts";
import {
  type FetchLike,
  fetchUserProfile,
  GoogleOAuthSession,
  type GoogleUserProfile,
  profileToUser,
  StaticGoogleSession,
} from "../src/google/oauth.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetch: FetchLike; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fetchImpl, calls };
}

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "pulsewire-oauth-" });
}

Deno.test("profileToUser derives a stable resource, display name, and handle", () => {
  const profile: GoogleUserProfile = {
    id: "12345",
    name: "  Alex   Rivera ",
    email: "alex.rivera@example.com",
    picture: "https://example.com/a.png",
  };
  deepStrictEqual(profileToUser(profile), {
    id: "users/12345",
    displayName: "Alex Rivera",
    handle: "alex.rivera",
  });
  strictEqual(profileToUser(profile, "users/999").id, "users/999");
  strictEqual(profileToUser({ id: "users/42" }).id, "users/42");
  strictEqual(profileToUser({ id: "7", email: "sam@example.com" }).displayName, "sam");
  strictEqual(profileToUser({ id: "8" }).displayName, "Google user");
});

Deno.test("StaticGoogleSession fetches the profile once and reuses it", async () => {
  const mock = mockFetch(() =>
    json({ sub: "123", name: "Alex Rivera", email: "alex@example.com" })
  );
  const session = new StaticGoogleSession({
    accessToken: "token",
    fetchImpl: mock.fetch,
  });
  strictEqual(await session.getAccessToken(), "token");
  const first = await session.getUser();
  const second = await session.getUser();
  strictEqual(first.id, "users/123");
  deepStrictEqual(first, second);
  strictEqual(mock.calls.length, 1);
});

Deno.test("fetchUserProfile reports rejected tokens with a sign-in hint", async () => {
  const mock = mockFetch(() => json({ error: { message: "bad token" } }, 401));
  await rejects(
    fetchUserProfile("stale", mock.fetch),
    (error: unknown) =>
      error instanceof ChatError &&
      error.code === "auth_required" &&
      /auth google/.test(error.message),
  );
});

Deno.test("OAuth sessions load a valid cached token without a network call", async () => {
  const dir = await tempDir();
  try {
    const tokenPath = join(dir, "token.json");
    await Deno.writeTextFile(
      tokenPath,
      JSON.stringify({
        version: 1,
        token: {
          accessToken: "cached-token",
          refreshToken: "refresh-token",
          expiresAt: 10 * 60_000,
          tokenType: "Bearer",
        },
        profile: { id: "123", name: "Alex Rivera", email: "alex@example.com" },
      }),
    );
    const mock = mockFetch(() => json({}));
    const session = new GoogleOAuthSession({
      clientId: "client",
      clientSecret: "secret",
      tokenPath,
      fetchImpl: mock.fetch,
      now: () => 0,
    });
    strictEqual(await session.getAccessToken(), "cached-token");
    const user = await session.getUser();
    strictEqual(user.id, "users/123");
    strictEqual(mock.calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("an expired token refreshes and rewrites the cache", async () => {
  const dir = await tempDir();
  try {
    const tokenPath = join(dir, "token.json");
    await Deno.writeTextFile(
      tokenPath,
      JSON.stringify({
        version: 1,
        token: {
          accessToken: "old-token",
          refreshToken: "refresh-token",
          expiresAt: 0,
          tokenType: "Bearer",
        },
      }),
    );
    const mock = mockFetch(() =>
      json({ access_token: "new-token", expires_in: 3_600, token_type: "Bearer" })
    );
    const session = new GoogleOAuthSession({
      clientId: "client",
      clientSecret: "secret",
      tokenPath,
      fetchImpl: mock.fetch,
      now: () => 60_000,
    });
    strictEqual(await session.getAccessToken(), "new-token");
    strictEqual(mock.calls[0]?.hostname, "oauth2.googleapis.com");
    const saved = JSON.parse(await Deno.readTextFile(tokenPath)) as {
      token: { accessToken: string; refreshToken?: string; expiresAt: number };
    };
    strictEqual(saved.token.accessToken, "new-token");
    strictEqual(saved.token.refreshToken, "refresh-token");
    strictEqual(saved.token.expiresAt, 60_000 + 3_600_000);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("a session with no cache asks the user to sign in", async () => {
  const dir = await tempDir();
  try {
    const session = new GoogleOAuthSession({
      clientId: "client",
      clientSecret: "secret",
      tokenPath: join(dir, "missing.json"),
      fetchImpl: mockFetch(() => json({})).fetch,
    });
    await rejects(
      session.getAccessToken(),
      (error: unknown) =>
        error instanceof ChatError &&
        error.code === "auth_required" &&
        /auth google/.test(error.message),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("malformed token caches are reported as corrupt", async () => {
  const dir = await tempDir();
  try {
    const notJson = join(dir, "not-json.json");
    await Deno.writeTextFile(notJson, "{nope");
    const invalidShape = join(dir, "shape.json");
    await Deno.writeTextFile(invalidShape, JSON.stringify({ version: 1, token: {} }));

    for (const tokenPath of [notJson, invalidShape]) {
      const session = new GoogleOAuthSession({
        clientId: "client",
        clientSecret: "secret",
        tokenPath,
        fetchImpl: mockFetch(() => json({})).fetch,
      });
      await rejects(
        session.getAccessToken(),
        (error: unknown) =>
          error instanceof ChatError &&
          error.code === "storage_corrupt" &&
          /auth google/.test(error.message),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});
