# Domain Recon

A Vineyard **plugin pack** for passive, keyless enrichment of **Domain** nodes. Nine of its ten
plugins run entirely in the browser sandbox — no server, no API key, no data leaves the client
beyond the public lookups each plugin makes, and every endpoint used is CORS-enabled and free. The
tenth (crt.name) needs the desktop app; see below.

- **DNS Lookup** — resolves a domain over **DNS-over-HTTPS** (Cloudflare, falling back to Google) and
  maps its records: `A`/`AAAA` become **IP Address** nodes (`resolves to`), while `MX`/`NS`/`TXT`/`CAA`
  become **DNS Record** nodes (`has record`).
- **RDAP Domain** — fills the domain's registrar, creation/expiry dates, status and nameservers from
  **RDAP** (the structured successor to WHOIS), via the `rdap.org` bootstrap. Keyless and CORS-native.
- **Certificate Transparency Subdomains** — discovers subdomains from public **Certificate
  Transparency** logs (`crt.sh`) and adds them as **Domain** nodes (`subdomain`). Capped at 150 per
  domain to keep the graph reviewable.
- **Certificate Transparency Subdomains (crt.name)** — a second CT source (`crt.name`'s search API),
  desktop-only. Every subdomain the API returns is added — no per-domain cap; crt.name enforces its
  own 1000-request/day quota per source IP.

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
