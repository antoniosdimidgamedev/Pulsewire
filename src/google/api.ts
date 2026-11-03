import { ChatError, errorMessage } from "../chat/errors.ts";
import type { FetchLike, GoogleSession } from "./oauth.ts";

export interface ChatApiUser {
  name: string;
  displayName?: string;
  type?: string;
  avatarUrl?: string;
}

export interface ChatApiSpace {
  name: string;
  spaceType?: string;
  displayName?: string;
  createTime?: string;
  lastActiveTime?: string;
  spaceDetails?: { description?: string };
  spaceThreadingState?: string;
}

export interface ChatApiMembership {
  name: string;
  member?: ChatApiUser;
  role?: string;
}

export interface ChatApiMessage {
  name: string;
  sender?: ChatApiUser;
  createTime: string;
  updateTime?: string;
  deleteTime?: string;
  text?: string;
  formattedText?: string;
  thread?: { name: string; threadReply?: boolean };
  attachment?: unknown[];
  cardsV2?: unknown[];
  accessoryWidgets?: unknown[];
  quotedMessageMetadata?: unknown;
}

interface ListResponse<T> {
  spaces?: T[];
  messages?: T[];
  memberships?: T[];
  nextPageToken?: string;
}

export interface SpaceReadState {
  name: string;
  lastReadTime?: string;
}

export class GoogleChatApi {
  private readonly session: GoogleSession;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: {
    session: GoogleSession;
    fetchImpl?: FetchLike;
    baseUrl?: string;
  }) {
    this.session = options.session;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://chat.googleapis.com/v1").replace(/\/$/, "");
  }

  async listSpaces(maxSpaces: number): Promise<ChatApiSpace[]> {
    const spaces: ChatApiSpace[] = [];
    let pageToken: string | undefined;
    while (spaces.length < maxSpaces) {
      const page = await this.request<ListResponse<ChatApiSpace>>("/spaces", {
        query: { pageSize: Math.min(100, maxSpaces - spaces.length), pageToken },
      });
      spaces.push(...(page.spaces ?? []));
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    return spaces.slice(0, maxSpaces);
  }

  async listMessages(
    spaceName: string,
    options: {
      pageSize?: number;
      pageToken?: string;
      orderBy?: string;
      showDeleted?: boolean;
      filter?: string;
    } = {},
  ): Promise<{ messages: ChatApiMessage[]; nextPageToken?: string }> {
    const page = await this.request<ListResponse<ChatApiMessage>>(`/${spaceName}/messages`, {
      query: {
        pageSize: options.pageSize ?? 50,
        pageToken: options.pageToken,
        orderBy: options.orderBy,
        showDeleted: options.showDeleted ?? true,
        filter: options.filter,
      },
    });
    return {
      messages: page.messages ?? [],
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    };
  }

  async getMessage(name: string): Promise<ChatApiMessage> {
    return await this.request<ChatApiMessage>(`/${name}`);
  }

  async createMessage(options: {
    spaceName: string;
    text: string;
    threadName?: string;
    requestId?: string;
  }): Promise<ChatApiMessage> {
    const body: Record<string, unknown> = { text: options.text };
    if (options.threadName) body.thread = { name: options.threadName };
    return await this.request<ChatApiMessage>(`/${options.spaceName}/messages`, {
      method: "POST",
      query: {
        requestId: options.requestId ?? crypto.randomUUID(),
        ...(options.threadName
          ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" }
          : {}),
      },
      body,
    });
  }

  async updateMessage(name: string, text: string): Promise<ChatApiMessage> {
    return await this.request<ChatApiMessage>(`/${name}`, {
      method: "PATCH",
      query: { updateMask: "text" },
      body: { text },
    });
  }

  async deleteMessage(name: string): Promise<void> {
    await this.request<void>(`/${name}`, { method: "DELETE" });
  }

  async listMembers(spaceName: string): Promise<ChatApiMembership[]> {
    const memberships: ChatApiMembership[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<ListResponse<ChatApiMembership>>(`/${spaceName}/members`, {
        query: { pageSize: 100, pageToken },
      });
      memberships.push(...(page.memberships ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return memberships;
  }

  async listThreadMessages(
    spaceName: string,
    threadName: string,
  ): Promise<ChatApiMessage[]> {
    const messages: ChatApiMessage[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.listMessages(spaceName, {
        pageSize: 100,
        pageToken,
        orderBy: "createTime ASC",
        filter: `thread.name = "${threadName.replaceAll('"', "")}"`,
      });
      messages.push(...page.messages);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return messages;
  }

  async getSpaceReadState(spaceName: string): Promise<SpaceReadState | undefined> {
    const spaceId = spaceName.replace(/^spaces\//, "");
    try {
      return await this.request<SpaceReadState>(`/users/me/spaces/${spaceId}/spaceReadState`);
    } catch (error) {
      // Read state needs an extra scope and can be unavailable to some accounts.
      if (error instanceof ChatError && error.code === "forbidden") return undefined;
      throw error;
    }
  }

  async updateSpaceReadState(spaceName: string, lastReadTime: string): Promise<void> {
    const spaceId = spaceName.replace(/^spaces\//, "");
    const name = `users/me/spaces/${spaceId}/spaceReadState`;
    await this.request<SpaceReadState>(`/${name}`, {
      method: "PATCH",
      query: { updateMask: "lastReadTime" },
      body: { name, lastReadTime },
    });
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const token = await this.session.getAccessToken();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new ChatError(
        "network_error",
        `Could not reach Google Chat: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw apiError(response.status, detail);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ChatError("network_error", "Google Chat returned a malformed JSON response.", {
        cause: error,
      });
    }
  }
}

function apiError(status: number, rawDetail: string): ChatError {
  let detail = rawDetail.replace(/\s+/g, " ").trim().slice(0, 400);
  try {
    const parsed = JSON.parse(rawDetail) as { error?: { message?: unknown; status?: unknown } };
    if (typeof parsed.error?.message === "string") detail = parsed.error.message;
  } catch {
    // Keep the plain-text detail.
  }
  if (status === 401) {
    return new ChatError(
      "auth_required",
      "Google Chat rejected the access token. Run `pulsewire auth google` to sign in again.",
    );
  }
  if (status === 403) {
    return new ChatError(
      "forbidden",
      `Google Chat denied this action: ${detail || "permission missing"}. ` +
        "Check that your OAuth scopes and Chat API access are configured.",
    );
  }
  if (status === 404) {
    return new ChatError(
      "not_found",
      `Google Chat could not find that item: ${detail || "not found"}.`,
    );
  }
  if (status === 429) {
    return new ChatError(
      "rate_limited",
      `Google Chat rate limit reached. Wait a moment and try again. ${detail}`.trim(),
    );
  }
  if (status === 400) {
    return new ChatError(
      "invalid_input",
      `Google Chat rejected the request: ${detail || "bad request"}.`,
    );
  }
  return new ChatError(
    "network_error",
    `Google Chat returned HTTP ${status}${detail ? `: ${detail}` : ""}.`,
  );
}
