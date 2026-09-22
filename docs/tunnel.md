# Public endpoint (tunnel)

Turn Jevonian into a remotely reachable endpoint — useful for cloud runners or editors like Cursor. The tunnel exposes a **separate loopback listener** that serves only `/v1` (and `/healthz`), so the dashboard and admin API are never published; every public request must carry a Jevonian API key (`sk-jev-…`). Starting a tunnel is refused while no key exists.

```json
"tunnel": { "enabled": true, "provider": "cloudflare" }
```

| Provider     | Command                                                                  | Notes                                                                                    |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `cloudflare` | `cloudflared tunnel --url http://127.0.0.1:<publicPort> --no-autoupdate` | quick tunnel, no account needed; gives a random `*.trycloudflare.com` URL                |
| `ngrok`      | `ngrok http 127.0.0.1:<publicPort> [--url <domain>] --log stdout`        | needs `ngrok config add-authtoken` once; optional `url` binds a reserved / static domain; IPv4 loopback avoids `::1` refused on reconnect |
| `custom`     | your command, `{port}` is replaced                                       | for bore, Tailscale Funnel, localtunnel, …                                               |

- The public listener lives on `tunnel.publicPort` (default: `listen.port + 1`) and binds `127.0.0.1`; the tunnel command points at it.
- The tunnel process is detached from the server and recorded in `tunnel-state.json`, so a server restart (including `pnpm dev` HMR restarts) **reuses the same tunnel instead of creating a new one**. Quick tunnels (`cloudflare`, or `ngrok` without a `url`) therefore keep the same hostname until you press **Stop tunnel** or kill the process. For a permanent address, set `"provider": "ngrok", "url": "https://your-name.ngrok-free.dev"` (Dashboard → Domains), or use a named Cloudflare tunnel: `"provider": "custom", "command": "cloudflared tunnel run my-named-tunnel", "url": "https://ai.example.com"`.
- `jevonian serve --tunnel` forces the tunnel on for that run, `--no-tunnel` forces it off (and cleans up a leftover tunnel process).
- The Overview page has a **Public endpoint** card with the live status, the public URL (copy button), provider picker, and start/stop. `PUT /api/tunnel` drives it; the URL is printed on the terminal as well.
- `Ctrl-C` (`SIGINT`) stops the tunnel; a bare `SIGTERM` — how `tsx watch` restarts the server on a file change — leaves it running for the next process to adopt. Provider/port changes restart the tunnel (new hostname).

## Security notes

Publishing the endpoint does not change what runs locally: inference still goes to your configured providers under your credentials. Keep these in mind:

- The public listener serves `/v1` only. The dashboard, admin API, and `/api/*` are never exposed by the tunnel.
- Every public request must present a Jevonian key. Revoke keys on the **Keys** page; revocation takes effect immediately.
- Anyone holding a key can spend your provider quota. Treat keys as secrets, and prefer a dedicated key per remote consumer so one can be revoked without disturbing the others.
- Cloudflare quick tunnels and ngrok free URLs are unauthenticated at the transport layer — the Jevonian key is the access control, so do not serve them over a channel you consider private.
