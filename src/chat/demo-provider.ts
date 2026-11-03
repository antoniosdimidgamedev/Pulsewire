// deno-lint-ignore-file require-await
import { dirname } from "node:path";
import { ChatError, errorMessage, isChatError } from "./errors.ts";
import type { AiReplyRequest, AiResponder } from "./ai.ts";
import {
  cloneDemoData,
  type DemoData,
  parseDemoData,
  seedDemoData,
  type StoredConversation,
  type StoredMessage,
  type StoredUser,
} from "./demo-data.ts";
import type {
  ChatProvider,
  Conversation,
  GetMessagesOptions,
  Message,
  ProviderEvent,
  ProviderListener,
  SearchResult,
  SendMessageInput,
  User,
  WorkspaceInfo,
} from "./types.ts";

export interface DemoProviderOptions {
  dataPath: string;
  displayName: string;
  simulateActivity?: boolean;
  connectDelayMs?: number;
  replyDelayMs?: number;
  ambientIntervalMs?: number;
  ai?: AiResponder;
  now?: () => Date;
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_SEARCH_RESULTS = 50;
const WORKSPACE_NAME = "Juniper Studio";

/**
 * A fully local, persistent demo provider.
 *
 * It never contacts a network. Incoming replies are clearly simulated and can
 * be disabled with `simulateActivity: false`.
 */
export class DemoProvider implements ChatProvider {
  readonly id = "demo";
  readonly label = "Local demo";
  readonly demo = true;
  readonly ai: boolean;

  private readonly dataPath: string;
  private readonly displayName: string;
  private readonly simulateActivity: boolean;
  private readonly connectDelayMs: number;
  private readonly replyDelayMs: number;
  private readonly ambientIntervalMs: number;
  private readonly aiResponder?: AiResponder;
  private readonly now: () => Date;
  private readonly listeners = new Set<ProviderListener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pendingReplies = new Set<string>();

  private data?: DemoData;
  private connected = false;
  private persistChain: Promise<void> = Promise.resolve();
  private ambientTimer?: ReturnType<typeof setTimeout>;
  private aiWarningShown = false;
  private placeholderUser: User;

  constructor(options: DemoProviderOptions) {
    this.dataPath = options.dataPath;
    this.displayName = options.displayName;
    this.simulateActivity = options.simulateActivity ?? true;
    this.connectDelayMs = options.connectDelayMs ?? 0;
    this.replyDelayMs = options.replyDelayMs ?? 1_800;
    this.ambientIntervalMs = options.ambientIntervalMs ?? 75_000;
    this.aiResponder = options.ai;
    this.ai = options.ai !== undefined;
    this.now = options.now ?? (() => new Date());
    this.placeholderUser = {
      id: "u-self",
      displayName: options.displayName,
      handle: slug(options.displayName),
    };
  }

  get currentUser(): User {
    if (!this.data) return this.placeholderUser;
    return this.hydrateUser(this.data, this.data.currentUserId);
  }

  async connect(): Promise<WorkspaceInfo> {
    if (this.connected) return this.workspaceInfo();
    if (this.connectDelayMs > 0) await delay(this.connectDelayMs);

    let data: DemoData;
    let raw: string | undefined;
    try {
      raw = await Deno.readTextFile(this.dataPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new ChatError(
          "storage_unavailable",
          `Could not read demo data at ${this.dataPath}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }

    if (raw === undefined) {
      data = seedDemoData({ displayName: this.displayName, now: this.now() });
      this.data = data;
      await this.persist();
    } else {
      try {
        data = parseDemoData(raw);
      } catch (error) {
        if (isChatError(error)) {
          throw new ChatError(
            error.code,
            `${error.message} File: ${this.dataPath}. Run "pulsewire --reset-demo" to start over.`,
            { cause: error },
          );
        }
        throw error;
      }
      this.data = data;
      const current = data.users[data.currentUserId];
      if (!current) {
        throw new ChatError(
          "storage_corrupt",
          `Demo data at ${this.dataPath} has no current user.`,
        );
      }
      if (current.displayName !== this.displayName) {
        current.displayName = this.displayName;
        current.handle = slug(this.displayName);
        data.updatedAt = this.nowIso();
        await this.persist();
      }
    }

    this.connected = true;
    this.scheduleAmbientMessage();
    return this.workspaceInfo();
  }

  async listConversations(): Promise<Conversation[]> {
    const data = this.requireData();
    const conversations = Object.values(data.conversations).map((conversation) =>
      this.hydrateConversation(data, conversation)
    );
    return conversations.sort((a, b) => {
      const delta = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    });
  }

  async getMessages(
    conversationId: string,
    options: GetMessagesOptions = {},
  ): Promise<Message[]> {
    const data = this.requireData();
    if (!data.conversations[conversationId]) {
      throw new ChatError("not_found", "That conversation no longer exists.");
    }
    let messages = this.messagesFor(data, conversationId);
    if (options.limit !== undefined && options.limit >= 0) {
      messages = messages.slice(Math.max(0, messages.length - options.limit));
    }
    return messages;
  }

  async getThread(messageId: string): Promise<Message[]> {
    const data = this.requireData();
    const message = data.messages[messageId];
    if (!message) throw new ChatError("not_found", "That message no longer exists.");
    const root = this.rootOf(data, message);
    return this.messagesForStored(data, root.conversationId)
      .filter((candidate) =>
        candidate.id === root.id || this.rootOf(data, candidate).id === root.id
      )
      .map((candidate) => this.hydrateMessage(data, candidate));
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    const data = this.requireData();
    const conversation = data.conversations[input.conversationId];
    if (!conversation) throw new ChatError("not_found", "That conversation no longer exists.");
    const body = this.validateBody(input.body);
    let replyToId: string | undefined;
    if (input.replyToId) {
      const parent = data.messages[input.replyToId];
      if (!parent || parent.conversationId !== input.conversationId) {
        throw new ChatError("invalid_input", "The message you tried to reply to is unavailable.");
      }
      if (parent.deletedAt) {
        throw new ChatError("invalid_input", "You cannot reply to a deleted message.");
      }
      replyToId = this.rootOf(data, parent).id;
    }

    const message: StoredMessage = {
      id: `m-${crypto.randomUUID()}`,
      conversationId: input.conversationId,
      authorId: data.currentUserId,
      body,
      createdAt: this.nowIso(),
      ...(replyToId ? { replyToId } : {}),
    };
    data.messages[message.id] = message;
    data.updatedAt = this.nowIso();
    await this.persist();
    const hydrated = this.hydrateMessage(data, message);
    this.emit({ type: "message-created", conversationId: input.conversationId, message: hydrated });
    this.scheduleSimulatedReply(input.conversationId, message);
    return hydrated;
  }

  async editMessage(messageId: string, body: string): Promise<Message> {
    const data = this.requireData();
    const message = data.messages[messageId];
    if (!message) throw new ChatError("not_found", "That message no longer exists.");
    if (message.authorId !== data.currentUserId) {
      throw new ChatError("forbidden", "You can only edit your own messages.");
    }
    if (message.deletedAt) {
      throw new ChatError("invalid_input", "Deleted messages cannot be edited.");
    }
    message.body = this.validateBody(body);
    message.editedAt = this.nowIso();
    data.updatedAt = this.nowIso();
    await this.persist();
    const hydrated = this.hydrateMessage(data, message);
    this.emit({
      type: "message-updated",
      conversationId: message.conversationId,
      message: hydrated,
    });
    return hydrated;
  }

  async deleteMessage(messageId: string): Promise<void> {
    const data = this.requireData();
    const message = data.messages[messageId];
    if (!message) throw new ChatError("not_found", "That message no longer exists.");
    if (message.authorId !== data.currentUserId) {
      throw new ChatError("forbidden", "You can only delete your own messages.");
    }
    if (message.deletedAt) return;
    message.body = "";
    message.deletedAt = this.nowIso();
    data.updatedAt = this.nowIso();
    await this.persist();
    this.emit({
      type: "message-deleted",
      conversationId: message.conversationId,
      messageId: message.id,
    });
  }

  async searchMessages(query: string): Promise<SearchResult[]> {
    const data = this.requireData();
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const results: SearchResult[] = [];

    for (const stored of Object.values(data.messages)) {
      if (stored.deletedAt) continue;
      const conversation = data.conversations[stored.conversationId];
      if (!conversation) continue;
      const author = data.users[stored.authorId];
      if (!author) continue;
      const bodyMatch = stored.body.toLocaleLowerCase().includes(normalized);
      const authorMatch = author.displayName.toLocaleLowerCase().includes(normalized);
      const conversationMatch = conversation.name.toLocaleLowerCase().includes(normalized);
      if (!bodyMatch && !authorMatch && !conversationMatch) continue;

      results.push({
        message: this.hydrateMessage(data, stored),
        conversation: this.hydrateConversation(data, conversation),
        snippet: bodyMatch
          ? snippetAround(stored.body, normalized)
          : truncateWords(stored.body, 90),
      });
    }

    return results
      .sort((a, b) => Date.parse(b.message.createdAt) - Date.parse(a.message.createdAt))
      .slice(0, MAX_SEARCH_RESULTS);
  }

  async markRead(conversationId: string): Promise<void> {
    const data = this.requireData();
    const conversation = data.conversations[conversationId];
    if (!conversation) throw new ChatError("not_found", "That conversation no longer exists.");
    conversation.lastReadAt = this.nowIso();
    data.updatedAt = this.nowIso();
    await this.persist();
  }

  subscribe(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isThreadingSupported(_conversation: Conversation): boolean {
    return true;
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.ambientTimer !== undefined) clearTimeout(this.ambientTimer);
    this.ambientTimer = undefined;
    this.pendingReplies.clear();
    this.listeners.clear();
    this.connected = false;
    await this.persistChain.catch(() => undefined);
  }

  /** Used by tests and tooling; not part of the ChatProvider interface. */
  snapshot(): DemoData {
    return cloneDemoData(this.requireData());
  }

  private requireData(): DemoData {
    if (!this.data) {
      throw new ChatError("not_connected", "The local demo workspace has not loaded yet.");
    }
    return this.data;
  }

  private workspaceInfo(): WorkspaceInfo {
    const currentUser = this.currentUser;
    const info: WorkspaceInfo = {
      name: WORKSPACE_NAME,
      providerId: this.id,
      providerLabel: this.label,
      demo: this.demo,
      currentUser,
    };
    if (this.aiResponder) info.note = `AI replies · ${this.aiResponder.label}`;
    return info;
  }

  private hydrateUser(data: DemoData, userId: string): User {
    const user = data.users[userId];
    if (!user) throw new ChatError("storage_corrupt", "A message references a missing author.");
    return { id: user.id, displayName: user.displayName, handle: user.handle };
  }

  private hydrateMessage(data: DemoData, stored: StoredMessage): Message {
    const message: Message = {
      id: stored.id,
      conversationId: stored.conversationId,
      author: this.hydrateUser(data, stored.authorId),
      body: stored.body,
      createdAt: stored.createdAt,
    };
    if (stored.editedAt) message.editedAt = stored.editedAt;
    if (stored.deletedAt) message.deletedAt = stored.deletedAt;
    if (stored.replyToId) message.replyToId = stored.replyToId;
    return message;
  }

  private hydrateConversation(data: DemoData, stored: StoredConversation): Conversation {
    const messages = this.messagesForStored(data, stored.id);
    const latest = messages[messages.length - 1];
    const unreadCount = messages.filter((message) =>
      message.authorId !== data.currentUserId &&
      !message.deletedAt &&
      (!stored.lastReadAt || Date.parse(message.createdAt) > Date.parse(stored.lastReadAt))
    ).length;
    const lastActivityAt = latest?.createdAt ?? stored.createdAt;
    const lastPreview = latest
      ? (latest.deletedAt ? "Message deleted" : truncateWords(latest.body, 120))
      : "No messages yet";

    const conversation: Conversation = {
      id: stored.id,
      kind: stored.kind,
      name: stored.name,
      members: stored.memberIds.map((memberId) => this.hydrateUser(data, memberId)),
      unreadCount,
      lastActivityAt,
      lastMessagePreview: lastPreview,
    };
    if (stored.topic) conversation.topic = stored.topic;
    if (latest) conversation.lastMessageAt = latest.createdAt;
    if (stored.lastReadAt) conversation.lastReadAt = stored.lastReadAt;
    return conversation;
  }

  private messagesFor(data: DemoData, conversationId: string): Message[] {
    return this.messagesForStored(data, conversationId).map((message) =>
      this.hydrateMessage(data, message)
    );
  }

  private messagesForStored(data: DemoData, conversationId: string): StoredMessage[] {
    return Object.values(data.messages)
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => {
        const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        return delta !== 0 ? delta : a.id.localeCompare(b.id);
      });
  }

  private rootOf(data: DemoData, message: StoredMessage): StoredMessage {
    let current = message;
    const seen = new Set<string>();
    while (current.replyToId) {
      if (seen.has(current.id)) {
        throw new ChatError("storage_corrupt", "The demo data contains a reply loop.");
      }
      seen.add(current.id);
      const parent = data.messages[current.replyToId];
      if (!parent) {
        throw new ChatError("storage_corrupt", "A reply points at a missing message.");
      }
      current = parent;
    }
    return current;
  }

  private validateBody(body: string): string {
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

  private nowIso(): string {
    return this.now().toISOString();
  }

  private emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken observer must not take down the chat provider.
      }
    }
  }

  private async persist(): Promise<void> {
    const data = this.requireData();
    data.updatedAt = this.nowIso();
    const snapshot = JSON.stringify(data, null, 2);
    const run = async () => {
      const tempPath = `${this.dataPath}.tmp-${crypto.randomUUID()}`;
      try {
        await Deno.mkdir(dirname(this.dataPath), { recursive: true });
        await Deno.writeTextFile(tempPath, snapshot + "\n", { mode: 0o600 });
        try {
          await Deno.rename(tempPath, this.dataPath);
        } catch (error) {
          // Windows cannot always rename over an existing file.
          if (Deno.build.os === "windows") {
            await Deno.remove(this.dataPath).catch(() => undefined);
            await Deno.rename(tempPath, this.dataPath);
          } else {
            throw error;
          }
        }
      } catch (error) {
        await Deno.remove(tempPath).catch(() => undefined);
        throw new ChatError(
          "write_failed",
          `Could not save demo data to ${this.dataPath}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    };
    this.persistChain = this.persistChain.then(run, run);
    await this.persistChain;
  }

  private scheduleSimulatedReply(conversationId: string, source: StoredMessage): void {
    if (!this.simulateActivity || this.pendingReplies.has(conversationId)) return;
    const data = this.requireData();
    const conversation = data.conversations[conversationId];
    if (!conversation) return;
    const others = conversation.memberIds.filter((id) => id !== data.currentUserId);
    if (others.length === 0) return;

    this.pendingReplies.add(conversationId);
    const authorId = others[this.messageCountFor(data, conversationId) % others.length];
    if (!authorId) {
      this.pendingReplies.delete(conversationId);
      return;
    }
    const author = data.users[authorId];
    if (!author) {
      this.pendingReplies.delete(conversationId);
      return;
    }

    this.emit({
      type: "typing",
      conversationId,
      user: this.hydrateUser(data, authorId),
      active: true,
    });

    const replyTimer = setTimeout(() => {
      this.timers.delete(replyTimer);
      void this.deliverSimulatedReply(conversationId, source, authorId);
    }, this.replyDelayMs);
    this.timers.add(replyTimer);
  }

  private async deliverSimulatedReply(
    conversationId: string,
    source: StoredMessage,
    authorId: string,
  ): Promise<void> {
    try {
      if (!this.connected) return;
      const current = this.requireData();
      const conversation = current.conversations[conversationId];
      const author = current.users[authorId];
      if (!conversation || !author) return;

      let body = simulatedReply(source.body, this.messageCountFor(current, conversationId));
      if (this.aiResponder) {
        const result = await this.aiResponder.reply(
          this.aiRequest(current, conversation, author, conversationId),
        );
        if (result.ok) body = result.text;
        else this.noteAiFailure(result.reason);
      }

      // The provider may have been disposed or reset while the model was thinking.
      if (!this.connected) return;
      const latest = this.requireData();
      const latestConversation = latest.conversations[conversationId];
      const latestAuthor = latest.users[authorId];
      if (!latestConversation || !latestAuthor) return;

      const createdAt = this.nowIso();
      const reply: StoredMessage = {
        id: `m-${crypto.randomUUID()}`,
        conversationId,
        authorId,
        body,
        createdAt,
        ...(source.replyToId || this.isThreadRoot(latest, source)
          ? { replyToId: this.rootOf(latest, source).id }
          : {}),
      };
      latest.messages[reply.id] = reply;
      latest.updatedAt = createdAt;
      await this.persist();
      this.emit({
        type: "typing",
        conversationId,
        user: this.hydrateUser(latest, authorId),
        active: false,
      });
      this.emit({
        type: "message-created",
        conversationId,
        message: this.hydrateMessage(latest, reply),
      });
    } catch (error) {
      this.emit({ type: "error", message: `Simulated reply failed: ${errorMessage(error)}` });
    } finally {
      this.pendingReplies.delete(conversationId);
    }
  }

  private aiRequest(
    data: DemoData,
    conversation: StoredConversation,
    author: StoredUser,
    conversationId: string,
  ): AiReplyRequest {
    const messages = this.messagesForStored(data, conversationId)
      .filter((message) => !message.deletedAt && message.body.trim())
      .map((message) => ({
        authorId: message.authorId,
        authorName: data.users[message.authorId]?.displayName ?? "Someone",
        body: message.body,
      }));

    return {
      conversation: {
        name: conversation.name,
        kind: conversation.kind,
        ...(conversation.topic ? { topic: conversation.topic } : {}),
      },
      members: conversation.memberIds
        .map((memberId) => data.users[memberId]?.displayName)
        .filter((name): name is string => Boolean(name)),
      persona: { id: author.id, displayName: author.displayName, handle: author.handle },
      messages,
    };
  }

  private noteAiFailure(reason: string): void {
    if (this.aiWarningShown) return;
    this.aiWarningShown = true;
    this.emit({
      type: "error",
      message: `Local AI replies are unavailable (${reason}). Using canned demo replies.`,
    });
  }

  private isThreadRoot(data: DemoData, message: StoredMessage): boolean {
    if (message.replyToId) return false;
    return Object.values(data.messages).some((candidate) => candidate.replyToId === message.id);
  }

  private messageCountFor(data: DemoData, conversationId: string): number {
    return Object.values(data.messages).filter((message) =>
      message.conversationId === conversationId
    ).length;
  }

  private scheduleAmbientMessage(): void {
    if (!this.simulateActivity || this.ambientIntervalMs <= 0 || this.ambientTimer !== undefined) {
      return;
    }
    const jittered = Math.round(this.ambientIntervalMs * (0.85 + Math.random() * 0.3));
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = undefined;
      if (!this.connected) return;
      void this.emitAmbientMessage().finally(() => {
        if (this.connected) this.scheduleAmbientMessage();
      });
    }, jittered);
  }

  private async emitAmbientMessage(): Promise<void> {
    try {
      const data = this.requireData();
      const conversations = Object.values(data.conversations);
      if (conversations.length === 0) return;
      const conversation = conversations[Math.floor(Math.random() * conversations.length)];
      if (!conversation) return;
      const others = conversation.memberIds.filter((id) => id !== data.currentUserId);
      if (others.length === 0) return;
      const authorId = others[Math.floor(Math.random() * others.length)];
      if (!authorId) return;
      const messages = ambientMessages;
      const message: StoredMessage = {
        id: `m-${crypto.randomUUID()}`,
        conversationId: conversation.id,
        authorId,
        body: messages[Math.floor(Math.random() * messages.length)] ?? "Quick update is in.",
        createdAt: this.nowIso(),
      };
      data.messages[message.id] = message;
      data.updatedAt = message.createdAt;
      await this.persist();
      this.emit({
        type: "message-created",
        conversationId: message.conversationId,
        message: this.hydrateMessage(data, message),
      });
    } catch (error) {
      this.emit({ type: "error", message: `Demo activity failed: ${errorMessage(error)}` });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 20) || "you";
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
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${collapsed.slice(start, end).trim()}${suffix}`;
}

const simulatedReplies = [
  "That makes sense. I will take a look and report back.",
  "Nice. I had the same read on it.",
  "Good catch - I will fold that into the next pass.",
  "Works for me. Let's keep v0.1 focused and revisit after feedback.",
  "I added it to the checklist. Nothing blocking from my side.",
  "That is clearer. The keyboard flow feels much easier to explain now.",
  "Agreed. Simplicity wins for the first release.",
  "I tested the narrow layout and it still holds together.",
];

const questionReplies = [
  "Yes, that matches what I see locally.",
  "I think so. Let me verify the edge case first.",
  "Probably - but I would keep the fallback visible just in case.",
  "Good question. I would choose the simpler option for v0.1.",
];

const ambientMessages = [
  "Quick status: the checklist is nearly clear.",
  "I left two small notes in the design review.",
  "Build is green on my machine. Running the final pass now.",
  "The narrow-terminal layout is holding up better than I expected.",
  "Reminder to take a break before the next review.",
  "I am testing the empty states again this afternoon.",
  "One more pass on the shortcut hints and I think we are done.",
];

function simulatedReply(sourceBody: string, messageCount: number): string {
  const pool = sourceBody.includes("?") ? questionReplies : simulatedReplies;
  return pool[messageCount % pool.length] ?? simulatedReplies[0]!;
}
