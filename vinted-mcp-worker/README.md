# vinted-mcp-worker

Cloudflare Worker, der den MCP-Server aus [googlarz/vinted-mcp-cli](https://github.com/googlarz/vinted-mcp-cli) über Streamable HTTP bereitstellt (Endpoint `/mcp`, Bearer-Auth).

`npm run sync` zieht den Upstream-Stand nach `src/vendor/` (gitignored). Ops, Endpoints, Tool-Definitionen und Prompts kommen unverändert von dort; nur `session.ts` (fetch statt undici), `browser.ts` (Stub) und `version.ts` sind eigene Versionen in `src/overrides/`. Mit `UPSTREAM_REF=<tag>` lässt sich eine feste Version pinnen.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler secret put MCP_TOKEN     # langes Zufallsgeheimnis, z.B. openssl rand -hex 32
npm run deploy
```

Im MCP-Client als Remote-Server eintragen:

```
URL:    https://vinted-mcp.<dein-subdomain>.workers.dev/mcp
Header: Authorization: Bearer <MCP_TOKEN>
```

Lokal: `.dev.vars` mit `MCP_TOKEN=...` anlegen, dann `npm run dev`.

## Einschränkungen

- Kein Browser-Modus (`get_item` mit Chromium) und kein Proxy; beides geht auf Workers nicht.
- Cache, Rate-Limit und Vinted-Session-Cookies liegen im Speicher des Isolates und gehen bei Kaltstart verloren.
- Vinted sitzt hinter DataDome. Lokal läuft es, von Cloudflare-IPs kann es 401/403 geben. Dann hilft nur ein Relay mit anderer Egress-IP.
