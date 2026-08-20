# Open-Lens production deployment

Production target: `openlens.renzhen.me` on the user's Alibaba Cloud ECS instance.
Caddy terminates HTTPS and serves the built PWA; `/api/*`, `/files/*`, and
`/mcp` are proxied to the Fastify service on `127.0.0.1:8787`.

The server runtime must be Node.js 22 or newer (`better-sqlite3@13` enforces
this at install time). The production service resolves Node and npm through
the versioned runtime symlinks in `/usr/local/bin`.

## Server layout

- releases: `/opt/open-lens/releases/<git-commit>/`
- current release: `/opt/open-lens/current`
- persistent data: `/var/lib/open-lens`
- environment: `/etc/open-lens/open-lens.env` (root-only; never commit it)
- service: `/etc/systemd/system/open-lens.service`
- HTTPS proxy: `/etc/caddy/Caddyfile`

The environment file contains only server-local values:

```dotenv
OL_TOKEN=<strong-random-token>
DATA_DIR=/var/lib/open-lens
PORT=8787
```

## Release gate

Before switching `current`, build `app/dist`, install the server dependencies
with `npm ci`, and verify `npm run check`. After switching, verify:

1. `open-lens.service` and `caddy.service` are active.
2. unauthenticated `/api/docs` returns 401.
3. authenticated `/api/docs` returns 200.
4. `/manifest.webmanifest`, `/sw.js`, icons, and OpenCV assets return 200 over
   HTTPS.

Rollback is a symlink change back to the previous release followed by
`systemctl restart open-lens`. The data directory is shared and must not be
deleted during rollback.
