import type {
  ChatProvider,
  Message,
  MessageDelivery,
  ProviderEvent,
  SearchResult,
} from "../chat/types.ts";
import { errorMessage, isChatError } from "../chat/errors.ts";
import { formatDateTime } from "./text.ts";
import {
  buildTimeline,
  computeLayout,
  type FocusArea,
  helpRowCount,
  type Layout,
  renderFrame,
  selectedConversation,
  selectedMessage,
  threadViewportHeight,
  type UiState,
} from "./render.ts";
import { type Key, KeyParser } from "./keys.ts";
import { Terminal } from "./terminal.ts";
import type { Theme } from "./theme.ts";

export interface AppOptions {
  provider: ChatProvider;
  theme: Theme;
  terminal?: Terminal;
  now?: () => Date;
}

/** Build the initial state separately so rendering can be tested without a terminal. */
export function createUiState(provider: ChatProvider): UiState {
  return {
    phase: "loading",
    providerLabel: provider.label,
    demo: provider.demo,
    ai: provider.ai,
    conversations: [],
    conversationIndex: -1,
    messages: [],
    messageIndex: -1,
    messageOffset: 0,
    sidebarOffset: 0,
    focus: "messages",
    composer: "",
    composerCursor: 0,
    spinner: 0,
    clock: new Date(),
    loadingConversation: false,
  };
}

export class PulsewireApp {
  readonly state: UiState;
  private readonly provider: ChatProvider;
  private readonly theme: Theme;
  private readonly terminal: Terminal;
  private readonly now: () => Date;
  private readonly parser = new KeyParser();

  private unsubscribe?: () => void;
  private loadToken = 0;
  private threadToken = 0;
  private searchToken = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private renderQueued = false;
  private lastMinute = -1;
  private loadedConversationId?: string;

  constructor(options: AppOptions) {
    this.provider = options.provider;
    this.theme = options.theme;
    this.terminal = options.terminal ?? new Terminal();
    this.now = options.now ?? (() => new Date());
    this.state = createUiState(options.provider);
    this.state.clock = this.now();
  }

  async run(): Promise<void> {
    this.unsubscribe = this.provider.subscribe((event) => this.onProviderEvent(event));
    this.startTicker();
    void this.connect();

    try {
      await this.terminal.run({
        onInput: (chunk) => this.onInput(chunk),
        onResize: () => this.requestRender(),
      });
    } finally {
      this.stop();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      await this.provider.dispose().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    this.state.phase = "loading";
    this.state.error = undefined;
    this.state.errorHint = undefined;
    this.requestRender();
    try {
      const workspace = await this.provider.connect();
      this.state.workspace = workspace;
      this.state.phase = "ready";
      await this.refreshConversations();
      const first = this.state.conversations[0];
      if (first) {
        this.state.conversationIndex = 0;
        await this.openConversation(first.id, { focusMessages: false });
      }
      this.setToast(
        workspace.note
          ? `Connected to ${workspace.name}. ${workspace.note}.`
          : `Connected to ${workspace.name}.`,
        "success",
      );
    } catch (error) {
      this.state.phase = "error";
      this.state.error = errorMessage(error);
      this.state.errorHint = hintForError(error);
      this.requestRender();
    }
  }

  private async refreshConversations(): Promise<void> {
    const currentId = selectedConversation(this.state)?.id;
    const conversations = await this.provider.listConversations();
    this.state.conversations = conversations;
    if (currentId) {
      const index = conversations.findIndex((conversation) => conversation.id === currentId);
      this.state.conversationIndex = index >= 0 ? index : (conversations.length > 0 ? 0 : -1);
    } else {
      this.state.conversationIndex = conversations.length > 0 ? 0 : -1;
    }
    this.ensureSidebarVisible(computeLayout(this.terminal.size()));
    this.requestRender();
  }

  private async openConversation(
    conversationId: string,
    options: { focusMessages?: boolean; selectMessageId?: string } = {},
  ): Promise<void> {
    const conversation = this.state.conversations.find((candidate) =>
      candidate.id === conversationId
    );
    if (!conversation) return;
    this.state.conversationIndex = this.state.conversations.indexOf(conversation);
    this.ensureSidebarVisible(computeLayout(this.terminal.size()));

    if (this.loadedConversationId === conversationId && this.state.messages.length > 0) {
      if (options.selectMessageId) {
        const index = this.state.messages.findIndex((message) =>
          message.id === options.selectMessageId
        );
        if (index >= 0) this.state.messageIndex = index;
      }
      if (options.focusMessages) this.state.focus = "messages";
      this.markCurrentRead(conversationId);
      this.requestRender();
      return;
    }

    const token = ++this.loadToken;
    this.state.loadingConversation = true;
    this.state.messages = [];
    this.state.messageIndex = -1;
    this.state.messageOffset = 0;
    this.state.typing = undefined;
    if (options.focusMessages) this.state.focus = "messages";
    this.requestRender();

    try {
      const messages = await this.provider.getMessages(conversationId);
      if (token !== this.loadToken) return;
      this.loadedConversationId = conversationId;
      this.state.messages = messages;
      const selectedIndex = options.selectMessageId
        ? messages.findIndex((message) => message.id === options.selectMessageId)
        : -1;
      this.state.messageIndex = selectedIndex >= 0 ? selectedIndex : messages.length - 1;
      this.state.loadingConversation = false;
      this.state.messageOffset = Math.max(0, messages.length - 1);
      this.markCurrentRead(conversationId);
      this.requestRender();
    } catch (error) {
      if (token !== this.loadToken) return;
      this.state.loadingConversation = false;
      this.setToast(errorMessage(error), "error");
      this.requestRender();
    }
  }

  private markCurrentRead(conversationId: string): void {
    const conversation = this.state.conversations.find((candidate) =>
      candidate.id === conversationId
    );
    if (conversation) conversation.unreadCount = 0;
    void this.provider.markRead(conversationId).catch(() => undefined);
  }

  private onInput(chunk: string): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const keys = this.parser.push(chunk);
    for (const key of keys) {
      this.handleKey(key);
      if (!this.isRunning()) return;
    }
    if (this.parser.hasPendingEscape()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        for (const key of this.parser.flushPendingEscape()) {
          this.handleKey(key);
          if (!this.isRunning()) return;
        }
      }, 25);
    }
  }

  private handleKey(key: Key): void {
    this.state.clock = this.now();

    if (key.type === "ctrl" && key.key === "c") {
      this.quit();
      return;
    }
    if (key.type === "f" && key.number === 1) {
      this.toggleHelp();
      return;
    }

    if (this.state.overlay) {
      this.handleOverlayKey(key);
      return;
    }

    if (this.state.phase === "loading") {
      if (isQuitKey(key)) this.quit();
      return;
    }
    if (this.state.phase === "error") {
      if (isQuitKey(key)) this.quit();
      return;
    }

    if (isHelpKey(key)) {
      this.toggleHelp();
      return;
    }
    if (key.type === "ctrl" && key.key === "f") {
      this.openSearch();
      return;
    }
    if (key.type === "tab") {
      this.cycleFocus(key.shift ? -1 : 1);
      return;
    }
    if (key.type === "ctrl" && (key.key === "n" || key.key === "p")) {
      this.moveConversation(key.key === "n" ? 1 : -1);
      return;
    }
    if (
      key.type === "text" && (key.text === "[" || key.text === "]") &&
      this.state.focus !== "composer"
    ) {
      this.moveConversation(key.text === "]" ? 1 : -1);
      return;
    }
    if (key.type === "text" && (key.text === "s" || key.text === "/") && !this.isComposing()) {
      this.openSearch();
      return;
    }
    if (key.type === "text" && key.text === "q" && !this.isComposing()) {
      this.quit();
      return;
    }

    switch (this.state.focus) {
      case "sidebar":
        this.handleSidebarKey(key);
        break;
      case "messages":
        this.handleMessageKey(key);
        break;
      case "composer":
        this.handleComposerKey(key);
        break;
    }
  }

  private handleSidebarKey(key: Key): void {
    switch (key.type) {
      case "arrow":
        if (key.direction === "up") this.moveConversation(-1);
        if (key.direction === "down") this.moveConversation(1);
        return;
      case "pageup":
        this.moveConversation(-this.pageSize());
        return;
      case "pagedown":
        this.moveConversation(this.pageSize());
        return;
      case "home":
        this.selectConversation(0);
        return;
      case "end":
        this.selectConversation(this.state.conversations.length - 1);
        return;
      case "enter":
        if (selectedConversation(this.state)) {
          this.state.focus = "messages";
          this.requestRender();
        }
        return;
      case "escape":
        return;
      default:
        if (isTypedText(key)) {
          this.state.focus = "composer";
          this.insertText(key.text);
        }
    }
  }

  private handleMessageKey(key: Key): void {
    const last = this.state.messages.length - 1;
    switch (key.type) {
      case "arrow":
        if (key.direction === "up") this.moveMessage(-1);
        if (key.direction === "down") this.moveMessage(1);
        return;
      case "pageup":
        this.moveMessage(-this.pageSize());
        return;
      case "pagedown":
        this.moveMessage(this.pageSize());
        return;
      case "home":
        this.moveMessage(-this.state.messages.length);
        return;
      case "end":
        this.moveMessage(this.state.messages.length);
        return;
      case "enter":
        this.focusComposer();
        return;
      case "escape":
        this.state.focus = "sidebar";
        this.requestRender();
        return;
      case "text":
        if (key.text === "g") {
          this.selectMessage(0);
          return;
        }
        if (key.text === "G") {
          this.selectMessage(last);
          return;
        }
        if (key.text === "r") {
          this.startReply();
          return;
        }
        if (key.text === "t") {
          void this.openThreadForSelected();
          return;
        }
        if (key.text === "e") {
          this.startEdit();
          return;
        }
        if (key.text === "d") {
          this.confirmDelete();
          return;
        }
        if (key.text === "u") {
          this.retrySelectedFailed();
          return;
        }
        if (key.text === "i") {
          this.focusComposer();
          return;
        }
        if (isTypedText(key)) {
          this.state.focus = "composer";
          this.insertText(key.text);
        }
    }
  }

  private handleComposerKey(key: Key): void {
    switch (key.type) {
      case "text":
        this.insertText(key.text);
        return;
      case "paste":
        this.insertText(key.text.replace(/\r\n?/g, " ").replace(/\n/g, " ").replace(/\t/g, " "));
        return;
      case "enter":
        void this.submitComposer();
        return;
      case "escape":
        if (this.state.editing || this.state.replyTo) {
          this.state.editing = undefined;
          this.state.replyTo = undefined;
          this.state.composer = "";
          this.state.composerCursor = 0;
          this.setToast("Cancelled.", "info");
        } else {
          this.state.focus = "messages";
        }
        this.requestRender();
        return;
      case "backspace":
        this.deleteBeforeCursor();
        return;
      case "delete":
        this.deleteAtCursor();
        return;
      case "arrow":
        if (key.direction === "left") this.moveComposerCursor(-1);
        if (key.direction === "right") this.moveComposerCursor(1);
        return;
      case "home":
        this.state.composerCursor = 0;
        this.requestRender();
        return;
      case "end":
        this.state.composerCursor = Array.from(this.state.composer).length;
        this.requestRender();
        return;
      case "ctrl":
        if (key.key === "a") this.state.composerCursor = 0;
        else if (key.key === "e") {
          this.state.composerCursor = Array.from(this.state.composer).length;
        } else if (key.key === "u") this.clearComposer();
        else if (key.key === "k") this.killToEnd();
        else if (key.key === "w") this.deleteWordBefore();
        this.requestRender();
        return;
    }
  }

  private handleOverlayKey(key: Key): void {
    const overlay = this.state.overlay;
    if (!overlay) return;

    if (key.type === "escape") {
      this.closeOverlay();
      return;
    }

    switch (overlay.kind) {
      case "help":
        if (key.type === "arrow" && key.direction === "up") overlay.offset--;
        else if (key.type === "arrow" && key.direction === "down") overlay.offset++;
        else if (key.type === "pageup") overlay.offset -= 8;
        else if (key.type === "pagedown") overlay.offset += 8;
        else if (
          key.type === "text" && (key.text === "?" || key.text === "q" || key.text === "H")
        ) {
          this.closeOverlay();
          return;
        } else if (key.type === "enter") {
          this.closeOverlay();
          return;
        }
        this.clampHelpOffset();
        this.requestRender();
        return;

      case "search":
        this.handleSearchKey(key);
        return;

      case "thread":
        this.handleThreadKey(key);
        return;

      case "confirm-delete":
        if (key.type === "text" && (key.text === "y" || key.text === "Y")) {
          void this.deleteConfirmed(overlay.message);
        } else if (
          key.type === "text" && (key.text === "n" || key.text === "N" || key.text === "q")
        ) {
          this.closeOverlay();
        }
        return;
    }
  }

  private handleSearchKey(key: Key): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;

    if (key.type === "text") {
      this.insertSearchText(key.text);
      return;
    }
    if (key.type === "paste") {
      this.insertSearchText(key.text.replace(/\s+/g, " "));
      return;
    }
    switch (key.type) {
      case "backspace":
        this.deleteSearchBefore();
        return;
      case "delete":
        this.deleteSearchAt();
        return;
      case "arrow":
        if (key.direction === "left") this.moveSearchCursor(-1);
        if (key.direction === "right") this.moveSearchCursor(1);
        if (key.direction === "up") this.moveSearchResult(-1);
        if (key.direction === "down") this.moveSearchResult(1);
        return;
      case "home":
        search.cursor = 0;
        this.requestRender();
        return;
      case "end":
        search.cursor = Array.from(search.query).length;
        this.requestRender();
        return;
      case "pageup":
        this.moveSearchResult(-6);
        return;
      case "pagedown":
        this.moveSearchResult(6);
        return;
      case "enter": {
        const result = search.results[search.index];
        if (result) void this.jumpToResult(result);
        return;
      }
      case "ctrl":
        if (key.key === "u") {
          search.query = "";
          search.cursor = 0;
          this.scheduleSearch();
        } else if (key.key === "w") {
          this.deleteSearchWord();
        }
        return;
    }
  }

  private handleThreadKey(key: Key): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "thread") return;
    const thread = overlay.state;
    const last = thread.messages.length - 1;
    const view = Math.max(1, threadViewportHeight(computeLayout(this.terminal.size())));

    switch (key.type) {
      case "arrow":
        if (key.direction === "up") thread.index = clamp(thread.index - 1, 0, last);
        if (key.direction === "down") thread.index = clamp(thread.index + 1, 0, last);
        break;
      case "pageup":
        thread.index = clamp(thread.index - view, 0, last);
        break;
      case "pagedown":
        thread.index = clamp(thread.index + view, 0, last);
        break;
      case "home":
        thread.index = 0;
        break;
      case "end":
        thread.index = last;
        break;
      case "text":
        if (key.text === "r") {
          const message = thread.messages[thread.index];
          if (message) {
            this.state.replyTo = message;
            this.state.editing = undefined;
            this.closeOverlay();
            this.state.focus = "composer";
            this.requestRender();
          }
          return;
        }
        break;
      case "enter":
        this.closeOverlay();
        return;
    }
    this.ensureThreadVisible(thread, view);
    this.requestRender();
  }

  private cycleFocus(direction: number): void {
    const order: FocusArea[] = ["sidebar", "messages", "composer"];
    const index = order.indexOf(this.state.focus);
    const next = order[(index + direction + order.length) % order.length] ?? "messages";
    this.state.focus = next;
    this.requestRender();
  }

  private moveConversation(delta: number): void {
    if (this.state.conversations.length === 0) return;
    this.selectConversation(this.state.conversationIndex + delta);
  }

  private selectConversation(index: number): void {
    if (this.state.conversations.length === 0) return;
    const clamped = clamp(index, 0, this.state.conversations.length - 1);
    if (clamped === this.state.conversationIndex && this.loadedConversationId) {
      this.requestRender();
      return;
    }
    this.state.conversationIndex = clamped;
    const conversation = this.state.conversations[clamped];
    if (!conversation) return;
    this.ensureSidebarVisible(computeLayout(this.terminal.size()));
    void this.openConversation(conversation.id, { focusMessages: false });
  }

  private moveMessage(delta: number): void {
    if (this.state.messages.length === 0) return;
    this.selectMessage(this.state.messageIndex + delta);
  }

  private selectMessage(index: number): void {
    if (this.state.messages.length === 0) return;
    this.state.messageIndex = clamp(index, 0, this.state.messages.length - 1);
    this.requestRender();
  }

  private pageSize(): number {
    return Math.max(1, computeLayout(this.terminal.size()).bodyContentHeight);
  }

  private focusComposer(): void {
    this.state.focus = "composer";
    this.requestRender();
  }

  private startReply(): void {
    const message = selectedMessage(this.state);
    const conversation = selectedConversation(this.state);
    if (!message || !conversation) return;
    if (message.deletedAt) {
      this.setToast("You cannot reply to a deleted message.", "error");
      return;
    }
    if (!this.provider.isThreadingSupported(conversation)) {
      this.setToast("Threads are available only in Google Chat spaces.", "info");
      return;
    }
    this.state.replyTo = message;
    this.state.editing = undefined;
    this.state.focus = "composer";
    this.requestRender();
  }

  private startEdit(): void {
    const message = selectedMessage(this.state);
    if (!message) return;
    if (message.deletedAt) {
      this.setToast("Deleted messages cannot be edited.", "error");
      return;
    }
    if (message.author.id !== this.state.workspace?.currentUser.id) {
      this.setToast("You can only edit your own messages.", "error");
      return;
    }
    this.state.editing = message;
    this.state.replyTo = undefined;
    this.state.composer = message.body;
    this.state.composerCursor = Array.from(message.body).length;
    this.state.focus = "composer";
    this.requestRender();
  }

  private confirmDelete(): void {
    const message = selectedMessage(this.state);
    if (!message) return;
    if (message.deletedAt) {
      this.setToast("That message is already deleted.", "info");
      return;
    }
    if (message.author.id !== this.state.workspace?.currentUser.id) {
      this.setToast("You can only delete your own messages.", "error");
      return;
    }
    this.state.overlay = { kind: "confirm-delete", message };
    this.requestRender();
  }

  private async deleteConfirmed(message: Message): Promise<void> {
    try {
      await this.provider.deleteMessage(message.id);
      this.applyDeleted(message.conversationId, message.id);
      this.closeOverlay();
      this.setToast("Message deleted.", "success");
    } catch (error) {
      this.closeOverlay();
      this.setToast(errorMessage(error), "error");
    }
  }

  private async submitComposer(): Promise<void> {
    const conversation = selectedConversation(this.state);
    if (!conversation) return;
    const body = this.state.composer.trim();
    if (!body) {
      this.setToast("Write something before sending.", "info");
      return;
    }

    const editing = this.state.editing;
    const replyTo = this.state.replyTo;
    this.state.status = editing ? "Saving changes…" : "Sending…";
    this.requestRender();

    if (editing) {
      try {
        const message = await this.provider.editMessage(editing.id, body);
        this.applySavedMessage(message, "updated");
        this.state.composer = "";
        this.state.composerCursor = 0;
        this.state.editing = undefined;
        this.state.replyTo = undefined;
        this.setToast("Message updated.", "success");
        void this.refreshConversationsSilently();
      } catch (error) {
        this.setToast(errorMessage(error), "error");
      } finally {
        this.state.status = undefined;
        this.requestRender();
      }
      return;
    }

    const optimistic = this.createOptimisticMessage(
      conversation.id,
      body,
      replyTo?.id,
    );
    this.appendLocalMessage(optimistic);
    this.state.composer = "";
    this.state.composerCursor = 0;
    this.state.replyTo = undefined;
    this.requestRender();
    await this.deliverOptimistic(optimistic);
  }

  private createOptimisticMessage(
    conversationId: string,
    body: string,
    replyToId?: string,
  ): Message {
    const author = this.state.workspace?.currentUser ?? {
      id: "u-self",
      displayName: "You",
      handle: "you",
    };
    return {
      id: `local-${crypto.randomUUID()}`,
      conversationId,
      author,
      body,
      createdAt: this.now().toISOString(),
      delivery: { status: "pending" },
      ...(replyToId ? { replyToId } : {}),
    };
  }

  private appendLocalMessage(message: Message): void {
    this.state.messages.push(message);
    this.state.messageIndex = this.state.messages.length - 1;
    this.requestRender();
  }

  private removeLocalMessage(messageId: string): boolean {
    const index = this.state.messages.findIndex((candidate) => candidate.id === messageId);
    if (index < 0) return false;
    this.state.messages.splice(index, 1);
    if (this.state.messageIndex >= index) {
      this.state.messageIndex = Math.max(0, this.state.messageIndex - 1);
    }
    return true;
  }

  private async deliverOptimistic(optimistic: Message): Promise<void> {
    this.state.status = "Sending…";
    this.requestRender();
    try {
      const message = await this.provider.sendMessage({
        conversationId: optimistic.conversationId,
        body: optimistic.body,
        ...(optimistic.replyToId ? { replyToId: optimistic.replyToId } : {}),
      });
      this.removeLocalMessage(optimistic.id);
      this.applySavedMessage(message, "created");
      this.setToast("Message sent.", "success");
      void this.refreshConversationsSilently();
    } catch (error) {
      optimistic.delivery = { status: "failed", error: errorMessage(error) };
      this.setToast(
        `Message not sent: ${errorMessage(error)} Select it and press u to retry.`,
        "error",
      );
    } finally {
      this.state.status = undefined;
      this.requestRender();
    }
  }

  private retrySelectedFailed(): void {
    const message = selectedMessage(this.state);
    if (!message || !message.id.startsWith("local-") || message.delivery?.status !== "failed") {
      return;
    }
    message.delivery = { status: "pending" };
    this.requestRender();
    void this.deliverOptimistic(message);
  }

  private async refreshConversationsSilently(): Promise<void> {
    try {
      await this.refreshConversations();
    } catch {
      // Provider events keep the visible state usable; polling will retry.
    }
  }

  private applySavedMessage(message: Message, mode: "created" | "updated"): void {
    const current = selectedConversation(this.state);
    if (current && message.conversationId === current.id) {
      const index = this.state.messages.findIndex((candidate) => candidate.id === message.id);
      if (index >= 0) {
        this.state.messages[index] = message;
      } else {
        this.state.messages.push(message);
        this.state.messageIndex = this.state.messages.length - 1;
      }
      current.unreadCount = 0;
    }
    if (mode === "created") {
      this.touchConversation(
        message.conversationId,
        message.deletedAt ? "Message deleted" : preview(message.body),
        message.createdAt,
      );
    } else {
      this.updatePreviewIfLatest(message);
    }
    this.requestRender();
  }

  private touchConversation(conversationId: string, previewText: string, at: string): void {
    const conversation = this.state.conversations.find((candidate) =>
      candidate.id === conversationId
    );
    if (conversation) {
      conversation.lastMessagePreview = previewText;
      conversation.lastActivityAt = at;
      conversation.lastMessageAt = at;
    }
    this.sortConversations();
  }

  private sortConversations(): void {
    const currentId = selectedConversation(this.state)?.id;
    this.state.conversations.sort((a, b) =>
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
    );
    if (currentId) {
      const index = this.state.conversations.findIndex((candidate) => candidate.id === currentId);
      if (index >= 0) this.state.conversationIndex = index;
    }
  }

  private applyReceived(conversationId: string, message: Message): void {
    if (this.state.phase !== "ready") return;
    if (message.author.id === this.state.workspace?.currentUser.id) {
      this.reconcileLocalEcho(message);
    }
    const current = selectedConversation(this.state);
    const isCurrent = current?.id === conversationId;
    if (isCurrent) {
      const exists = this.state.messages.some((candidate) => candidate.id === message.id);
      const follow = this.state.messageIndex >= this.state.messages.length - 1;
      if (!exists) this.state.messages.push(message);
      if (!exists && follow) this.state.messageIndex = this.state.messages.length - 1;
      current.unreadCount = 0;
      if (message.author.id !== this.state.workspace?.currentUser.id) {
        this.markCurrentRead(conversationId);
      }
    } else {
      const conversation = this.state.conversations.find((candidate) =>
        candidate.id === conversationId
      );
      if (
        conversation && message.author.id !== this.state.workspace?.currentUser.id
      ) {
        conversation.unreadCount += 1;
      }
    }
    this.touchConversation(
      conversationId,
      message.deletedAt ? "Message deleted" : preview(message.body),
      message.createdAt,
    );
    this.requestRender();
  }

  private reconcileLocalEcho(message: Message): void {
    const index = this.state.messages.findIndex((candidate) =>
      candidate.id.startsWith("local-") &&
      candidate.conversationId === message.conversationId &&
      candidate.body === message.body &&
      candidate.replyToId === message.replyToId &&
      (candidate.delivery?.status === "pending" || candidate.delivery?.status === "failed")
    );
    if (index < 0) return;
    this.state.messages.splice(index, 1);
    if (this.state.messageIndex >= index) {
      this.state.messageIndex = Math.max(0, this.state.messageIndex - 1);
    }
  }

  private applyUpdated(conversationId: string, message: Message): void {
    if (this.state.phase !== "ready") return;
    if (selectedConversation(this.state)?.id === conversationId) {
      const index = this.state.messages.findIndex((candidate) => candidate.id === message.id);
      if (index >= 0) this.state.messages[index] = message;
    }
    this.updatePreviewIfLatest(message);
    this.requestRender();
  }

  private updatePreviewIfLatest(message: Message): void {
    const conversation = this.state.conversations.find((candidate) =>
      candidate.id === message.conversationId
    );
    if (!conversation) return;
    if (conversation.lastMessageAt === message.createdAt) {
      conversation.lastMessagePreview = message.deletedAt
        ? "Message deleted"
        : preview(message.body);
    }
  }

  private applyDeleted(conversationId: string, messageId: string): void {
    if (this.state.phase !== "ready") return;
    const message = this.state.messages.find((candidate) => candidate.id === messageId);
    if (message) {
      message.deletedAt = this.now().toISOString();
      message.body = "";
    }
    const conversation = this.state.conversations.find((candidate) =>
      candidate.id === conversationId
    );
    if (conversation && message && conversation.lastMessageAt === message.createdAt) {
      conversation.lastMessagePreview = "Message deleted";
    }
    if (this.state.overlay?.kind === "thread") {
      const threadMessage = this.state.overlay.state.messages.find((candidate) =>
        candidate.id === messageId
      );
      if (threadMessage) {
        threadMessage.deletedAt = this.now().toISOString();
        threadMessage.body = "";
      }
    }
    this.requestRender();
  }

  private applyDelivery(messageId: string, delivery: MessageDelivery): void {
    if (this.state.phase !== "ready") return;
    const message = this.state.messages.find((candidate) => candidate.id === messageId);
    if (message) message.delivery = delivery;
    if (this.state.overlay?.kind === "thread") {
      const threadMessage = this.state.overlay.state.messages.find((candidate) =>
        candidate.id === messageId
      );
      if (threadMessage) threadMessage.delivery = delivery;
    }
    this.requestRender();
  }

  private onProviderEvent(event: ProviderEvent): void {
    switch (event.type) {
      case "message-created":
        this.applyReceived(event.conversationId, event.message);
        break;
      case "message-updated":
        this.applyUpdated(event.conversationId, event.message);
        break;
      case "message-deleted":
        this.applyDeleted(event.conversationId, event.messageId);
        break;
      case "message-delivery":
        this.applyDelivery(event.messageId, event.delivery);
        break;
      case "typing":
        this.state.typing = event.active ? event.user : undefined;
        this.requestRender();
        break;
      case "error":
        this.setToast(event.message, "error");
        break;
    }
  }

  private openSearch(): void {
    this.state.overlay = {
      kind: "search",
      state: { query: "", cursor: 0, results: [], index: 0, loading: false },
    };
    this.requestRender();
  }

  private insertSearchText(text: string): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    const chars = Array.from(search.query);
    chars.splice(search.cursor, 0, ...Array.from(text));
    search.query = chars.join("");
    search.cursor += Array.from(text).length;
    search.index = 0;
    this.scheduleSearch();
  }

  private deleteSearchBefore(): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    if (search.cursor === 0) return;
    const chars = Array.from(search.query);
    chars.splice(search.cursor - 1, 1);
    search.query = chars.join("");
    search.cursor--;
    search.index = 0;
    this.scheduleSearch();
  }

  private deleteSearchAt(): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    const chars = Array.from(search.query);
    if (search.cursor >= chars.length) return;
    chars.splice(search.cursor, 1);
    search.query = chars.join("");
    search.index = 0;
    this.scheduleSearch();
  }

  private moveSearchCursor(delta: number): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    search.cursor = clamp(search.cursor + delta, 0, Array.from(search.query).length);
    this.requestRender();
  }

  private deleteSearchWord(): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    const chars = Array.from(search.query);
    let index = search.cursor;
    while (index > 0 && /\s/.test(chars[index - 1] ?? "")) index--;
    while (index > 0 && !/\s/.test(chars[index - 1] ?? "")) index--;
    chars.splice(index, search.cursor - index);
    search.query = chars.join("");
    search.cursor = index;
    this.scheduleSearch();
  }

  private moveSearchResult(delta: number): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    if (search.results.length === 0) return;
    search.index = clamp(search.index + delta, 0, search.results.length - 1);
    this.requestRender();
  }

  private scheduleSearch(): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "search") return;
    const search = overlay.state;
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    const token = ++this.searchToken;
    const query = search.query.trim();
    if (!query) {
      search.results = [];
      search.loading = false;
      search.error = undefined;
      search.index = 0;
      this.requestRender();
      return;
    }
    search.loading = true;
    search.error = undefined;
    this.requestRender();
    this.searchTimer = setTimeout(async () => {
      this.searchTimer = undefined;
      try {
        const results = await this.provider.searchMessages(query);
        if (token !== this.searchToken || this.state.overlay?.kind !== "search") return;
        const current = this.state.overlay.state;
        current.results = results;
        current.index = 0;
      } catch (error) {
        if (token !== this.searchToken || this.state.overlay?.kind !== "search") return;
        const current = this.state.overlay.state;
        current.results = [];
        current.error = errorMessage(error);
      } finally {
        if (token === this.searchToken && this.state.overlay?.kind === "search") {
          this.state.overlay.state.loading = false;
          this.requestRender();
        }
      }
    }, 160);
  }

  private async jumpToResult(result: SearchResult): Promise<void> {
    this.state.overlay = undefined;
    const conversation = this.state.conversations.find((candidate) =>
      candidate.id === result.conversation.id
    );
    if (!conversation) {
      this.setToast("That conversation is no longer available.", "error");
      return;
    }
    await this.openConversation(conversation.id, {
      focusMessages: true,
      selectMessageId: result.message.id,
    });
    const message = this.state.messages.find((candidate) => candidate.id === result.message.id);
    if (message?.replyToId) await this.openThread(message);
    this.requestRender();
  }

  private async openThreadForSelected(): Promise<void> {
    const message = selectedMessage(this.state);
    if (!message) return;
    await this.openThread(message);
  }

  private async openThread(message: Message): Promise<void> {
    const token = ++this.threadToken;
    this.state.overlay = {
      kind: "thread",
      state: {
        rootId: message.id,
        title: `${message.author.displayName} · ${formatDateTime(message.createdAt)}`,
        messages: [],
        index: 0,
        offset: 0,
        loading: true,
      },
    };
    this.requestRender();
    try {
      const messages = await this.provider.getThread(message.id);
      if (token !== this.threadToken || this.state.overlay?.kind !== "thread") return;
      const thread = this.state.overlay.state;
      thread.messages = messages;
      const index = messages.findIndex((candidate) => candidate.id === message.id);
      thread.index = index >= 0 ? index : 0;
      thread.loading = false;
      this.ensureThreadVisible(thread, threadViewportHeight(computeLayout(this.terminal.size())));
      this.requestRender();
    } catch (error) {
      if (token !== this.threadToken || this.state.overlay?.kind !== "thread") return;
      const thread = this.state.overlay.state;
      thread.loading = false;
      thread.error = errorMessage(error);
      this.requestRender();
    }
  }

  private isComposing(): boolean {
    return this.state.focus === "composer";
  }

  private insertText(text: string): void {
    const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (!cleaned) return;
    const chars = Array.from(this.state.composer);
    const added = Array.from(cleaned);
    if (chars.length + added.length > 4_000) {
      this.setToast("Message is limited to 4,000 characters.", "error");
      return;
    }
    chars.splice(this.state.composerCursor, 0, ...added);
    this.state.composer = chars.join("");
    this.state.composerCursor += added.length;
    this.requestRender();
  }

  private deleteBeforeCursor(): void {
    if (this.state.composerCursor === 0) return;
    const chars = Array.from(this.state.composer);
    chars.splice(this.state.composerCursor - 1, 1);
    this.state.composer = chars.join("");
    this.state.composerCursor--;
    this.requestRender();
  }

  private deleteAtCursor(): void {
    const chars = Array.from(this.state.composer);
    if (this.state.composerCursor >= chars.length) return;
    chars.splice(this.state.composerCursor, 1);
    this.state.composer = chars.join("");
    this.requestRender();
  }

  private moveComposerCursor(delta: number): void {
    this.state.composerCursor = clamp(
      this.state.composerCursor + delta,
      0,
      Array.from(this.state.composer).length,
    );
    this.requestRender();
  }

  private clearComposer(): void {
    this.state.composer = this.state.composer.slice(this.state.composerCursor);
    this.state.composerCursor = 0;
  }

  private killToEnd(): void {
    const chars = Array.from(this.state.composer);
    chars.splice(this.state.composerCursor);
    this.state.composer = chars.join("");
  }

  private deleteWordBefore(): void {
    const chars = Array.from(this.state.composer);
    let index = this.state.composerCursor;
    while (index > 0 && /\s/.test(chars[index - 1] ?? "")) index--;
    while (index > 0 && !/\s/.test(chars[index - 1] ?? "")) index--;
    chars.splice(index, this.state.composerCursor - index);
    this.state.composer = chars.join("");
    this.state.composerCursor = index;
  }

  private toggleHelp(): void {
    if (this.state.overlay?.kind === "help") {
      this.closeOverlay();
      return;
    }
    this.state.overlay = { kind: "help", offset: 0 };
    this.requestRender();
  }

  private closeOverlay(): void {
    this.state.overlay = undefined;
    this.threadToken++;
    this.searchToken++;
    if (this.searchTimer !== undefined) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
    this.requestRender();
  }

  private clampHelpOffset(): void {
    const overlay = this.state.overlay;
    if (!overlay || overlay.kind !== "help") return;
    const viewport = this.terminal.size();
    const layout = computeLayout(viewport);
    const rows = helpRowCount(layout.mainContentWidth);
    const max = Math.max(0, rows - layout.bodyContentHeight);
    overlay.offset = clamp(overlay.offset, 0, max);
  }

  private ensureSidebarVisible(layout: Layout): void {
    if (!layout.wide) return;
    const content = layout.bodyContentHeight;
    if (this.state.conversationIndex < 0) return;
    if (this.state.conversationIndex < this.state.sidebarOffset) {
      this.state.sidebarOffset = this.state.conversationIndex;
    } else if (this.state.conversationIndex >= this.state.sidebarOffset + content) {
      this.state.sidebarOffset = this.state.conversationIndex - content + 1;
    }
    this.state.sidebarOffset = clamp(
      this.state.sidebarOffset,
      0,
      Math.max(0, this.state.conversations.length - content),
    );
  }

  private ensureMessagesVisible(layout: Layout): void {
    if (this.state.messages.length === 0) {
      this.state.messageOffset = 0;
      return;
    }
    const timeline = buildTimeline(
      this.state.messages,
      layout.mainContentWidth,
      this.theme,
      this.state.clock,
      this.timelineOptions(),
    );
    const selectedId = selectedMessage(this.state)?.id;
    let start = -1;
    let end = -1;
    if (selectedId) {
      for (let index = 0; index < timeline.length; index++) {
        if (timeline[index]?.messageId === selectedId) {
          if (start < 0) start = index;
          end = index;
        }
      }
    }
    const view = Math.max(1, layout.bodyContentHeight);
    if (start >= 0) {
      if (start < this.state.messageOffset) this.state.messageOffset = start;
      if (end >= this.state.messageOffset + view) this.state.messageOffset = end - view + 1;
    }
    this.state.messageOffset = clamp(
      this.state.messageOffset,
      0,
      Math.max(0, timeline.length - view),
    );
  }

  private ensureThreadVisible(
    thread: { messages: Message[]; index: number; offset: number },
    view: number,
  ): void {
    if (thread.messages.length === 0) {
      thread.offset = 0;
      return;
    }
    const layout = computeLayout(this.terminal.size());
    const timeline = buildTimeline(
      thread.messages,
      layout.mainContentWidth,
      this.theme,
      this.state.clock,
      this.timelineOptions(),
    );
    const selectedId = thread.messages[thread.index]?.id;
    let start = -1;
    let end = -1;
    if (selectedId) {
      for (let index = 0; index < timeline.length; index++) {
        if (timeline[index]?.messageId === selectedId) {
          if (start < 0) start = index;
          end = index;
        }
      }
    }
    if (start >= 0) {
      if (start < thread.offset) thread.offset = start;
      if (end >= thread.offset + view) thread.offset = end - view + 1;
    }
    thread.offset = clamp(thread.offset, 0, Math.max(0, timeline.length - view));
  }

  private timelineOptions(): { ownUserId?: string } {
    const ownUserId = this.state.workspace?.currentUser.id;
    return ownUserId ? { ownUserId } : {};
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const viewport = this.terminal.size();
    const layout = computeLayout(viewport);
    this.ensureSidebarVisible(layout);
    this.ensureMessagesVisible(layout);
    if (this.state.overlay?.kind === "thread") {
      this.ensureThreadVisible(
        this.state.overlay.state,
        threadViewportHeight(layout),
      );
    }
    const frame = renderFrame(this.state, viewport, this.theme);
    this.terminal.draw(frame);
  }

  private startTicker(): void {
    this.lastMinute = this.now().getMinutes();
    this.ticker = setInterval(() => {
      const now = this.now();
      this.state.clock = now;
      const minute = now.getMinutes();
      const busy = this.state.phase === "loading" ||
        this.state.loadingConversation ||
        this.state.overlay?.kind === "thread" && this.state.overlay.state.loading ||
        this.state.overlay?.kind === "search" && this.state.overlay.state.loading ||
        this.state.typing !== undefined;
      if (busy) this.state.spinner++;
      if (busy || minute !== this.lastMinute) {
        this.lastMinute = minute;
        this.requestRender();
      }
    }, busyInterval());
  }

  private setToast(text: string, tone: "info" | "success" | "error"): void {
    this.state.toast = { text, tone };
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = undefined;
      this.state.toast = undefined;
      this.requestRender();
    }, 4_000);
    this.requestRender();
  }

  private quit(): void {
    this.stop();
    this.terminal.stop();
  }

  private stop(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.toastTimer = undefined;
  }

  private isRunning(): boolean {
    return this.ticker !== undefined;
  }
}

function busyInterval(): number {
  return 140;
}

function isTypedText(key: Key): key is { type: "text"; text: string } {
  return key.type === "text" && key.text.length > 0 && !/[\u0000-\u001f\u007f]/.test(key.text);
}

function isHelpKey(key: Key): boolean {
  return (key.type === "text" && key.text === "?") || (key.type === "f" && key.number === 1);
}

function isQuitKey(key: Key): boolean {
  return (key.type === "text" && (key.text === "q" || key.text === "Q")) ||
    key.type === "escape";
}

function hintForError(error: unknown): string {
  if (isChatError(error)) {
    switch (error.code) {
      case "auth_required":
        return "Run `pulsewire auth google` to sign in, then start Pulsewire again.";
      case "network_error":
        return "Check your network connection and proxy settings, then try again.";
      case "rate_limited":
        return "Google Chat is rate limiting requests. Wait a moment and restart.";
      case "forbidden":
        return "Check that the Chat API is enabled and your OAuth scopes include Google Chat access.";
      default:
        return "See README.md for setup details.";
    }
  }
  return "See README.md for setup details.";
}

function preview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (!collapsed) return "No messages yet";
  return collapsed.length > 120 ? `${collapsed.slice(0, 119).trimEnd()}…` : collapsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
