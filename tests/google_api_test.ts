import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { GoogleChatApi } from "../src/google/api.ts";
import { ChatError } from "../src/chat/errors.ts";
import type { FetchLike, GoogleSession } from "../src/google/oauth.ts";

const session: GoogleSession = {
  getAccessToken: () => Promise.resolve("access-token"),
  getUser: () => Promise.resolve({ id: "users/1", displayName: "Alex", handle: "alex" }),
};

interface Call {
  url: URL;
  init: RequestInit | undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = new URL(String(input));
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { fetch: fetchImpl, calls };
}

Deno.test("listSpaces follows pagination and respects maxSpaces", async () => {
  const mock = mockFetch(({ url }) => {
    const token = url.searchParams.get("pageToken");
    if (!token) {
      return json({ spaces: [{ name: "spaces/a" }], nextPageToken: "next" });
    }
    return json({ spaces: [{ name: "spaces/b" }], nextPageToken: "more" });
  });
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  const spaces = await api.listSpaces(2);
  deepStrictEqual(spaces.map((space) => space.name), ["spaces/a", "spaces/b"]);
  strictEqual(mock.calls.length, 2);
  strictEqual(mock.calls[0]!.url.searchParams.get("pageSize"), "2");
  strictEqual(mock.calls[1]!.url.searchParams.get("pageToken"), "next");
  strictEqual(
    new Headers(mock.calls[0]!.init?.headers).get("authorization"),
    "Bearer access-token",
  );
});

Deno.test("listMessages passes ordering, filters, and deleted-message flags", async () => {
  const mock = mockFetch(() => json({ messages: [{ name: "spaces/s/messages/m" }] }));
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  const page = await api.listMessages("spaces/s", {
    pageSize: 25,
    orderBy: "createTime DESC",
    filter: 'thread.name = "spaces/s/threads/t"',
  });
  strictEqual(page.messages.length, 1);
  const params = mock.calls[0]!.url.searchParams;
  strictEqual(params.get("pageSize"), "25");
  strictEqual(params.get("orderBy"), "createTime DESC");
  strictEqual(params.get("showDeleted"), "true");
  strictEqual(params.get("filter"), 'thread.name = "spaces/s/threads/t"');
  strictEqual(mock.calls[0]!.url.pathname, "/v1/spaces/s/messages");
});

Deno.test("createMessage sends text, request ids, and thread fallback options", async () => {
  const mock = mockFetch(() => json({ name: "spaces/s/messages/new", text: "hi" }));
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  await api.createMessage({
    spaceName: "spaces/s",
    text: "hi",
    threadName: "spaces/s/threads/t",
    requestId: "request-1",
  });
  const call = mock.calls[0]!;
  strictEqual(call.init?.method, "POST");
  strictEqual(call.url.searchParams.get("requestId"), "request-1");
  strictEqual(
    call.url.searchParams.get("messageReplyOption"),
    "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
  );
  deepStrictEqual(JSON.parse(String(call.init?.body)), {
    text: "hi",
    thread: { name: "spaces/s/threads/t" },
  });
});

Deno.test("update and delete use the REST update mask and DELETE method", async () => {
  const mock = mockFetch(({ init }) => {
    if (init?.method === "PATCH") return json({ name: "spaces/s/messages/m", text: "new" });
    return new Response(null, { status: 204 });
  });
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  const updated = await api.updateMessage("spaces/s/messages/m", "new");
  strictEqual(updated.text, "new");
  strictEqual(mock.calls[0]!.url.searchParams.get("updateMask"), "text");
  strictEqual(mock.calls[0]!.init?.method, "PATCH");

  await api.deleteMessage("spaces/s/messages/m");
  strictEqual(mock.calls[1]!.init?.method, "DELETE");
  strictEqual(mock.calls[1]!.url.pathname, "/v1/spaces/s/messages/m");
});

Deno.test("thread listing filters by thread name and strips quotes", async () => {
  const mock = mockFetch(() => json({ messages: [] }));
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  await api.listThreadMessages("spaces/s", 'threads/t"quote');
  const filter = mock.calls[0]!.url.searchParams.get("filter");
  strictEqual(filter, 'thread.name = "threads/tquote"');
  strictEqual(mock.calls[0]!.url.searchParams.get("orderBy"), "createTime ASC");
});

Deno.test("read state uses the current user resource and update mask", async () => {
  const mock = mockFetch(({ init }) => {
    if (init?.method === "PATCH") {
      return json({ name: "users/me/spaces/s/spaceReadState" });
    }
    return json({ name: "users/me/spaces/s/spaceReadState", lastReadTime: "2026-01-01T00:00:00Z" });
  });
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  const state = await api.getSpaceReadState("spaces/s");
  strictEqual(state?.lastReadTime, "2026-01-01T00:00:00Z");
  await api.updateSpaceReadState("spaces/s", "2026-01-02T00:00:00Z");
  const patch = mock.calls[1]!;
  strictEqual(patch.url.searchParams.get("updateMask"), "lastReadTime");
  const body = JSON.parse(String(patch.init?.body));
  strictEqual(body.name, "users/me/spaces/s/spaceReadState");
  strictEqual(body.lastReadTime, "2026-01-02T00:00:00Z");
});

Deno.test("missing read state permission is treated as no remote state", async () => {
  const mock = mockFetch(() => json({ error: { message: "nope" } }, 403));
  const api = new GoogleChatApi({
    session,
    fetchImpl: mock.fetch,
    baseUrl: "https://chat.example/v1",
  });
  strictEqual(await api.getSpaceReadState("spaces/s"), undefined);
});

Deno.test("HTTP failures map to user-presentable ChatErrors", async () => {
  const cases: Array<[number, string]> = [
    [401, "auth_required"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "invalid_input"],
    [500, "network_error"],
  ];
  for (const [status, code] of cases) {
    const mock = mockFetch(() => json({ error: { message: `failure ${status}` } }, status));
    const api = new GoogleChatApi({
      session,
      fetchImpl: mock.fetch,
      baseUrl: "https://chat.example/v1",
    });
    await rejects(
      api.listSpaces(1),
      (error: unknown) => error instanceof ChatError && error.code === code,
    );
  }
});

Deno.test("network and malformed JSON failures are reported clearly", async () => {
  const offline: FetchLike = () => Promise.reject(new Error("offline"));
  const offlineApi = new GoogleChatApi({
    session,
    fetchImpl: offline,
    baseUrl: "https://chat.example/v1",
  });
  await rejects(
    offlineApi.listSpaces(1),
    (error: unknown) =>
      error instanceof ChatError && error.code === "network_error" && /offline/.test(error.message),
  );

  const malformed = mockFetch(() => new Response("<html>nope</html>", { status: 200 }));
  const malformedApi = new GoogleChatApi({
    session,
    fetchImpl: malformed.fetch,
    baseUrl: "https://chat.example/v1",
  });
  await rejects(malformedApi.listSpaces(1), /malformed JSON/);
});
