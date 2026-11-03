// deno-lint-ignore-file require-await
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { GoogleChatProvider } from "../src/google/provider.ts";
import { ChatError } from "../src/chat/errors.ts";
import type { FetchLike, GoogleSession } from "../src/google/oauth.ts";
import type { ProviderEvent } from "../src/chat/types.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");

const session: GoogleSession = {
  getAccessToken: () => Promise.resolve("token"),
  getUser: () =>
    Promise.resolve({
      id: "users/me",
      displayName: "Alex Rivera",
      handle: "alex",
    }),
};

interface Harness {
  fetch: FetchLike;
  calls: URL[];
  bodies: unknown[];
}

function response(value: unknown, status = 200): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(overrides: {
  messages?: Record<string, unknown[]>;
  createMessage?: (body: Record<string, unknown>) => unknown;
  updateMessage?: (body: Record<string, unknown>) => unknown;
} = {}): Harness {
  const calls: URL[] = [];
  const bodies: unknown[] = [];
  const messages: Record<string, unknown[]> = overrides.messages ?? {
    "spaces/team": [
      {
        name: "spaces/team/messages/m1",
        sender: { name: "users/2", displayName: "Maya Chen" },
        createTime: "2026-11-03T10:00:00.000Z",
        text: "hello team",
        thread: { name: "spaces/team/threads/t1" },
      },
      {
        name: "spaces/team/messages/m2",
        sender: { name: "users/me", displayName: "Alex Rivera" },
        createTime: "2026-11-03T10:05:00.000Z",
        text: "thread reply",
        thread: { name: "spaces/team/threads/t1", threadReply: true },
      },
      {
        name: "spaces/team/messages/m3",
        sender: { name: "users/2", displayName: "Maya Chen" },
        createTime: "2026-11-03T11:00:00.000Z",
        text: "newest team note",
      },
    ],
    "spaces/dm": [
      {
        name: "spaces/dm/messages/d1",
        sender: { name: "users/2", displayName: "Maya Chen" },
        createTime: "2026-11-03T10:00:00.000Z",
        text: "direct note",
      },
    ],
  };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (init?.body) {
      try {
        bodies.push(JSON.parse(String(init.body)));
      } catch {
        bodies.push(init.body);
      }
    }

    if (url.hostname === "openidconnect.googleapis.com") {
      return response({
        id: "123",
        name: "Alex Rivera",
        email: "alex@example.com",
      });
    }

    const path = url.pathname.replace(/^\/v1\/?/, "");
    const method = init?.method ?? "GET";

    if (path === "spaces") {
      return response({
        spaces: [
          {
            name: "spaces/team",
            spaceType: "SPACE",
            displayName: "Team Room",
            spaceDetails: { description: "Where the team talks" },
            lastActiveTime: "2026-11-03T11:00:00.000Z",
          },
          {
            name: "spaces/dm",
            spaceType: "DIRECT_MESSAGE",
            lastActiveTime: "2026-11-03T10:00:00.000Z",
          },
        ],
      });
    }

    if (path.endsWith("/members")) {
      const space = path.slice(0, -"/members".length);
      return response({
        memberships: [
          { name: `${space}/members/1`, member: { name: "users/me", displayName: "Alex Rivera" } },
          { name: `${space}/members/2`, member: { name: "users/2", displayName: "Maya Chen" } },
        ],
      });
    }

    if (path.endsWith("/spaceReadState")) {
      const space = path.slice(0, -"/spaceReadState".length);
      if (method === "PATCH") {
        return response({ name: `${space}/spaceReadState` });
      }
      return response({
        name: `${space}/spaceReadState`,
        lastReadTime: space.endsWith("spaces/team")
          ? "2026-11-03T10:30:00.000Z"
          : "2026-11-03T11:00:00.000Z",
      });
    }

    if (path.endsWith("/messages") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const created = overrides.createMessage?.(body) ?? {
        name: "spaces/team/messages/new1",
        sender: { name: "users/me", displayName: "Alex Rivera" },
        createTime: "2026-11-03T12:00:00.000Z",
        text: body.text,
        ...(body.thread ? { thread: { name: "spaces/team/threads/t1", threadReply: true } } : {}),
      };
      return response(created);
    }

    if (path.endsWith("/messages") && method === "GET") {
      const space = path.slice(0, -"/messages".length);
      const filter = url.searchParams.get("filter");
      const all = messages[space] ?? [];
      if (filter) {
        const threadName = /thread\.name = "([^"]+)"/.exec(filter)?.[1];
        return response({
          messages: all.filter((message) => {
            const thread = (message as { thread?: { name?: string } }).thread;
            return thread?.name === threadName;
          }),
        });
      }
      return response({ messages: all });
    }

    if (path.endsWith("/messages/new1") && method === "DELETE") {
      return response(undefined, 204);
    }

    if (path.includes("/messages/") && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const name = path;
      return response(
        overrides.updateMessage?.(body) ?? {
          name,
          sender: { name: "users/me", displayName: "Alex Rivera" },
          createTime: "2026-11-03T10:00:00.000Z",
          updateTime: "2026-11-03T12:00:00.000Z",
          text: body.text,
        },
      );
    }

    if (path.includes("/messages/") && method === "GET") {
      const name = path;
      const space = name.split("/messages/")[0] ?? "";
      const found = (messages[space] ?? []).find((message) =>
        (message as { name?: string }).name === name
      );
      if (found) return response(found);
      return response({ error: { message: "missing" } }, 404);
    }

    return response({ error: { message: `unhandled ${method} ${path}` } }, 500);
  };

  return { fetch: fetchImpl, calls, bodies };
}

async function connectProvider(h: Harness, dir: string): Promise<GoogleChatProvider> {
  const provider = new GoogleChatProvider({
    session,
    dataDir: dir,
    readStatePath: join(dir, "readstate.json"),
    pollIntervalMs: 0,
    maxSpaces: 10,
    fetchImpl: h.fetch,
    baseUrl: "https://chat.example/v1",
    now: () => NOW,
  });
  await provider.connect();
  return provider;
}

Deno.test("Google provider connects, names spaces, and computes unread counts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  try {
    const workspace = await provider.connect();
    strictEqual(workspace.name, "Google Chat");
    strictEqual(workspace.demo, false);
    strictEqual(workspace.currentUser.id, "users/me");

    const conversations = await provider.listConversations();
    const team = conversations.find((item) => item.id === "spaces/team");
    const dm = conversations.find((item) => item.id === "spaces/dm");
    strictEqual(team?.name, "Team Room");
    strictEqual(team?.kind, "space");
    strictEqual(team?.topic, "Where the team talks");
    strictEqual(team?.unreadCount, 1);
    strictEqual(dm?.name, "Maya Chen");
    strictEqual(dm?.kind, "dm");
    strictEqual(dm?.unreadCount, 0);

    const messages = await provider.getMessages("spaces/team");
    deepStrictEqual(messages.map((message) => message.id), [
      "spaces/team/messages/m1",
      "spaces/team/messages/m2",
      "spaces/team/messages/m3",
    ]);
    const reply = messages.find((message) => message.id === "spaces/team/messages/m2");
    strictEqual(reply?.replyToId, "spaces/team/messages/m1");
    // History carries no receipts: Google Chat does not expose them.
    strictEqual(messages.every((message) => message.delivery === undefined), true);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Google provider sends, edits, and deletes messages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  try {
    await provider.getMessages("spaces/team");
    const sent = await provider.sendMessage({
      conversationId: "spaces/team",
      body: "  a new message  ",
    });
    strictEqual(sent.body, "a new message");
    strictEqual(sent.author.id, "users/me");
    // The API confirms acceptance, so we show "sent" and never fake read receipts.
    strictEqual(sent.delivery?.status, "sent");
    const createBody = h.bodies.find((body) =>
      typeof body === "object" && body !== null &&
      (body as { text?: string }).text === "a new message"
    ) as { thread?: unknown } | undefined;
    strictEqual(createBody?.thread, undefined);
    strictEqual(events.some((event) => event.type === "message-created"), true);

    const edited = await provider.editMessage("spaces/team/messages/new1", "changed");
    strictEqual(edited.body, "changed");
    strictEqual(edited.editedAt !== undefined, true);
    strictEqual(events.some((event) => event.type === "message-updated"), true);

    await provider.deleteMessage("spaces/team/messages/new1");
    strictEqual(events.some((event) => event.type === "message-deleted"), true);
    const deleted = (await provider.getMessages("spaces/team")).find((message) =>
      message.id === "spaces/team/messages/new1"
    );
    strictEqual(deleted?.deletedAt !== undefined, true);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Google provider replies inside a thread when the parent supports it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  try {
    await provider.getMessages("spaces/team");
    await provider.sendMessage({
      conversationId: "spaces/team",
      body: "threaded reply",
      replyToId: "spaces/team/messages/m1",
    });
    const body = h.bodies.find((value) =>
      typeof value === "object" && value !== null &&
      (value as { text?: string }).text === "threaded reply"
    ) as { thread?: { name?: string } } | undefined;
    strictEqual(body?.thread?.name, "spaces/team/threads/t1");
    const createUrl = h.calls.find((url) =>
      url.pathname.endsWith("/messages") && url.searchParams.get("requestId") !== null
    );
    strictEqual(
      createUrl?.searchParams.get("messageReplyOption"),
      "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Google provider returns thread roots and replies", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  try {
    await provider.getMessages("spaces/team");
    const thread = await provider.getThread("spaces/team/messages/m2");
    deepStrictEqual(thread.map((message) => message.id), [
      "spaces/team/messages/m1",
      "spaces/team/messages/m2",
    ]);
    const single = await provider.getThread("spaces/team/messages/m3");
    strictEqual(single.length, 1);
    strictEqual(single[0]?.id, "spaces/team/messages/m3");
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Google provider searches loaded messages and reports empty queries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  try {
    await provider.getMessages("spaces/team");
    const results = await provider.searchMessages("team note");
    strictEqual(results.length > 0, true);
    strictEqual(results.every((result) => result.conversation.id === "spaces/team"), true);
    const byAuthor = await provider.searchMessages("maya");
    strictEqual(byAuthor.length > 0, true);
    deepStrictEqual(await provider.searchMessages("   "), []);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Google provider persists local read state and marks the space read", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  try {
    await provider.markRead("spaces/team");
    const raw = await Deno.readTextFile(join(dir, "readstate.json"));
    const parsed = JSON.parse(raw) as { version: number; lastRead: Record<string, string> };
    strictEqual(parsed.version, 1);
    strictEqual(parsed.lastRead["spaces/team"], NOW.toISOString());
    const conversation = (await provider.listConversations()).find((item) =>
      item.id === "spaces/team"
    );
    strictEqual(conversation?.unreadCount, 0);
    const patch = h.calls.find((url) =>
      url.pathname.endsWith("/spaceReadState") &&
      url.searchParams.get("updateMask") === "lastReadTime"
    );
    strictEqual(patch !== undefined, true);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Google provider requires a connection and reports missing spaces", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const unconnected = new GoogleChatProvider({
    session,
    dataDir: dir,
    readStatePath: join(dir, "readstate.json"),
    pollIntervalMs: 0,
    fetchImpl: h.fetch,
    now: () => NOW,
  });
  try {
    await rejects(
      unconnected.listConversations(),
      (error: unknown) => error instanceof ChatError && error.code === "not_connected",
    );
    const provider = await connectProvider(h, dir);
    await rejects(
      provider.sendMessage({ conversationId: "spaces/missing", body: "hi" }),
      (error: unknown) => error instanceof ChatError && error.code === "not_found",
    );
    await rejects(
      provider.getMessages("spaces/missing"),
      (error: unknown) => error instanceof ChatError && error.code === "not_found",
    );
    await provider.dispose();
  } finally {
    await unconnected.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("thread support is limited to full spaces", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-google-" });
  const h = harness();
  const provider = await connectProvider(h, dir);
  try {
    const conversations = await provider.listConversations();
    const team = conversations.find((item) => item.id === "spaces/team");
    const dm = conversations.find((item) => item.id === "spaces/dm");
    if (!team || !dm) throw new Error("missing fixture conversation");
    strictEqual(provider.isThreadingSupported(team), true);
    strictEqual(provider.isThreadingSupported(dm), false);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});
