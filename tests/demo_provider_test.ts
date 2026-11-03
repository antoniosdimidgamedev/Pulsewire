import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import type { AiReplyRequest } from "../src/chat/ai.ts";
import { DemoProvider } from "../src/chat/demo-provider.ts";
import type { ProviderEvent } from "../src/chat/types.ts";
import { ChatError } from "../src/chat/errors.ts";

const FIXED = new Date("2026-11-03T12:00:00.000Z");

async function withProvider(
  run: (context: {
    provider: DemoProvider;
    dataPath: string;
    dir: string;
    events: ProviderEvent[];
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-" });
  const dataPath = join(dir, "demo.json");
  const provider = new DemoProvider({
    dataPath,
    displayName: "Alex Rivera",
    simulateActivity: false,
    connectDelayMs: 0,
    now: () => FIXED,
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  try {
    await run({ provider, dataPath, dir, events });
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("demo provider seeds a persistent local workspace", async () => {
  await withProvider(async ({ provider, dataPath, events }) => {
    const workspace = await provider.connect();
    strictEqual(workspace.name, "Juniper Studio");
    strictEqual(workspace.demo, true);
    strictEqual(workspace.currentUser.displayName, "Alex Rivera");

    const conversations = await provider.listConversations();
    strictEqual(conversations.length >= 6, true);
    strictEqual(conversations.some((item) => item.id === "c-dm-maya"), true);
    strictEqual(conversations.some((item) => item.kind === "space"), true);
    for (let index = 1; index < conversations.length; index++) {
      strictEqual(
        Date.parse(conversations[index - 1]!.lastActivityAt) >=
          Date.parse(conversations[index]!.lastActivityAt),
        true,
      );
    }

    const messages = await provider.getMessages("c-dm-maya");
    strictEqual(messages.length > 0, true);
    strictEqual(messages.every((message) => message.conversationId === "c-dm-maya"), true);
    const stat = await Deno.stat(dataPath);
    strictEqual(stat.isFile, true);

    const sent = await provider.sendMessage({
      conversationId: "c-dm-maya",
      body: "  hello from the test  ",
    });
    strictEqual(sent.body, "hello from the test");
    strictEqual(sent.author.id, workspace.currentUser.id);
    strictEqual(events.some((event) => event.type === "message-created"), true);

    const updated = await provider.editMessage(sent.id, "edited body");
    strictEqual(updated.body, "edited body");
    strictEqual(updated.editedAt !== undefined, true);
    strictEqual(
      events.some((event) =>
        event.type === "message-updated" && event.message.body === "edited body"
      ),
      true,
    );

    await provider.deleteMessage(sent.id);
    const afterDelete = await provider.getMessages("c-dm-maya");
    const deleted = afterDelete.find((message) => message.id === sent.id);
    strictEqual(deleted?.deletedAt !== undefined, true);
    strictEqual(deleted?.body, "");
    strictEqual(events.some((event) => event.type === "message-deleted"), true);
  });
});

Deno.test("demo provider enforces ownership and input rules", async () => {
  await withProvider(async ({ provider }) => {
    await provider.connect();
    await rejects(
      provider.editMessage("m-maya-1", "nope"),
      (error: unknown) => error instanceof ChatError && error.code === "forbidden",
    );
    await rejects(
      provider.deleteMessage("m-maya-1"),
      (error: unknown) => error instanceof ChatError && error.code === "forbidden",
    );
    await rejects(
      provider.sendMessage({ conversationId: "c-dm-maya", body: "   " }),
      /cannot be empty/i,
    );
    await rejects(
      provider.sendMessage({ conversationId: "missing", body: "hello" }),
      (error: unknown) => error instanceof ChatError && error.code === "not_found",
    );
    await rejects(
      provider.getMessages("missing"),
      (error: unknown) => error instanceof ChatError && error.code === "not_found",
    );
  });
});

Deno.test("demo threads return the root and every reply", async () => {
  await withProvider(async ({ provider }) => {
    await provider.connect();
    const thread = await provider.getThread("m-launch-thread-r2");
    strictEqual(thread[0]?.id, "m-launch-thread");
    strictEqual(thread.length, 4);
    strictEqual(
      thread.every((message) => message.replyToId === undefined || message.id !== thread[0]!.id),
      true,
    );

    const reply = await provider.sendMessage({
      conversationId: "c-grp-launch",
      body: "one more reply",
      replyToId: "m-launch-thread-r1",
    });
    strictEqual(reply.replyToId, "m-launch-thread");
    const updated = await provider.getThread(reply.id);
    strictEqual(updated.length, 5);
  });
});

Deno.test("demo background chatter has members talking to each other", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-chatter-" });
  const provider = new DemoProvider({
    dataPath: join(dir, "demo.json"),
    displayName: "Alex Rivera",
    simulateActivity: true,
    connectDelayMs: 0,
    ambientIntervalMs: 50,
    now: () => FIXED,
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  try {
    await provider.connect();

    const chatters = new Set<string>();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      for (const event of events) {
        if (
          event.type === "message-created" &&
          event.message.author.id !== "u-self"
        ) {
          chatters.add(event.message.author.id);
        }
      }
      if (chatters.size >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Background activity should get at least two different members talking.
    strictEqual(chatters.size >= 2, true);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("demo search covers bodies, authors, and conversation names", async () => {
  await withProvider(async ({ provider }) => {
    await provider.connect();
    const body = await provider.searchMessages("composer");
    strictEqual(body.length > 0, true);
    strictEqual(
      body.some((result) => result.message.body.toLowerCase().includes("composer")),
      true,
    );

    const author = await provider.searchMessages("maya");
    strictEqual(author.length > 0, true);
    strictEqual(author.some((result) => result.message.author.displayName === "Maya Chen"), true);

    const conversation = await provider.searchMessages("design-lab");
    strictEqual(conversation.length > 0, true);
    strictEqual(conversation.every((result) => result.conversation.id === "c-sp-design"), true);

    deepStrictEqual(await provider.searchMessages("   "), []);
    strictEqual((await provider.searchMessages("zzz-no-match")).length, 0);
  });
});

Deno.test("demo messages and read state survive a restart", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-" });
  const dataPath = join(dir, "demo.json");
  try {
    const first = new DemoProvider({
      dataPath,
      displayName: "Alex Rivera",
      simulateActivity: false,
      now: () => FIXED,
    });
    await first.connect();
    const sent = await first.sendMessage({ conversationId: "c-sp-general", body: "persist me" });
    await first.markRead("c-sp-general");
    await first.dispose();

    const second = new DemoProvider({
      dataPath,
      displayName: "Alex Rivera",
      simulateActivity: false,
      now: () => FIXED,
    });
    await second.connect();
    const messages = await second.getMessages("c-sp-general");
    strictEqual(
      messages.some((message) => message.id === sent.id && message.body === "persist me"),
      true,
    );
    const conversation = (await second.listConversations()).find((item) =>
      item.id === "c-sp-general"
    );
    strictEqual(conversation?.unreadCount, 0);
    await second.dispose();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("corrupt demo data reports a storage error with a reset hint", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-" });
  const dataPath = join(dir, "demo.json");
  try {
    await Deno.writeTextFile(dataPath, "{not valid json");
    const provider = new DemoProvider({
      dataPath,
      displayName: "Alex Rivera",
      simulateActivity: false,
    });
    await rejects(provider.connect(), (error: unknown) =>
      error instanceof ChatError &&
      error.code === "storage_corrupt" &&
      error.message.includes("--reset-demo"));
    await provider.dispose();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("operations before connect return not_connected", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-" });
  try {
    const provider = new DemoProvider({
      dataPath: join(dir, "demo.json"),
      displayName: "Alex Rivera",
      simulateActivity: false,
    });
    await rejects(
      provider.listConversations(),
      (error: unknown) => error instanceof ChatError && error.code === "not_connected",
    );
    await provider.dispose();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("demo replies can come from a local AI responder", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-ai-" });
  const dataPath = join(dir, "demo.json");
  const requests: AiReplyRequest[] = [];
  const provider = new DemoProvider({
    dataPath,
    displayName: "Alex Rivera",
    simulateActivity: true,
    connectDelayMs: 0,
    replyDelayMs: 0,
    ai: {
      label: "test-model",
      model: "test-model",
      reply: (request) => {
        requests.push(request);
        return Promise.resolve({ ok: true, text: "Generated in character." });
      },
    },
    now: () => FIXED,
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));

  try {
    const workspace = await provider.connect();
    strictEqual(workspace.note, "AI replies · test-model");
    strictEqual(provider.ai, true);

    const sent = await provider.sendMessage({
      conversationId: "c-dm-maya",
      body: "What should we polish next?",
    });
    const reply = await waitForReply(events, "c-dm-maya", 0, sent.id);
    strictEqual(reply.body, "Generated in character.");
    strictEqual(reply.author.id, "u-maya");
    strictEqual(requests.length, 1);
    strictEqual(requests[0]?.persona.handle, "maya");
    strictEqual(requests[0]?.conversation.name, "Maya Chen");
    strictEqual(requests[0]?.messages.at(-1)?.body, "What should we polish next?");
    strictEqual(
      events.some((event) => event.type === "typing" && event.active === true),
      true,
    );
    strictEqual(
      events.some((event) => event.type === "typing" && event.active === false),
      true,
    );
    const persisted = await provider.getMessages("c-dm-maya");
    strictEqual(persisted.some((message) => message.body === "Generated in character."), true);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("AI failures fall back to canned replies with one warning", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-ai-" });
  const provider = new DemoProvider({
    dataPath: join(dir, "demo.json"),
    displayName: "Alex Rivera",
    simulateActivity: true,
    connectDelayMs: 0,
    replyDelayMs: 0,
    ai: {
      label: "offline-model",
      model: "offline-model",
      reply: () => Promise.resolve({ ok: false, reason: "connection refused" }),
    },
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));

  try {
    await provider.connect();
    const first = await provider.sendMessage({
      conversationId: "c-dm-ivo",
      body: "Are the builds green?",
    });
    const firstReply = await waitForReply(events, "c-dm-ivo", 0, first.id);
    strictEqual(firstReply.body.length > 0, true);
    strictEqual(firstReply.body.includes("Generated"), false);

    const second = await provider.sendMessage({
      conversationId: "c-dm-ivo",
      body: "Any blockers?",
    });
    await waitForReply(events, "c-dm-ivo", 1, second.id);
    const warnings = events.filter((event) =>
      event.type === "error" && event.message.includes("Local AI replies are unavailable")
    );
    strictEqual(warnings.length, 1);
    if (warnings[0]?.type === "error") {
      strictEqual(warnings[0].message.includes("connection refused"), true);
      strictEqual(warnings[0].message.includes("canned demo replies"), true);
    }
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("demo group chats get an answer from every other member", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-group-" });
  const provider = new DemoProvider({
    dataPath: join(dir, "demo.json"),
    displayName: "Alex Rivera",
    simulateActivity: true,
    connectDelayMs: 0,
    replyDelayMs: 0,
    receiptDelayMs: 10,
    now: () => FIXED,
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  try {
    await provider.connect();
    const conversation = (await provider.listConversations()).find((item) =>
      item.id === "c-grp-launch"
    );
    const others = (conversation?.members ?? [])
      .map((member) => member.id)
      .filter((id) => id !== "u-self")
      .sort();
    strictEqual(others.length, 4);

    const sent = await provider.sendMessage({
      conversationId: "c-grp-launch",
      body: "Which detail matters most before launch?",
    });
    await waitFor(
      () => repliesTo(events, "c-grp-launch", sent.id).length >= others.length,
      "every group member to reply",
    );

    const replies = repliesTo(events, "c-grp-launch", sent.id);
    deepStrictEqual(replies.map((reply) => reply.author.id).sort(), others);
    // Every member answers, and questions stay question-shaped so they can ask back.
    strictEqual(replies.every((reply) => reply.body.includes("?")), true);

    const typing = new Set(
      events
        .filter((event) =>
          event.type === "typing" &&
          event.active &&
          event.conversationId === "c-grp-launch"
        )
        .map((event) => event.type === "typing" ? event.user.id : ""),
    );
    deepStrictEqual([...typing].sort(), others);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("demo delivery ticks move from pending to sent to delivered", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-delivery-" });
  const provider = new DemoProvider({
    dataPath: join(dir, "demo.json"),
    displayName: "Alex Rivera",
    simulateActivity: false,
    connectDelayMs: 0,
    receiptDelayMs: 10,
    now: () => FIXED,
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  try {
    await provider.connect();
    const sent = await provider.sendMessage({
      conversationId: "c-dm-maya",
      body: "Do these ticks look right?",
    });
    strictEqual(sent.delivery?.status, "pending");

    await waitFor(
      () => deliveryStatuses(events, sent.id).includes("delivered"),
      "the message to be delivered",
    );
    deepStrictEqual(deliveryStatuses(events, sent.id), ["sent", "delivered"]);

    const stored = (await provider.getMessages("c-dm-maya")).find((message) =>
      message.id === sent.id
    );
    strictEqual(stored?.delivery?.status, "delivered");
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("demo marks your message read once every member answers", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pulsewire-demo-read-" });
  const provider = new DemoProvider({
    dataPath: join(dir, "demo.json"),
    displayName: "Alex Rivera",
    simulateActivity: true,
    connectDelayMs: 0,
    replyDelayMs: 0,
    receiptDelayMs: 5_000,
    now: () => FIXED,
  });
  const events: ProviderEvent[] = [];
  provider.subscribe((event) => events.push(event));
  try {
    const workspace = await provider.connect();
    const conversation = (await provider.listConversations()).find((item) =>
      item.id === "c-grp-terminal"
    );
    const others = (conversation?.members ?? [])
      .map((member) => member.id)
      .filter((id) => id !== workspace.currentUser.id)
      .sort();
    strictEqual(others.length, 3);

    const sent = await provider.sendMessage({
      conversationId: "c-grp-terminal",
      body: "Does everyone see the same ticks?",
    });
    await waitFor(
      () => deliveryStatuses(events, sent.id).includes("read"),
      "every member to read the message",
    );

    const read = events
      .filter((event) => event.type === "message-delivery" && event.messageId === sent.id)
      .map((event) => event.type === "message-delivery" ? event.delivery : undefined)
      .filter((delivery) => delivery?.status === "read")
      .at(-1);
    deepStrictEqual([...(read?.readBy ?? [])].sort(), others);
  } finally {
    await provider.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

function repliesTo(
  events: ProviderEvent[],
  conversationId: string,
  sentId: string,
): import("../src/chat/types.ts").Message[] {
  return events
    .filter((event) =>
      event.type === "message-created" &&
      event.conversationId === conversationId &&
      event.message.id !== sentId &&
      event.message.author.id !== "u-self"
    )
    .map((event) => event.type === "message-created" ? event.message : undefined)
    .filter((message) => message !== undefined);
}

function deliveryStatuses(events: ProviderEvent[], messageId: string): string[] {
  return events
    .filter((event) => event.type === "message-delivery" && event.messageId === messageId)
    .map((event) => event.type === "message-delivery" ? event.delivery.status : "");
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function waitForReply(
  events: ProviderEvent[],
  conversationId: string,
  previousReplies: number,
  sentId: string,
): Promise<import("../src/chat/types.ts").Message> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const replies = events.filter((event) =>
      event.type === "message-created" &&
      event.conversationId === conversationId &&
      event.message.id !== sentId &&
      event.message.author.id !== "u-self"
    );
    if (replies.length > previousReplies) {
      const latest = replies[replies.length - 1];
      if (latest?.type === "message-created") return latest.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a simulated reply.");
}
