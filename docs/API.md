# Pulsewire HTTP API

All endpoints are under `/v1` unless noted. Requests and responses are JSON (`UTF-8`), except
`204 No Content` responses. The API is the platform boundary for the Linux terminal client and for
future Windows and Android clients.

Base URL in the examples:

```sh
export PULSEWIRE_URL=http://127.0.0.1:8787
```

## Authentication

Protected endpoints require a bearer token:

```http
Authorization: Bearer <session-token>
```

Get a token with `POST /v1/auth/register` or `POST /v1/auth/login`. Tokens are random 256-bit
values. The server stores only a SHA-256 hash of each token. Sessions expire after 30 days by
default (`PULSEWIRE_SESSION_TTL_DAYS`).

Passwords are never returned. Registration and sign-in requests must use TLS in any deployment that
leaves the local machine.

## Errors

Errors use a consistent envelope:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Messages cannot be empty."
  }
}
```

| Status | Code            | Meaning                                                    |
| ------ | --------------- | ---------------------------------------------------------- |
| 400    | `invalid_input` | Malformed JSON, missing field, or failed validation        |
| 401    | `auth_required` | Missing, invalid, or expired session                       |
| 403    | `forbidden`     | Authenticated but not allowed, or not an administrator     |
| 404    | `not_found`     | Missing resource, or a conversation the caller cannot see  |
| 409    | `conflict`      | Handle or membership already exists, or last admin removal |
| 413    | `invalid_input` | Request body larger than 64 KiB                            |
| 429    | `rate_limited`  | Too many failed sign-in attempts                           |
| 500    | `internal`      | Unexpected server failure                                  |

Non-members receive `404`, not `403`, when reading a conversation or message. This avoids disclosing
whether a private conversation exists.

## Health

```sh
curl "$PULSEWIRE_URL/health"
```

```json
{ "status": "ok" }
```

No authentication is required.

## Accounts

### Register

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/auth/register" \
  -H 'content-type: application/json' \
  -d '{"handle":"alice","displayName":"Alice","password":"correct horse battery"}'
```

`201 Created`:

```json
{
  "user": { "id": "u_...", "handle": "alice", "displayName": "Alice" },
  "token": "<session-token>",
  "expiresAt": "2026-12-05T12:00:00.000Z"
}
```

Handles are 3–32 characters of lowercase letters, numbers, or underscores. Passwords must be at
least 10 characters. Display names are 1–40 characters.

### Login

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"handle":"alice","password":"correct horse battery"}'
```

Returns the same shape as registration. A wrong handle and a wrong password produce the same `401`
message. Ten failures per handle in five minutes are allowed before `429`.

### Logout

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/auth/logout" \
  -H "authorization: Bearer $TOKEN"
```

`204 No Content`. The token is deleted server-side.

## Profile

```sh
curl -sS "$PULSEWIRE_URL/v1/me" -H "authorization: Bearer $TOKEN"
```

```json
{ "user": { "id": "u_...", "handle": "alice", "displayName": "Alice" } }
```

Update either field:

```sh
curl -sS -X PATCH "$PULSEWIRE_URL/v1/me" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"displayName":"Alice A.","handle":"alice_a"}'
```

## Users

Search for people to invite:

```sh
curl -sS "$PULSEWIRE_URL/v1/users?query=bo" \
  -H "authorization: Bearer $TOKEN"
```

```json
{ "users": [{ "id": "u_...", "handle": "bob", "displayName": "Bob" }] }
```

The result excludes the caller and is limited to 20 accounts.

## Conversations

### List

```sh
curl -sS "$PULSEWIRE_URL/v1/conversations" \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "conversations": [
    {
      "id": "c_...",
      "kind": "group",
      "name": "Release",
      "members": [
        { "id": "u_...", "handle": "alice", "displayName": "Alice" },
        { "id": "u_...", "handle": "bob", "displayName": "Bob" }
      ],
      "unreadCount": 1,
      "lastActivityAt": "2026-11-05T19:39:00.000Z",
      "lastMessagePreview": "Ship it tomorrow",
      "lastMessageAt": "2026-11-05T19:39:00.000Z"
    }
  ]
}
```

Sorted by most recent activity.

### Create a direct message

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/conversations" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"dm","memberHandles":["bob"]}'
```

A DM is idempotent per pair. If it already exists, the existing conversation is returned with `200`;
otherwise `201`.

### Create a group

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/conversations" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"group","name":"Release","topic":"Shipping","memberHandles":["bob","carol"]}'
```

`kind` may be `dm`, `group`, or `space`. The caller becomes the owner.

### Get one conversation

```sh
curl -sS "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID" \
  -H "authorization: Bearer $TOKEN"
```

### Messages

```sh
# Most recent page (oldest-to-newest within the page)
curl -sS "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/messages?limit=50" \
  -H "authorization: Bearer $TOKEN"

# Older page: pass the nextBefore value from the previous response
curl -sS "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/messages?limit=50&before=120" \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "messages": [
    {
      "id": "m_...",
      "conversationId": "c_...",
      "author": { "id": "u_...", "handle": "alice", "displayName": "Alice" },
      "body": "Ship it tomorrow",
      "createdAt": "2026-11-05T19:39:00.000Z",
      "delivery": { "status": "read", "readBy": ["u_..."] }
    }
  ],
  "hasMore": true,
  "nextBefore": 121
}
```

- `limit` is 1–100 and defaults to 50.
- `before` is an exclusive message sequence cursor.
- Messages are ordered oldest to newest within the page.
- `nextBefore` is present only when older messages exist.
- `delivery` appears for the caller's own messages. `read` means at least one other member's read
  cursor is at or beyond that message.
- Deleted messages have an empty `body` and a `deletedAt` timestamp.

### Send a message

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/messages" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"Hello","replyToId":"m_..."}'
```

`201 Created` with `{ "message": { ... } }`. `replyToId` is optional. Messages are trimmed, must be
1–4000 characters, and must not contain control characters. A failed send returns an error; clients
must not discard the draft.

### Read state

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/read" \
  -H "authorization: Bearer $TOKEN"
```

Returns `{ "conversation": { ... } }` with `unreadCount` recalculated.

### Members

```sh
curl -sS "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/members" \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "members": [
    {
      "user": { "id": "u_...", "handle": "alice", "displayName": "Alice" },
      "role": "owner",
      "lastReadSeq": 12
    },
    {
      "user": { "id": "u_...", "handle": "bob", "displayName": "Bob" },
      "role": "member",
      "lastReadSeq": 11
    }
  ]
}
```

Invite someone:

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/members" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"handle":"bob"}'
```

`201 Created` with the updated conversation. DMs cannot gain members.

Remove someone:

```sh
curl -sS -X DELETE "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/members/$USER_ID" \
  -H "authorization: Bearer $TOKEN"
```

`204 No Content`. Only the owner may remove other members; members may remove themselves. If the
owner leaves, ownership transfers to the earliest remaining member.

Leave:

```sh
curl -sS -X POST "$PULSEWIRE_URL/v1/conversations/$CONVERSATION_ID/leave" \
  -H "authorization: Bearer $TOKEN"
```

`204 No Content`. A conversation with no members is deleted.

## Messages

### Edit

```sh
curl -sS -X PATCH "$PULSEWIRE_URL/v1/messages/$MESSAGE_ID" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"Updated text"}'
```

Only the author can edit. Deleted messages cannot be edited.

### Delete

```sh
curl -sS -X DELETE "$PULSEWIRE_URL/v1/messages/$MESSAGE_ID" \
  -H "authorization: Bearer $TOKEN"
```

`204 No Content`. Only the author can delete. The message row remains as a tombstone so history and
event ordering stay stable.

### Thread

```sh
curl -sS "$PULSEWIRE_URL/v1/messages/$MESSAGE_ID/thread" \
  -H "authorization: Bearer $TOKEN"
```

Returns `{ "messages": [...] }` with the thread root and all descendants in sequence order.

## Search

```sh
curl -sS "$PULSEWIRE_URL/v1/search?query=release" \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "results": [
    {
      "message": { "...": "message object" },
      "conversation": { "...": "conversation object" },
      "snippet": "…the release plan…"
    }
  ]
}
```

Only messages in conversations the caller currently belongs to, and that are not deleted, are
searched. Results are newest first and capped at 50.

## Events

Clients poll an append-only event log. The sequence is monotonic and shared by the server.

Get the current head before polling:

```sh
curl -sS "$PULSEWIRE_URL/v1/events/head" \
  -H "authorization: Bearer $TOKEN"
```

```json
{ "seq": 42 }
```

Fetch changes after a cursor:

```sh
curl -sS "$PULSEWIRE_URL/v1/events?after=42&limit=100" \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "events": [
    {
      "seq": 43,
      "type": "message-created",
      "conversationId": "c_...",
      "messageId": "m_...",
      "message": { "...": "message object" },
      "actorId": "u_...",
      "createdAt": "2026-11-05T19:39:00.000Z"
    }
  ],
  "nextSeq": 43
}
```

Event types: `message-created`, `message-updated`, `message-deleted`, `conversation-updated`, and
`read`. Events are filtered by the caller's current memberships. Feed `nextSeq` into the next
request as `after`.

The terminal client polls every 1.5 seconds by default. The event feed is deliberately simple so SSE
or WebSocket transport can replace polling later without changing the UI or data model. A future
Android client should use push or a foreground refresh policy rather than tight polling.

## Management dashboard

The server also serves an HTML, CSS, and JavaScript dashboard from the same origin:

| Path                                         | Asset          |
| -------------------------------------------- | -------------- |
| `/admin`, `/admin/`, `/admin/index.html`     | Dashboard page |
| `/admin/styles.css` (alias `/admin/app.css`) | Stylesheet     |
| `/admin/app.js`                              | Client script  |

Assets are public so the page can load before sign-in; they set a strict Content Security Policy,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a no-referrer policy. Every
`/v1/admin/*` API below requires an authenticated account with the administrator flag. A
non-administrator receives `403 forbidden` with the message “Administrator access is required.”
Authentication failures still return `401`.

The first account registered on a fresh database becomes an administrator. At startup the server
promotes the oldest account if no administrator exists, and `PULSEWIRE_ADMIN_HANDLE` promotes the
named existing account. If that handle does not exist, the server refuses to start.

### Overview

```sh
curl -sS "$PULSEWIRE_URL/v1/admin/overview" -H "authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "overview": {
    "users": 4,
    "admins": 1,
    "conversations": 3,
    "groups": 2,
    "dms": 1,
    "messages": 57,
    "deletedMessages": 2,
    "events": 83,
    "messagesLast24h": 12
  }
}
```

`GET /v1/admin` is an alias for the same response.

### Accounts

```sh
curl -sS "$PULSEWIRE_URL/v1/admin/users?query=bo&limit=20&offset=0" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "users": [
    {
      "id": "u_...",
      "handle": "bob",
      "displayName": "Bob",
      "isAdmin": false,
      "createdAt": "2026-11-05T19:39:00.000Z",
      "conversationCount": 2,
      "messageCount": 14
    }
  ],
  "total": 1
}
```

`query` matches handles and display names. `limit` is 1–100 (default 50) and `offset` is
non-negative. Results are newest accounts first.

Promote or demote an account:

```sh
curl -sS -X PATCH "$PULSEWIRE_URL/v1/admin/users/$USER_ID" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"isAdmin":true}'
```

Returns `{ "user": { ... } }` with the updated flag. Demoting the last remaining administrator is
rejected with `409 conflict` and “At least one administrator must remain.” Accounts cannot be
deleted through the dashboard.

### Conversations

```sh
curl -sS "$PULSEWIRE_URL/v1/admin/conversations?query=release&limit=20&offset=0" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "conversations": [
    {
      "id": "c_...",
      "kind": "group",
      "name": "Release",
      "topic": "Shipping",
      "createdBy": { "id": "u_...", "handle": "alice", "displayName": "Alice" },
      "memberCount": 3,
      "messageCount": 22,
      "createdAt": "2026-11-01T09:00:00.000Z",
      "updatedAt": "2026-11-05T19:39:00.000Z",
      "lastMessageAt": "2026-11-05T19:39:00.000Z"
    }
  ],
  "total": 1
}
```

`query` matches names and topics. Results are most recently updated first.

Inspect a conversation and its messages:

```sh
curl -sS "$PULSEWIRE_URL/v1/admin/conversations/$CONVERSATION_ID/messages?limit=50" \
  -H "authorization: Bearer $ADMIN_TOKEN"

curl -sS \
  "$PULSEWIRE_URL/v1/admin/conversations/$CONVERSATION_ID/messages?limit=50&before=120" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "conversation": { "...": "conversation summary" },
  "messages": [{ "...": "message object" }],
  "hasMore": true,
  "nextBefore": 121
}
```

The page shape and `before` cursor match the normal history endpoint. Deleted messages appear as
tombstones.

Delete a conversation (and all of its messages):

```sh
curl -sS -X DELETE "$PULSEWIRE_URL/v1/admin/conversations/$CONVERSATION_ID" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

`204 No Content`. The delete emits a `conversation-updated` event with a null conversation ID.
Connected clients receive it as a broadcast with `"conversationId": ""` and refresh their lists.

Delete a single message:

```sh
curl -sS -X DELETE "$PULSEWIRE_URL/v1/admin/messages/$MESSAGE_ID" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

`204 No Content`. The message remains as a tombstone and a `message-deleted` event is recorded.
Deleting an already-deleted message is idempotent.

### Activity

```sh
curl -sS "$PULSEWIRE_URL/v1/admin/events?limit=40" \
  -H "authorization: Bearer $ADMIN_TOKEN"

curl -sS \
  "$PULSEWIRE_URL/v1/admin/events?before=83&limit=40&type=message-created" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "events": [
    {
      "seq": 83,
      "type": "message-created",
      "conversationId": "c_...",
      "conversationName": "Release",
      "messageId": "m_...",
      "actor": { "id": "u_...", "handle": "bob", "displayName": "Bob" },
      "createdAt": "2026-11-05T19:39:00.000Z"
    }
  ],
  "nextBefore": 83,
  "headSeq": 83
}
```

The admin feed is newest first. Pass `nextBefore` as `before` to load older events. `type` filters
to one of `message-created`, `message-updated`, `message-deleted`, `conversation-updated`, or
`read`. `conversationId` is `null` for server-wide broadcast events such as an admin deleting a
conversation. `limit` is 1–200 (default 50).

## Limits

| Setting              | Value                       |
| -------------------- | --------------------------- |
| Request body         | 64 KiB                      |
| Message length       | 4,000 characters            |
| Search query         | 100 characters              |
| History page         | 1–100 messages (default 50) |
| Conversation members | 51 including the owner      |
| DM participants      | exactly 2                   |
| Events per poll      | 1–200 (default 100)         |
| Login failures       | 10 per handle per 5 minutes |
