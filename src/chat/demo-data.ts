import type { ConversationKind, MessageDelivery, MessageDeliveryStatus } from "./types.ts";
import { ChatError } from "./errors.ts";

export const DEMO_DATA_VERSION = 1;

const DELIVERY_STATUSES: readonly MessageDeliveryStatus[] = [
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
];

export interface StoredUser {
  id: string;
  displayName: string;
  handle: string;
}

export interface StoredConversation {
  id: string;
  kind: ConversationKind;
  name: string;
  topic?: string;
  memberIds: string[];
  createdAt: string;
  lastReadAt?: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  replyToId?: string;
  delivery?: MessageDelivery;
}

export interface DemoData {
  version: number;
  createdAt: string;
  updatedAt: string;
  currentUserId: string;
  users: Record<string, StoredUser>;
  conversations: Record<string, StoredConversation>;
  messages: Record<string, StoredMessage>;
}

export interface SeedOptions {
  displayName: string;
  now?: Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Build a deterministic-looking, entirely local demo workspace. */
export function seedDemoData(options: SeedOptions): DemoData {
  const now = options.now ?? new Date();
  const iso = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();
  const currentUserId = "u-self";
  const currentHandle = slugHandle(options.displayName) || "you";

  const users: Record<string, StoredUser> = {
    [currentUserId]: { id: currentUserId, displayName: options.displayName, handle: currentHandle },
    "u-maya": { id: "u-maya", displayName: "Maya Chen", handle: "maya" },
    "u-ivo": { id: "u-ivo", displayName: "Ivo Santos", handle: "ivo" },
    "u-noor": { id: "u-noor", displayName: "Noor Haddad", handle: "noor" },
    "u-tess": { id: "u-tess", displayName: "Tess Okafor", handle: "tess" },
    "u-rafael": { id: "u-rafael", displayName: "Rafael Kim", handle: "rafael" },
  };

  const conversations: Record<string, StoredConversation> = {
    "c-dm-maya": {
      id: "c-dm-maya",
      kind: "dm",
      name: "Maya Chen",
      topic: "Design systems and release polish",
      memberIds: [currentUserId, "u-maya"],
      createdAt: iso(30 * 24 * HOUR),
      lastReadAt: iso(3 * MINUTE),
    },
    "c-dm-ivo": {
      id: "c-dm-ivo",
      kind: "dm",
      name: "Ivo Santos",
      topic: "Infra, builds, and the Windows runner",
      memberIds: [currentUserId, "u-ivo"],
      createdAt: iso(25 * 24 * HOUR),
      lastReadAt: iso(20 * MINUTE),
    },
    "c-grp-launch": {
      id: "c-grp-launch",
      kind: "group",
      name: "Launch crew",
      topic: "Everything needed for the 0.1 launch",
      memberIds: [currentUserId, "u-maya", "u-noor", "u-tess", "u-ivo"],
      createdAt: iso(14 * 24 * HOUR),
      lastReadAt: iso(90 * MINUTE),
    },
    "c-grp-terminal": {
      id: "c-grp-terminal",
      kind: "group",
      name: "Terminal nerds",
      topic: "Keyboards, TUIs, and questionable color choices",
      memberIds: [currentUserId, "u-ivo", "u-rafael", "u-noor"],
      createdAt: iso(40 * 24 * HOUR),
      lastReadAt: iso(3 * HOUR),
    },
    "c-sp-general": {
      id: "c-sp-general",
      kind: "space",
      name: "general",
      topic: "Studio-wide announcements and watercooler talk",
      memberIds: [currentUserId, "u-maya", "u-ivo", "u-noor", "u-tess", "u-rafael"],
      createdAt: iso(90 * 24 * HOUR),
      lastReadAt: iso(1 * HOUR),
    },
    "c-sp-design": {
      id: "c-sp-design",
      kind: "space",
      name: "design-lab",
      topic: "Critique, prototypes, and interface details",
      memberIds: [currentUserId, "u-maya", "u-tess"],
      createdAt: iso(60 * 24 * HOUR),
      lastReadAt: iso(5 * HOUR),
    },
  };

  const messages: Record<string, StoredMessage> = {};
  const add = (
    id: string,
    conversationId: string,
    authorId: string,
    offsetMs: number,
    body: string,
    extra: Partial<
      Pick<StoredMessage, "editedAt" | "deletedAt" | "replyToId" | "delivery">
    > = {},
  ) => {
    messages[id] = {
      id,
      conversationId,
      authorId,
      body,
      createdAt: iso(offsetMs),
      ...extra,
    };
  };

  // Direct message: Maya
  add(
    "m-maya-1",
    "c-dm-maya",
    "u-maya",
    50 * MINUTE,
    "The sidebar density feels much better at 80 columns now.",
  );
  add(
    "m-maya-2",
    "c-dm-maya",
    currentUserId,
    48 * MINUTE,
    "Great. I kept the unread dot but dropped the second preview line so the names have room.",
    { delivery: { status: "read", readBy: ["u-maya"] } },
  );
  add(
    "m-maya-3",
    "c-dm-maya",
    "u-maya",
    46 * MINUTE,
    "That was the right call. Want me to review the focus states before lunch?",
  );
  add(
    "m-maya-4",
    "c-dm-maya",
    currentUserId,
    44 * MINUTE,
    "Please do. The composer border is the part I am least sure about.",
    { editedAt: iso(43 * MINUTE), delivery: { status: "read", readBy: ["u-maya"] } },
  );
  add(
    "m-maya-5",
    "c-dm-maya",
    "u-maya",
    2 * MINUTE,
    "Composer reads clearly now. One thought: make the send hint change with the current mode.",
  );

  // Direct message: Ivo
  add(
    "m-ivo-1",
    "c-dm-ivo",
    "u-ivo",
    2 * HOUR,
    "Windows smoke test passed on the studio laptop. Raw mode and resize both behave.",
  );
  add(
    "m-ivo-2",
    "c-dm-ivo",
    currentUserId,
    110 * MINUTE,
    "Excellent. Any color issues in the legacy console?",
    { delivery: { status: "read", readBy: ["u-ivo"] } },
  );
  add(
    "m-ivo-3",
    "c-dm-ivo",
    "u-ivo",
    105 * MINUTE,
    "Only the box glyphs. ASCII mode fixes it, and Windows Terminal is fine.",
  );
  add(
    "m-ivo-4",
    "c-dm-ivo",
    "u-ivo",
    12 * MINUTE,
    "I also checked the data path under LOCALAPPDATA. It stays out of the repository.",
  );

  // Group: Launch crew
  add(
    "m-launch-1",
    "c-grp-launch",
    "u-noor",
    3 * HOUR,
    "Release checklist is up. The only open item is the demo reset flow.",
  );
  add(
    "m-launch-2",
    "c-grp-launch",
    currentUserId,
    175 * MINUTE,
    "I can take that. It should be one explicit flag, not a hidden key.",
    {
      delivery: {
        status: "read",
        readBy: ["u-maya", "u-noor", "u-tess", "u-ivo"],
      },
    },
  );
  add(
    "m-launch-3",
    "c-grp-launch",
    "u-tess",
    170 * MINUTE,
    "Agreed. Accidental data loss is a terrible first impression.",
  );
  add(
    "m-launch-4",
    "c-grp-launch",
    "u-noor",
    165 * MINUTE,
    "Also, can we label the demo everywhere? I do not want anyone thinking this is a live workspace.",
  );
  add(
    "m-launch-5",
    "c-grp-launch",
    currentUserId,
    160 * MINUTE,
    "Yes: header badge, status line, and README.",
    {
      delivery: {
        status: "read",
        readBy: ["u-maya", "u-noor", "u-tess", "u-ivo"],
      },
    },
  );
  add("m-launch-6", "c-grp-launch", "u-noor", 155 * MINUTE, "Perfect.");
  add(
    "m-launch-thread",
    "c-grp-launch",
    "u-maya",
    60 * MINUTE,
    "Thread: what should search cover for v0.1?",
  );
  add(
    "m-launch-thread-r1",
    "c-grp-launch",
    "u-ivo",
    55 * MINUTE,
    "Message bodies, author names, and conversation names feels right.",
    { replyToId: "m-launch-thread" },
  );
  add(
    "m-launch-thread-r2",
    "c-grp-launch",
    "u-tess",
    50 * MINUTE,
    "Substring matching is enough. Keep ranking obvious: newest first.",
    { replyToId: "m-launch-thread" },
  );
  add(
    "m-launch-thread-r3",
    "c-grp-launch",
    currentUserId,
    45 * MINUTE,
    "Agreed. I will also jump directly into a thread when the hit is a reply.",
    {
      replyToId: "m-launch-thread",
      delivery: { status: "delivered", readBy: ["u-ivo", "u-tess"] },
    },
  );
  add(
    "m-launch-7",
    "c-grp-launch",
    "u-maya",
    18 * MINUTE,
    "I pushed tiny copy edits to the empty states. Nothing structural.",
  );

  // Group: Terminal nerds
  add(
    "m-term-1",
    "c-grp-terminal",
    "u-rafael",
    6 * HOUR,
    "Hot take: a terminal chat app should still feel like a terminal.",
  );
  add(
    "m-term-2",
    "c-grp-terminal",
    currentUserId,
    350 * MINUTE,
    "No fake browser chrome. Just good typography and clear focus.",
    {
      delivery: {
        status: "read",
        readBy: ["u-ivo", "u-rafael", "u-noor"],
      },
    },
  );
  add(
    "m-term-3",
    "c-grp-terminal",
    "u-ivo",
    340 * MINUTE,
    "And a real ASCII fallback. Not everyone runs Windows Terminal.",
  );
  add(
    "m-term-4",
    "c-grp-terminal",
    "u-rafael",
    2 * HOUR,
    "I tried the layout at 120x40. The extra room should not become a third rail.",
  );
  add(
    "m-term-5",
    "c-grp-terminal",
    "u-noor",
    50 * MINUTE,
    "Maybe the modal thread view is the right compromise.",
  );

  // Space: general
  add(
    "m-general-1",
    "c-sp-general",
    currentUserId,
    26 * HOUR,
    "Welcome to Pulsewire's local demo workspace. Everything here is generated on your machine.",
    {
      delivery: {
        status: "read",
        readBy: ["u-maya", "u-ivo", "u-noor", "u-tess", "u-rafael"],
      },
    },
  );
  add(
    "m-general-2",
    "c-sp-general",
    "u-maya",
    25 * HOUR,
    "It is a nice way to test the workflow without wiring up a server.",
  );
  add(
    "m-general-3",
    "c-sp-general",
    "u-rafael",
    5 * HOUR,
    "Reminder: demo replies are simulated. No network calls, no external accounts.",
  );
  add(
    "m-general-4",
    "c-sp-general",
    "u-tess",
    4 * HOUR,
    "This message was removed to demonstrate deletion.",
    { deletedAt: iso(3.9 * HOUR) },
  );
  add(
    "m-general-5",
    "c-sp-general",
    "u-noor",
    3 * HOUR,
    "Coffee run at 15:00. The good place, not the sad one.",
  );
  add(
    "m-general-6",
    "c-sp-general",
    currentUserId,
    2 * HOUR,
    "I will bring the launch notes.",
    { delivery: { status: "delivered", readBy: ["u-noor", "u-tess"] } },
  );

  // Space: design-lab
  add(
    "m-design-1",
    "c-sp-design",
    "u-tess",
    30 * HOUR,
    "New empty-state copy: 'No messages here yet. Start the conversation.' Short and calm.",
  );
  add(
    "m-design-2",
    "c-sp-design",
    "u-maya",
    28 * HOUR,
    "I like it. Can we keep the composer hint visible even when the list is empty?",
  );
  add(
    "m-design-3",
    "c-sp-design",
    currentUserId,
    3 * HOUR,
    "Done. The composer stays pinned.",
    { delivery: { status: "read", readBy: ["u-maya", "u-tess"] } },
  );
  add(
    "m-design-4",
    "c-sp-design",
    "u-tess",
    2 * HOUR,
    "The thread modal needs one more line of breathing room at 80x24. Right now the last reply " +
      "sits directly against the footer, and the scroll hint competes with the close hint. A little " +
      "space would make dense threads much easier to scan without making the box feel heavy.",
  );
  add(
    "m-design-5",
    "c-sp-design",
    "u-maya",
    110 * MINUTE,
    "Checking this now. I think the footer can absorb it without shrinking the transcript.",
  );

  return {
    version: DEMO_DATA_VERSION,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    currentUserId,
    users,
    conversations,
    messages,
  };
}

/** Validate untrusted JSON before it reaches the provider. */
export function parseDemoData(raw: string): DemoData {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ChatError("storage_corrupt", "The demo data file is not valid JSON.", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new ChatError("storage_corrupt", "The demo data file must contain a JSON object.");
  }
  if (value.version !== DEMO_DATA_VERSION) {
    throw new ChatError(
      "storage_corrupt",
      `Unsupported demo data version ${String(value.version)} (expected ${DEMO_DATA_VERSION}).`,
    );
  }
  if (
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.currentUserId !== "string"
  ) {
    throw new ChatError("storage_corrupt", "The demo data file is missing workspace metadata.");
  }
  if (!isRecord(value.users) || !isRecord(value.conversations) || !isRecord(value.messages)) {
    throw new ChatError(
      "storage_corrupt",
      "The demo data file is missing users, conversations, or messages.",
    );
  }

  const users = value.users as Record<string, unknown>;
  const conversations = value.conversations as Record<string, unknown>;
  const messages = value.messages as Record<string, unknown>;

  for (const [id, user] of Object.entries(users)) {
    if (
      !isRecord(user) || user.id !== id || typeof user.displayName !== "string" ||
      typeof user.handle !== "string"
    ) {
      throw new ChatError("storage_corrupt", `Invalid user record "${id}".`);
    }
  }
  if (!users[value.currentUserId]) {
    throw new ChatError("storage_corrupt", "The current user is missing from the demo data.");
  }

  for (const [id, conversation] of Object.entries(conversations)) {
    if (
      !isRecord(conversation) || conversation.id !== id || typeof conversation.name !== "string" ||
      !["dm", "group", "space"].includes(String(conversation.kind)) ||
      !Array.isArray(conversation.memberIds) ||
      conversation.memberIds.some((memberId) => typeof memberId !== "string" || !users[memberId])
    ) {
      throw new ChatError("storage_corrupt", `Invalid conversation record "${id}".`);
    }
  }

  for (const [id, message] of Object.entries(messages)) {
    if (
      !isRecord(message) || message.id !== id || typeof message.conversationId !== "string" ||
      !conversations[message.conversationId] || typeof message.authorId !== "string" ||
      !users[message.authorId] || typeof message.body !== "string" ||
      typeof message.createdAt !== "string"
    ) {
      throw new ChatError("storage_corrupt", `Invalid message record "${id}".`);
    }
    if (message.replyToId !== undefined) {
      if (typeof message.replyToId !== "string" || !messages[message.replyToId]) {
        throw new ChatError("storage_corrupt", `Message "${id}" replies to a missing message.`);
      }
    }
    if (message.delivery !== undefined) {
      if (
        !isRecord(message.delivery) ||
        !DELIVERY_STATUSES.includes(message.delivery.status as MessageDeliveryStatus)
      ) {
        throw new ChatError("storage_corrupt", `Message "${id}" has an invalid delivery state.`);
      }
      if (message.delivery.readBy !== undefined) {
        const conversationRecord = conversations[message.conversationId];
        const memberIds =
          isRecord(conversationRecord) && Array.isArray(conversationRecord.memberIds)
            ? conversationRecord.memberIds
            : [];
        if (
          !Array.isArray(message.delivery.readBy) ||
          message.delivery.readBy.some((userId) =>
            typeof userId !== "string" || !users[userId] || !memberIds.includes(userId)
          )
        ) {
          throw new ChatError(
            "storage_corrupt",
            `Message "${id}" lists a reader who is not in the conversation.`,
          );
        }
      }
      if (message.delivery.error !== undefined && typeof message.delivery.error !== "string") {
        throw new ChatError("storage_corrupt", `Message "${id}" has an invalid delivery error.`);
      }
    }
  }

  return value as unknown as DemoData;
}

export function cloneDemoData(data: DemoData): DemoData {
  return structuredClone(data);
}

export function slugHandle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
