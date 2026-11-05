import { strictEqual } from "node:assert/strict";
import { ApiClient } from "../src/client/api.ts";
import { PulsewireProvider } from "../src/chat/server-provider.ts";
import type { ProviderEvent } from "../src/chat/types.ts";
import { startServer } from "../src/server/main.ts";

const PASSWORD = "correct horse battery";

function waitFor(
  register: (listener: (event: ProviderEvent) => void) => () => void,
  predicate: (event: ProviderEvent) => boolean,
  timeoutMs = 5_000,
): Promise<ProviderEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for a provider event."));
    }, timeoutMs);
    const unsubscribe = register((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

Deno.test("network provider: realtime events, history, search, and read state", async () => {
  const running = await startServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    sessionTtlMs: 60 * 60 * 1_000,
    passwordIterations: 1_000,
  }, { quiet: true });

  try {
    const anonymous = new ApiClient({ baseUrl: running.url });
    const aliceAuth = await anonymous.register({
      handle: "alice",
      displayName: "Alice",
      password: PASSWORD,
    });
    const bobAuth = await anonymous.register({
      handle: "bob",
      displayName: "Bob",
      password: PASSWORD,
    });

    const aliceApi = new ApiClient({ baseUrl: running.url, token: aliceAuth.token });
    const conversation = await aliceApi.createConversation({
      kind: "group",
      name: "Project",
      memberHandles: ["bob"],
    });

    const alice = new PulsewireProvider({
      baseUrl: running.url,
      token: aliceAuth.token,
      pollIntervalMs: 25,
    });
    const bob = new PulsewireProvider({
      baseUrl: running.url,
      token: bobAuth.token,
      pollIntervalMs: 25,
    });
    const aliceEvents: ProviderEvent[] = [];
    const bobEvents: ProviderEvent[] = [];
    alice.subscribe((event) => aliceEvents.push(event));
    bob.subscribe((event) => bobEvents.push(event));

    const aliceWorkspace = await alice.connect();
    strictEqual(aliceWorkspace.currentUser.handle, "alice");
    strictEqual(aliceWorkspace.demo, false);
    const bobWorkspace = await bob.connect();
    strictEqual(bobWorkspace.currentUser.handle, "bob");

    const received = waitFor(
      (listener) => bob.subscribe(listener),
      (event) => event.type === "message-created" && event.message.body === "hello Bob",
    );
    const sent = await alice.sendMessage({
      conversationId: conversation.id,
      body: "hello Bob",
    });
    const event = await received;
    strictEqual(event.type, "message-created");
    if (event.type === "message-created") {
      strictEqual(event.message.id, sent.id);
      strictEqual(event.message.author.handle, "alice");
    }

    const bobHistory = await bob.getMessages(conversation.id);
    strictEqual(bobHistory.length, 1);
    strictEqual(bobHistory[0]!.body, "hello Bob");
    strictEqual(bobHistory[0]!.delivery, undefined);

    await bob.markRead(conversation.id);
    const aliceHistory = await alice.getMessages(conversation.id);
    strictEqual(aliceHistory[0]!.delivery?.status, "read");
    strictEqual(aliceHistory[0]!.delivery?.readBy?.includes(bobAuth.user.id), true);

    const bobSearch = await bob.searchMessages("hello");
    strictEqual(bobSearch.length, 1);
    strictEqual(bobSearch[0]!.conversation.id, conversation.id);

    await alice.editMessage(sent.id, "hello Bob, edited");
    const edited = await bob.getMessages(conversation.id);
    strictEqual(edited[0]!.body, "hello Bob, edited");
    strictEqual(typeof edited[0]!.editedAt, "string");

    const thread = await bob.getThread(sent.id);
    strictEqual(thread.length, 1);

    await alice.deleteMessage(sent.id);
    const deleted = await bob.getMessages(conversation.id);
    strictEqual(deleted[0]!.body, "");
    strictEqual(typeof deleted[0]!.deletedAt, "string");

    strictEqual(aliceEvents.some((entry) => entry.type === "message-created"), true);
    strictEqual(bobEvents.some((entry) => entry.type === "message-created"), true);

    await alice.dispose();
    await bob.dispose();
  } finally {
    await running.shutdown();
  }
});
