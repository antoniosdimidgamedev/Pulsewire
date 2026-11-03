import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  type AiReplyRequest,
  buildChatRequest,
  chatCompletionsUrl,
  createAiResponder,
  sanitizeAiReply,
} from "../src/chat/ai.ts";

const SETTINGS = {
  baseUrl: "http://127.0.0.1:9931/v1",
  model: "qwen3:0.6b",
  temperature: 0.7,
  maxTokens: 80,
  timeoutMs: 5_000,
  history: 6,
};

const REQUEST: AiReplyRequest = {
  conversation: {
    name: "design-lab",
    kind: "space",
    topic: "Critique, prototypes, and interface details",
  },
  members: ["Alex Rivera", "Maya Chen", "Tess Okafor"],
  persona: { id: "u-maya", displayName: "Maya Chen", handle: "maya" },
  messages: [
    { authorId: "u-maya", authorName: "Maya Chen", body: "The composer reads clearly now." },
    { authorId: "u-self", authorName: "Alex Rivera", body: "Should we add a send hint?" },
    { authorId: "u-maya", authorName: "Maya Chen", body: "Yes, one short hint." },
    { authorId: "u-self", authorName: "Alex Rivera", body: "Which wording?" },
  ],
};

Deno.test("chat completion URLs accept a base or a full endpoint", () => {
  strictEqual(
    chatCompletionsUrl("http://127.0.0.1:9931/v1"),
    "http://127.0.0.1:9931/v1/chat/completions",
  );
  strictEqual(
    chatCompletionsUrl("http://127.0.0.1:8080/v1/"),
    "http://127.0.0.1:8080/v1/chat/completions",
  );
  strictEqual(
    chatCompletionsUrl("http://localhost:1234/v1/chat/completions"),
    "http://localhost:1234/v1/chat/completions",
  );
});

Deno.test("the prompt carries the persona, topic, and recent turns", () => {
  const payload = buildChatRequest(SETTINGS, REQUEST);
  strictEqual(payload.model, "qwen3:0.6b");
  strictEqual(payload.stream, false);
  strictEqual(payload.temperature, 0.7);
  strictEqual(payload.max_tokens, 80);

  const system = payload.messages[0];
  strictEqual(system?.role, "system");
  strictEqual(system?.content.includes("Maya Chen (@maya)"), true);
  strictEqual(system?.content.includes("design-lab"), true);
  strictEqual(system?.content.includes("Critique, prototypes"), true);
  strictEqual(system?.content.includes("no Markdown"), true);
  strictEqual(system?.content.includes("simulated teammates"), true);

  const personaTurn = payload.messages.find((message) => message.role === "assistant");
  strictEqual(personaTurn?.content, "The composer reads clearly now.");

  const last = payload.messages[payload.messages.length - 1];
  strictEqual(last?.role, "user");
  strictEqual(last?.content, "Alex Rivera: Which wording?");
});

Deno.test("the conversation window stays small and recent", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    authorId: index % 2 === 0 ? "u-self" : "u-maya",
    authorName: index % 2 === 0 ? "Alex Rivera" : "Maya Chen",
    body: `message ${index}`,
  }));
  const payload = buildChatRequest(
    { ...SETTINGS, history: 4 },
    { ...REQUEST, messages: many },
  );
  strictEqual(payload.messages.length, 5);
  strictEqual(payload.messages[1]?.content, "Alex Rivera: message 36");
  strictEqual(payload.messages[4]?.content, "message 39");
});

Deno.test("model output is cleaned up for a terminal transcript", () => {
  strictEqual(
    sanitizeAiReply("**Maya:** Sounds good.\n\nLet's ship it.", "Maya Chen"),
    "Sounds good. Let's ship it.",
  );
  strictEqual(
    sanitizeAiReply("Maya Chen: I can take that.", "Maya Chen"),
    "I can take that.",
  );
  strictEqual(
    sanitizeAiReply("- One option\n- Another option", "Maya Chen"),
    "One option Another option",
  );
  strictEqual(sanitizeAiReply("   \n  ", "Maya Chen"), null);
  strictEqual(sanitizeAiReply("```\n```", "Maya Chen"), null);
  const long = sanitizeAiReply("word ".repeat(300), "Maya Chen") ?? "";
  strictEqual(long.length <= 600, true);
  strictEqual(long.endsWith("…"), true);
});

Deno.test("the responder posts to the local endpoint and returns text", async () => {
  let calledUrl = "";
  let calledBody = "";
  const responder = createAiResponder(SETTINGS, {
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(input);
      calledBody = String(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "**Maya:** On it." } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch,
  });

  const result = await responder.reply(REQUEST);
  strictEqual(result.ok, true);
  if (result.ok) strictEqual(result.text, "On it.");
  strictEqual(calledUrl, "http://127.0.0.1:9931/v1/chat/completions");
  const parsed = JSON.parse(calledBody) as { model: string; messages: unknown[] };
  strictEqual(parsed.model, "qwen3:0.6b");
  strictEqual(parsed.messages.length > 1, true);
  strictEqual(responder.label, "qwen3:0.6b");
});

Deno.test("the responder falls back cleanly on server and transport errors", async () => {
  const serverError = createAiResponder(SETTINGS, {
    fetch: (() =>
      Promise.resolve(new Response("model not found", { status: 404 }))) as typeof fetch,
  });
  deepStrictEqual(await serverError.reply(REQUEST), {
    ok: false,
    reason: "the server returned HTTP 404: model not found",
  });

  const invalidJson = createAiResponder(SETTINGS, {
    fetch: (() => Promise.resolve(new Response("{nope", { status: 200 }))) as typeof fetch,
  });
  deepStrictEqual(await invalidJson.reply(REQUEST), {
    ok: false,
    reason: "the server returned invalid JSON",
  });

  const empty = createAiResponder(SETTINGS, {
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), {
          status: 200,
        }),
      )) as typeof fetch,
  });
  deepStrictEqual(await empty.reply(REQUEST), {
    ok: false,
    reason: "the model returned an empty reply",
  });

  const refused = createAiResponder(SETTINGS, {
    fetch: (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch,
  });
  deepStrictEqual(await refused.reply(REQUEST), {
    ok: false,
    reason: "connection refused",
  });

  const timeout = createAiResponder(SETTINGS, {
    fetch: (() =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))) as typeof fetch,
  });
  deepStrictEqual(await timeout.reply(REQUEST), {
    ok: false,
    reason: "the request timed out",
  });
});
