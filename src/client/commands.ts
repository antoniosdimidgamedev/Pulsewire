import { ChatError, errorMessage } from "../chat/errors.ts";
import type { Conversation, Message, User } from "../chat/types.ts";
import type { Command } from "../cli.ts";
import type { AppConfig } from "../config.ts";
import { ApiClient } from "./api.ts";
import { readSecret } from "./prompt.ts";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session.ts";

export interface CommandIO {
  out(line: string): void;
  error(line: string): void;
}

export interface CommandOptions {
  io?: CommandIO;
  /** Injected for tests; defaults to a hidden terminal prompt. */
  readPassword?: (prompt: string) => Promise<string>;
}

const consoleIO: CommandIO = {
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Commands that talk to the server. `serve` is handled by main.ts. */
export async function runClientCommand(
  command: Command,
  config: AppConfig,
  options: CommandOptions = {},
): Promise<number> {
  const io = options.io ?? consoleIO;
  const readPassword = options.readPassword ?? readSecret;
  try {
    switch (command.kind) {
      case "register":
        return await register(command, config, io, readPassword);
      case "login":
        return await login(command, config, io, readPassword);
      case "logout":
        return await logout(config, io);
      case "whoami":
        return await whoami(config, io);
      case "profile":
        return await profile(command, config, io);
      case "conversations":
        return await conversations(config, io);
      case "history":
        return await history(command, config, io);
      case "send":
        return await send(command, config, io);
      case "search":
        return await search(command, config, io);
      case "new-dm":
        return await newDm(command, config, io);
      case "new-group":
        return await newGroup(command, config, io);
      case "members":
        return await members(command, config, io);
      case "invite":
        return await invite(command, config, io);
      case "remove-member":
        return await removeMember(command, config, io);
      case "leave":
        return await leave(command, config, io);
      case "read":
        return await read(command, config, io);
      default:
        io.error(`pulsewire: \`${command.kind}\` is not a server command.`);
        return 2;
    }
  } catch (error) {
    io.error(`pulsewire: ${errorMessage(error)}`);
    if (error instanceof ChatError && error.code === "auth_required") {
      io.error("Run `pulsewire login <handle>` to sign in again.");
    }
    return 1;
  }
}

async function register(
  command: Extract<Command, { kind: "register" }>,
  config: AppConfig,
  io: CommandIO,
  readPassword: (prompt: string) => Promise<string>,
): Promise<number> {
  const password = await readPassword("Password: ");
  if (!command.passwordStdin && Deno.stdin.isTerminal()) {
    const confirmation = await readPassword("Confirm password: ");
    if (password !== confirmation) {
      throw new ChatError("invalid_input", "The passwords did not match.");
    }
  }
  const api = client(config);
  const result = await api.register({
    handle: command.handle,
    displayName: command.displayName ?? config.displayName,
    password,
  });
  await persist(config, result);
  io.out(`Created account @${result.user.handle} (${result.user.displayName}).`);
  io.out(`Signed in to ${config.server.baseUrl}.`);
  return 0;
}

async function login(
  command: Extract<Command, { kind: "login" }>,
  config: AppConfig,
  io: CommandIO,
  readPassword: (prompt: string) => Promise<string>,
): Promise<number> {
  const password = await readPassword("Password: ");
  const api = client(config);
  const result = await api.login(command.handle, password);
  await persist(config, result);
  io.out(`Signed in as ${result.user.displayName} (@${result.user.handle}).`);
  return 0;
}

async function logout(config: AppConfig, io: CommandIO): Promise<number> {
  const session = await loadSession(config.sessionPath, config.server.baseUrl);
  if (!session) {
    io.out(`Not signed in to ${config.server.baseUrl}.`);
    return 0;
  }
  try {
    await client(config, session.token).logout();
  } catch (error) {
    io.error(
      `pulsewire: could not reach the server (${errorMessage(error)}). ` +
        "Removing the local session anyway.",
    );
  }
  await clearSession(config.sessionPath, config.server.baseUrl);
  io.out(`Signed out of ${config.server.baseUrl}.`);
  return 0;
}

async function whoami(config: AppConfig, io: CommandIO): Promise<number> {
  const session = await requireSession(config);
  const user = await client(config, session.token).me();
  io.out(`${user.displayName} (@${user.handle})`);
  io.out(`Server: ${config.server.baseUrl}`);
  io.out(`User id: ${user.id}`);
  return 0;
}

async function profile(
  command: Extract<Command, { kind: "profile" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const patch: { displayName?: string; handle?: string } = {};
  if (command.displayName !== undefined) patch.displayName = command.displayName;
  if (command.handle !== undefined) patch.handle = command.handle;
  const user = await client(config, session.token).updateProfile(patch);
  await persist(config, { token: session.token, expiresAt: session.expiresAt, user });
  io.out(`Profile updated: ${user.displayName} (@${user.handle}).`);
  return 0;
}

async function conversations(config: AppConfig, io: CommandIO): Promise<number> {
  const session = await requireSession(config);
  const list = await client(config, session.token).listConversations();
  if (list.length === 0) {
    io.out("No conversations yet. Start one with `pulsewire new-dm <handle>`.");
    return 0;
  }
  for (const conversation of list) {
    io.out(describeConversation(conversation));
  }
  return 0;
}

async function history(
  command: Extract<Command, { kind: "history" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  const page = await api.getMessages(conversation.id, {
    ...(command.limit !== undefined ? { limit: command.limit } : {}),
    ...(command.before !== undefined ? { before: command.before } : {}),
  });
  io.out(`${conversation.name} (${conversation.kind}) · ${conversation.id}`);
  if (page.messages.length === 0) {
    io.out("No messages yet.");
  } else {
    let lastDay = "";
    for (const message of page.messages) {
      const day = message.createdAt.slice(0, 10);
      if (day !== lastDay) {
        io.out(`— ${day} —`);
        lastDay = day;
      }
      io.out(formatMessage(message));
    }
  }
  if (page.hasMore && page.nextBefore !== undefined) {
    io.out(
      `Older messages available. Run: pulsewire history ${conversation.id} --before ${page.nextBefore}`,
    );
  }
  return 0;
}

async function send(
  command: Extract<Command, { kind: "send" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  const message = await api.sendMessage(conversation.id, command.body, command.replyTo);
  io.out(`Sent to ${conversation.name}: ${formatMessage(message)}`);
  return 0;
}

async function search(
  command: Extract<Command, { kind: "search" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const results = await client(config, session.token).search(command.query);
  if (results.length === 0) {
    io.out("No matching messages.");
    return 0;
  }
  for (const result of results) {
    io.out(`[${result.conversation.name}] ${formatMessage(result.message)}`);
    if (result.snippet && result.snippet !== result.message.body) {
      io.out(`  ${result.snippet}`);
    }
  }
  return 0;
}

async function newDm(
  command: Extract<Command, { kind: "new-dm" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await api.createConversation({
    kind: "dm",
    memberHandles: [command.handle],
  });
  io.out(`Direct message ready: ${conversation.name} · ${conversation.id}`);
  return 0;
}

async function newGroup(
  command: Extract<Command, { kind: "new-group" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const conversation = await client(config, session.token).createConversation({
    kind: "group",
    name: command.name,
    memberHandles: command.members,
  });
  io.out(`Created group ${conversation.name} · ${conversation.id}`);
  return 0;
}

async function members(
  command: Extract<Command, { kind: "members" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  const result = await api.listMembers(conversation.id);
  io.out(`${conversation.name} · ${result.members.length} member(s)`);
  for (const member of result.members) {
    io.out(
      `${
        member.role.padEnd(6)
      } @${member.user.handle}  ${member.user.displayName}  ${member.user.id}`,
    );
  }
  return 0;
}

async function invite(
  command: Extract<Command, { kind: "invite" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  const updated = await api.addMember(conversation.id, command.handle);
  io.out(`Added ${normalizeHandle(command.handle)} to ${updated.name}.`);
  return 0;
}

async function removeMember(
  command: Extract<Command, { kind: "remove-member" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  const list = await api.listMembers(conversation.id);
  const reference = command.member.trim().replace(/^@+/, "").toLowerCase();
  const target = list.members.find((member) =>
    member.user.id === command.member || member.user.handle.toLowerCase() === reference
  );
  if (!target) {
    throw new ChatError(
      "not_found",
      `No member "${command.member}" in ${conversation.name}. Try \`pulsewire members ${conversation.id}\`.`,
    );
  }
  await api.removeMember(conversation.id, target.user.id);
  io.out(`Removed @${target.user.handle} from ${conversation.name}.`);
  return 0;
}

async function leave(
  command: Extract<Command, { kind: "leave" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  await api.leaveConversation(conversation.id);
  io.out(`Left ${conversation.name}.`);
  return 0;
}

async function read(
  command: Extract<Command, { kind: "read" }>,
  config: AppConfig,
  io: CommandIO,
): Promise<number> {
  const session = await requireSession(config);
  const api = client(config, session.token);
  const conversation = await resolveConversation(api, command.conversation);
  const updated = await api.markRead(conversation.id);
  io.out(`Marked ${updated.name} as read.`);
  return 0;
}

function client(config: AppConfig, token?: string): ApiClient {
  return new ApiClient({
    baseUrl: config.server.baseUrl,
    ...(token ? { token } : {}),
    timeoutMs: config.server.requestTimeoutMs,
  });
}

async function requireSession(config: AppConfig): Promise<StoredSession> {
  const session = await loadSession(config.sessionPath, config.server.baseUrl);
  if (!session) {
    throw new ChatError(
      "auth_required",
      `Not signed in to ${config.server.baseUrl}.`,
    );
  }
  return session;
}

async function persist(
  config: AppConfig,
  result: { token: string; expiresAt: string; user: User },
): Promise<void> {
  await saveSession(config.sessionPath, {
    baseUrl: config.server.baseUrl,
    token: result.token,
    userId: result.user.id,
    handle: result.user.handle,
    displayName: result.user.displayName,
    expiresAt: result.expiresAt,
    savedAt: new Date().toISOString(),
  });
}

async function resolveConversation(
  api: ApiClient,
  reference: string,
): Promise<Conversation> {
  const target = reference.trim();
  if (!target) throw new ChatError("invalid_input", "Enter a conversation id or name.");
  const list = await api.listConversations();
  const byId = list.find((conversation) => conversation.id === target);
  if (byId) return byId;
  const normalized = target.replace(/^[#@]+/, "").toLowerCase();
  const matches = list.filter((conversation) =>
    conversation.name.toLowerCase() === normalized ||
    conversation.name.toLowerCase() === target.toLowerCase()
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ChatError(
      "invalid_input",
      `"${target}" matches several conversations. Use one of these ids:\n` +
        matches.map((conversation) => `  ${conversation.id}  ${conversation.name}`).join("\n"),
    );
  }
  const partial = list.filter((conversation) =>
    conversation.name.toLowerCase().includes(normalized)
  );
  if (partial.length === 1) return partial[0]!;
  throw new ChatError(
    "not_found",
    `No conversation matches "${target}". Run \`pulsewire conversations\` to list them.`,
  );
}

export function describeConversation(conversation: Conversation): string {
  const unread = conversation.unreadCount > 0 ? ` [${conversation.unreadCount} unread]` : "";
  const preview = conversation.lastMessagePreview ? `  ${conversation.lastMessagePreview}` : "";
  return `${conversation.id}  ${
    conversation.kind.padEnd(5)
  }  ${conversation.name}${unread}${preview}`;
}

export function formatMessage(message: Message): string {
  const when = formatTimestamp(message.createdAt);
  const edited = message.editedAt ? " (edited)" : "";
  const deleted = message.deletedAt ? " [deleted]" : "";
  const reply = message.replyToId ? ` (reply to ${message.replyToId})` : "";
  return `${when}  @${message.author.handle}: ${message.body}${edited}${deleted}${reply}  (${message.id})`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeHandle(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}
