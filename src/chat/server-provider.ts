import type {
  ChatProvider,
  Conversation,
  GetMessagesOptions,
  Message,
  ProviderEvent,
  SearchResult,
  SendMessageInput,
  User,
  WorkspaceInfo,
} from "./types.ts";
import { ChatError } from "./errors.ts";
import { ApiClient, type FetchLike } from "../client/api.ts";

export interface PulsewireProviderOptions {
  baseUrl: string;
  token: string;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Network provider for the self-hosted Pulsewire server.
 *
 * The terminal UI, Windows client, and a future Android client all use the
 * same REST API. Events are polled from the append-only server event log; the
 * polling loop is isolated here so it can be replaced by SSE/WebSocket later
 * without touching the UI.
 */
export class PulsewireProvider implements ChatProvider {
  readonly id = "server";
  readonly label = "Pulsewire";
  readonly demo = false;

  private readonly api: ApiClient;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly deliverySeen = new Map<string, string>();
  private me?: User;
  private connected = false;
  private cursor = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private disposed = false;
  private lastError?: string;
  private conversations = new Map<string, Conversation>();

  constructor(options: PulsewireProviderOptions) {
    this.api = new ApiClient({
      baseUrl: options.baseUrl,
      token: options.token,
      ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
  }

  get currentUser(): User {
    return this.me ?? { id: "", displayName: "You", handle: "you" };
  }

  get baseUrl(): string {
    return this.api.baseUrl;
  }

  async connect(): Promise<WorkspaceInfo> {
    this.me = await this.api.me();
    this.conversations = new Map(
      (await this.api.listConversations()).map((conversation) => [conversation.id, conversation]),
    );
    this.cursor = await this.api.headEvents();
    this.connected = true;
    this.disposed = false;
    this.lastError = undefined;
    this.startPolling();
    return {
      name: "Pulsewire",
      providerId: this.id,
      providerLabel: this.label,
      demo: false,
      currentUser: this.me,
      note: new URL(this.api.baseUrl).host,
    };
  }

  async listConversations(): Promise<Conversation[]> {
    this.requireConnected();
    const conversations = await this.api.listConversations();
    this.conversations = new Map(
      conversations.map((conversation) => [conversation.id, conversation]),
    );
    return conversations;
  }

  async getMessages(
    conversationId: string,
    options: GetMessagesOptions = {},
  ): Promise<Message[]> {
    this.requireConnected();
    const page = await this.api.getMessages(conversationId, {
      limit: options.limit ?? 100,
    });
    this.rememberDelivery(page.messages);
    return page.messages;
  }

  async getThread(messageId: string): Promise<Message[]> {
    this.requireConnected();
    const messages = await this.api.getThread(messageId);
    this.rememberDelivery(messages);
    return messages;
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    this.requireConnected();
    const message = await this.api.sendMessage(
      input.conversationId,
      input.body,
      input.replyToId,
    );
    this.rememberDelivery([message]);
    return message;
  }

  async editMessage(messageId: string, body: string): Promise<Message> {
    this.requireConnected();
    const message = await this.api.editMessage(messageId, body);
    this.rememberDelivery([message]);
    return message;
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.requireConnected();
    await this.api.deleteMessage(messageId);
  }

  async searchMessages(query: string): Promise<SearchResult[]> {
    this.requireConnected();
    return await this.api.search(query);
  }

  async markRead(conversationId: string): Promise<void> {
    this.requireConnected();
    const conversation = await this.api.markRead(conversationId);
    this.conversations.set(conversation.id, conversation);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isThreadingSupported(_conversation: Conversation): boolean {
    return true;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.connected = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    return Promise.resolve();
  }

  private startPolling(): void {
    if (this.disposed || this.timer !== undefined || this.pollIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollOnce().finally(() => {
        if (this.connected && !this.disposed) this.startPolling();
      });
    }, this.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || !this.connected || this.disposed) return;
    this.polling = true;
    try {
      const page = await this.api.getEvents(this.cursor);
      for (const event of page.events) {
        this.cursor = Math.max(this.cursor, event.seq);
        switch (event.type) {
          case "message-created":
          case "message-updated":
            if (event.message) {
              this.rememberDelivery([event.message]);
              this.emit({
                type: event.type,
                conversationId: event.conversationId,
                message: event.message,
              });
            }
            break;
          case "message-deleted":
            if (event.messageId) {
              this.emit({
                type: "message-deleted",
                conversationId: event.conversationId,
                messageId: event.messageId,
              });
            }
            break;
          case "conversation-updated":
            this.emit({ type: "conversation-updated", conversationId: event.conversationId });
            break;
          case "read":
            if (event.actorId && event.actorId !== this.me?.id) {
              await this.refreshDelivery(event.conversationId);
            }
            break;
        }
      }
      this.lastError = undefined;
    } catch (error) {
      const message = error instanceof ChatError
        ? error.message
        : "Pulsewire could not check for new messages.";
      if (message !== this.lastError) {
        this.lastError = message;
        this.emit({ type: "error", message });
      }
    } finally {
      this.polling = false;
    }
  }

  private async refreshDelivery(conversationId: string): Promise<void> {
    const page = await this.api.getMessages(conversationId, { limit: 100 });
    for (const message of page.messages) {
      if (message.author.id !== this.me?.id || !message.delivery) continue;
      const key = `${message.id}:${message.delivery.status}`;
      if (this.deliverySeen.get(message.id) === key) continue;
      this.deliverySeen.set(message.id, key);
      this.emit({
        type: "message-delivery",
        conversationId,
        messageId: message.id,
        delivery: message.delivery,
      });
    }
  }

  private rememberDelivery(messages: Message[]): void {
    for (const message of messages) {
      if (!message.delivery) continue;
      this.deliverySeen.set(message.id, `${message.id}:${message.delivery.status}`);
    }
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop polling.
      }
    }
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new ChatError("not_connected", "Pulsewire is not connected to the server.");
    }
  }
}
