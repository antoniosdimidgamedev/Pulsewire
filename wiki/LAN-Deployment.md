# LAN Deployment

Reach the Pulsewire server from phones, laptops, and other devices on your
local area network.

## 1. Bind the server to a private interface

By default the server listens on `127.0.0.1`, which other devices cannot reach.
Start it on a private interface:

```sh
deno task server --host 0.0.0.0 --port 8787
```

For automatic launch with systemd, set `PULSEWIRE_SERVER_HOST=0.0.0.0` in
`scripts/pulsewire-server.service`.

## 2. Set a static LAN IP (recommended)

A DHCP address can change, breaking the server URL clients use. Set a static IP
on the host:

```sh
# Example using NetworkManager
nmcli connection modify <connection> \
  ipv4.addresses 192.168.1.55/24 \
  ipv4.gateway 192.168.1.1 \
  ipv4.dns "1.1.1.1,8.8.8.8" \
  ipv4.method manual
nmcli connection up <connection>
```

Replace `<connection>` with your connection name (`nmcli connection show`) and
the addresses with your LAN's gateway/DNS.

## 3. Allow the port through the firewall

```sh
sudo ufw allow 8787/tcp
```

## 4. Confirm reachability

From another device on the same LAN:

```sh
curl http://<LAN-IP>:8787/health
# {"status":"ok"}
```

Open `http://<LAN-IP>:8787/admin` for the dashboard.

## 5. Connect clients

- **Terminal client:** `deno task start login <handle> --server http://<LAN-IP>:8787`
- **Android app:** Enter `http://<LAN-IP>:8787` as the server address
  (Android Studio emulator: `http://10.0.2.2:8787`)
- **Dashboard:** `http://<LAN-IP>:8787/admin`

## Security boundary

The server permits cleartext HTTP so trusted LANs can use it without a
certificate. Anyone on the LAN can observe traffic. Use HTTPS via a reverse
proxy for any network you do not control, and do not expose plain HTTP to the
internet.

## Troubleshooting

- "Connection refused": Is the server running? Is it bound to `0.0.0.0`?
- Timeout: Is port `8787` allowed through the host firewall?
- Wrong address: Use the host's LAN IP, not `127.0.0.1`, from other devices.
