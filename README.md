# Domain Recon

A Vineyard **plugin pack** for passive, keyless enrichment of **Domain** nodes. Nine of its ten
plugins run entirely in the browser sandbox — no server, no API key, no data leaves the client
beyond the public lookups each plugin makes, and every endpoint used is CORS-enabled and free. The
tenth (crt.name) needs the desktop app; see below.

- **DNS Lookup (A / AAAA / CNAME / MX / NS / TXT / CAA Record)** — seven plugins, one per record
  type. `A`/`AAAA` add **IP Address** nodes (`resolves to`); the others add **DNS Record** nodes
  (`has record`).
- **RDAP Domain** — fills the domain's registrar, creation and expiration dates, status and
  nameservers from **RDAP**.
- **Certificate Transparency Subdomains** — finds subdomains in Certificate Transparency logs
  (`crt.sh`) and adds them as **Domain** nodes (`subdomain`). Up to 150 per domain.
- **Certificate Transparency Subdomains (crt.name)** — the same from `crt.name`. crt.name allows
  1,000 requests a day per IP address. Desktop only.

## How it works

- **DNS-over-HTTPS** answers from `cloudflare-dns.com` / `dns.google` are filtered by record type;
  `A`/`AAAA` are promoted to first-class IP nodes for pivoting.
- **RDAP** lookups go to `rdap.org`, which redirects to the authoritative registry
  (Verisign/registry operators).
- **Certificate Transparency (crt.sh)** logs are queried through `crt.sh`'s JSON output. Subject
  Alternative Names are flattened, wildcards stripped, and only true subdomains of the queried domain
  are kept.
- **Certificate Transparency (crt.name)** works the same way conceptually, but `crt.name` sends no
  CORS headers, so a browser cannot read its response; this plugin runs only in the Vineyard desktop
  app. The response is plain text, one hostname per line, not JSON.

All ten enrich **existing** Domain nodes and never overwrite known fields with blanks.

## Layout

Self-contained — no dependency on the Vineyard frontend repo. Everything needed to rebuild this pack
lives here:

- `src/main.ts` — the pack source (all ten plugins) plus `src/sdk.ts`, a local copy of the plugin SDK
  types.
- `build.mjs` — bundles `src/main.ts` into `dist/pack.mjs` with esbuild (`node build.mjs`).
- `gen-manifest.mjs` — regenerates `plugins/domain-recon.manifest.json` from the built bundle, so the
  two copies cannot drift (`node gen-manifest.mjs`, after a build).
- `plugins/domain-recon.manifest.json` — the pack manifest (catalog entry source; generated, do not
  hand-edit).
- `dist/pack.mjs` — the runnable bundle the registry serves.

To ship a change: edit `src/main.ts`, then `node build.mjs && node gen-manifest.mjs`.

Data sources: public DNS resolvers, the RDAP bootstrap (`rdap.org`), and Certificate Transparency via
`crt.sh` and `crt.name`. No credentials, no cost.
