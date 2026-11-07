const TOKEN_KEY = "pulsewire.admin.token";
const PAGE_SIZE = 20;
const EVENT_PAGE_SIZE = 40;
const REFRESH_INTERVAL_MS = 30_000;

const state = {
  token: readStoredToken(),
  user: null,
  view: "overview",
  loadSeq: 0,
  timer: null,
  users: { query: "", offset: 0, total: 0 },
  conversations: { query: "", offset: 0, total: 0 },
  activity: { type: "", nextBefore: null, loaded: 0 },
  conversation: { id: null, summary: null, nextBefore: null },
};

const els = {
  loginView: document.getElementById("login-view"),
  loginForm: document.getElementById("login-form"),
  loginHandle: document.getElementById("login-handle"),
  loginPassword: document.getElementById("login-password"),
  loginError: document.getElementById("login-error"),
  loginSubmit: document.getElementById("login-submit"),
  loginOrigin: document.getElementById("login-origin"),
  appView: document.getElementById("app-view"),
  accountAvatar: document.getElementById("account-avatar"),
  accountName: document.getElementById("account-name"),
  accountHandle: document.getElementById("account-handle"),
  logoutButton: document.getElementById("logout-button"),
  viewTitle: document.getElementById("view-title"),
  viewSubtitle: document.getElementById("view-subtitle"),
  statusPill: document.getElementById("status-pill"),
  statusText: document.getElementById("status-text"),
  refreshButton: document.getElementById("refresh-button"),
  panels: {
    overview: document.getElementById("panel-overview"),
    users: document.getElementById("panel-users"),
    conversations: document.getElementById("panel-conversations"),
    activity: document.getElementById("panel-activity"),
    guide: document.getElementById("panel-guide"),
  },
  navItems: Array.from(document.querySelectorAll(".nav-item[data-view]")),
  overviewCards: document.getElementById("overview-cards"),
  overviewConversations: document.getElementById("overview-conversations"),
  overviewActivity: document.getElementById("overview-activity"),
  usersSearch: document.getElementById("users-search"),
  usersCount: document.getElementById("users-count"),
  usersBody: document.getElementById("users-body"),
  usersEmpty: document.getElementById("users-empty"),
  usersPrev: document.getElementById("users-prev"),
  usersNext: document.getElementById("users-next"),
  usersPage: document.getElementById("users-page"),
  conversationsSearch: document.getElementById("conversations-search"),
  conversationsCount: document.getElementById("conversations-count"),
  conversationsBody: document.getElementById("conversations-body"),
  conversationsEmpty: document.getElementById("conversations-empty"),
  conversationsPrev: document.getElementById("conversations-prev"),
  conversationsNext: document.getElementById("conversations-next"),
  conversationsPage: document.getElementById("conversations-page"),
  activityFilter: document.getElementById("activity-filter"),
  activityList: document.getElementById("activity-list"),
  activityEmpty: document.getElementById("activity-empty"),
  activityCount: document.getElementById("activity-count"),
  activityHint: document.getElementById("activity-hint"),
  activityMore: document.getElementById("activity-more"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmMessage: document.getElementById("confirm-message"),
  confirmAccept: document.getElementById("confirm-accept"),
  conversationDialog: document.getElementById("conversation-dialog"),
  conversationTitle: document.getElementById("conversation-title"),
  conversationMeta: document.getElementById("conversation-meta"),
  conversationMessages: document.getElementById("conversation-messages"),
  conversationOlder: document.getElementById("conversation-older"),
  conversationDelete: document.getElementById("conversation-delete"),
  conversationClose: document.getElementById("conversation-close"),
  toastRegion: document.getElementById("toast-region"),
};

const VIEW_META = {
  overview: {
    title: "Overview",
    subtitle: "Server health and recent activity.",
  },
  users: {
    title: "Accounts",
    subtitle: "Manage people and administrator access.",
  },
  conversations: {
    title: "Conversations",
    subtitle: "Inspect direct messages, groups, and spaces.",
  },
  activity: {
    title: "Activity",
    subtitle: "Review the server's append-only event log.",
  },
  guide: {
    title: "Guide",
    subtitle: "Set up your server and connect your devices.",
  },
};

const EVENT_META = {
  "message-created": { glyph: "✉", label: "Message sent" },
  "message-updated": { glyph: "✎", label: "Message edited" },
  "message-deleted": { glyph: "×", label: "Message deleted" },
  "conversation-updated": { glyph: "▤", label: "Conversation changed" },
  "read": { glyph: "✓", label: "Read receipt" },
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const numberFormatter = new Intl.NumberFormat();

function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing modes may disable storage; the in-memory token still works.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : dateFormatter.format(date);
}

function formatRelative(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  if (diff < 45_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

function formatCount(value) {
  return numberFormatter.format(Number(value) || 0);
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${formatCount(count)} ${Number(count) === 1 ? singular : pluralForm}`;
}

function initials(user) {
  const source = (user.displayName || user.handle || "?").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "");
  return letters.slice(0, 2).toUpperCase();
}

function kindLabel(kind) {
  if (kind === "dm") return "Direct";
  if (kind === "space") return "Space";
  return "Group";
}

function shortId(id) {
  if (!id) return "";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function setStatus(mode, message) {
  els.statusPill.dataset.state = mode;
  els.statusText.textContent = message;
}

function toast(message, kind = "info") {
  const node = el("div", "toast", message);
  node.dataset.kind = kind;
  els.toastRegion.append(node);
  setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 180);
  }, kind === "error" ? 6_000 : 4_000);
}

function showLoginError(message) {
  els.loginError.textContent = message;
  els.loginError.hidden = !message;
}

function clearSession() {
  state.token = "";
  state.user = null;
  storeToken("");
  stopTimer();
  els.appView.hidden = true;
  els.loginView.hidden = false;
}

function showLogin(message) {
  clearSession();
  showLoginError(message ?? "");
  els.loginPassword.value = "";
  setTimeout(() => {
    if (els.loginHandle.value.trim()) els.loginPassword.focus();
    else els.loginHandle.focus();
  }, 0);
}

function sessionExpired() {
  if (!state.token) return;
  showLogin("Your session expired. Sign in again.");
}

async function request(path, options = {}) {
  const { method = "GET", body, auth = true } = options;
  const headers = { accept: "application/json" };
  if (auth && state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    });
  } catch {
    throw new Error("Could not reach the Pulsewire server. Check that it is running.");
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && auth) sessionExpired();
    const message = data?.error?.message ?? `The server returned HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(() => {
    if (document.hidden) return;
    if (state.view === "overview") loadView();
  }, REFRESH_INTERVAL_MS);
}

function stopTimer() {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

async function enterApp() {
  els.loginView.hidden = true;
  els.appView.hidden = false;
  els.accountName.textContent = state.user.displayName;
  els.accountHandle.textContent = `@${state.user.handle}`;
  els.accountAvatar.textContent = initials(state.user);
  startTimer();
  await setView("overview");
}

function setAccountView(view) {
  const meta = VIEW_META[view];
  if (!meta) return;
  state.view = view;
  els.viewTitle.textContent = meta.title;
  els.viewSubtitle.textContent = meta.subtitle;
  for (const item of els.navItems) {
    item.classList.toggle("is-active", item.dataset.view === view);
  }
  for (const [name, panel] of Object.entries(els.panels)) {
    panel.hidden = name !== view;
  }
}

async function setView(view) {
  if (!VIEW_META[view]) return;
  setAccountView(view);
  await loadView();
}

async function loadView() {
  const seq = ++state.loadSeq;
  setStatus("busy", "Loading…");
  try {
    if (state.view === "overview") await loadOverview(seq);
    else if (state.view === "users") await loadUsers(seq);
    else if (state.view === "conversations") await loadConversations(seq);
    else if (state.view === "activity") await loadActivity(seq, { reset: true });
    if (seq !== state.loadSeq) return;
    setStatus("ready", "Ready");
  } catch (error) {
    if (seq !== state.loadSeq) return;
    setStatus("error", "Error");
    showPanelError(error.message);
    toast(error.message, "error");
  }
}

function showPanelError(message) {
  if (state.view === "overview") {
    els.overviewCards.replaceChildren(errorCard("Could not load the overview", message));
    els.overviewConversations.replaceChildren(emptyMessage(message));
    els.overviewActivity.replaceChildren(emptyMessage(message));
    return;
  }
  if (state.view === "users") {
    els.usersBody.replaceChildren();
    setEmpty(els.usersEmpty, "Could not load accounts", message);
    els.usersPage.textContent = "";
    els.usersPrev.disabled = true;
    els.usersNext.disabled = true;
    return;
  }
  if (state.view === "conversations") {
    els.conversationsBody.replaceChildren();
    setEmpty(els.conversationsEmpty, "Could not load conversations", message);
    els.conversationsPage.textContent = "";
    els.conversationsPrev.disabled = true;
    els.conversationsNext.disabled = true;
    return;
  }
  if (state.view === "activity") {
    els.activityList.replaceChildren();
    setEmpty(els.activityEmpty, "Could not load activity", message);
    els.activityHint.textContent = "";
    els.activityMore.hidden = true;
  }
}

function errorCard(title, detail) {
  const card = el("div", "stat-card");
  card.append(el("span", "stat-label", title), el("span", "stat-note", detail));
  return card;
}

function emptyMessage(message) {
  return el("div", "empty-state", message);
}

function setEmpty(node, title, detail) {
  node.hidden = false;
  const strong = node.querySelector("strong");
  const span = node.querySelector("span");
  if (strong) strong.textContent = title;
  if (span) span.textContent = detail;
}

/* Overview --------------------------------------------------------------- */

async function loadOverview(seq) {
  const [summary, conversations, events] = await Promise.all([
    request("/v1/admin/overview"),
    request(`/v1/admin/conversations?limit=5`),
    request(`/v1/admin/events?limit=6`),
  ]);
  if (seq !== state.loadSeq) return;
  renderOverviewCards(summary.overview);
  renderOverviewConversations(conversations.conversations);
  renderOverviewActivity(events.events);
}

function renderOverviewCards(overview) {
  const cards = [
    {
      label: "Accounts",
      glyph: "◇",
      value: overview.users,
      note: `${plural(overview.admins, "administrator")}`,
      tone: "warm",
    },
    {
      label: "Conversations",
      glyph: "▤",
      value: overview.conversations,
      note: `${formatCount(overview.groups)} groups · ${formatCount(overview.dms)} DMs`,
      tone: "blue",
    },
    {
      label: "Messages",
      glyph: "✉",
      value: overview.messages,
      note: `${formatCount(overview.messagesLast24h)} in the last 24 hours`,
      tone: "",
    },
    {
      label: "Activity events",
      glyph: "≡",
      value: overview.events,
      note: `${formatCount(overview.deletedMessages)} deleted messages`,
      tone: "rose",
    },
  ];

  const nodes = cards.map((card) => {
    const node = el("article", "stat-card");
    if (card.tone) node.dataset.tone = card.tone;
    const label = el("span", "stat-label");
    label.append(el("span", "stat-glyph", card.glyph), document.createTextNode(card.label));
    node.append(
      label,
      el("strong", "stat-value", formatCount(card.value)),
      el("span", "stat-note", card.note),
    );
    return node;
  });
  els.overviewCards.replaceChildren(...nodes);
}

function renderOverviewConversations(conversations) {
  if (conversations.length === 0) {
    els.overviewConversations.replaceChildren(emptyMessage("No conversations yet."));
    return;
  }
  const nodes = conversations.map((conversation) => {
    const item = el("div", "mini-item");
    const main = el("div", "mini-main");
    main.append(
      el("strong", "mini-title", conversation.name),
      el(
        "span",
        "mini-meta",
        `${kindLabel(conversation.kind)} · ${plural(conversation.memberCount, "member")} · ` +
          `${plural(conversation.messageCount, "message")}`,
      ),
    );
    item.append(main, el("span", "mini-badge", kindLabel(conversation.kind)));
    return item;
  });
  els.overviewConversations.replaceChildren(...nodes);
}

function eventTitle(event) {
  const actor = event.actor ? `@${event.actor.handle}` : "Someone";
  const where = event.conversationName
    ? `“${event.conversationName}”`
    : event.conversationId
    ? "a conversation"
    : "the server";
  switch (event.type) {
    case "message-created":
      return `${actor} sent a message in ${where}`;
    case "message-updated":
      return `${actor} edited a message in ${where}`;
    case "message-deleted":
      return `${actor} deleted a message in ${where}`;
    case "conversation-updated":
      return event.conversationId === null
        ? `${actor} removed a conversation`
        : `${actor} updated ${where}`;
    case "read":
      return `${actor} read messages in ${where}`;
    default:
      return `Activity in ${where}`;
  }
}

function renderOverviewActivity(events) {
  if (events.length === 0) {
    els.overviewActivity.replaceChildren(emptyMessage("No activity yet."));
    return;
  }
  const nodes = events.map((event) => {
    const item = el("div", "mini-item");
    const main = el("div", "mini-main");
    main.append(
      el("strong", "mini-title", eventTitle(event)),
      el("span", "mini-meta", formatRelative(event.createdAt)),
    );
    item.append(main, el("span", "mini-badge", EVENT_META[event.type]?.label ?? "Event"));
    return item;
  });
  els.overviewActivity.replaceChildren(...nodes);
}

/* Accounts --------------------------------------------------------------- */

async function loadUsers(seq) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(state.users.offset),
  });
  if (state.users.query) params.set("query", state.users.query);
  const data = await request(`/v1/admin/users?${params.toString()}`);
  if (seq !== state.loadSeq) return;
  renderUsers(data);
}

function renderUsers(data) {
  state.users.total = Number(data.total) || 0;
  els.usersBody.replaceChildren();

  if (data.users.length === 0) {
    setEmpty(els.usersEmpty, "No accounts found", "Try a different search or page.");
  } else {
    els.usersEmpty.hidden = true;
    const rows = data.users.map((user) => userRow(user));
    els.usersBody.append(...rows);
  }

  els.usersCount.textContent = `${plural(state.users.total, "account")}`;
  const start = data.users.length === 0 ? 0 : state.users.offset + 1;
  const end = state.users.offset + data.users.length;
  els.usersPage.textContent = `${start}–${end} of ${formatCount(state.users.total)}`;
  els.usersPrev.disabled = state.users.offset <= 0;
  els.usersNext.disabled = state.users.offset + PAGE_SIZE >= state.users.total;
}

function userRow(user) {
  const row = document.createElement("tr");

  const accountCell = el("td");
  const account = el("div", "cell-account");
  account.append(el("div", "avatar", initials(user)));
  const stack = el("div", "cell-stack");
  const name = el("strong");
  name.append(document.createTextNode(user.displayName));
  if (state.user && user.id === state.user.id) {
    name.append(el("span", "badge badge-you", "You"));
  }
  stack.append(name, el("span", "", `@${user.handle}`));
  account.append(stack);
  accountCell.append(account);

  const roleCell = el("td");
  roleCell.append(
    el(
      "span",
      `badge ${user.isAdmin ? "badge-admin" : "badge-member"}`,
      user.isAdmin ? "Admin" : "Member",
    ),
  );

  const conversationsCell = el("td", "num", formatCount(user.conversationCount));
  const messagesCell = el("td", "num", formatCount(user.messageCount));
  const joinedCell = el("td", "", formatDate(user.createdAt));

  const actionsCell = el("td", "actions-col");
  const actions = el("div", "cell-actions");
  const toggle = button(
    `button button-small ${user.isAdmin ? "button-secondary" : "button-primary"}`,
    user.isAdmin ? "Remove admin" : "Make admin",
    () => toggleAdmin(user, toggle),
  );
  actions.append(toggle);
  actionsCell.append(actions);

  row.append(accountCell, roleCell, conversationsCell, messagesCell, joinedCell, actionsCell);
  return row;
}

async function toggleAdmin(user, toggle) {
  if (user.isAdmin) {
    const confirmed = await confirmAction({
      title: "Remove administrator access?",
      message: `@${user.handle} will no longer be able to open this dashboard or use admin APIs.`,
      confirmLabel: "Remove access",
    });
    if (!confirmed) return;
  }

  const originalLabel = toggle.textContent;
  toggle.disabled = true;
  toggle.textContent = "Saving…";
  try {
    const data = await request(`/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: { isAdmin: !user.isAdmin },
    });
    toast(
      `@${user.handle} ${
        data.user.isAdmin ? "is now an administrator" : "is no longer an administrator"
      }.`,
      "success",
    );
    if (state.user && data.user.id === state.user.id && !data.user.isAdmin) {
      showLogin("You removed your own administrator access. Sign in with another administrator.");
      return;
    }
    await loadView();
  } catch (error) {
    toast(error.message, "error");
    toggle.disabled = false;
    toggle.textContent = originalLabel;
  }
}

/* Conversations ---------------------------------------------------------- */

async function loadConversations(seq) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(state.conversations.offset),
  });
  if (state.conversations.query) params.set("query", state.conversations.query);
  const data = await request(`/v1/admin/conversations?${params.toString()}`);
  if (seq !== state.loadSeq) return;
  renderConversations(data);
}

function renderConversations(data) {
  state.conversations.total = Number(data.total) || 0;
  els.conversationsBody.replaceChildren();

  if (data.conversations.length === 0) {
    setEmpty(els.conversationsEmpty, "No conversations found", "Try a different search or page.");
  } else {
    els.conversationsEmpty.hidden = true;
    els.conversationsBody.append(
      ...data.conversations.map((conversation) => conversationRow(conversation)),
    );
  }

  els.conversationsCount.textContent = `${plural(state.conversations.total, "conversation")}`;
  const start = data.conversations.length === 0 ? 0 : state.conversations.offset + 1;
  const end = state.conversations.offset + data.conversations.length;
  els.conversationsPage.textContent = `${start}–${end} of ${
    formatCount(state.conversations.total)
  }`;
  els.conversationsPrev.disabled = state.conversations.offset <= 0;
  els.conversationsNext.disabled = state.conversations.offset + PAGE_SIZE >=
    state.conversations.total;
}

function conversationRow(conversation) {
  const row = document.createElement("tr");

  const nameCell = el("td");
  const stack = el("div", "cell-stack");
  stack.append(
    el("strong", "", conversation.name),
    el(
      "span",
      "",
      conversation.topic ? conversation.topic : `Created by @${conversation.createdBy.handle}`,
    ),
  );
  nameCell.append(stack);

  const kindCell = el("td");
  kindCell.append(
    el("span", `badge badge-${conversation.kind}`, kindLabel(conversation.kind)),
  );

  const membersCell = el("td", "num", formatCount(conversation.memberCount));
  const messagesCell = el("td", "num", formatCount(conversation.messageCount));
  const updatedCell = el(
    "td",
    "",
    formatDate(conversation.lastMessageAt ?? conversation.updatedAt),
  );

  const actionsCell = el("td", "actions-col");
  const actions = el("div", "cell-actions");
  actions.append(
    button("button button-small button-secondary", "View", () => openConversation(conversation)),
    button("button button-small button-danger", "Delete", () => {
      deleteConversation(conversation);
    }),
  );
  actionsCell.append(actions);

  row.append(nameCell, kindCell, membersCell, messagesCell, updatedCell, actionsCell);
  return row;
}

async function deleteConversation(conversation) {
  const confirmed = await confirmAction({
    title: "Delete this conversation?",
    message:
      `“${conversation.name}” and all of its messages will be permanently removed for everyone. ` +
      "This cannot be undone.",
    confirmLabel: "Delete conversation",
  });
  if (!confirmed) return;

  try {
    await request(`/v1/admin/conversations/${encodeURIComponent(conversation.id)}`, {
      method: "DELETE",
    });
    if (state.conversation.id === conversation.id) {
      state.conversation = { id: null, summary: null, nextBefore: null };
      if (els.conversationDialog.open) els.conversationDialog.close();
    }
    toast(`Deleted “${conversation.name}”.`, "success");
    await loadView();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openConversation(conversation) {
  if (els.conversationDialog.open) els.conversationDialog.close();
  state.conversation = {
    id: conversation.id,
    summary: conversation,
    nextBefore: null,
  };
  els.conversationTitle.textContent = conversation.name;
  els.conversationMeta.textContent =
    `${kindLabel(conversation.kind)} · ${plural(conversation.memberCount, "member")} · ` +
    `created by @${conversation.createdBy.handle}`;
  els.conversationOlder.hidden = true;
  els.conversationMessages.replaceChildren(
    el("p", "message-placeholder", "Loading messages…"),
  );
  els.conversationDelete.disabled = false;
  els.conversationDialog.showModal();

  try {
    const data = await request(
      `/v1/admin/conversations/${encodeURIComponent(conversation.id)}/messages?limit=50`,
    );
    if (state.conversation.id !== conversation.id) return;
    els.conversationMessages.replaceChildren();
    if (data.messages.length === 0) {
      els.conversationMessages.append(
        el("p", "message-placeholder", "This conversation has no messages."),
      );
    } else {
      appendMessages(data.messages, false);
    }
    state.conversation.nextBefore = data.nextBefore ?? null;
    els.conversationOlder.hidden = !data.hasMore;
  } catch (error) {
    if (state.conversation.id !== conversation.id) return;
    els.conversationMessages.replaceChildren(
      el("p", "message-placeholder", error.message),
    );
    toast(error.message, "error");
  }
}

function messageNode(message) {
  const article = el("article", "message");
  article.append(el("div", "avatar", initials(message.author)));

  const body = el("div", "message-body");
  const head = el("div", "message-head");
  head.append(
    el("span", "message-author", message.author.displayName),
    el("span", "message-handle", `@${message.author.handle}`),
    el("span", "message-time", formatDate(message.createdAt)),
  );
  if (message.editedAt) head.append(el("span", "message-edited", "edited"));

  const text = el(
    "p",
    `message-text${message.deletedAt ? " is-deleted" : ""}`,
    message.deletedAt ? "Message deleted" : message.body,
  );
  body.append(head, text);
  article.append(body);
  return article;
}

function appendMessages(messages, prepend) {
  const placeholder = els.conversationMessages.querySelector(".message-placeholder");
  if (placeholder) placeholder.remove();

  const fragment = document.createDocumentFragment();
  for (const message of messages) fragment.append(messageNode(message));
  if (prepend) els.conversationMessages.prepend(fragment);
  else els.conversationMessages.append(fragment);
}

async function loadOlderMessages() {
  const { id, nextBefore } = state.conversation;
  if (!id || nextBefore === null) return;

  const previousHeight = els.conversationMessages.scrollHeight;
  els.conversationOlder.disabled = true;
  els.conversationOlder.textContent = "Loading…";
  try {
    const data = await request(
      `/v1/admin/conversations/${encodeURIComponent(id)}/messages?limit=50&before=${nextBefore}`,
    );
    if (state.conversation.id !== id) return;
    appendMessages(data.messages, true);
    state.conversation.nextBefore = data.nextBefore ?? null;
    els.conversationOlder.hidden = !data.hasMore;
    els.conversationMessages.scrollTop += els.conversationMessages.scrollHeight - previousHeight;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    els.conversationOlder.disabled = false;
    els.conversationOlder.textContent = "Load older messages";
  }
}

async function deleteOpenConversation() {
  const conversation = state.conversation.summary;
  if (!conversation) return;
  els.conversationDelete.disabled = true;
  try {
    await deleteConversation(conversation);
  } finally {
    els.conversationDelete.disabled = false;
  }
}

/* Activity --------------------------------------------------------------- */

async function loadActivity(seq, { reset }) {
  const params = new URLSearchParams({ limit: String(EVENT_PAGE_SIZE) });
  if (state.activity.type) params.set("type", state.activity.type);
  if (!reset && state.activity.nextBefore !== null) {
    params.set("before", String(state.activity.nextBefore));
  }
  const data = await request(`/v1/admin/events?${params.toString()}`);
  if (seq !== state.loadSeq) return;

  if (reset) {
    els.activityList.replaceChildren();
    state.activity.loaded = 0;
  }

  if (data.events.length === 0 && state.activity.loaded === 0) {
    setEmpty(
      els.activityEmpty,
      state.activity.type ? "No matching events" : "No activity yet",
      state.activity.type
        ? "Try a different event type."
        : "Events appear here as people use the server.",
    );
  } else {
    els.activityEmpty.hidden = true;
  }

  const items = data.events.map((event) => activityItem(event));
  els.activityList.append(...items);
  state.activity.loaded += data.events.length;
  state.activity.nextBefore = data.nextBefore ?? null;

  els.activityCount.textContent = `${plural(state.activity.loaded, "event")} loaded`;
  els.activityHint.textContent = data.nextBefore
    ? `Newest first · more events available`
    : `Newest first · start of the log`;
  els.activityMore.hidden = !data.nextBefore;
}

function activityItem(event) {
  const meta = EVENT_META[event.type] ?? { glyph: "•", label: "Event" };
  const item = el("li", "timeline-item");
  item.dataset.type = event.type;

  const dot = el("span", "timeline-dot", meta.glyph);

  const main = el("div", "timeline-main");
  const title = el("div", "timeline-title");
  title.append(
    document.createTextNode(eventTitle(event)),
    el("span", "timeline-time", formatRelative(event.createdAt)),
  );

  const details = [];
  if (event.messageId) details.push(`Message ${shortId(event.messageId)}`);
  if (event.conversationId) details.push(`Conversation ${shortId(event.conversationId)}`);
  if (event.actor) details.push(`@${event.actor.handle}`);
  details.push(formatDate(event.createdAt));

  const metaLine = el("div", "timeline-meta", details.join(" · "));
  main.append(title, metaLine);
  item.append(dot, main);
  return item;
}

async function loadMoreActivity() {
  if (state.activity.nextBefore === null) return;
  const seq = ++state.loadSeq;
  els.activityMore.disabled = true;
  els.activityMore.textContent = "Loading…";
  try {
    await loadActivity(seq, { reset: false });
    if (seq !== state.loadSeq) return;
  } catch (error) {
    if (seq === state.loadSeq) toast(error.message, "error");
  } finally {
    els.activityMore.disabled = false;
    els.activityMore.textContent = "Load older";
  }
}

/* Confirmation ----------------------------------------------------------- */

function confirmAction({ title, message, confirmLabel }) {
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.confirmAccept.textContent = confirmLabel;
  els.confirmDialog.returnValue = "";
  els.confirmDialog.showModal();

  return new Promise((resolve) => {
    const onClose = () => {
      els.confirmDialog.removeEventListener("close", onClose);
      resolve(els.confirmDialog.returnValue === "confirm");
    };
    els.confirmDialog.addEventListener("close", onClose);
  });
}

/* Events ---------------------------------------------------------------- */

function debounce(callback, delay = 280) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(callback, delay);
  };
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showLoginError("");
  const handle = els.loginHandle.value.trim();
  const password = els.loginPassword.value;
  if (!handle || !password) {
    showLoginError("Enter your handle and password.");
    return;
  }

  els.loginSubmit.disabled = true;
  els.loginSubmit.textContent = "Signing in…";
  try {
    const data = await request("/v1/auth/login", {
      method: "POST",
      auth: false,
      body: { handle, password },
    });
    if (!data?.user?.isAdmin) {
      if (data?.token) {
        try {
          await fetch("/v1/auth/logout", {
            method: "POST",
            headers: { authorization: `Bearer ${data.token}` },
          });
        } catch {
          // Revoking the token is best-effort on a failed dashboard login.
        }
      }
      showLoginError("That account does not have administrator access.");
      return;
    }

    state.token = data.token;
    state.user = data.user;
    storeToken(data.token);
    els.loginForm.reset();
    await enterApp();
  } catch (error) {
    showLoginError(error.message);
  } finally {
    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = "Sign in";
  }
});

els.logoutButton.addEventListener("click", async () => {
  els.logoutButton.disabled = true;
  try {
    await request("/v1/auth/logout", { method: "POST" });
  } catch {
    // The local session is discarded even if the server cannot be reached.
  } finally {
    els.logoutButton.disabled = false;
    showLogin("You signed out.");
  }
});

els.refreshButton.addEventListener("click", () => loadView());

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const viewButton = target.closest("[data-view]");
  if (!viewButton || viewButton.classList.contains("nav-item")) return;
  const view = viewButton.dataset.view;
  if (view && VIEW_META[view]) setView(view);
});

els.navItems.forEach((item) => {
  item.addEventListener("click", () => {
    if (item.dataset.view) setView(item.dataset.view);
  });
});

els.usersSearch.addEventListener(
  "input",
  debounce(() => {
    state.users.query = els.usersSearch.value.trim();
    state.users.offset = 0;
    if (state.view === "users") loadView();
  }),
);

els.conversationsSearch.addEventListener(
  "input",
  debounce(() => {
    state.conversations.query = els.conversationsSearch.value.trim();
    state.conversations.offset = 0;
    if (state.view === "conversations") loadView();
  }),
);

els.usersPrev.addEventListener("click", () => {
  state.users.offset = Math.max(0, state.users.offset - PAGE_SIZE);
  loadView();
});

els.usersNext.addEventListener("click", () => {
  state.users.offset += PAGE_SIZE;
  loadView();
});

els.conversationsPrev.addEventListener("click", () => {
  state.conversations.offset = Math.max(0, state.conversations.offset - PAGE_SIZE);
  loadView();
});

els.conversationsNext.addEventListener("click", () => {
  state.conversations.offset += PAGE_SIZE;
  loadView();
});

els.activityFilter.addEventListener("change", () => {
  state.activity.type = els.activityFilter.value;
  state.activity.nextBefore = null;
  loadView();
});

els.activityMore.addEventListener("click", () => loadMoreActivity());

els.conversationOlder.addEventListener("click", () => loadOlderMessages());
els.conversationDelete.addEventListener("click", () => deleteOpenConversation());
els.conversationClose.addEventListener("click", () => els.conversationDialog.close());

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.user && state.view === "overview") loadView();
});

async function init() {
  els.loginOrigin.textContent = location.origin;
  if (!state.token) {
    showLogin("");
    return;
  }

  try {
    const data = await request("/v1/me");
    if (!data?.user?.isAdmin) {
      showLogin("That account does not have administrator access.");
      return;
    }
    state.user = data.user;
    await enterApp();
  } catch (error) {
    if (error.status === 401) {
      showLogin("Your session expired. Sign in again.");
      return;
    }
    // Keep the stored token during a transient outage; a reload can retry it.
    els.appView.hidden = true;
    els.loginView.hidden = false;
    showLoginError(error.message);
  }
}

init();
