import type { ChatErrorCode } from "../chat/errors.ts";
import { ChatError } from "../chat/errors.ts";
import type { Conversation, ConversationKind, Message, SearchResult, User } from "../chat/types.ts";
import type {
  AuthResponse,
  ConversationListResponse,
  ConversationResponse,
  EventListResponse,
  HeadEventResponse,
  MemberListResponse,
  MessageListResponse,
  MessagePageResponse,
  MessageResponse,
  SearchResponse,
  UserListResponse,
  UserResponse,
} from "../protocol/api.ts";
import { normalizeBaseUrl } from "./session.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Minimal typed client for the Pulsewire REST API. */
export class ApiClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<boolean> {
    try {
      const data = await this.request<{ status: string }>("health", { auth: false });
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  register(input: {
    handle: string;
    displayName: string;
    password: string;
  }): Promise<AuthResponse> {
    return this.request("v1/auth/register", {
      method: "POST",
      body: input,
      auth: false,
    });
  }

  login(handle: string, password: string): Promise<AuthResponse> {
    return this.request("v1/auth/login", {
      method: "POST",
      body: { handle, password },
      auth: false,
    });
  }

  async logout(): Promise<void> {
    await this.request("v1/auth/logout", { method: "POST" });
  }

  me(): Promise<User> {
    return this.request<UserResponse>("v1/me").then((response) => response.user);
  }

  updateProfile(patch: { displayName?: string; handle?: string }): Promise<User> {
    return this.request<UserResponse>("v1/me", {
      method: "PATCH",
      body: patch,
    }).then((response) => response.user);
  }

  searchUsers(query: string): Promise<User[]> {
    return this.request<UserListResponse>(`v1/users?query=${encodeURIComponent(query)}`)
      .then((response) => response.users);
  }

  listConversations(): Promise<Conversation[]> {
    return this.request<ConversationListResponse>("v1/conversations")
      .then((response) => response.conversations);
  }

  createConversation(input: {
    kind: ConversationKind;
    name?: string;
    topic?: string;
    memberHandles: string[];
  }): Promise<Conversation> {
    return this.request<ConversationResponse>("v1/conversations", {
      method: "POST",
      body: input,
    }).then((response) => response.conversation);
  }

  getMessages(
    conversationId: string,
    options: { limit?: number; before?: number } = {},
  ): Promise<MessagePageResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.before !== undefined) params.set("before", String(options.before));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<MessagePageResponse>(
      `v1/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
    );
  }

  sendMessage(
    conversationId: string,
    body: string,
    replyToId?: string,
  ): Promise<Message> {
    return this.request<MessageResponse>(
      `v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: { body, ...(replyToId ? { replyToId } : {}) },
      },
    ).then((response) => response.message);
  }

  editMessage(messageId: string, body: string): Promise<Message> {
    return this.request<MessageResponse>(`v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: { body },
    }).then((response) => response.message);
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.request(`v1/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  }

  getThread(messageId: string): Promise<Message[]> {
    return this.request<MessageListResponse>(
      `v1/messages/${encodeURIComponent(messageId)}/thread`,
    ).then((response) => response.messages);
  }

  search(query: string): Promise<SearchResult[]> {
    return this.request<SearchResponse>(`v1/search?query=${encodeURIComponent(query)}`)
      .then((response) => response.results);
  }

  markRead(conversationId: string): Promise<Conversation> {
    return this.request<ConversationResponse>(
      `v1/conversations/${encodeURIComponent(conversationId)}/read`,
      { method: "POST" },
    ).then((response) => response.conversation);
  }

  listMembers(conversationId: string): Promise<MemberListResponse> {
    return this.request<MemberListResponse>(
      `v1/conversations/${encodeURIComponent(conversationId)}/members`,
    );
  }

  addMember(conversationId: string, handle: string): Promise<Conversation> {
    return this.request<ConversationResponse>(
      `v1/conversations/${encodeURIComponent(conversationId)}/members`,
      { method: "POST", body: { handle } },
    ).then((response) => response.conversation);
  }

  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.request(
      `v1/conversations/${encodeURIComponent(conversationId)}/members/${
        encodeURIComponent(userId)
      }`,
      { method: "DELETE" },
    );
  }

  async leaveConversation(conversationId: string): Promise<void> {
    await this.request(
      `v1/conversations/${encodeURIComponent(conversationId)}/leave`,
      { method: "POST" },
    );
  }

  getEvents(after: number, limit = 100): Promise<EventListResponse> {
    return this.request<EventListResponse>(`v1/events?after=${after}&limit=${limit}`);
  }

  async headEvents(): Promise<number> {
    const response = await this.request<HeadEventResponse>("v1/events/head");
    return response.seq;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ChatError("network_error", "The Pulsewire server did not answer in time.");
      }
      throw new ChatError(
        "network_error",
        `Could not reach the Pulsewire server at ${this.baseUrl}. Is it running?`,
        { cause: error },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const parsed = parseError(text);
      throw new ChatError(
        mapErrorCode(parsed.code, response.status),
        parsed.message || `The server returned HTTP ${response.status}.`,
      );
    }
    if (response.status === 204 || text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ChatError("network_error", "The server returned an invalid response.");
    }
  }
}

function parseError(text: string): { code: string; message: string } {
  try {
    const value = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    return {
      code: typeof value.error?.code === "string" ? value.error.code : "",
      message: typeof value.error?.message === "string" ? value.error.message : "",
    };
  } catch {
    return { code: "", message: text.trim().slice(0, 300) };
  }
}

function mapErrorCode(code: string, status: number): ChatErrorCode {
  if (
    code === "invalid_input" ||
    code === "auth_required" ||
    code === "forbidden" ||
    code === "not_found" ||
    code === "rate_limited" ||
    code === "network_error"
  ) {
    return code;
  }
  switch (status) {
    case 400:
      return "invalid_input";
    case 401:
      return "auth_required";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return "network_error";
  }
}
