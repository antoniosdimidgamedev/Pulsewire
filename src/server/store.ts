import type { DatabaseSync } from "node:sqlite";
import type { Conversation, ConversationKind, Message, SearchResult, User } from "../chat/types.ts";
import {
  createSessionToken,
  DEFAULT_PBKDF2_ITERATIONS,
  hashPassword,
  hashToken,
  verifyPassword,
} from "./auth.ts";
import { ApiError, badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { decrypt, encrypt, isEnabled } from "./crypto.ts";

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_GROUP_NAME = 80;
const MAX_TOPIC = 200;
const MAX_MEMBERS = 50;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_ADMIN_PAGE_SIZE = 50;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const EVENT_TYPES: EventInfo["type"][] = [
  "message-created",
  "message-updated",
  "message-deleted",
  "conversation-updated",
  "read",
];

export interface StoreOptions {
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  passwordIterations?: number;
  sessionTtlMs?: number;
}

export interface AuthResult {
  user: User;
  token: string;
  expiresAt: string;
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
  nextBefore?: number;
}

export interface MemberInfo {
  user: User;
  role: "owner" | "member";
  lastReadSeq: number;
}

export interface EventInfo {
  seq: number;
  type: "message-created" | "message-updated" | "message-deleted" | "conversation-updated" | "read";
  conversationId: string;
  messageId?: string;
  message?: Message;
  actorId?: string;
  createdAt: string;
}

export interface EventPage {
  events: EventInfo[];
  nextSeq: number;
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

export interface AdminUserPage {
  users: AdminUserSummary[];
  total: number;
}

export interface AdminConversationSummary {
  id: string;
  kind: ConversationKind;
  name: string;
  topic?: string;
  createdBy: User;
  memberCount: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
}

export interface AdminConversationPage {
  conversations: AdminConversationSummary[];
  total: number;
}

export interface AdminEventInfo {
  seq: number;
  type: EventInfo["type"];
  conversationId: string | null;
  conversationName?: string;
  messageId?: string;
  actor?: User;
  createdAt: string;
}

export interface AdminEventPage {
  events: AdminEventInfo[];
  nextBefore?: number;
  headSeq: number;
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

export interface ConversationResult {
  conversation: Conversation;
  created: boolean;
}

interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  name: string;
  topic: string | null;
  created_by: string;
  dm_key: string | null;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  conversation_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: string;
  last_read_seq: number;
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

interface EventRow {
  seq: number;
  type: EventInfo["type"];
  conversation_id: string | null;
  message_id: string | null;
  actor_id: string | null;
  created_at: string;
}

interface AdminUserRow extends UserRow {
  conversation_count: number;
  message_count: number;
}

interface AdminConversationRow extends ConversationRow {
  member_count: number;
  message_count: number;
  last_message_at: string | null;
}

interface AdminEventRow extends EventRow {
  conversation_name: string | null;
}

/**
 * All persistence and authorization rules for the messaging service live here.
 * The HTTP layer is intentionally thin so a future Windows or Android client
 * reuses exactly the same behavior through the REST API.
 */
export class MessagingStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly idFactory: (prefix: string) => string;
  private readonly passwordIterations: number;
  private readonly sessionTtlMs: number;

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`);
    this.passwordIterations = options.passwordIterations ?? DEFAULT_PBKDF2_ITERATIONS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  async register(input: {
    handle: string;
    displayName: string;
    password: string;
  }): Promise<AuthResult> {
    const handle = normalizeHandle(input.handle);
    validateHandle(handle);
    const displayName = validateDisplayName(input.displayName);
    validatePassword(input.password);
    if (this.findUserByHandle(handle)) {
      throw conflict("That handle is already taken.");
    }
    const now = this.nowIso();
    const id = this.idFactory("u");
    const passwordHash = await hashPassword(input.password, this.passwordIterations);
    const existingUsers = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
      count: number;
    };
    // The first account owns the fresh installation and can open the dashboard.
    const isAdmin = Number(existingUsers.count) === 0 ? 1 : 0;
    this.db.prepare(
      `INSERT INTO users (id, handle, display_name, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, handle, displayName, passwordHash, isAdmin, now, now);
    return await this.createSession(id);
  }

  async login(handleInput: string, password: string): Promise<AuthResult> {
    const handle = normalizeHandle(handleInput);
    const row = this.findUserByHandle(handle);
    // Keep the failure generic so account existence is not disclosed.
    if (!row) {
      throw new ApiError("auth_required", "That handle or password is not correct.", 401);
    }
    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) {
      throw new ApiError("auth_required", "That handle or password is not correct.", 401);
    }
    return await this.createSession(row.id);
  }

  async authenticate(token: string): Promise<User | null> {
    if (!token) return null;
    const tokenHash = await hashToken(token);
    const row = this.db.prepare(
      `SELECT u.*, s.expires_at AS session_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    ).get(tokenHash) as (UserRow & { session_expires_at: string }) | undefined;
    if (!row) return null;
    if (Date.parse(row.session_expires_at) <= this.now().getTime()) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    return userFromRow(row);
  }

  async logout(token: string): Promise<void> {
    if (!token) return;
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(await hashToken(token));
  }

  getUser(userId: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
      | UserRow
      | undefined;
    return row ? userFromRow(row) : null;
  }

  isAdmin(userId: string): boolean {
    const row = this.db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as
      | { is_admin: number }
      | undefined;
    return row?.is_admin === 1;
  }

  /**
   * Make sure an administrator exists. With a configured handle, that account is
   * promoted. Otherwise the oldest account is promoted, which upgrades databases
   * created before the dashboard existed.
   */
  ensureAdmin(handleInput?: string): User | null {
    if (handleInput !== undefined && handleInput.trim() !== "") {
      const handle = normalizeHandle(handleInput);
      validateHandle(handle);
      const row = this.findUserByHandle(handle);
      if (!row) throw notFound(`No account exists for @${handle}.`);
      if (row.is_admin !== 1) {
        this.db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(row.id);
      }
      return this.getUser(row.id);
    }

    const existing = this.db.prepare("SELECT id FROM users WHERE is_admin = 1 LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (existing) return null;

    const oldest = this.db.prepare(
      "SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1",
    ).get() as { id: string } | undefined;
    if (!oldest) return null;
    this.db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(oldest.id);
    return this.getUser(oldest.id);
  }

  setAdmin(targetUserId: string, admin: boolean): User {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId) as
      | UserRow
      | undefined;
    if (!row) throw notFound("Account not found.");
    if (!admin && row.is_admin === 1) {
      const admins = this.db.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE is_admin = 1",
      ).get() as { count: number };
      if (Number(admins.count) <= 1) {
        throw conflict("At least one administrator must remain.");
      }
    }
    if ((admin ? 1 : 0) !== row.is_admin) {
      this.db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(
        admin ? 1 : 0,
        targetUserId,
      );
    }
    return this.getUser(targetUserId)!;
  }

  adminOverview(): AdminOverview {
    const count = (sql: string, ...params: Array<string | number>): number => {
      const row = this.db.prepare(sql).get(...params) as { count: number };
      return Number(row.count);
    };
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1_000).toISOString();
    return {
      users: count("SELECT COUNT(*) AS count FROM users"),
      admins: count("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1"),
      conversations: count("SELECT COUNT(*) AS count FROM conversations"),
      groups: count("SELECT COUNT(*) AS count FROM conversations WHERE kind = 'group'"),
      dms: count("SELECT COUNT(*) AS count FROM conversations WHERE kind = 'dm'"),
      messages: count("SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NULL"),
      deletedMessages: count("SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NOT NULL"),
      events: count("SELECT COUNT(*) AS count FROM events"),
      messagesLast24h: count(
        "SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NULL AND created_at >= ?",
        since,
      ),
    };
  }

  adminListUsers(options: { query?: string; limit?: number; offset?: number } = {}): AdminUserPage {
    const query = normalizeAdminQuery(options.query);
    const limit = clampAdminLimit(options.limit);
    const offset = clampOffset(options.offset);
    const like = `%${escapeLike(query)}%`;
    const where = query
      ? "WHERE (u.handle LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')"
      : "";
    const params: string[] = query ? [like, like] : [];
    const rows = this.db.prepare(
      `SELECT u.*,
         (SELECT COUNT(*) FROM memberships mb WHERE mb.user_id = u.id) AS conversation_count,
         (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id AND m.deleted_at IS NULL)
           AS message_count
       FROM users u
       ${where}
       ORDER BY u.created_at DESC, u.handle ASC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as unknown as AdminUserRow[];
    const total = this.db.prepare(
      `SELECT COUNT(*) AS count FROM users u ${where}`,
    ).get(...params) as { count: number };
    return {
      users: rows.map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        isAdmin: row.is_admin === 1,
        createdAt: row.created_at,
        conversationCount: Number(row.conversation_count),
        messageCount: Number(row.message_count),
      })),
      total: Number(total.count),
    };
  }

  adminListConversations(
    options: { query?: string; limit?: number; offset?: number } = {},
  ): AdminConversationPage {
    const query = normalizeAdminQuery(options.query);
    const limit = clampAdminLimit(options.limit);
    const offset = clampOffset(options.offset);
    const like = `%${escapeLike(query)}%`;
    const where = query ? "WHERE (c.name LIKE ? ESCAPE '\\' OR c.topic LIKE ? ESCAPE '\\')" : "";
    const params: string[] = query ? [like, like] : [];
    const rows = this.db.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM memberships mb WHERE mb.conversation_id = c.id) AS member_count,
         (SELECT COUNT(*) FROM messages m
           WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS message_count,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id)
           AS last_message_at
       FROM conversations c
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as unknown as AdminConversationRow[];
    const total = this.db.prepare(
      `SELECT COUNT(*) AS count FROM conversations c ${where}`,
    ).get(...params) as { count: number };
    return {
      conversations: rows.map((row) => this.adminConversationFromRow(row)),
      total: Number(total.count),
    };
  }

  adminGetConversation(conversationId: string): AdminConversationSummary {
    const row = this.db.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM memberships mb WHERE mb.conversation_id = c.id) AS member_count,
         (SELECT COUNT(*) FROM messages m
           WHERE m.conversation_id = c.id AND m.deleted_at IS NULL) AS message_count,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id)
           AS last_message_at
       FROM conversations c WHERE c.id = ?`,
    ).get(conversationId) as AdminConversationRow | undefined;
    if (!row) throw notFound("Conversation not found.");
    return this.adminConversationFromRow(row);
  }

  async adminGetMessagePage(
    conversationId: string,
    options: { limit?: number; before?: number } = {},
  ): Promise<MessagePage> {
    if (!this.conversationRow(conversationId)) throw notFound("Conversation not found.");
    const limit = clampLimit(options.limit);
    const before = options.before ?? (this.maxSeq(conversationId) + 1);
    if (!Number.isInteger(before) || before < 0) {
      throw badRequest("`before` must be a non-negative message sequence.");
    }
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    ).all(conversationId, before, limit + 1) as unknown as MessageRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return {
      messages: await Promise.all(page.map((row) => this.hydrateMessage(row, "", []))),
      hasMore,
      ...(hasMore && page[0] ? { nextBefore: page[0].seq } : {}),
    };
  }

  adminDeleteConversation(conversationId: string, actorId?: string): void {
    if (!this.conversationRow(conversationId)) throw notFound("Conversation not found.");
    // Drop reply links first so the cascade cannot violate the self-reference.
    this.db.prepare("UPDATE messages SET reply_to_id = NULL WHERE conversation_id = ?").run(
      conversationId,
    );
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    // Broadcast so every connected client refreshes its conversation list.
    this.insertEvent(
      "conversation-updated",
      null,
      actorId ? { actorId } : {},
    );
  }

  adminDeleteMessage(messageId: string, actorId?: string): void {
    const row = this.messageRow(messageId);
    if (!row) throw notFound("Message not found.");
    if (row.deleted_at) return;
    const now = this.nowIso();
    this.db.prepare("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?").run(
      now,
      messageId,
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      now,
      row.conversation_id,
    );
    this.insertEvent(
      "message-deleted",
      row.conversation_id,
      { messageId, ...(actorId ? { actorId } : {}) },
    );
  }

  adminListEvents(
    options: { before?: number; limit?: number; type?: string } = {},
  ): AdminEventPage {
    const limit = clampAdminLimit(options.limit, 200);
    const before = options.before ?? (this.headEventSeq() + 1);
    if (!Number.isInteger(before) || before < 0) {
      throw badRequest("`before` must be a non-negative event sequence.");
    }
    const type = options.type?.trim();
    if (type && !EVENT_TYPES.includes(type as EventInfo["type"])) {
      throw badRequest("Unknown event type.");
    }
    const clauses = ["e.seq < ?"];
    const params: Array<string | number> = [before];
    if (type) {
      clauses.push("e.type = ?");
      params.push(type);
    }
    const rows = this.db.prepare(
      `SELECT e.*, c.name AS conversation_name
       FROM events e LEFT JOIN conversations c ON c.id = e.conversation_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY e.seq DESC LIMIT ?`,
    ).all(...params, limit) as unknown as AdminEventRow[];
    const events: AdminEventInfo[] = rows.map((row) => {
      const event: AdminEventInfo = {
        seq: Number(row.seq),
        type: row.type,
        conversationId: row.conversation_id,
        createdAt: row.created_at,
      };
      if (row.conversation_name) event.conversationName = row.conversation_name;
      if (row.message_id) event.messageId = row.message_id;
      if (row.actor_id) {
        const actor = this.getUser(row.actor_id);
        if (actor) event.actor = actor;
      }
      return event;
    });
    return {
      events,
      headSeq: this.headEventSeq(),
      ...(events.length > 0 ? { nextBefore: events[events.length - 1]!.seq } : {}),
    };
  }

  updateProfile(
    userId: string,
    patch: { displayName?: string; handle?: string },
  ): User {
    const current = this.getUser(userId);
    if (!current) throw notFound("Account not found.");
    const handle = patch.handle === undefined ? current.handle : normalizeHandle(patch.handle);
    if (patch.handle !== undefined) {
      validateHandle(handle);
      const existing = this.findUserByHandle(handle);
      if (existing && existing.id !== userId) throw conflict("That handle is already taken.");
    }
    const displayName = patch.displayName === undefined
      ? current.displayName
      : validateDisplayName(patch.displayName);
    this.db.prepare(
      "UPDATE users SET handle = ?, display_name = ?, updated_at = ? WHERE id = ?",
    ).run(handle, displayName, this.nowIso(), userId);
    return this.getUser(userId)!;
  }

  searchUsers(viewerId: string, query: string): User[] {
    const q = validateQuery(query);
    const like = `%${escapeLike(q)}%`;
    const rows = this.db.prepare(
      `SELECT * FROM users
       WHERE id != ? AND (handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY handle ASC LIMIT 20`,
    ).all(viewerId, like, like) as unknown as UserRow[];
    return rows.map(userFromRow);
  }

  async listConversations(userId: string): Promise<Conversation[]> {
    const rows = this.db.prepare(
      `SELECT c.* FROM conversations c
       JOIN memberships mb ON mb.conversation_id = c.id
       WHERE mb.user_id = ?`,
    ).all(userId) as unknown as ConversationRow[];
    const conversations = await Promise.all(
      rows.map((row) => this.hydrateConversation(row, userId)),
    );
    return conversations.sort(
      (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation> {
    const row = this.conversationRow(conversationId);
    if (!row || !this.membership(conversationId, userId)) {
      throw notFound("Conversation not found.");
    }
    return await this.hydrateConversation(row, userId);
  }

  async createConversation(
    userId: string,
    input: {
      kind: ConversationKind;
      name?: string;
      topic?: string;
      memberHandles: string[];
    },
  ): Promise<ConversationResult> {
    if (input.kind === "dm") {
      const handles = uniqueHandles(input.memberHandles);
      if (handles.length !== 1) {
        throw badRequest("A direct message needs exactly one other person.");
      }
      const other = this.findUserByHandle(handles[0]!);
      if (!other) throw badRequest(`No user with handle @${handles[0]}.`);
      if (other.id === userId) throw badRequest("You cannot start a direct message with yourself.");
      const dmKey = [userId, other.id].sort().join(":");
      const existing = this.db.prepare("SELECT * FROM conversations WHERE dm_key = ?").get(dmKey) as
        | ConversationRow
        | undefined;
      if (existing) {
        return { conversation: await this.hydrateConversation(existing, userId), created: false };
      }
      const id = this.idFactory("c");
      const name = other.display_name;
      const now = this.nowIso();
      this.db.prepare(
        `INSERT INTO conversations
          (id, kind, name, topic, created_by, dm_key, created_at, updated_at)
         VALUES (?, 'dm', ?, NULL, ?, ?, ?, ?)`,
      ).run(id, name, userId, dmKey, now, now);
      this.insertMembership(id, userId, "owner", now);
      this.insertMembership(id, other.id, "member", now);
      this.insertEvent("conversation-updated", id, { actorId: userId });
      return { conversation: await this.getConversation(userId, id), created: true };
    }

    const name = validateGroupName(input.name ?? "");
    const topic = input.topic === undefined || input.topic.trim() === ""
      ? undefined
      : validateTopic(input.topic);
    const handles = uniqueHandles(input.memberHandles).filter((handle) =>
      handle !== this.getUser(userId)?.handle.toLowerCase()
    );
    if (handles.length === 0) {
      throw badRequest("Add at least one other person to the group.");
    }
    if (handles.length > MAX_MEMBERS) {
      throw badRequest(`A conversation can have at most ${MAX_MEMBERS} other members.`);
    }
    const members = handles.map((handle) => {
      const user = this.findUserByHandle(handle);
      if (!user) throw badRequest(`No user with handle @${handle}.`);
      return user;
    });
    const id = this.idFactory("c");
    const now = this.nowIso();
    this.db.prepare(
      `INSERT INTO conversations
        (id, kind, name, topic, created_by, dm_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, input.kind === "space" ? "space" : "group", name, topic ?? null, userId, now, now);
    this.insertMembership(id, userId, "owner", now);
    for (const member of members) this.insertMembership(id, member.id, "member", now);
    this.insertEvent("conversation-updated", id, { actorId: userId });
    return { conversation: await this.getConversation(userId, id), created: true };
  }

  listMembers(userId: string, conversationId: string): MemberInfo[] {
    this.requireMembership(userId, conversationId);
    return this.members(conversationId);
  }

  async addMember(
    userId: string,
    conversationId: string,
    handleInput: string,
  ): Promise<Conversation> {
    this.requireMembership(userId, conversationId);
    const conversation = this.conversationRow(conversationId)!;
    if (conversation.kind === "dm") {
      throw badRequest("Direct messages cannot have additional members.");
    }
    const handle = normalizeHandle(handleInput);
    validateHandle(handle);
    const target = this.findUserByHandle(handle);
    if (!target) throw badRequest(`No user with handle @${handle}.`);
    if (this.membership(conversationId, target.id)) {
      throw conflict(`@${handle} is already in this conversation.`);
    }
    const count = this.db.prepare(
      "SELECT COUNT(*) AS count FROM memberships WHERE conversation_id = ?",
    ).get(conversationId) as { count: number };
    if (Number(count.count) >= MAX_MEMBERS + 1) {
      throw badRequest(`A conversation can have at most ${MAX_MEMBERS + 1} members.`);
    }
    const now = this.nowIso();
    this.insertMembership(conversationId, target.id, "member", now);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      now,
      conversationId,
    );
    this.insertEvent("conversation-updated", conversationId, { actorId: userId });
    return await this.getConversation(userId, conversationId);
  }

  removeMember(userId: string, conversationId: string, targetUserId: string): boolean {
    const actor = this.requireMembership(userId, conversationId);
    const conversation = this.conversationRow(conversationId)!;
    if (conversation.kind === "dm") {
      throw badRequest("Direct messages cannot remove members.");
    }
    const target = this.membership(conversationId, targetUserId);
    if (!target) throw notFound("That person is not in this conversation.");
    if (targetUserId !== userId && actor.role !== "owner") {
      throw forbidden("Only the conversation owner can remove other members.");
    }

    this.db.prepare(
      "DELETE FROM memberships WHERE conversation_id = ? AND user_id = ?",
    ).run(conversationId, targetUserId);

    const remaining = this.db.prepare(
      "SELECT COUNT(*) AS count FROM memberships WHERE conversation_id = ?",
    ).get(conversationId) as { count: number };
    if (Number(remaining.count) === 0) {
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      return true;
    }

    if (target.role === "owner") {
      const next = this.db.prepare(
        `SELECT user_id FROM memberships WHERE conversation_id = ?
         ORDER BY joined_at ASC, user_id ASC LIMIT 1`,
      ).get(conversationId) as { user_id: string } | undefined;
      if (next) {
        this.db.prepare(
          `UPDATE memberships SET role = 'owner' WHERE conversation_id = ? AND user_id = ?`,
        ).run(conversationId, next.user_id);
      }
    }
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      this.nowIso(),
      conversationId,
    );
    this.insertEvent("conversation-updated", conversationId, { actorId: userId });
    return false;
  }

  async getMessagePage(
    userId: string,
    conversationId: string,
    options: { limit?: number; before?: number } = {},
  ): Promise<MessagePage> {
    this.requireMembership(userId, conversationId);
    const limit = clampLimit(options.limit);
    const before = options.before ?? (this.maxSeq(conversationId) + 1);
    if (!Number.isInteger(before) || before < 0) {
      throw badRequest("`before` must be a non-negative message sequence.");
    }
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    ).all(conversationId, before, limit + 1) as unknown as MessageRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    const cutoffs = this.members(conversationId);
    return {
      messages: await Promise.all(page.map((row) => this.hydrateMessage(row, userId, cutoffs))),
      hasMore,
      ...(hasMore && page[0] ? { nextBefore: page[0].seq } : {}),
    };
  }

  async getThread(userId: string, messageId: string): Promise<Message[]> {
    const start = this.messageRow(messageId);
    if (!start) throw notFound("Message not found.");
    this.requireMembership(userId, start.conversation_id);
    let root = start;
    for (let depth = 0; depth < 50 && root.reply_to_id; depth += 1) {
      const parent = this.messageRow(root.reply_to_id);
      if (!parent) break;
      root = parent;
    }
    const rows = this.db.prepare(
      `WITH RECURSIVE thread AS (
         SELECT * FROM messages WHERE id = ?
         UNION ALL
         SELECT m.* FROM messages m JOIN thread t ON m.reply_to_id = t.id
       )
       SELECT * FROM thread ORDER BY seq ASC`,
    ).all(root.id) as unknown as MessageRow[];
    const cutoffs = this.members(start.conversation_id);
    return await Promise.all(rows.map((row) => this.hydrateMessage(row, userId, cutoffs)));
  }

  async sendMessage(
    userId: string,
    conversationId: string,
    bodyInput: string,
    replyToId?: string,
  ): Promise<Message> {
    this.requireMembership(userId, conversationId);
    const body = validateBody(bodyInput);
    const encryptedBody = isEnabled() ? await encrypt(body) : body;
    if (replyToId) {
      const parent = this.messageRow(replyToId);
      if (!parent || parent.conversation_id !== conversationId || parent.deleted_at) {
        throw badRequest("The message you are replying to is no longer available.");
      }
    }
    const now = this.nowIso();
    const id = this.idFactory("m");
    const result = this.db.prepare(
      `INSERT INTO messages
        (id, conversation_id, author_id, body, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, conversationId, userId, encryptedBody, replyToId ?? null, now);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      now,
      conversationId,
    );
    this.insertEvent("message-created", conversationId, { messageId: id, actorId: userId });
    const row = this.messageRowById(id) ?? this.messageRowBySeq(Number(result.lastInsertRowid));
    return this.hydrateMessage(row!, userId, this.members(conversationId));
  }

  async editMessage(userId: string, messageId: string, bodyInput: string): Promise<Message> {
    const row = this.messageRow(messageId);
    if (!row) throw notFound("Message not found.");
    this.requireMembership(userId, row.conversation_id);
    if (row.author_id !== userId) throw forbidden("You can only edit your own messages.");
    if (row.deleted_at) throw badRequest("Deleted messages cannot be edited.");
    const body = validateBody(bodyInput);
    const encryptedBody = isEnabled() ? await encrypt(body) : body;
    const now = this.nowIso();
    this.db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").run(
      encryptedBody,
      now,
      messageId,
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      now,
      row.conversation_id,
    );
    this.insertEvent("message-updated", row.conversation_id, { messageId, actorId: userId });
    const updated = this.messageRow(messageId)!;
    return this.hydrateMessage(updated, userId, this.members(row.conversation_id));
  }

  deleteMessage(userId: string, messageId: string): void {
    const row = this.messageRow(messageId);
    if (!row) throw notFound("Message not found.");
    this.requireMembership(userId, row.conversation_id);
    if (row.author_id !== userId) throw forbidden("You can only delete your own messages.");
    if (row.deleted_at) return;
    const now = this.nowIso();
    this.db.prepare(
      "UPDATE messages SET body = '', deleted_at = ? WHERE id = ?",
    ).run(now, messageId);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      now,
      row.conversation_id,
    );
    this.insertEvent("message-deleted", row.conversation_id, { messageId, actorId: userId });
  }

  async markRead(userId: string, conversationId: string): Promise<Conversation> {
    const membership = this.requireMembership(userId, conversationId);
    const max = this.maxSeq(conversationId);
    if (max > membership.last_read_seq) {
      this.db.prepare(
        `UPDATE memberships SET last_read_seq = ?
         WHERE conversation_id = ? AND user_id = ?`,
      ).run(max, conversationId, userId);
      this.insertEvent("read", conversationId, { actorId: userId });
    }
    return await this.getConversation(userId, conversationId);
  }

  async search(userId: string, queryInput: string): Promise<SearchResult[]> {
    const query = validateQuery(queryInput);
    const like = `%${escapeLike(query)}%`;
    // When bodies are encrypted, SQL LIKE cannot match ciphertext, so search
    // matches conversation names only. Message bodies are decrypted below.
    let rows: MessageRow[];
    if (isEnabled()) {
      rows = this.db.prepare(
        `SELECT m.* FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN memberships mb ON mb.conversation_id = m.conversation_id
         WHERE mb.user_id = ? AND m.deleted_at IS NULL
           AND (c.name LIKE ? ESCAPE '\\')
         ORDER BY m.seq DESC LIMIT ?`,
      ).all(userId, like, MAX_SEARCH_RESULTS) as unknown as MessageRow[];
    } else {
      rows = this.db.prepare(
        `SELECT m.* FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN memberships mb ON mb.conversation_id = m.conversation_id
         WHERE mb.user_id = ? AND m.deleted_at IS NULL
           AND (m.body LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')
         ORDER BY m.seq DESC LIMIT ?`,
      ).all(userId, like, like, MAX_SEARCH_RESULTS) as unknown as MessageRow[];
    }
    const conversations = new Map<string, Conversation>();
    const results: SearchResult[] = [];
    for (const row of rows) {
      let conversation = conversations.get(row.conversation_id);
      if (!conversation) {
        conversation = await this.getConversation(userId, row.conversation_id);
        conversations.set(row.conversation_id, conversation);
      }
      const message = await this.hydrateMessage(
        row,
        userId,
        this.members(row.conversation_id),
      );
      let snippetBody = row.body;
      if (isEnabled()) {
        const decrypted = await decrypt(row.body);
        snippetBody = decrypted ?? "";
      }
      results.push({ message, conversation, snippet: snippetFor(snippetBody, query) });
    }
    return results;
  }

  async getEvents(userId: string, after: number, limitInput?: number): Promise<EventPage> {
    if (!Number.isInteger(after) || after < 0) {
      throw badRequest("`after` must be a non-negative event sequence.");
    }
    const limit = Math.min(Math.max(limitInput ?? 100, 1), 200);
    const rows = this.db.prepare(
      `SELECT e.* FROM events e
       WHERE e.seq > ? AND (
         e.conversation_id IS NULL OR EXISTS (
           SELECT 1 FROM memberships mb
           WHERE mb.conversation_id = e.conversation_id AND mb.user_id = ?
         )
       )
       ORDER BY e.seq ASC LIMIT ?`,
    ).all(after, userId, limit) as unknown as EventRow[];
    const events: EventInfo[] = [];
    for (const row of rows) {
      const event: EventInfo = {
        seq: Number(row.seq),
        type: row.type,
        conversationId: row.conversation_id ?? "",
        createdAt: row.created_at,
      };
      if (row.message_id) event.messageId = row.message_id;
      if (row.actor_id) event.actorId = row.actor_id;
      if (row.type === "message-created" || row.type === "message-updated") {
        const messageRow = row.message_id ? this.messageRow(row.message_id) : undefined;
        if (messageRow) {
          event.message = await this.hydrateMessage(
            messageRow,
            userId,
            this.members(messageRow.conversation_id),
          );
        }
      }
      events.push(event);
    }
    return {
      events,
      nextSeq: events.length > 0 ? events[events.length - 1]!.seq : after,
    };
  }

  headEventSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as {
      seq: number;
    };
    return Number(row.seq);
  }

  private async createSession(userId: string): Promise<AuthResult> {
    const user = this.getUser(userId);
    if (!user) throw notFound("Account not found.");
    const now = this.now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    const { token, tokenHash } = await createSessionToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString();
    this.db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run(tokenHash, userId, now.toISOString(), expiresAt);
    return { user, token, expiresAt };
  }

  private findUserByHandle(handle: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as
      | UserRow
      | undefined;
  }

  private conversationRow(conversationId: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as
      | ConversationRow
      | undefined;
  }

  private messageRow(messageId: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
      | MessageRow
      | undefined;
  }

  private messageRowById(messageId: string): MessageRow | undefined {
    return this.messageRow(messageId);
  }

  private messageRowBySeq(seq: number): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE seq = ?").get(seq) as
      | MessageRow
      | undefined;
  }

  private membership(conversationId: string, userId: string): MembershipRow | undefined {
    return this.db.prepare(
      "SELECT * FROM memberships WHERE conversation_id = ? AND user_id = ?",
    ).get(conversationId, userId) as MembershipRow | undefined;
  }

  private requireMembership(userId: string, conversationId: string): MembershipRow {
    const membership = this.membership(conversationId, userId);
    if (!membership) throw notFound("Conversation not found.");
    return membership;
  }

  private members(conversationId: string): MemberInfo[] {
    const rows = this.db.prepare(
      `SELECT u.*, mb.role AS membership_role, mb.last_read_seq AS membership_last_read
       FROM memberships mb JOIN users u ON u.id = mb.user_id
       WHERE mb.conversation_id = ?
       ORDER BY mb.joined_at ASC, u.handle ASC`,
    ).all(conversationId) as unknown as Array<
      UserRow & { membership_role: "owner" | "member"; membership_last_read: number }
    >;
    return rows.map((row) => ({
      user: userFromRow(row),
      role: row.membership_role,
      lastReadSeq: Number(row.membership_last_read),
    }));
  }

  private adminConversationFromRow(row: AdminConversationRow): AdminConversationSummary {
    const createdBy = this.getUser(row.created_by) ?? {
      id: row.created_by,
      handle: "unknown",
      displayName: "Unknown",
    };
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      ...(row.topic ? { topic: row.topic } : {}),
      createdBy,
      memberCount: Number(row.member_count),
      messageCount: Number(row.message_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_message_at ? { lastMessageAt: row.last_message_at } : {}),
    };
  }

  private async hydrateConversation(row: ConversationRow, viewerId: string): Promise<Conversation> {
    const members = this.members(row.id);
    const viewer = members.find((member) => member.user.id === viewerId);
    const latest = this.db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(row.id) as MessageRow | undefined;
    const lastReadSeq = viewer?.lastReadSeq ?? 0;
    const unread = this.db.prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE conversation_id = ? AND seq > ? AND author_id != ? AND deleted_at IS NULL`,
    ).get(row.id, lastReadSeq, viewerId) as { count: number };
    const lastReadRow = lastReadSeq > 0
      ? this.db.prepare(
        `SELECT created_at FROM messages
         WHERE conversation_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1`,
      ).get(row.id, lastReadSeq) as { created_at: string } | undefined
      : undefined;
    const other = members.find((member) => member.user.id !== viewerId);
    const name = row.kind === "dm" && other ? other.user.displayName : row.name;
    let previewText = "";
    if (latest) {
      if (latest.deleted_at) {
        previewText = "Message deleted";
      } else if (isEnabled()) {
        const decrypted = await decrypt(latest.body);
        previewText = decrypted ? preview(decrypted) : "";
      } else {
        previewText = preview(latest.body);
      }
    }
    return {
      id: row.id,
      kind: row.kind,
      name,
      ...(row.topic ? { topic: row.topic } : {}),
      members: members.map((member) => member.user),
      unreadCount: Number(unread.count),
      lastActivityAt: latest?.created_at ?? row.updated_at,
      lastMessagePreview: previewText,
      ...(latest ? { lastMessageAt: latest.created_at } : {}),
      ...(lastReadRow ? { lastReadAt: lastReadRow.created_at } : {}),
    };
  }

  private async hydrateMessage(
    row: MessageRow,
    viewerId: string,
    cutoffs: MemberInfo[],
  ): Promise<Message> {
    const author = this.getUser(row.author_id) ?? {
      id: row.author_id,
      displayName: "Unknown",
      handle: "unknown",
    };
    let body = row.deleted_at ? "" : row.body;
    if (!row.deleted_at && isEnabled()) {
      const decrypted = await decrypt(row.body);
      body = decrypted ?? "";
    }
    const message: Message = {
      id: row.id,
      conversationId: row.conversation_id,
      author,
      body,
      createdAt: row.created_at,
      ...(row.edited_at ? { editedAt: row.edited_at } : {}),
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
    };
    if (row.author_id === viewerId) {
      const readBy = cutoffs
        .filter((member) => member.user.id !== viewerId && member.lastReadSeq >= row.seq)
        .map((member) => member.user.id);
      message.delivery = {
        status: readBy.length > 0 ? "read" : "sent",
        ...(readBy.length > 0 ? { readBy } : {}),
      };
    }
    return message;
  }

  private insertMembership(
    conversationId: string,
    userId: string,
    role: "owner" | "member",
    joinedAt: string,
  ): void {
    this.db.prepare(
      `INSERT INTO memberships (conversation_id, user_id, role, joined_at, last_read_seq)
       VALUES (?, ?, ?, ?, 0)`,
    ).run(conversationId, userId, role, joinedAt);
  }

  private insertEvent(
    type: EventInfo["type"],
    conversationId: string | null,
    extra: { messageId?: string; actorId?: string } = {},
  ): void {
    this.db.prepare(
      `INSERT INTO events (type, conversation_id, message_id, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      type,
      conversationId,
      extra.messageId ?? null,
      extra.actorId ?? null,
      this.nowIso(),
    );
  }

  private maxSeq(conversationId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?",
    ).get(conversationId) as { seq: number };
    return Number(row.seq);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    handle: row.handle,
    isAdmin: row.is_admin === 1,
  };
}

export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function validateHandle(handle: string): void {
  if (!/^[a-z0-9_]{3,32}$/.test(handle)) {
    throw badRequest(
      "Handles must be 3-32 characters and use only lowercase letters, numbers, and underscores.",
    );
  }
}

export function validateDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw badRequest("Display name must not be empty.");
  if (name.length > 40) throw badRequest("Display name must be 40 characters or fewer.");
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest("Display name must not contain control characters.");
  }
  return name;
}

export function validatePassword(password: string): void {
  if (password.length < 10) {
    throw badRequest("Passwords must be at least 10 characters.");
  }
  if (password.length > 200) {
    throw badRequest("Passwords must be 200 characters or fewer.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(password)) {
    throw badRequest("Passwords must not contain control characters.");
  }
}

function validateGroupName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw badRequest("Group conversations need a name.");
  if (name.length > MAX_GROUP_NAME) {
    throw badRequest(`Group names must be ${MAX_GROUP_NAME} characters or fewer.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest("Group names must not contain control characters.");
  }
  return name;
}

function validateTopic(value: string): string {
  const topic = value.trim().replace(/\s+/g, " ");
  if (topic.length > MAX_TOPIC) {
    throw badRequest(`Topics must be ${MAX_TOPIC} characters or fewer.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(topic)) {
    throw badRequest("Topics must not contain control characters.");
  }
  return topic;
}

function validateBody(value: string): string {
  const body = value.replace(/\r\n?/g, "\n").trim();
  if (!body) throw badRequest("Messages cannot be empty.");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw badRequest(`Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
    throw badRequest("Messages must not contain control characters.");
  }
  return body;
}

function validateQuery(value: string): string {
  const query = value.trim();
  if (!query) throw badRequest("Enter something to search for.");
  if (query.length > 100) throw badRequest("Search queries must be 100 characters or fewer.");
  return query;
}

function uniqueHandles(handles: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of handles) {
    const handle = normalizeHandle(raw);
    if (!handle || seen.has(handle)) continue;
    validateHandle(handle);
    seen.add(handle);
    output.push(handle);
  }
  return output;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw badRequest("`limit` must be a positive integer.");
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

function clampAdminLimit(
  limit: number | undefined,
  max = MAX_PAGE_SIZE,
  fallback = DEFAULT_ADMIN_PAGE_SIZE,
): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw badRequest("`limit` must be a positive integer.");
  }
  return Math.min(limit, max);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw badRequest("`offset` must be a non-negative integer.");
  }
  return offset;
}

function normalizeAdminQuery(value: string | undefined): string {
  const query = (value ?? "").trim();
  if (query.length > 100) throw badRequest("Search queries must be 100 characters or fewer.");
  return query;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function preview(body: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

function snippetFor(body: string, query: string): string {
  const clean = body.replace(/\s+/g, " ").trim();
  const index = clean.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return preview(clean);
  const start = Math.max(0, index - 40);
  const end = Math.min(clean.length, index + query.length + 60);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}
