import { seedDemoData } from "../src/chat/demo-data.ts";
import type { Conversation, Message, User, WorkspaceInfo } from "../src/chat/types.ts";
import type { UiState } from "../src/ui/render.ts";

export const FIXED_NOW = new Date("2026-11-03T12:00:00.000Z");

export function demoFixture(now: Date = FIXED_NOW): {
  workspace: WorkspaceInfo;
  conversations: Conversation[];
  messages: Map<string, Message[]>;
} {
  const data = seedDemoData({ displayName: "Alex Rivera", now });
  const user = (id: string): User => {
    const stored = data.users[id];
    if (!stored) throw new Error(`Missing fixture user ${id}`);
    return { id: stored.id, displayName: stored.displayName, handle: stored.handle };
  };

  const messages = new Map<string, Message[]>();
  for (const stored of Object.values(data.messages)) {
    const list = messages.get(stored.conversationId) ?? [];
    const message: Message = {
      id: stored.id,
      conversationId: stored.conversationId,
      author: user(stored.authorId),
      body: stored.body,
      createdAt: stored.createdAt,
    };
    if (stored.editedAt) message.editedAt = stored.editedAt;
    if (stored.deletedAt) message.deletedAt = stored.deletedAt;
    if (stored.replyToId) message.replyToId = stored.replyToId;
    if (stored.delivery) message.delivery = structuredClone(stored.delivery);
    list.push(message);
    messages.set(stored.conversationId, list);
  }
  for (const list of messages.values()) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  const conversations: Conversation[] = Object.values(data.conversations)
    .map((stored) => {
      const list = messages.get(stored.id) ?? [];
      const latest = list[list.length - 1];
      const conversation: Conversation = {
        id: stored.id,
        kind: stored.kind,
        name: stored.name,
        members: stored.memberIds.map(user),
        unreadCount: 0,
        lastActivityAt: latest?.createdAt ?? stored.createdAt,
        lastMessagePreview: latest?.body ?? "No messages yet",
      };
      if (stored.topic) conversation.topic = stored.topic;
      if (latest) conversation.lastMessageAt = latest.createdAt;
      if (stored.lastReadAt) conversation.lastReadAt = stored.lastReadAt;
      return conversation;
    })
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

  const first = conversations[0];
  if (first) first.unreadCount = 2;

  return {
    workspace: {
      name: "Juniper Studio",
      providerId: "demo",
      providerLabel: "Local demo",
      demo: true,
      currentUser: user(data.currentUserId),
    },
    conversations,
    messages,
  };
}

export function sampleUiState(now: Date = FIXED_NOW): UiState {
  const fixture = demoFixture(now);
  const conversation = fixture.conversations[0];
  const messages = conversation ? (fixture.messages.get(conversation.id) ?? []) : [];
  return {
    phase: "ready",
    providerLabel: "Local demo",
    demo: true,
    workspace: fixture.workspace,
    conversations: fixture.conversations,
    conversationIndex: 0,
    messages,
    messageIndex: messages.length > 0 ? messages.length - 1 : -1,
    messageOffset: 0,
    sidebarOffset: 0,
    focus: "messages",
    composer: "",
    composerCursor: 0,
    spinner: 0,
    clock: now,
    loadingConversation: false,
  };
}
