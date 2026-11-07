import { deepStrictEqual, match, rejects, strictEqual, throws } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "../src/server/errors.ts";
import { migrate, openDatabase } from "../src/server/db.ts";
import { createRequestHandler } from "../src/server/http.ts";
import { MessagingStore, normalizeHandle, validateHandle } from "../src/server/store.ts";

interface Harness {
  db: DatabaseSync;
  store: MessagingStore;
  handler: (request: Request) => Promise<Response>;
}

function harness(): Harness {
  const db = openDatabase(":memory:");
  let clock = Date.parse("2026-01-01T09:00:00.000Z");
  const store = new MessagingStore(db, {
    passwordIterations: 1_000,
    now: () => new Date(clock += 1_000),
    idFactory: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  });
  const handler = createRequestHandler(store);
  return { db, store, handler };
}

let counter = 0;

async function register(store: MessagingStore, handle: string, name = handle) {
  return await store.register({ handle, displayName: name, password: "correct horse battery" });
}

Deno.test("accounts: registration hashes passwords and sessions store only token hashes", async () => {
  const { db, store } = harness();
  const alice = await register(store, "Alice", "Alice Adams");
  strictEqual(alice.user.handle, "alice");
  strictEqual(alice.user.displayName, "Alice Adams");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(alice.user.id) as {
    password_hash: string;
    handle: string;
  };
  strictEqual(row.handle, "alice");
  strictEqual(row.password_hash.startsWith("pbkdf2-sha256$"), true);
  strictEqual(row.password_hash.includes("correct horse battery"), false);

  const session = db.prepare("SELECT * FROM sessions WHERE user_id = ?").get(alice.user.id) as {
    token_hash: string;
  };
  strictEqual(session.token_hash === alice.token, false);
  strictEqual(session.token_hash.length, 64);

  const authenticated = await store.authenticate(alice.token);
  strictEqual(authenticated?.id, alice.user.id);
  await store.logout(alice.token);
  strictEqual(await store.authenticate(alice.token), null);
});

Deno.test("accounts: duplicate handles and bad passwords are rejected without leaking accounts", async () => {
  const { store } = harness();
  await register(store, "alice");
  await rejects(
    register(store, "ALICE"),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );

  await rejects(
    store.login("alice", "wrong password"),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.message === "That handle or password is not correct.",
  );
  await rejects(
    store.login("nobody", "wrong password"),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.message === "That handle or password is not correct.",
  );

  const result = await store.login("@ALICE", "correct horse battery");
  strictEqual(result.user.handle, "alice");
});

Deno.test("accounts: validation and profile updates", async () => {
  const { store } = harness();
  const alice = await register(store, "alice");
  const bob = await register(store, "bob");

  strictEqual(normalizeHandle("  @Alice_1 "), "alice_1");
  throws(() => validateHandle("ab"), /3-32 characters/);
  throws(() => validateHandle("has space"), /3-32 characters/);

  const updated = store.updateProfile(alice.user.id, { displayName: "  Alice   A. " });
  strictEqual(updated.displayName, "Alice A.");
  const renamed = store.updateProfile(alice.user.id, { handle: "@alice_new" });
  strictEqual(renamed.handle, "alice_new");
  throws(
    () => store.updateProfile(alice.user.id, { handle: bob.user.handle }),
    /already taken/,
  );
  deepStrictEqual(store.searchUsers(alice.user.id, "bo").map((user) => user.handle), ["bob"]);
});

Deno.test("direct messages are idempotent and hidden from non-members", async () => {
  const { store } = harness();
  const alice = await register(store, "alice");
  await register(store, "bob");
  const carol = await register(store, "carol");

  const first = await store.createConversation(alice.user.id, {
    kind: "dm",
    memberHandles: ["bob"],
  });
  strictEqual(first.conversation.kind, "dm");
  strictEqual(first.created, true);
  strictEqual(first.conversation.members.length, 2);

  const second = await store.createConversation(alice.user.id, {
    kind: "dm",
    memberHandles: ["@BOB"],
  });
  strictEqual(second.created, false);
  strictEqual(second.conversation.id, first.conversation.id);

  const message = await store.sendMessage(alice.user.id, first.conversation.id, "hello Bob");
  strictEqual(message.body, "hello Bob");

  // Non-members get a not-found response so conversation existence is not disclosed.
  await rejects(
    store.getConversation(carol.user.id, first.conversation.id),
    /not found/i,
  );
  await rejects(
    store.getMessagePage(carol.user.id, first.conversation.id),
    /not found/i,
  );
  await rejects(
    store.sendMessage(carol.user.id, first.conversation.id, "let me in"),
    /not found/i,
  );
  await rejects(
    store.getThread(carol.user.id, message.id),
    /not found/i,
  );
  strictEqual((await store.search(carol.user.id, "hello")).length, 0);
});

Deno.test("messages: ordering, pagination, edit, delete, and read state", async () => {
  const { store } = harness();
  const alice = await register(store, "alice");
  const bob = await register(store, "bob");
  const group = await store.createConversation(alice.user.id, {
    kind: "group",
    name: "Team",
    memberHandles: ["bob"],
  });
  const id = group.conversation.id;

  const first = await store.sendMessage(alice.user.id, id, "one");
  await store.sendMessage(bob.user.id, id, "two");
  const third = await store.sendMessage(alice.user.id, id, "three");

  const page = await store.getMessagePage(alice.user.id, id, { limit: 2 });
  deepStrictEqual(page.messages.map((message) => message.body), ["two", "three"]);
  strictEqual(page.hasMore, true);
  strictEqual(typeof page.nextBefore, "number");

  const older = await store.getMessagePage(alice.user.id, id, {
    limit: 2,
    before: page.nextBefore,
  });
  deepStrictEqual(older.messages.map((message) => message.body), ["one"]);
  strictEqual(older.hasMore, false);

  const thread = await store.getThread(bob.user.id, first.id);
  deepStrictEqual(thread.map((message) => message.body), ["one"]);

  const edited = await store.editMessage(alice.user.id, first.id, "one (edited)");
  strictEqual(edited.body, "one (edited)");
  strictEqual(typeof edited.editedAt, "string");
  await rejects(() => store.editMessage(bob.user.id, first.id, "hijacked"), /your own/);

  await store.deleteMessage(alice.user.id, third.id);
  const afterDelete = await store.getMessagePage(alice.user.id, id, { limit: 10 });
  const deleted = afterDelete.messages.find((message) => message.id === third.id)!;
  strictEqual(deleted.body, "");
  strictEqual(typeof deleted.deletedAt, "string");
  await rejects(() => store.editMessage(alice.user.id, third.id, "revived"), /Deleted/);
  throws(() => store.deleteMessage(bob.user.id, first.id), /your own/);

  const before = await store.getConversation(bob.user.id, id);
  strictEqual(before.unreadCount, 1);
  const read = await store.markRead(bob.user.id, id);
  strictEqual(read.unreadCount, 0);
});

Deno.test("membership: invite, remove, ownership, and leave", async () => {
  const { store } = harness();
  const alice = await register(store, "alice");
  const bob = await register(store, "bob");
  const carol = await register(store, "carol");

  const group = await store.createConversation(alice.user.id, {
    kind: "group",
    name: "Garden",
    memberHandles: ["bob"],
  });
  const id = group.conversation.id;

  await rejects(
    store.addMember(carol.user.id, id, "carol"),
    /not found/i,
  );
  strictEqual((await store.addMember(alice.user.id, id, "@carol")).members.length, 3);
  await rejects(
    store.addMember(alice.user.id, id, "carol"),
    /already in/,
  );

  throws(
    () => store.removeMember(bob.user.id, id, carol.user.id),
    /owner can remove/,
  );
  strictEqual(store.removeMember(alice.user.id, id, carol.user.id), false);
  strictEqual(store.listMembers(alice.user.id, id).length, 2);

  // A member may leave on their own, and ownership transfers when the owner leaves.
  strictEqual(store.removeMember(bob.user.id, id, bob.user.id), false);
  strictEqual(store.listMembers(alice.user.id, id).length, 1);
  strictEqual(store.listMembers(alice.user.id, id)[0]!.role, "owner");

  const dm = await store.createConversation(alice.user.id, {
    kind: "dm",
    memberHandles: ["bob"],
  });
  await rejects(
    store.addMember(alice.user.id, dm.conversation.id, "carol"),
    /Direct messages/,
  );
});

Deno.test("search and events are scoped to the current user's memberships", async () => {
  const { store } = harness();
  const alice = await register(store, "alice");
  const bob = await register(store, "bob");
  const carol = await register(store, "carol");

  const dm = await store.createConversation(alice.user.id, {
    kind: "dm",
    memberHandles: ["bob"],
  });
  const secret = await store.sendMessage(alice.user.id, dm.conversation.id, "a private plan");
  const group = await store.createConversation(alice.user.id, {
    kind: "group",
    name: "Planning",
    memberHandles: ["bob", "carol"],
  });
  await store.sendMessage(alice.user.id, group.conversation.id, "the public plan");

  deepStrictEqual(
    (await store.search(bob.user.id, "plan")).map((result) => result.message.body).sort(),
    ["a private plan", "the public plan"],
  );
  deepStrictEqual(
    (await store.search(carol.user.id, "plan")).map((result) => result.message.body),
    ["the public plan"],
  );
  strictEqual(
    (await store.search(bob.user.id, "private plan"))[0]!.snippet.includes("private"),
    true,
  );

  const aliceEvents = await store.getEvents(alice.user.id, 0, 200);
  strictEqual(aliceEvents.events.some((event) => event.messageId === secret.id), true);
  const bobEvents = await store.getEvents(bob.user.id, 0, 200);
  strictEqual(bobEvents.events.some((event) => event.messageId === secret.id), true);

  // Carol only sees events for the group she was added to.
  const carolEvents = await store.getEvents(carol.user.id, 0, 200);
  strictEqual(
    carolEvents.events.every((event) => event.conversationId === group.conversation.id),
    true,
  );

  await store.markRead(bob.user.id, dm.conversation.id);
  const readEvents = await store.getEvents(alice.user.id, 0, 200);
  strictEqual(readEvents.events.some((event) => event.type === "read"), true);
  strictEqual(store.headEventSeq() >= readEvents.nextSeq, true);
});

Deno.test("HTTP API: auth, validation, routes, and authorization", async () => {
  const { handler } = harness();

  const health = await handler(new Request("http://localhost/health"));
  strictEqual(health.status, 200);
  strictEqual((await health.json()).status, "ok");

  const unauthenticated = await handler(new Request("http://localhost/v1/me"));
  strictEqual(unauthenticated.status, 401);

  const aliceAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "alice",
    displayName: "Alice",
    password: "correct horse battery",
  });
  strictEqual(aliceAuth.status, 201);
  const alice = await aliceAuth.json();
  const aliceToken = alice.token as string;

  const bobAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "bob",
    displayName: "Bob",
    password: "correct horse battery",
  });
  const bobToken = (await bobAuth.json()).token as string;

  const me = await callJson(handler, "GET", "/v1/me", aliceToken);
  strictEqual((await me.json()).user.handle, "alice");

  const created = await callJson(handler, "POST", "/v1/conversations", aliceToken, {
    kind: "group",
    name: "Team",
    memberHandles: ["bob"],
  });
  strictEqual(created.status, 201);
  const conversation = (await created.json()).conversation;
  const conversationId = conversation.id as string;

  const sent = await callJson(
    handler,
    "POST",
    `/v1/conversations/${conversationId}/messages`,
    aliceToken,
    { body: "hello from the API" },
  );
  strictEqual(sent.status, 201);
  const message = (await sent.json()).message;

  const page = await callJson(
    handler,
    "GET",
    `/v1/conversations/${conversationId}/messages?limit=10`,
    bobToken,
  );
  strictEqual(page.status, 200);
  const pageBody = await page.json();
  strictEqual(pageBody.messages.length, 1);
  strictEqual(pageBody.hasMore, false);

  const carolAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "carol",
    displayName: "Carol",
    password: "correct horse battery",
  });
  const carolToken = (await carolAuth.json()).token as string;
  const forbidden = await callJson(
    handler,
    "GET",
    `/v1/conversations/${conversationId}/messages`,
    carolToken,
  );
  strictEqual(forbidden.status, 404);
  strictEqual((await forbidden.json()).error.code, "not_found");

  const badBody = await callJson(
    handler,
    "POST",
    `/v1/conversations/${conversationId}/messages`,
    aliceToken,
    { body: "   " },
  );
  strictEqual(badBody.status, 400);

  const editOther = await callJson(handler, "PATCH", `/v1/messages/${message.id}`, bobToken, {
    body: "not mine",
  });
  strictEqual(editOther.status, 403);

  const edited = await callJson(handler, "PATCH", `/v1/messages/${message.id}`, aliceToken, {
    body: "edited through HTTP",
  });
  strictEqual(edited.status, 200);
  strictEqual((await edited.json()).message.body, "edited through HTTP");

  const read = await callJson(
    handler,
    "POST",
    `/v1/conversations/${conversationId}/read`,
    bobToken,
  );
  strictEqual(read.status, 200);

  const search = await callJson(handler, "GET", "/v1/search?query=through", aliceToken);
  strictEqual((await search.json()).results.length, 1);

  const deleted = await callJson(handler, "DELETE", `/v1/messages/${message.id}`, aliceToken);
  strictEqual(deleted.status, 204);

  const logout = await callJson(handler, "POST", "/v1/auth/logout", aliceToken);
  strictEqual(logout.status, 204);
  const afterLogout = await callJson(handler, "GET", "/v1/me", aliceToken);
  strictEqual(afterLogout.status, 401);

  const unknown = await callJson(handler, "GET", "/v1/nope", aliceToken);
  strictEqual(unknown.status, 401);
});

Deno.test("HTTP API: login failures are rate limited without revealing the account", async () => {
  const { handler } = harness();
  await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "alice",
    displayName: "Alice",
    password: "correct horse battery",
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await callJson(handler, "POST", "/v1/auth/login", undefined, {
      handle: "alice",
      password: "wrong password",
    });
    strictEqual(response.status, 401);
    match((await response.json()).error.message, /not correct/);
  }
  const limited = await callJson(handler, "POST", "/v1/auth/login", undefined, {
    handle: "alice",
    password: "wrong password",
  });
  strictEqual(limited.status, 429);
});

Deno.test("database: version 1 databases gain the administrator column", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);

  migrate(db);

  const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  strictEqual(columns.some((column) => column.name === "is_admin"), true);
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  strictEqual(Number(version.user_version), 2);
});

Deno.test("admin: first account owns the dashboard and non-admins are rejected", async () => {
  const { db, handler } = harness();

  const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  strictEqual(columns.some((column) => column.name === "is_admin"), true);

  const aliceAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "alice",
    displayName: "Alice",
    password: "correct horse battery",
  });
  const alice = await aliceAuth.json();
  strictEqual(alice.user.isAdmin, true);
  const aliceToken = alice.token as string;

  const bobAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "bob",
    displayName: "Bob",
    password: "correct horse battery",
  });
  const bob = await bobAuth.json();
  strictEqual(bob.user.isAdmin, false);
  const bobToken = bob.token as string;

  const denied = await callJson(handler, "GET", "/v1/admin/overview", bobToken);
  strictEqual(denied.status, 403);
  strictEqual((await denied.json()).error.code, "forbidden");

  const overview = await callJson(handler, "GET", "/v1/admin/overview", aliceToken);
  strictEqual(overview.status, 200);
  const overviewBody = (await overview.json()).overview;
  strictEqual(overviewBody.users, 2);
  strictEqual(overviewBody.admins, 1);
  strictEqual(overviewBody.conversations, 0);

  const users = await callJson(handler, "GET", "/v1/admin/users?query=bo", aliceToken);
  strictEqual(users.status, 200);
  const userPage = await users.json();
  strictEqual(userPage.total, 1);
  strictEqual(userPage.users[0].handle, "bob");

  const promoted = await callJson(
    handler,
    "PATCH",
    `/v1/admin/users/${bob.user.id}`,
    aliceToken,
    { isAdmin: true },
  );
  strictEqual(promoted.status, 200);
  strictEqual((await promoted.json()).user.isAdmin, true);

  const demoted = await callJson(
    handler,
    "PATCH",
    `/v1/admin/users/${alice.user.id}`,
    bobToken,
    { isAdmin: false },
  );
  strictEqual(demoted.status, 200);
  strictEqual((await demoted.json()).user.isAdmin, false);

  const lastAdmin = await callJson(
    handler,
    "PATCH",
    `/v1/admin/users/${bob.user.id}`,
    bobToken,
    { isAdmin: false },
  );
  strictEqual(lastAdmin.status, 409);
  strictEqual((await lastAdmin.json()).error.code, "conflict");

  const badPatch = await callJson(
    handler,
    "PATCH",
    `/v1/admin/users/${bob.user.id}`,
    bobToken,
    { isAdmin: "yes" },
  );
  strictEqual(badPatch.status, 400);
});

Deno.test("admin: moderation deletes conversations and messages with broadcast events", async () => {
  const { handler } = harness();
  const aliceAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "alice",
    displayName: "Alice",
    password: "correct horse battery",
  });
  const aliceToken = (await aliceAuth.json()).token as string;
  const bobAuth = await callJson(handler, "POST", "/v1/auth/register", undefined, {
    handle: "bob",
    displayName: "Bob",
    password: "correct horse battery",
  });
  const bobToken = (await bobAuth.json()).token as string;

  const created = await callJson(handler, "POST", "/v1/conversations", aliceToken, {
    kind: "group",
    name: "Moderated",
    memberHandles: ["bob"],
  });
  const conversationId = (await created.json()).conversation.id as string;
  const sent = await callJson(
    handler,
    "POST",
    `/v1/conversations/${conversationId}/messages`,
    bobToken,
    { body: "message from bob" },
  );
  const messageId = (await sent.json()).message.id as string;

  const deletedMessage = await callJson(
    handler,
    "DELETE",
    `/v1/admin/messages/${messageId}`,
    aliceToken,
  );
  strictEqual(deletedMessage.status, 204);

  const history = await callJson(
    handler,
    "GET",
    `/v1/conversations/${conversationId}/messages`,
    bobToken,
  );
  const deleted = (await history.json()).messages[0];
  strictEqual(deleted.body, "");
  strictEqual(typeof deleted.deletedAt, "string");

  const headResponse = await callJson(handler, "GET", "/v1/events/head", bobToken);
  const head = (await headResponse.json()).seq as number;
  const deletedConversation = await callJson(
    handler,
    "DELETE",
    `/v1/admin/conversations/${conversationId}`,
    aliceToken,
  );
  strictEqual(deletedConversation.status, 204);

  const gone = await callJson(
    handler,
    "GET",
    `/v1/conversations/${conversationId}`,
    bobToken,
  );
  strictEqual(gone.status, 404);

  const events = await callJson(handler, "GET", `/v1/events?after=${head}`, bobToken);
  const broadcast = (await events.json()).events.find((event: { type: string }) =>
    event.type === "conversation-updated"
  );
  strictEqual(broadcast.conversationId, "");

  const adminEvents = await callJson(handler, "GET", "/v1/admin/events?limit=20", aliceToken);
  strictEqual(adminEvents.status, 200);
  const adminEventBody = await adminEvents.json();
  strictEqual(Array.isArray(adminEventBody.events), true);
  const removal = adminEventBody.events.find(
    (event: { type: string; conversationId: string | null }) =>
      event.type === "conversation-updated" && event.conversationId === null,
  );
  strictEqual(removal.actor.handle, "alice");
  strictEqual(typeof removal.seq, "number");
});

Deno.test("admin: configured handle promotion and the last-admin guard", async () => {
  const { store } = harness();
  const alice = await register(store, "alice");
  const bob = await register(store, "bob");
  strictEqual(alice.user.isAdmin, true);

  const promoted = store.ensureAdmin("@bob");
  strictEqual(promoted?.isAdmin, true);
  throws(() => store.ensureAdmin("nobody"), /No account exists/);

  strictEqual(store.setAdmin(alice.user.id, false).isAdmin, false);
  strictEqual(store.isAdmin(alice.user.id), false);
  throws(() => store.setAdmin(bob.user.id, false), /At least one administrator/);
});

Deno.test("dashboard assets are served with a strict content security policy", async () => {
  const { handler } = harness();

  const page = await handler(new Request("http://localhost/admin"));
  strictEqual(page.status, 200);
  strictEqual(page.headers.get("content-type"), "text/html; charset=utf-8");
  strictEqual(page.headers.get("x-content-type-options"), "nosniff");
  const csp = page.headers.get("content-security-policy") ?? "";
  strictEqual(csp.includes("script-src 'self'"), true);
  strictEqual(csp.includes("frame-ancestors 'none'"), true);
  const html = await page.text();
  strictEqual(html.includes("Pulsewire Admin"), true);
  strictEqual(html.includes("/admin/app.js"), true);

  const script = await handler(new Request("http://localhost/admin/app.js"));
  strictEqual(script.status, 200);
  strictEqual(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  const source = await script.text();
  strictEqual(source.includes("pulsewire.admin.token"), true);

  const styles = await handler(new Request("http://localhost/admin/styles.css"));
  strictEqual(styles.status, 200);
  strictEqual(styles.headers.get("content-type"), "text/css; charset=utf-8");
  strictEqual((await styles.text()).includes("--accent"), true);
});

async function callJson(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
