# API Reference

Pulsewire exposes a versioned REST API under `/v1`. All responses are JSON.
Clients authenticate with a bearer token in the `Authorization` header.

## Authentication

| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/v1/auth/register` | `{ handle, displayName, password }` | Create an account |
| POST | `/v1/auth/login` | `{ handle, password }` | Sign in, returns `{ user, token, expiresAt }` |
| POST | `/v1/auth/logout` | — | Revoke the current session |

## Profile

| Method | Endpoint | Body | Description |
|---|---|---|---|
| GET | `/v1/me` | — | Current profile |
| PATCH | `/v1/me` | `{ displayName?, handle? }` | Update profile |

## Users

| Method | Endpoint | Query | Description |
|---|---|---|---|
| GET | `/v1/users` | `query` | Look up people by handle or name |

## Conversations

| Method | Endpoint | Body | Description |
|---|---|---|---|
| GET | `/v1/conversations` | — | List the caller's conversations |
| POST | `/v1/conversations` | `{ kind, name?, topic?, memberHandles[] }` | Create a conversation |
| GET | `/v1/conversations/:id` | — | Get one conversation |
| POST | `/v1/conversations/:id/messages` | `{ body, replyToId? }` | Send a message |
| GET | `/v1/conversations/:id/messages` | `limit, before` | Page message history |
| POST | `/v1/conversations/:id/read` | — | Mark the conversation read |
| GET | `/v1/conversations/:id/members` | — | List members |
| POST | `/v1/conversations/:id/members` | `{ handle }` | Add a member (owner only) |
| DELETE | `/v1/conversations/:id/members/:userId` | — | Remove a member (owner only) |
| POST | `/v1/conversations/:id/leave` | — | Leave the conversation |

## Messages

| Method | Endpoint | Body | Description |
|---|---|---|---|
| PATCH | `/v1/messages/:id` | `{ body }` | Edit your own message |
| DELETE | `/v1/messages/:id` | — | Delete your own message |

## Search

| Method | Endpoint | Query | Description |
|---|---|---|---|
| GET | `/v1/search` | `query` | Search message text and conversation names |

## Events (change feed)

| Method | Endpoint | Query | Description |
|---|---|---|---|
| GET | `/v1/events/head` | — | Current event sequence cursor |
| GET | `/v1/events` | `after, limit` | Events after a cursor |

## Admin (`/v1/admin/*`)

Requires an administrator token.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/v1/admin` | Server overview counts |
| GET | `/v1/admin/users` | List accounts (search, paginate) |
| PATCH | `/v1/admin/users/:id` | Promote/demote administrator |
| GET | `/v1/admin/conversations` | List conversations |
| GET | `/v1/admin/conversations/:id/messages` | Message history |
| DELETE | `/v1/admin/conversations/:id` | Delete a conversation |
| DELETE | `/v1/admin/messages/:id` | Delete a message |
| GET | `/v1/admin/events` | Activity feed |

## Health

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Unauthenticated liveness check (`{"status":"ok"}`) |

## Errors

Errors return JSON: `{ "error": { "code": "...", "message": "..." } }`. Non-members
receive `404` for resources they cannot access, so existence is not disclosed.
