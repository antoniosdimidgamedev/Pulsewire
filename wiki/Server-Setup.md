# Server Setup

Install and run the Pulsewire server.

## Requirements

- [Deno](https://deno.com/) 2.x
- Linux or macOS (the primary development platforms)
- No external database server — SQLite comes from Deno's built-in `node:sqlite`

## Install

```sh
# Clone the repository
git clone https://github.com/antoniosdimidgamedev/Pulsewire.git
cd Pulsewire

# Verify Deno is available
deno --version
```

## Run the server

```sh
# Default: listens on 127.0.0.1:8787 (loopback only)
pulsewire server

# LAN access: bind to all interfaces
pulsewire server --host 0.0.0.0 --port 8787

# Run in the background (daemon)
pulsewire server --daemon

# Custom database path
PULSEWIRE_SERVER_DB=/data/pulsewire.db pulsewire server
```

Equivalently, all commands can be run with `deno task <name>`.

## Automatic launch

For a systemd-managed service, install the unit file:

```sh
sudo cp scripts/pulsewire-server.service /etc/systemd/system/pulsewire-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now pulsewire-server.service
```

Or use the shell script directly (see `scripts/pulsewire-server.sh --help`):

```sh
./scripts/pulsewire-server.sh --daemon
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PULSEWIRE_SERVER_HOST` | `127.0.0.1` | Bind address |
| `PULSEWIRE_SERVER_PORT` | `8787` | TCP port |
| `PULSEWIRE_SERVER_DB` | `./pulsewire.db` | SQLite database path |
| `PULSEWIRE_DB_KEY` | *(unset)* | At-rest encryption passphrase for message bodies |
| `PULSEWIRE_SESSION_TTL_DAYS` | `30` | Session lifetime in days |
| `PULSEWIRE_PBKDF2_ITERATIONS` | `210000` | Password hashing iterations |
| `PULSEWIRE_ADMIN_HANDLE` | *(unset)* | Handle promoted to admin at first start |
| `PULSEWIRE_DATA_DIR` | `~/.local/share/pulsewire` | Data/log directory |

## First account

The first account registered on a fresh database becomes the administrator.
Alternatively, set `PULSEWIRE_ADMIN_HANDLE` to a known handle to promote it at
startup. The last administrator cannot be demoted.

## Production

- Terminate TLS at a reverse proxy (nginx, Caddy, etc.) and use `https://`
- Bind to a private interface and restrict access to the data directory
- Back up the SQLite file together with its WAL sidecars
- Add proxy-level rate limiting in addition to the built-in login limiter
