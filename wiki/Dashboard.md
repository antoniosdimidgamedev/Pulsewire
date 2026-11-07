# Dashboard

The management dashboard is an administrator-only interface served at `/admin`
by the Pulsewire server process. No separate web server or build step is needed.

## Sign in

1. Start the server: `deno task server --host 0.0.0.0 --port 8787`
2. Open `http://<LAN-IP>:8787/admin` in a browser
3. Sign in with an administrator account (the first registered account becomes
   admin, or set `PULSEWIRE_ADMIN_HANDLE`)

## Views

### Overview

Server health: account, conversation, message, and event counts, plus recent
conversations and latest activity.

### Accounts

Search, paginate, and promote/demote administrators. The last administrator
cannot be removed.

### Conversations

Search, paginate, and inspect message history. Delete conversations as an
administrator.

### Activity

Newest-first event feed (messages, edits, deletions, conversation changes, read
receipts) with type filters and pagination.

## Security

- All data routes require an administrator token.
- Server values are rendered as text nodes (no HTML injection).
- Strict Content Security Policy: `script-src 'self'`, `frame-ancestors 'none'`.

## Guide

A **Guide** button appears in the dashboard navigation after sign-in. It walks
through setup, LAN deployment, client connection, and the security boundary.
