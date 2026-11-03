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
  MessageDelivery,
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
  /** How long a sent message stays in each simulated delivery state. */
  receiptDelayMs?: number;
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
  private readonly receiptDelayMs: number;
  private readonly ambientIntervalMs: number;
  private readonly aiResponder?: AiResponder;
  private readonly now: () => Date;
  private readonly listeners = new Set<ProviderListener>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pendingReplies = new Set<string>();
  private readonly replyQueues = new Map<string, StoredMessage[]>();

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
    this.receiptDelayMs = options.receiptDelayMs ?? 400;
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
      delivery: { status: "pending" },
      ...(replyToId ? { replyToId } : {}),
    };
    data.messages[message.id] = message;
    data.updatedAt = this.nowIso();
    await this.persist();
    const hydrated = this.hydrateMessage(data, message);
    this.emit({ type: "message-created", conversationId: input.conversationId, message: hydrated });
    this.scheduleDeliveryReceipts(input.conversationId, message.id);
    this.scheduleSimulatedReplies(input.conversationId, message);
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
    this.replyQueues.clear();
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
    if (stored.delivery) {
      message.delivery = {
        status: stored.delivery.status,
        ...(stored.delivery.readBy ? { readBy: [...stored.delivery.readBy] } : {}),
        ...(stored.delivery.error ? { error: stored.delivery.error } : {}),
      };
    }
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

  private scheduleDeliveryReceipts(conversationId: string, messageId: string): void {
    const schedule = (run: () => void) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        run();
      }, this.receiptDelayMs);
      this.timers.add(timer);
    };

    schedule(() => {
      void this.advanceDelivery(conversationId, messageId, "pending", "sent").then((advanced) => {
        if (!advanced || !this.connected) return;
        schedule(() => {
          void this.advanceDelivery(conversationId, messageId, "sent", "delivered");
        });
      });
    });
  }

  private async advanceDelivery(
    conversationId: string,
    messageId: string,
    from: MessageDelivery["status"],
    to: MessageDelivery["status"],
  ): Promise<boolean> {
    if (!this.connected) return false;
    const data = this.requireData();
    const message = data.messages[messageId];
    if (!message || message.deletedAt || message.delivery?.status !== from) return false;
    const conversation = data.conversations[conversationId];
    if (!conversation) return false;
    const recipients = conversation.memberIds.filter((id) => id !== data.currentUserId);
    if (recipients.length === 0) return false;

    message.delivery = {
      ...message.delivery,
      status: to,
    };
    data.updatedAt = this.nowIso();
    await this.persist();
    this.emit({
      type: "message-delivery",
      conversationId,
      messageId,
      delivery: this.hydrateDelivery(message.delivery),
    });
    return true;
  }

  /**
   * Each message from the current user queues one reply from every other
   * member of the conversation. Batches run in order so a quick follow-up
   * message does not starve the first one.
   */
  private scheduleSimulatedReplies(conversationId: string, source: StoredMessage): void {
    if (!this.simulateActivity) return;
    const queue = this.replyQueues.get(conversationId) ?? [];
    queue.push(source);
    this.replyQueues.set(conversationId, queue);
    this.drainReplyQueue(conversationId);
  }

  private drainReplyQueue(conversationId: string): void {
    if (this.pendingReplies.has(conversationId)) return;
    const queue = this.replyQueues.get(conversationId);
    const source = queue?.shift();
    if (!queue || !source) {
      this.replyQueues.delete(conversationId);
      return;
    }
    if (queue.length === 0) this.replyQueues.delete(conversationId);
    this.pendingReplies.add(conversationId);
    this.startReplyBatch(conversationId, source);
  }

  private startReplyBatch(conversationId: string, source: StoredMessage): void {
    const data = this.requireData();
    const conversation = data.conversations[conversationId];
    const others = conversation
      ? conversation.memberIds.filter((id) => id !== data.currentUserId)
      : [];
    if (others.length === 0) {
      this.finishReplyBatch(conversationId);
      return;
    }

    const staggerMs = Math.max(0, Math.min(600, Math.floor(this.replyDelayMs / 2)));
    let remaining = others.length;
    const finish = () => {
      remaining -= 1;
      if (remaining <= 0) this.finishReplyBatch(conversationId);
    };

    others.forEach((authorId, index) => {
      const startTimer = setTimeout(() => {
        this.timers.delete(startTimer);
        if (!this.connected) {
          finish();
          return;
        }
        const current = this.requireData();
        if (!current.users[authorId] || !current.conversations[conversationId]) {
          finish();
          return;
        }
        this.emit({
          type: "typing",
          conversationId,
          user: this.hydrateUser(current, authorId),
          active: true,
        });

        const replyTimer = setTimeout(() => {
          this.timers.delete(replyTimer);
          void this.deliverSimulatedReply(conversationId, source, authorId).finally(finish);
        }, this.replyDelayMs);
        this.timers.add(replyTimer);
      }, index * staggerMs);
      this.timers.add(startTimer);
    });
  }

  private finishReplyBatch(conversationId: string): void {
    this.pendingReplies.delete(conversationId);
    this.drainReplyQueue(conversationId);
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

      let body = simulatedReply(
        source.body,
        this.messageCountFor(current, conversationId),
        authorId,
      );
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
      const deliveryUpdates = this.markOwnMessagesReadBy(latest, conversationId, authorId);
      await this.persist();
      this.emit({
        type: "message-created",
        conversationId,
        message: this.hydrateMessage(latest, reply),
      });
      for (const updated of deliveryUpdates) {
        if (!updated.delivery) continue;
        this.emit({
          type: "message-delivery",
          conversationId,
          messageId: updated.id,
          delivery: this.hydrateDelivery(updated.delivery),
        });
      }
    } catch (error) {
      this.emit({ type: "error", message: `Simulated reply failed: ${errorMessage(error)}` });
    } finally {
      if (this.connected) {
        const data = this.data;
        const author = data?.users[authorId];
        if (data && author) {
          this.emit({
            type: "typing",
            conversationId,
            user: this.hydrateUser(data, authorId),
            active: false,
          });
        }
      }
    }
  }

  /**
   * A reply proves that its author has seen the messages above it. Mark the
   * current user's earlier messages delivered first, then read once every
   * other member has replied or been marked as a reader.
   */
  private markOwnMessagesReadBy(
    data: DemoData,
    conversationId: string,
    readerId: string,
  ): StoredMessage[] {
    const conversation = data.conversations[conversationId];
    if (!conversation || readerId === data.currentUserId) return [];
    const recipients = conversation.memberIds.filter((id) => id !== data.currentUserId);
    if (recipients.length === 0) return [];

    const updates: StoredMessage[] = [];
    for (const message of Object.values(data.messages)) {
      if (
        message.conversationId !== conversationId ||
        message.authorId !== data.currentUserId ||
        message.deletedAt
      ) continue;
      const delivery = message.delivery;
      if (!delivery || delivery.status === "failed") continue;
      const readers = new Set(delivery.readBy ?? []);
      if (readers.has(readerId)) continue;
      readers.add(readerId);
      const readBy = recipients.filter((id) => readers.has(id));
      const status = readBy.length === recipients.length ? "read" : "delivered";
      if (delivery.status === status && (delivery.readBy?.length ?? 0) === readBy.length) {
        continue;
      }
      message.delivery = { status, readBy };
      updates.push(message);
    }
    return updates;
  }

  private hydrateDelivery(delivery: MessageDelivery): MessageDelivery {
    return {
      status: delivery.status,
      ...(delivery.readBy ? { readBy: [...delivery.readBy] } : {}),
      ...(delivery.error ? { error: delivery.error } : {}),
    };
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
      // Let a couple of other members chime in so the workspace chatter
      // continues between user turns.
      this.scheduleBackgroundChatter(message.conversationId, message);
    } catch (error) {
      this.emit({ type: "error", message: `Demo activity failed: ${errorMessage(error)}` });
    }
  }

  /** After an ambient message lands, 1-2 other members reply after short
   * staggered delays so people talk to each other in the background. */
  private scheduleBackgroundChatter(conversationId: string, source: StoredMessage): void {
    const data = this.requireData();
    const conversation = data.conversations[conversationId];
    if (!conversation) return;
    const candidates = conversation.memberIds.filter(
      (id) => id !== data.currentUserId && id !== source.authorId,
    );
    if (candidates.length === 0) return;
    const count = Math.min(2, candidates.length);
    const picked = shuffle(candidates).slice(0, count);
    picked.forEach((authorId, index) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.connected) return;
        void this.deliverAmbientReply(conversationId, source, authorId);
      }, 600 + index * 700);
      this.timers.add(timer);
    });
  }

  private async deliverAmbientReply(
    conversationId: string,
    source: StoredMessage,
    authorId: string,
  ): Promise<void> {
    try {
      const current = this.requireData();
      const conversation = current.conversations[conversationId];
      const author = current.users[authorId];
      if (!conversation || !author || !this.connected) return;

      const body = ambientReply(source.body);
      const reply: StoredMessage = {
        id: `m-${crypto.randomUUID()}`,
        conversationId,
        authorId,
        body,
        createdAt: this.nowIso(),
      };
      current.messages[reply.id] = reply;
      current.updatedAt = reply.createdAt;
      await this.persist();
      this.emit({
        type: "message-created",
        conversationId,
        message: this.hydrateMessage(current, reply),
      });
    } catch (error) {
      this.emit({ type: "error", message: `Background chatter failed: ${errorMessage(error)}` });
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
  "That makes sense. Which part should I pick up first?",
  "I can take that. Do you want it in this pass or after the review?",
  "Nice. I had the same read on it.",
  "Good catch - I will fold that into the next pass. Anything else on your list?",
  "Works for me. Let's keep v0.1 focused and revisit after feedback.",
  "I added it to the checklist. Nothing blocking from my side.",
  "That is clearer. Should the same wording appear in the help overlay?",
  "Agreed. Simplicity wins for the first release.",
  "I tested the narrow layout and it still holds together.",
  "One question: do we want this in the README before launch?",
];

const questionReplies = [
  "Yes, that matches what I see locally. Should we lock it in?",
  "I think so. Should I verify the edge case before we confirm?",
  "Probably - but should we keep the fallback visible just in case?",
  "Good question. Which option would you pick for v0.1?",
  "That is my read too. Can you check the Windows path before we close it?",
  "Almost certainly. What happens if the terminal is narrower than 40 columns?",
];

const ambientMessages = [
  "Quick status: the checklist is nearly clear.",
  "I left two small notes in the design review.",
  "Build is green on my machine. Running the final pass now.",
  "The narrow-terminal layout is holding up better than I expected.",
  "Reminder to take a break before the next review.",
  "I am testing the empty states again this afternoon.",
  "One more pass on the shortcut hints and I think we are done.",
  "Does anyone know if the config example is up to date?",
  "Should we cut a release once the delivery ticks land?",
];

const ambientReplies = [
  "I'll take a look at that later today.",
  "Good point - anything blocking on it?",
  "Sounds right to me. Want me to draft it?",
  "I can pick that up after the current pass.",
  "That matches what I see locally.",
  "Should we add it to the checklist so it isn't forgotten?",
  "I think we're good unless someone objects.",
  "Quick check: does this affect the Windows build too?",
];

function ambientReply(sourceBody: string): string {
  const pool = sourceBody.includes("?") ? ambientReplies : ambientMessages;
  return pool[Math.floor(Math.random() * pool.length)] ?? ambientMessages[0]!;
}

function simulatedReply(sourceBody: string, messageCount: number, authorId: string): string {
  const pool = sourceBody.includes("?") ? questionReplies : simulatedReplies;
  const offset = authorHash(authorId) + messageCount;
  return pool[offset % pool.length] ?? simulatedReplies[0]!;
}

function authorHash(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash;
}

function shuffle<T>(values: T[]): T[] {
  const copy = values.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = temp;
  }
  return copy;
}
