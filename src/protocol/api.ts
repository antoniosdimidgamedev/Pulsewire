import type { Conversation, Message, SearchResult, User } from "../chat/types.ts";

/** JSON shapes shared by the HTTP client, provider, and documentation. */

export interface AuthResponse {
  user: User;
  token: string;
  expiresAt: string;
}

export interface UserResponse {
  user: User;
}

export interface UserListResponse {
  users: User[];
}

export interface ConversationResponse {
  conversation: Conversation;
}

export interface ConversationListResponse {
  conversations: Conversation[];
}

export interface MessageResponse {
  message: Message;
}

export interface MessagePageResponse {
  messages: Message[];
  hasMore: boolean;
  nextBefore?: number;
}

export interface MessageListResponse {
  messages: Message[];
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface MemberRecord {
  user: User;
  role: "owner" | "member";
  lastReadSeq: number;
}

export interface MemberListResponse {
  members: MemberRecord[];
}

export interface ApiEvent {
  seq: number;
  type: "message-created" | "message-updated" | "message-deleted" | "conversation-updated" | "read";
  conversationId: string;
  messageId?: string;
  message?: Message;
  actorId?: string;
  createdAt: string;
}

export interface EventListResponse {
  events: ApiEvent[];
  nextSeq: number;
}

export interface HeadEventResponse {
  seq: number;
}

export interface AdminOverview {
  users: number;
  admins: number;
  conversations: number;
  groups: number;
  dms: number;
  messages: number;
  deletedMessages: number;
  events: number;
  messagesLast24h: number;
}

export interface AdminUserSummary {
  id: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
  conversationCount: number;
  messageCount: number;
}

export interface AdminUserListResponse {
  users: AdminUserSummary[];
  total: number;
}

export interface AdminConversationSummary {
  id: string;
  kind: "dm" | "group" | "space";
  name: string;
  topic?: string;
  createdBy: User;
  memberCount: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
}

export interface AdminConversationListResponse {
  conversations: AdminConversationSummary[];
  total: number;
}

export interface AdminEvent {
  seq: number;
  type: ApiEvent["type"];
  conversationId: string | null;
  conversationName?: string;
  messageId?: string;
  actor?: User;
  createdAt: string;
}

export interface AdminEventListResponse {
  events: AdminEvent[];
  nextBefore?: number;
  headSeq: number;
}

export interface AdminOverviewResponse {
  overview: AdminOverview;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
