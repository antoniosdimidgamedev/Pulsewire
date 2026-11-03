import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { join } from "node:path";
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
