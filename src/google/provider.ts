// deno-lint-ignore-file require-await
import { join } from "node:path";
import { ChatError, errorMessage } from "../chat/errors.ts";
import type {
  ChatProvider,
  Conversation,
  ConversationKind,
  GetMessagesOptions,
  Message,
  ProviderEvent,
  ProviderListener,
  SearchResult,
  SendMessageInput,
  User,
  WorkspaceInfo,
} from "../chat/types.ts";
import { writePrivateJson } from "../storage.ts";
import { type ChatApiMessage, type ChatApiSpace, GoogleChatApi } from "./api.ts";
import type { FetchLike, GoogleSession } from "./oauth.ts";

export interface GoogleChatProviderOptions {
  session: GoogleSession;
  dataDir: string;
  readStatePath?: string;
  pollIntervalMs?: number;
  maxSpaces?: number;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  now?: () => Date;
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_POLLED_SPACES = 10;
const CONNECT_MESSAGE_LIMIT = 50;
const OPEN_MESSAGE_LIMIT = 100;

interface ReadStateFile {
  version: 1;
  lastRead: Record<string, string>;
}

/**
 * Google Chat provider using the Google Chat REST API with user OAuth.
 *
 * Limitations of the public API are surfaced honestly:
 * - No full-text search endpoint, so search covers recently loaded messages.
 * - No typing indicators.
 * - No message-level delivery or read receipts, so only "sent" is shown for
 *   messages created during this session. History messages carry no ticks.
 * - Threads are supported in named spaces (Google Chat's own restriction).
 * - Incoming messages are received by polling; there is no push channel for
 *   user-auth desktop clients.
 */
export class GoogleChatProvider implements ChatProvider {
  readonly id = "googlechat";
  readonly label = "Google Chat";
  readonly demo = false;

  private readonly session: GoogleSession;
  private readonly api: GoogleChatApi;
  private readonly readStatePath: string;
  private readonly pollIntervalMs: number;
  private readonly maxSpaces: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<ProviderListener>();

  private currentUserValue: User = { id: "users/me", displayName: "Google user", handle: "user" };
  private workspace?: WorkspaceInfo;
  private connected = false;
  private spaces = new Map<string, ChatApiSpace>();
  private rawMessages = new Map<string, Map<string, ChatApiMessage>>();
  private messages = new Map<string, Message[]>();
  private members = new Map<string, User[]>();
  private readState = new Map<string, string>();
  private seen = new Map<string, Set<string>>();
  private localReadState: ReadStateFile = { version: 1, lastRead: {} };
  private pollTimer?: ReturnType<typeof setTimeout>;
  private lastPollError = "";
  private lastPollErrorAt = 0;

  constructor(options: GoogleChatProviderOptions) {
    this.session = options.session;
    this.api = new GoogleChatApi({
      session: options.session,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    });
    this.readStatePath = options.readStatePath ??
      join(options.dataDir, "googlechat-readstate.json");
    this.pollIntervalMs = options.pollIntervalMs ?? 20_000;
    this.maxSpaces = options.maxSpaces ?? 30;
    this.now = options.now ?? (() => new Date());
  }

  get currentUser(): User {
    return this.currentUserValue;
  }

  async connect(): Promise<WorkspaceInfo> {
    if (this.connected && this.workspace) return this.workspace;
    const user = await this.session.getUser();
    this.currentUserValue = user;
    this.localReadState = await this.loadLocalReadState();
    const spaces = await this.api.listSpaces(this.maxSpaces);
    this.spaces = new Map(spaces.map((space) => [space.name, space]));

    const warnings: string[] = [];
    const nowIso = this.now().toISOString();
    await mapLimit(spaces, 4, async (space) => {
      const [page, members, remoteRead] = await Promise.all([
        this.api.listMessages(space.name, {
          pageSize: CONNECT_MESSAGE_LIMIT,
          orderBy: "createTime DESC",
          showDeleted: true,
        }).catch((error) => {
          warnings.push(`${spaceLabel(space)}: ${errorMessage(error)}`);
          return { messages: [] as ChatApiMessage[] };
        }),
        this.api.listMembers(space.name).catch(() => []),
        this.api.getSpaceReadState(space.name).catch(() => undefined),
      ]);
      this.rawMessages.set(
        space.name,
        new Map(page.messages.map((message) => [message.name, message])),
      );
      this.members.set(
        space.name,
        members.flatMap((membership) => membership.member ? [apiUser(membership.member)] : []),
      );
      if (remoteRead?.lastReadTime) this.readState.set(space.name, remoteRead.lastReadTime);
      if (!this.readState.has(space.name)) {
        this.readState.set(space.name, this.localReadState.lastRead[space.name] ?? nowIso);
      }
      this.seen.set(space.name, new Set(page.messages.map((message) => message.name)));
      this.rebuildSpace(space.name);
    });

    if (warnings.length > 0) {
      setTimeout(() => {
        this.emit({
          type: "error",
          message: `Some Google Chat spaces could not be loaded: ${warnings[0]}`,
        });
      }, 0);
    }

    await this.saveLocalReadState();
    this.workspace = {
      name: "Google Chat",
      providerId: this.id,
      providerLabel: this.label,
      demo: false,
      currentUser: user,
    };
    this.connected = true;
    this.schedulePoll();
    return this.workspace;
  }

  async listConversations(): Promise<Conversation[]> {
    this.requireConnected();
    return [...this.spaces.values()]
      .map((space) => this.hydrateConversation(space))
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  }

  async getMessages(
    conversationId: string,
    options: GetMessagesOptions = {},
  ): Promise<Message[]> {
    this.requireConnected();
    const space = this.spaces.get(conversationId);
    if (!space) throw new ChatError("not_found", "That Google Chat space no longer exists.");
    const page = await this.api.listMessages(conversationId, {
      pageSize: OPEN_MESSAGE_LIMIT,
      orderBy: "createTime DESC",
      showDeleted: true,
    });
    this.mergeRaw(conversationId, page.messages);
    const all = this.messages.get(conversationId) ?? [];
    if (options.limit !== undefined && options.limit >= 0) {
      return all.slice(Math.max(0, all.length - options.limit));
    }
    return all;
  }

  async getThread(messageId: string): Promise<Message[]> {
    this.requireConnected();
    const raw = await this.getMessageRaw(messageId);
    const spaceId = spaceNameForMessage(raw.name);
    const threadName = raw.thread?.name;
    if (!threadName || !raw.thread?.threadReply) {
      return [this.hydrateMessage(raw)];
    }
    const thread = await this.api.listThreadMessages(spaceId, threadName);
    this.mergeRaw(spaceId, thread);
    const rootId = threadRootFor(this.rawIn(spaceId), threadName);
    return (this.messages.get(spaceId) ?? []).filter((message) => {
      if (message.id === rootId) return true;
      return this.rawIn(spaceId).get(message.id)?.thread?.name === threadName;
    });
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    this.requireConnected();
    const space = this.spaces.get(input.conversationId);
    if (!space) throw new ChatError("not_found", "That Google Chat space no longer exists.");
    const text = validateBody(input.body);
    let threadName: string | undefined;
    if (input.replyToId) {
      const conversation = this.hydrateConversation(space);
      if (!this.isThreadingSupported(conversation)) {
        throw new ChatError(
          "invalid_input",
          "Threads are only supported in Google Chat spaces, not direct or group messages.",
        );
      }
      const parent = await this.getMessageRaw(input.replyToId);
      if (!parent.thread?.name) {
        throw new ChatError("invalid_input", "That message is not part of a Google Chat thread.");
      }
      threadName = parent.thread.name;
    }

    const created = await this.api.createMessage({
      spaceName: input.conversationId,
      text,
      threadName,
    });
    const normalized = created.sender ? created : {
      ...created,
      sender: { name: this.currentUser.id, displayName: this.currentUser.displayName },
    };
    this.mergeRaw(input.conversationId, [normalized]);
    await this.markRead(input.conversationId).catch(() => undefined);
    const message = this.hydrateMessage(normalized);
    // The API confirms the server accepted this message; it does not expose
    // per-recipient delivery or read receipts.
    message.delivery = { status: "sent" };
    this.emit({ type: "message-created", conversationId: input.conversationId, message });
    return message;
  }

  async editMessage(messageId: string, body: string): Promise<Message> {
    this.requireConnected();
    const text = validateBody(body);
    const updated = await this.api.updateMessage(messageId, text);
    const spaceId = spaceNameForMessage(updated.name || messageId);
    this.mergeRaw(spaceId, [updated]);
    const message = this.hydrateMessage(updated);
    this.emit({ type: "message-updated", conversationId: spaceId, message });
    return message;
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.requireConnected();
    await this.api.deleteMessage(messageId);
    const raw = this.rawByName(messageId);
    const spaceId = raw ? spaceNameForMessage(raw.name) : spaceNameForMessage(messageId);
    if (raw) {
      raw.deleteTime = this.now().toISOString();
      raw.text = undefined;
      raw.formattedText = undefined;
      this.rebuildSpace(spaceId);
    }
    this.emit({ type: "message-deleted", conversationId: spaceId, messageId });
  }

  async searchMessages(query: string): Promise<SearchResult[]> {
    this.requireConnected();
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const results: SearchResult[] = [];
    for (const space of this.spaces.values()) {
      const conversation = this.hydrateConversation(space);
      for (const message of this.messages.get(space.name) ?? []) {
        if (message.deletedAt) continue;
        const bodyMatch = message.body.toLocaleLowerCase().includes(normalized);
        const authorMatch = message.author.displayName.toLocaleLowerCase().includes(normalized);
        const conversationMatch = conversation.name.toLocaleLowerCase().includes(normalized);
        if (!bodyMatch && !authorMatch && !conversationMatch) continue;
        results.push({
          message,
          conversation,
          snippet: bodyMatch
            ? snippetAround(message.body, normalized)
            : truncateWords(message.body, 90),
        });
      }
    }
    return results
      .sort((a, b) => Date.parse(b.message.createdAt) - Date.parse(a.message.createdAt))
      .slice(0, MAX_SEARCH_RESULTS);
  }

  async markRead(conversationId: string): Promise<void> {
    this.requireConnected();
    const space = this.spaces.get(conversationId);
    if (!space) throw new ChatError("not_found", "That Google Chat space no longer exists.");
    const timestamp = this.now().toISOString();
    this.readState.set(conversationId, timestamp);
    this.localReadState.lastRead[conversationId] = timestamp;
    await this.saveLocalReadState();
    try {
      await this.api.updateSpaceReadState(conversationId, timestamp);
    } catch (error) {
      // Local read state still prevents repeated unread badges in this app.
      if (
        error instanceof ChatError && (error.code === "forbidden" || error.code === "not_found")
      ) return;
      throw error;
    }
  }

  subscribe(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isThreadingSupported(conversation: Conversation): boolean {
    return conversation.kind === "space";
  }

  dispose(): Promise<void> {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.listeners.clear();
    this.connected = false;
    return Promise.resolve();
  }

  private hydrateConversation(space: ChatApiSpace): Conversation {
    const messages = this.messages.get(space.name) ?? [];
    const members = this.members.get(space.name) ?? [];
    const latest = messages[messages.length - 1];
    const lastRead = this.readState.get(space.name);
    const unreadCount = messages.filter((message) =>
      message.author.id !== this.currentUser.id &&
      !message.deletedAt &&
      (!lastRead || Date.parse(message.createdAt) > Date.parse(lastRead))
    ).length;
    const kind = spaceKind(space);
    const conversation: Conversation = {
      id: space.name,
      kind,
      name: conversationName(space, kind, members, this.currentUser),
      members,
      unreadCount,
      lastActivityAt: latest?.createdAt ?? space.lastActiveTime ?? space.createTime ??
        this.now().toISOString(),
      lastMessagePreview: latest
        ? (latest.deletedAt ? "Message deleted" : truncateWords(latest.body, 120))
        : "No messages yet",
    };
    const description = space.spaceDetails?.description;
    if (description) conversation.topic = description;
    if (latest) conversation.lastMessageAt = latest.createdAt;
    if (lastRead) conversation.lastReadAt = lastRead;
    return conversation;
  }

  private hydrateMessage(raw: ChatApiMessage): Message {
    const sender = raw.sender;
    const author: User = sender
      ? apiUser(sender)
      : { id: "users/unknown", displayName: "Unknown", handle: "unknown" };
    const message: Message = {
      id: raw.name,
      conversationId: spaceNameForMessage(raw.name),
      author,
      body: raw.deleteTime ? "" : messageText(raw),
      createdAt: raw.createTime,
    };
    if (raw.deleteTime) message.deletedAt = raw.deleteTime;
    if (raw.updateTime && Date.parse(raw.updateTime) - Date.parse(raw.createTime) > 1_000) {
      message.editedAt = raw.updateTime;
    }
    return message;
  }

  private rebuildSpace(spaceName: string): void {
    const raw = this.rawIn(spaceName);
    const sorted = [...raw.values()].sort(compareRawMessages);
    const threadRoots = new Map<string, ChatApiMessage>();
    for (const message of sorted) {
      if (message.thread?.name && !message.thread.threadReply) {
        threadRoots.set(message.thread.name, message);
      }
    }
    this.messages.set(
      spaceName,
      sorted.map((message) => {
        const hydrated = this.hydrateMessage(message);
        const threadName = message.thread?.name;
        if (threadName && message.thread?.threadReply) {
          const root = threadRoots.get(threadName);
          if (root && root.name !== message.name) hydrated.replyToId = root.name;
        }
        return hydrated;
      }),
    );
    this.seen.set(spaceName, new Set(sorted.map((message) => message.name)));
  }

  private mergeRaw(spaceName: string, incoming: ChatApiMessage[]): void {
    if (!this.rawMessages.has(spaceName)) this.rawMessages.set(spaceName, new Map());
    const target = this.rawIn(spaceName);
    for (const message of incoming) target.set(message.name, message);
    this.rebuildSpace(spaceName);
  }

  private rawIn(spaceName: string): Map<string, ChatApiMessage> {
    let map = this.rawMessages.get(spaceName);
    if (!map) {
      map = new Map();
      this.rawMessages.set(spaceName, map);
    }
    return map;
  }

  private rawByName(messageId: string): ChatApiMessage | undefined {
    for (const messages of this.rawMessages.values()) {
      const found = messages.get(messageId);
      if (found) return found;
    }
    return undefined;
  }

  private async getMessageRaw(messageId: string): Promise<ChatApiMessage> {
    const cached = this.rawByName(messageId);
    if (cached) return cached;
    const raw = await this.api.getMessage(messageId);
    const spaceName = spaceNameForMessage(raw.name);
    this.mergeRaw(spaceName, [raw]);
    return raw;
  }

  private schedulePoll(): void {
    if (!this.connected || this.pollIntervalMs <= 0 || this.pollTimer !== undefined) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollOnce().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.connected) return;
    const conversations = [...this.spaces.values()]
      .sort((a, b) =>
        Date.parse(b.lastActiveTime ?? b.createTime ?? "") -
        Date.parse(a.lastActiveTime ?? a.createTime ?? "")
      )
      .slice(0, Math.min(MAX_POLLED_SPACES, this.maxSpaces));
    for (const space of conversations) {
      if (!this.connected) return;
      try {
        const page = await this.api.listMessages(space.name, {
          pageSize: 10,
          orderBy: "createTime DESC",
          showDeleted: true,
        });
        const known = this.seen.get(space.name) ?? new Set<string>();
        const fresh = page.messages.filter((message) => !known.has(message.name));
        if (fresh.length > 0) {
          this.mergeRaw(space.name, page.messages);
          const freshIds = new Set(fresh.map((message) => message.name));
          const events = (this.messages.get(space.name) ?? [])
            .filter((message) => freshIds.has(message.id))
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
          for (const message of events) {
            this.emit({ type: "message-created", conversationId: space.name, message });
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        const now = Date.now();
        if (message !== this.lastPollError || now - this.lastPollErrorAt > 300_000) {
          this.lastPollError = message;
          this.lastPollErrorAt = now;
          this.emit({ type: "error", message: `Google Chat polling failed: ${message}` });
        }
      }
    }
  }

  private async loadLocalReadState(): Promise<ReadStateFile> {
    try {
      const raw = await Deno.readTextFile(this.readStatePath);
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" && parsed !== null &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { lastRead?: unknown }).lastRead === "object" &&
        (parsed as { lastRead?: unknown }).lastRead !== null
      ) {
        const lastRead = (parsed as { lastRead: Record<string, unknown> }).lastRead;
        const cleaned: Record<string, string> = {};
        for (const [key, value] of Object.entries(lastRead)) {
          if (typeof value === "string") cleaned[key] = value;
        }
        return { version: 1, lastRead: cleaned };
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        this.emit({
          type: "error",
          message: `Could not read local Google read state; using defaults. ${errorMessage(error)}`,
        });
      }
    }
    return { version: 1, lastRead: {} };
  }

  private async saveLocalReadState(): Promise<void> {
    try {
      await writePrivateJson(this.readStatePath, this.localReadState);
    } catch (error) {
      this.emit({
        type: "error",
        message: `Could not save local Google read state: ${errorMessage(error)}`,
      });
    }
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new ChatError("not_connected", "Google Chat has not connected yet.");
    }
  }

  private emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Observers cannot break the provider.
      }
    }
  }
}

function apiUser(user: { name: string; displayName?: string }): User {
  const displayName = user.displayName?.trim() || user.name.replace(/^users\//, "User ");
  return {
    id: user.name,
    displayName,
    handle: displayName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "user",
  };
}

function spaceKind(space: ChatApiSpace): ConversationKind {
  if (space.spaceType === "DIRECT_MESSAGE") return "dm";
  if (space.spaceType === "GROUP_CHAT") return "group";
  return "space";
}

function conversationName(
  space: ChatApiSpace,
  kind: ConversationKind,
  members: User[],
  currentUser: User,
): string {
  const display = space.displayName?.trim();
  if (display) return display;
  const others = members.filter((member) =>
    member.id !== currentUser.id && member.displayName !== currentUser.displayName
  );
  if (kind === "dm") return others[0]?.displayName ?? "Direct message";
  if (kind === "group") {
    if (others.length === 0) return "Group chat";
    const names = others.slice(0, 3).map((member) => member.displayName);
    return others.length > 3 ? `${names.join(", ")} +${others.length - 3}` : names.join(", ");
  }
  return space.name.replace(/^spaces\//, "Space ");
}

function messageText(raw: ChatApiMessage): string {
  const text = raw.text?.trim() || raw.formattedText?.trim();
  if (text) return text;
  if (raw.attachment?.length || raw.cardsV2?.length || raw.accessoryWidgets?.length) {
    return "[Message contains an attachment or card that Pulsewire cannot display]";
  }
  return "(empty message)";
}

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new ChatError("invalid_input", "Message cannot be empty.");
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError(
      "invalid_input",
      `Message is too long (${trimmed.length}/${MAX_MESSAGE_LENGTH} characters).`,
    );
  }
  return trimmed;
}

function compareRawMessages(a: ChatApiMessage, b: ChatApiMessage): number {
  const delta = Date.parse(a.createTime) - Date.parse(b.createTime);
  return delta !== 0 ? delta : a.name.localeCompare(b.name);
}

function spaceNameForMessage(name: string): string {
  const match = /^(spaces\/[^/]+)\/messages\//.exec(name);
  if (!match?.[1]) {
    throw new ChatError("invalid_input", `Invalid Google Chat message name: ${name}`);
  }
  return match[1];
}

function spaceLabel(space: ChatApiSpace): string {
  return space.displayName?.trim() || space.name;
}

function threadRootFor(raw: Map<string, ChatApiMessage>, threadName: string): string | undefined {
  for (const message of raw.values()) {
    if (message.thread?.name === threadName && !message.thread.threadReply) return message.name;
  }
  return undefined;
}

function truncateWords(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function snippetAround(body: string, query: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  const index = collapsed.toLocaleLowerCase().indexOf(query);
  if (index < 0) return truncateWords(collapsed, 90);
  const start = Math.max(0, index - 30);
  const end = Math.min(collapsed.length, index + query.length + 45);
  return `${start > 0 ? "…" : ""}${collapsed.slice(start, end).trim()}${
    end < collapsed.length ? "…" : ""
  }`;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      const item = items[current];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}
