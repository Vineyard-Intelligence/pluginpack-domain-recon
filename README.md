# Domain Recon

A Vineyard **plugin pack** for passive, keyless enrichment of **Domain** nodes. Everything runs
in the browser sandbox — no server, no API key, no data leaves the client beyond the public lookups
each plugin makes. Every endpoint used is CORS-enabled and free.

Three plugins:

- **DNS Lookup** — resolves a domain over **DNS-over-HTTPS** (Cloudflare, falling back to Google) and
  maps its records: `A`/`AAAA` become **IP Address** nodes (`resolves to`), while `MX`/`NS`/`TXT`/`CAA`
  become **DNS Record** nodes (`has record`).
- **RDAP Domain** — fills the domain's registrar, creation/expiry dates, status and nameservers from
  **RDAP** (the structured successor to WHOIS), via the `rdap.org` bootstrap. Keyless and CORS-native.
- **Certificate Transparency Subdomains** — discovers subdomains from public **Certificate
  Transparency** logs (`crt.sh`) and adds them as **Domain** nodes (`subdomain`). Capped at 150 per
  domain to keep the graph reviewable.

## How it works

- **DNS-over-HTTPS** turns a DNS query into a CORS-enabled HTTPS `GET` — both `cloudflare-dns.com` and
  `dns.google` answer with `access-control-allow-origin: *`, so no proxy is needed. Answers are
  filtered by record type; `A`/`AAAA` are promoted to first-class IP nodes for pivoting.
- **RDAP** publishes registration data as JSON with permissive CORS. `rdap.org` 302-redirects to the
  authoritative registry (Verisign/registry operators); the browser follows it and the final response
  also sends CORS, so the whole lookup works client-side.
- **Certificate Transparency** logs are queried through `crt.sh`'s JSON output. Subject Alternative
  Names are flattened, wildcards stripped, and only true subdomains of the queried domain are kept.

All three enrich **existing** Domain nodes and never overwrite known fields with blanks (Vineyard's
create-time de-dup merges observations).

## Layout

- `plugins/domain-recon.manifest.json` — the pack manifest (catalog entry source).
- `dist/` — runnable bundle (see note; not built yet — plugins run as built-ins in-app today).

Data sources: public DNS resolvers, the RDAP bootstrap (`rdap.org`), and Certificate Transparency via
`crt.sh`. No credentials, no cost.
