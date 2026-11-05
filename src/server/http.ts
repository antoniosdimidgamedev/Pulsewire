import type { User } from "../chat/types.ts";
import { serveAdminAsset } from "./admin-assets.ts";
import { ApiError, badRequest, forbidden, unauthorized } from "./errors.ts";
import type { MessagingStore } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_WINDOW_MS = 5 * 60 * 1_000;
const LOGIN_LIMIT = 10;

export interface HandlerOptions {
  /** Called with safe request metadata only; never with bodies or tokens. */
  onRequest?: (method: string, path: string, status: number) => void;
  loginLimit?: number;
}

interface LoginAttempt {
  count: number;
  resetAt: number;
}

export function createRequestHandler(
  store: MessagingStore,
  options: HandlerOptions = {},
): (request: Request) => Promise<Response> {
  const attempts = new Map<string, LoginAttempt>();
  const loginLimit = options.loginLimit ?? LOGIN_LIMIT;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let response: Response;
    try {
      response = await route(store, request, url, attempts, loginLimit);
    } catch (error) {
      response = errorResponse(error);
    }
    try {
      options.onRequest?.(request.method, url.pathname, response.status);
    } catch {
      // Logging must never break a request.
    }
    return response;
  };
}

async function route(
  store: MessagingStore,
  request: Request,
  url: URL,
  attempts: Map<string, LoginAttempt>,
  loginLimit: number,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = url.pathname;
  if (method === "GET") {
    const asset = await serveAdminAsset(path);
    if (asset) return asset;
  }

  if (method === "GET" && path === "/health") {
    return json({ status: "ok" });
  }

  if (method === "POST" && path === "/v1/auth/register") {
    const body = await readJson(request);
    const result = await store.register({
      handle: requiredString(body, "handle"),
      displayName: requiredString(body, "displayName"),
      password: requiredString(body, "password"),
    });
    return json(result, 201);
  }

  if (method === "POST" && path === "/v1/auth/login") {
    const body = await readJson(request);
    const handle = requiredString(body, "handle").trim().toLowerCase();
    const key = `login:${handle}`;
    checkLoginLimit(attempts.get(key), Date.now(), loginLimit);
    try {
      const result = await store.login(handle, requiredString(body, "password"));
      attempts.delete(key);
      return json(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        recordLoginFailure(attempts, key, Date.now(), loginLimit);
      }
      throw error;
    }
  }

  const auth = await authenticate(store, request);
  const user = auth.user;

  if (path === "/v1/admin" || path.startsWith("/v1/admin/")) {
    if (!user.isAdmin) throw forbidden("Administrator access is required.");
    return await adminRoute(store, request, url, method, path.slice("/v1/admin".length), user.id);
  }

  if (method === "POST" && path === "/v1/auth/logout") {
    await store.logout(auth.token);
    return new Response(null, { status: 204 });
  }

  if (method === "GET" && path === "/v1/me") {
    return json({ user });
  }

  if (method === "PATCH" && path === "/v1/me") {
    const body = await readJson(request);
    const patch: { displayName?: string; handle?: string } = {};
    if (body.displayName !== undefined) {
      patch.displayName = requiredString(body, "displayName");
    }
    if (body.handle !== undefined) patch.handle = requiredString(body, "handle");
    if (patch.displayName === undefined && patch.handle === undefined) {
      throw badRequest("Provide a display name or handle to update.");
    }
    return json({ user: store.updateProfile(user.id, patch) });
  }

  if (method === "GET" && path === "/v1/users") {
    return json({ users: store.searchUsers(user.id, url.searchParams.get("query") ?? "") });
  }

  if (method === "GET" && path === "/v1/conversations") {
    return json({ conversations: store.listConversations(user.id) });
  }

  if (method === "POST" && path === "/v1/conversations") {
    const body = await readJson(request);
    const kind = requiredString(body, "kind");
    if (kind !== "dm" && kind !== "group" && kind !== "space") {
      throw badRequest('`kind` must be "dm", "group", or "space".');
    }
    const memberHandles = requiredStringArray(body, "memberHandles");
    const name = body.name === undefined ? undefined : requiredString(body, "name");
    const topic = body.topic === undefined ? undefined : requiredString(body, "topic");
    const result = await store.createConversation(user.id, {
      kind,
      memberHandles,
      ...(name !== undefined ? { name } : {}),
      ...(topic !== undefined ? { topic } : {}),
    });
    return json({ conversation: result.conversation }, result.created ? 201 : 200);
  }

  if (method === "GET" && path === "/v1/search") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    return json({ results: store.search(user.id, query) });
  }

  if (method === "GET" && path === "/v1/events/head") {
    return json({ seq: store.headEventSeq() });
  }

  if (method === "GET" && path === "/v1/events") {
    const after = queryInteger(url, "after", 0);
    const limit = queryInteger(url, "limit", 100);
    return json(store.getEvents(user.id, after, limit));
  }

  const messageMatch = path.match(/^\/v1\/messages\/([^/]+)(?:\/(thread))?$/);
  if (messageMatch) {
    const messageId = decodeURIComponent(messageMatch[1]!);
    if (method === "GET" && messageMatch[2] === "thread") {
      return json({ messages: store.getThread(user.id, messageId) });
    }
    if (method === "PATCH") {
      const body = await readJson(request);
      return json({ message: store.editMessage(user.id, messageId, requiredString(body, "body")) });
    }
    if (method === "DELETE") {
      store.deleteMessage(user.id, messageId);
      return new Response(null, { status: 204 });
    }
  }

  const conversationMatch = path.match(
    /^\/v1\/conversations\/([^/]+)(?:\/(messages|read|members|leave))?(?:\/([^/]+))?$/,
  );
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]!);
    const action = conversationMatch[2];
    const extra = conversationMatch[3];

    if (!action && method === "GET") {
      return json({ conversation: store.getConversation(user.id, conversationId) });
    }

    if (action === "messages" && !extra) {
      if (method === "GET") {
        const limit = optionalQueryInteger(url, "limit");
        const before = optionalQueryInteger(url, "before");
        return json(store.getMessagePage(user.id, conversationId, {
          ...(limit !== undefined ? { limit } : {}),
          ...(before !== undefined ? { before } : {}),
        }));
      }
      if (method === "POST") {
        const body = await readJson(request);
        const replyToId = body.replyToId === undefined
          ? undefined
          : requiredString(body, "replyToId");
        return json({
          message: store.sendMessage(
            user.id,
            conversationId,
            requiredString(body, "body"),
            replyToId,
          ),
        }, 201);
      }
    }

    if (action === "read" && !extra && method === "POST") {
      return json({ conversation: store.markRead(user.id, conversationId) });
    }

    if (action === "members" && !extra) {
      if (method === "GET") {
        return json({ members: store.listMembers(user.id, conversationId) });
      }
      if (method === "POST") {
        const body = await readJson(request);
        return json(
          {
            conversation: store.addMember(user.id, conversationId, requiredString(body, "handle")),
          },
          201,
        );
      }
    }

    if (action === "members" && extra && method === "DELETE") {
      const removed = store.removeMember(
        user.id,
        conversationId,
        decodeURIComponent(extra),
      );
      return new Response(null, {
        status: 204,
        headers: { "x-conversation-deleted": String(removed) },
      });
    }

    if (action === "leave" && !extra && method === "POST") {
      store.removeMember(user.id, conversationId, user.id);
      return new Response(null, { status: 204 });
    }
  }

  throw new ApiError("not_found", "That API endpoint does not exist.", 404);
}

async function adminRoute(
  store: MessagingStore,
  request: Request,
  url: URL,
  method: string,
  suffix: string,
  actorId: string,
): Promise<Response> {
  const parts = suffix.split("/").filter((part) => part !== "").map(decodedSegment);
  const [first, second, third] = parts;

  if ((first === undefined || first === "overview") && method === "GET") {
    return json({ overview: store.adminOverview() });
  }

  if (first === "users" && second === undefined && method === "GET") {
    return json(store.adminListUsers({
      query: url.searchParams.get("query") ?? undefined,
      limit: optionalQueryInteger(url, "limit"),
      offset: optionalQueryInteger(url, "offset"),
    }));
  }

  if (first === "users" && second !== undefined && third === undefined && method === "PATCH") {
    const body = await readJson(request);
    const isAdmin = body.isAdmin;
    if (typeof isAdmin !== "boolean") throw badRequest("`isAdmin` must be a boolean.");
    return json({ user: store.setAdmin(second, isAdmin) });
  }

  if (first === "conversations" && second === undefined && method === "GET") {
    return json(store.adminListConversations({
      query: url.searchParams.get("query") ?? undefined,
      limit: optionalQueryInteger(url, "limit"),
      offset: optionalQueryInteger(url, "offset"),
    }));
  }

  if (
    first === "conversations" && second !== undefined && third === undefined && method === "DELETE"
  ) {
    store.adminDeleteConversation(second, actorId);
    return new Response(null, { status: 204 });
  }

  if (
    first === "conversations" && second !== undefined && third === "messages" &&
    parts.length === 3 && method === "GET"
  ) {
    const conversation = store.adminGetConversation(second);
    const page = store.adminGetMessagePage(second, {
      limit: optionalQueryInteger(url, "limit"),
      before: optionalQueryInteger(url, "before"),
    });
    return json({ conversation, ...page });
  }

  if (first === "messages" && second !== undefined && third === undefined && method === "DELETE") {
    store.adminDeleteMessage(second, actorId);
    return new Response(null, { status: 204 });
  }

  if (first === "events" && second === undefined && method === "GET") {
    return json(store.adminListEvents({
      before: optionalQueryInteger(url, "before"),
      limit: optionalQueryInteger(url, "limit"),
      type: url.searchParams.get("type") ?? undefined,
    }));
  }

  throw new ApiError("not_found", "That administrator endpoint does not exist.", 404);
}

function decodedSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest("The request path contains invalid encoding.");
  }
}

async function authenticate(
  store: MessagingStore,
  request: Request,
): Promise<{ user: User; token: string }> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw unauthorized();
  const token = match[1]!.trim();
  if (!token) throw unauthorized();
  const user = await store.authenticate(token);
  if (!user) throw unauthorized("Your session has expired. Sign in again.");
  return { user, token };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError("invalid_input", "Request body is too large.", 413);
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  if (!isRecord(parsed)) throw badRequest("Request body must be a JSON object.");
  return parsed;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw badRequest(`\`${key}\` must be a string.`);
  return value;
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw badRequest(`\`${key}\` must be an array of strings.`);
  }
  return value;
}

function queryInteger(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`\`${name}\` must be a non-negative integer.`);
  }
  return parsed;
}

function optionalQueryInteger(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequest(`\`${name}\` must be a non-negative integer.`);
  }
  return parsed;
}

function checkLoginLimit(attempt: LoginAttempt | undefined, now: number, limit: number): void {
  if (!attempt) return;
  if (attempt.resetAt <= now) return;
  if (attempt.count >= limit) {
    throw new ApiError(
      "rate_limited",
      "Too many sign-in attempts. Wait a few minutes and try again.",
      429,
    );
  }
}

function recordLoginFailure(
  attempts: Map<string, LoginAttempt>,
  key: string,
  now: number,
  limit: number,
): void {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  const count = current.count + 1;
  attempts.set(key, { count, resetAt: current.resetAt });
  if (count > limit * 4) attempts.delete(key);
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error(
    "pulsewire-server: unexpected request failure:",
    error instanceof Error ? error.name : "unknown error",
  );
  return json(
    { error: { code: "internal", message: "The server could not complete that request." } },
    500,
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
