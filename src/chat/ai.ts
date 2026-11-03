import type { ConversationKind, User } from "./types.ts";

/**
 * A tiny, local-first reply generator for the demo workspace.
 *
 * Pulsewire talks to any OpenAI-compatible chat-completions endpoint, which
 * keeps the core free of runtime dependencies. The supported local setup is
 * llama.cpp (`deno task ai`); LM Studio and similar servers work too.
 */
export interface AiReplySettings {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  history?: number;
}

export interface AiMessageContext {
  authorId: string;
  authorName: string;
  body: string;
}

export interface AiReplyRequest {
  conversation: {
    name: string;
    kind: ConversationKind;
    topic?: string;
  };
  members: string[];
  persona: User;
  messages: AiMessageContext[];
}

export type AiReplyResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export interface AiResponder {
  readonly label: string;
  readonly model: string;
  reply(request: AiReplyRequest): Promise<AiReplyResult>;
}

export interface AiResponderOptions {
  fetch?: typeof fetch;
}

const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 96;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_HISTORY = 12;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_REPLY_CHARS = 600;

export function createAiResponder(
  settings: AiReplySettings,
  options: AiResponderOptions = {},
): AiResponder {
  const fetchImpl = options.fetch ?? fetch;
  const url = chatCompletionsUrl(settings.baseUrl);
  const temperature = settings.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = settings.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const history = settings.history ?? DEFAULT_HISTORY;

  return {
    label: settings.model,
    model: settings.model,
    async reply(request) {
      const payload = buildChatRequest(settings, request, {
        temperature,
        maxTokens,
        history,
      });
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { ok: false, reason: describeFailure(error) };
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const suffix = detail.trim()
          ? `: ${truncate(detail.replace(/\s+/g, " ").trim(), 160)}`
          : "";
        return { ok: false, reason: `the server returned HTTP ${response.status}${suffix}` };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, reason: "the server returned invalid JSON" };
      }

      const content = extractContent(body);
      if (!content) return { ok: false, reason: "the model returned no text" };

      const text = sanitizeAiReply(content, request.persona.displayName);
      if (!text) return { ok: false, reason: "the model returned an empty reply" };
      return { ok: true, text };
    },
  };
}

/** Accept either a base URL (`.../v1`) or a full chat-completions URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function buildChatRequest(
  settings: AiReplySettings,
  request: AiReplyRequest,
  overrides: { temperature?: number; maxTokens?: number; history?: number } = {},
): {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
  max_tokens: number;
  stream: false;
} {
  const history = overrides.history ?? settings.history ?? DEFAULT_HISTORY;
  const recent = recentContext(request.messages, history);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt(request) },
  ];

  for (const entry of recent) {
    if (entry.authorId === request.persona.id) {
      messages.push({ role: "assistant", content: entry.body });
    } else {
      messages.push({ role: "user", content: `${entry.authorName}: ${entry.body}` });
    }
  }

  return {
    model: settings.model,
    messages,
    temperature: overrides.temperature ?? settings.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: overrides.maxTokens ?? settings.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  };
}

interface Persona {
  role: string;
  voice: string;
}

const PERSONAS: Record<string, Persona> = {
  maya: {
    role: "a product designer who owns layout, typography, and focus states",
    voice: "warm and precise, with a short design question when it helps",
  },
  ivo: {
    role: "an infrastructure engineer who owns builds, Windows support, and storage",
    voice: "practical and low-ceremony, mentioning concrete checks",
  },
  noor: {
    role: "the release lead who tracks scope, checklists, and launch risk",
    voice: "direct and organized, keeping the team honest about the demo",
  },
  tess: {
    role: "a writer and UX researcher who shapes copy and empty states",
    voice: "thoughtful and concise, caring about clarity",
  },
  rafael: {
    role: "a terminal UI enthusiast and skeptical reviewer",
    voice: "dry and opinionated about terminals, pushing back on scope creep",
  },
};

const KIND_LABELS: Record<ConversationKind, string> = {
  dm: "direct message",
  group: "group chat",
  space: "space",
};

function systemPrompt(request: AiReplyRequest): string {
  const persona = personaFor(request.persona);
  const topic = request.conversation.topic
    ? `The conversation topic is: ${request.conversation.topic}`
    : "There is no fixed topic.";
  const others = request.members.filter((member) => member !== request.persona.displayName);
  const members = others.length > 0 ? `Other people here: ${others.join(", ")}.` : "";

  return [
    `You are ${request.persona.displayName} (@${request.persona.handle}), ${persona.role} ` +
    `on the small Juniper Studio team.`,
    `You are in the ${KIND_LABELS[request.conversation.kind]} "${request.conversation.name}" ` +
    `of Pulsewire, a terminal team-chat app.`,
    topic,
    members,
    `Your voice is ${persona.voice}.`,
    "",
    `Reply as ${request.persona.displayName} in one or two short sentences (at most 45 words).`,
    "React to the latest message and keep the thread moving; ask a brief question or name a next step.",
    "Use plain text only: no Markdown, no lists, no emoji, and no name prefix.",
    "Do not invent facts about real people, companies, or events. If you are unsure, say so briefly.",
    "This is a local demo workspace with simulated teammates. If someone asks directly whether the " +
    "demo is real, say it is simulated.",
  ].filter(Boolean).join("\n");
}

function personaFor(user: User): Persona {
  return PERSONAS[user.handle] ?? {
    role: "a teammate on the Juniper Studio demo team",
    voice: "friendly, specific, and concise",
  };
}

/**
 * Keep the tail of the conversation, newest last, while staying inside a
 * small context budget that even a 0.5B model can handle quickly.
 */
function recentContext(
  messages: AiMessageContext[],
  limit: number,
): AiMessageContext[] {
  const window = messages.slice(-Math.max(1, limit));
  const output: AiMessageContext[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (let index = window.length - 1; index >= 0; index--) {
    const entry = window[index];
    if (!entry) continue;
    const body = truncate(entry.body.replace(/\s+/g, " ").trim(), 500);
    if (!body) continue;
    if (body.length > budget && output.length > 1) break;
    budget -= body.length;
    output.unshift({ ...entry, body });
  }

  return output;
}

/**
 * Turn model output into something that looks natural in the transcript.
 * Small models love Markdown, name prefixes, and quoted replies.
 */
export function sanitizeAiReply(raw: string, speakerName: string): string | null {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;

  // Qwen3 (and other reasoning models) emit a `<thinking>...</thinking>` block
  // when thinking mode is on. Strip it so only the spoken reply reaches the
  // transcript; a thinking block is never a message the teammate "said".
  text = text.replace(/<thinking[\s\S]*?<\/thinking>/gu, "");
  text = text.replace(/<\/thinking>/gu, "");

  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/u, "").replace(/```$/u, "").trim();
  text = text.replace(/^\s*#{1,6}\s*/gmu, "");
  text = text.replace(/^\s*[-*+]\s+/gmu, "");
  text = text.replace(/[*_`~]/gu, "");
  text = text.replace(/\n+/gu, " ");
  for (const candidate of [speakerName, speakerName.split(/\s+/u)[0]]) {
    if (!candidate) continue;
    text = text.replace(
      new RegExp(`^\\s*${escapeRegExp(candidate)}\\s*:\\s*`, "iu"),
      "",
    );
  }
  text = text.replace(/^["'“”](.*)["'“”]$/u, "$1");
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  text = text.replace(/\s+/gu, " ").trim();

  if (!text) return null;
  return truncate(text, MAX_REPLY_CHARS);
}

function extractContent(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (isRecord(message) && typeof message.content === "string") return message.content;
  if (typeof first.text === "string") return first.text;
  return null;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "the request timed out";
    }
    return error.message || error.name;
  }
  return String(error);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
