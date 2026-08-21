// Domain Recon — passive, keyless enrichment for Domain nodes.
//
// Ten plugins, mostly running entirely in the browser sandbox (no server, no API key, no cost):
//   • DNS Lookup (×7)      One plugin per record type — A, AAAA, CNAME, MX, NS, TXT, CAA — over
//                          DNS-over-HTTPS (DoH). Split so an analyst pays for the records they
//                          asked for; tick several in the Run dialog to fan out concurrently.
//   • RDAP Domain          Domain → registrar / registration & expiry dates / status / nameservers,
//                          via the RDAP bootstrap (rdap.org → the authoritative RIR/registry server).
//   • Certificate Transp.  Domain → subdomains observed in public Certificate Transparency logs (crt.sh).
//   • CT Subdomains (crt.name)  Same idea, second source. Desktop-only — see its own comment block.
//
// Every endpoint used by the first nine answers with `access-control-allow-origin: *` and needs no
// credential, so `ctx.net.fetch` reaches them directly (see each manifest's declared
// `scopes.network`). RDAP's 302 from rdap.org is followed by the browser to an RIR endpoint that
// ALSO sends permissive CORS, and the host only allowlists the initial rdap.org URL — so no
// per-RIR endpoint list is needed. crt.name is the exception: it sends no CORS headers at all, so
// its plugin instead uses `ctx.net.probe` (desktop-only) — see the plugin's own comment for why.
import { definePlugin, definePluginPack } from './sdk';
import type { HostContext, RunResult, GraphNode, VineyardPluginPack, PluginManifest } from './sdk';

const DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

// Shared platform blocks, referenced by every plugin below (never a fresh 'inline' entry per
// plugin): the catalog manifest gen-manifest.mjs writes IS what a project installs from, and a
// member whose entry names 'inline' installs without error and then never appears in the plugin
// list — there is no bundling context here for 'inline' to mean anything within.
const WEB_PLATFORMS: PluginManifest['platforms'] = {
    primary: 'web',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
};
const DESKTOP_PLATFORMS: PluginManifest['platforms'] = {
    primary: 'desktop',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs', min_app_version: '0.1.0' },
};

const isDomain = (n: GraphNode) => n.type === 'infrastructure.domain';
const domainOf = (n: GraphNode) =>
    String((n.data as any).domain_name ?? (n.data as any).value ?? '')
        .trim()
        .toLowerCase();

/** Normalize a DNS presentation host: drop the trailing root dot, lowercase. */
const normHost = (s: string) => s.replace(/\.$/, '').trim().toLowerCase();

// ---- DoH JSON query (Cloudflare, then Google) ---------------------------------------------
// Returns the `data` strings of Answer records whose numeric type matches `wantType` (so a CNAME
// hop that precedes the real answer is filtered out). Both resolvers speak `application/dns-json`.
const DNS_TYPE_NUM: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };

async function dohQuery(ctx: HostContext, name: string, type: string): Promise<string[]> {
    const want = DNS_TYPE_NUM[type];
    for (const base of DOH_ENDPOINTS) {
        try {
            const res = await ctx.net!.fetch!(`${base}?name=${encodeURIComponent(name)}&type=${type}`, {
                method: 'GET',
                headers: { accept: 'application/dns-json' },
            });
            if (!res.ok) continue;
            const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
            if (!Array.isArray(data.Answer)) return []; // NXDOMAIN / empty
            return data.Answer.flatMap((a) =>
                // Unwrap ONLY a fully-surrounding quote pair (whole-quoted TXT). Stripping quotes
                // independently would corrupt CAA (`0 issue "…"`) and multi-string TXT.
                a.type === want
                    ? [
                          String(a.data)
                              .replace(/^"(.*)"$/s, '$1')
                              .trim(),
                      ]
                    : [],
            );
        } catch {
            /* try next resolver */
        }
    }
    return [];
}

// =====================================================================================
// Plugins 1a-1g — DNS Lookup, one plugin per record type
// =====================================================================================
//
// Split from a single "DNS Lookup" that always queried A/AAAA/MX/NS/TXT/CAA. Asking for one record
// type meant paying for six and dumping five unwanted node kinds into the graph — resolving 40
// domains for MX alone cost 240 DoH queries.
//
// SEPARATE PLUGINS, not one plugin with a record-type parameter. The params form renders an enum as
// a single-value Select, so a parameter would allow exactly ONE type per run and "A and MX" would
// mean opening the dialog twice. Separate plugins get multi-select for free from the dialog's
// existing checkbox list, which already runs everything ticked concurrently over the same
// selection. It also makes `io.produces` honest per plugin (A/AAAA yield IP addresses; the rest
// yield DNS records), which a parameterised version could only ever declare as "both, sometimes".
//
// Installs are pack-scoped (`PACK_MEMBERS`), so an existing domain_recon install picks these up
// with no reinstall.

const DNS_SCOPES = {
    graph: ['node:read', 'node:create', 'edge:create'],
    network: [
        {
            endpoint: 'https://cloudflare-dns.com/dns-query',
            methods: ['GET'],
            purpose: 'Resolve DNS records over DoH.',
        },
        { endpoint: 'https://dns.google/resolve', methods: ['GET'], purpose: 'Fallback DoH resolver.' },
    ],
} as const;

const DNS_CONSUMES = [
    { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
] as const;

/** Shared per-domain preamble: validate capability + selection, then walk the selected domains. */
async function eachDomain(
    ctx: HostContext,
    label: string,
    visit: (domain: string, nodeId: string) => Promise<void>,
): Promise<number | null> {
    if (!ctx.net?.fetch) return null;
    const ids = ctx.input.selection;
    if (!ids.length) return -1;
    for (let i = 0; i < ids.length; i++) {
        if (ctx.signal?.aborted) break;
        const node = await ctx.graph!.get!(ids[i]);
        if (!node || !isDomain(node)) continue;
        const domain = domainOf(node);
        if (!domain) continue;
        ctx.progress?.set?.({
            percent: Math.round(((i + 1) / ids.length) * 100),
            message: `${label} ${domain}`,
        });
        await visit(domain, ids[i]);
    }
    return ids.length;
}

/** A / AAAA → IP Address nodes. Dedup key is `ip_address`, global on purpose: two domains on one
 *  host SHOULD share the node — that shared node is the pivot. */
function addressPlugin(type: 'A' | 'AAAA', version: 'ipv4' | 'ipv6', icon: string) {
    return definePlugin({
        manifest: {
            identifier: `run.vineyard.plugins.dns_lookup_${type.toLowerCase()}`,
            content_type: 'vineyard:plugin',
            name: `DNS Lookup (${type} Record)`,
            version: '1.0.0',
            description: `Resolves each selected Domain's ${type} records over DNS-over-HTTPS and links the ${
                version === 'ipv4' ? 'IPv4' : 'IPv6'
            } addresses it finds as IP Address nodes. Keyless, no server.`,
            icon,
            platforms: WEB_PLATFORMS,
            io: {
                consumes: DNS_CONSUMES as never,
                produces: [
                    {
                        typepack: 'run.vineyard.typepacks.infrastructure',
                        category: 'infrastructure',
                        name: 'ip_address',
                    },
                ],
            },
            scopes: DNS_SCOPES as never,
            lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
        },
        async run(ctx): Promise<RunResult> {
            let ips = 0;
            const total = await eachDomain(ctx, 'Resolving', async (domain, nodeId) => {
                for (const ip of await dohQuery(ctx, domain, type)) {
                    const ipNode = await ctx.graph!.createNode!({
                        type: 'infrastructure.ip_address',
                        data: { ip_address: ip, version },
                    });
                    await ctx.graph!.createEdge!({ from: nodeId, to: String(ipNode.id), label: 'resolves to' });
                    ips++;
                }
            });
            if (total === null)
                return { summary: 'Network capability not granted to this plugin', counts: { ip_addresses: 0 } };
            if (total === -1) return { summary: 'Select one or more Domain nodes first', counts: { ip_addresses: 0 } };
            return { summary: `${ips} ${type} address(es) from ${total} domain(s)`, counts: { ip_addresses: ips } };
        },
    });
}

/** CNAME / MX / NS / TXT / CAA → DNS Record nodes. */
function recordPlugin(type: 'CNAME' | 'MX' | 'NS' | 'TXT' | 'CAA', icon: string, blurb: string) {
    return definePlugin({
        manifest: {
            identifier: `run.vineyard.plugins.dns_lookup_${type.toLowerCase()}`,
            content_type: 'vineyard:plugin',
            name: `DNS Lookup (${type} Record)`,
            version: '1.0.0',
            description: `Resolves each selected Domain's ${type} records over DNS-over-HTTPS and adds them as DNS Record nodes. ${blurb} Keyless, no server.`,
            icon,
            platforms: WEB_PLATFORMS,
            io: {
                consumes: DNS_CONSUMES as never,
                produces: [
                    {
                        typepack: 'run.vineyard.typepacks.infrastructure',
                        category: 'infrastructure',
                        name: 'dns_record',
                    },
                ],
            },
            scopes: DNS_SCOPES as never,
            lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
        },
        async run(ctx): Promise<RunResult> {
            let records = 0;
            const total = await eachDomain(ctx, 'Resolving', async (domain, nodeId) => {
                for (const raw of await dohQuery(ctx, domain, type)) {
                    // MX data is "<pref> <host>." — drop the preference so the value is a clean host
                    // and the identity is stable across preference changes. TXT and CAA are left
                    // byte-for-byte: a CAA value is `0 issue "letsencrypt.org"`, and stripping its
                    // quotes would corrupt the record.
                    const value =
                        type === 'MX'
                            ? normHost(raw.replace(/^\d+\s+/, ''))
                            : type === 'NS' || type === 'CNAME'
                            ? normHost(raw)
                            : raw;
                    // A DNS record is identified by all three of (name, type, value): it is a
                    // per-domain fact, so shared values — Google MX, Cloudflare NS, a common SPF
                    // string — would otherwise collapse unrelated domains into one hub node, and
                    // an MX and an NS pointing at the same host would collide with each other.
                    const recNode = await ctx.graph!.createNode!({
                        type: 'infrastructure.dns_record',
                        data: { record_name: domain, record_value: value, record_type: type },
                    });
                    await ctx.graph!.createEdge!({ from: nodeId, to: String(recNode.id), label: 'has record' });
                    records++;
                }
            });
            if (total === null)
                return { summary: 'Network capability not granted to this plugin', counts: { dns_records: 0 } };
            if (total === -1) return { summary: 'Select one or more Domain nodes first', counts: { dns_records: 0 } };
            return {
                summary: `${records} ${type} record(s) from ${total} domain(s)`,
                counts: { dns_records: records },
            };
        },
    });
}

const dnsLookupA = addressPlugin('A', 'ipv4', 'network');
const dnsLookupAAAA = addressPlugin('AAAA', 'ipv6', 'waypoints');
const dnsLookupCNAME = recordPlugin('CNAME', 'link', 'Reveals aliasing and hosting providers.');
const dnsLookupMX = recordPlugin('MX', 'server', 'Mail routing often identifies the provider or tenant.');
const dnsLookupNS = recordPlugin('NS', 'server', 'Nameservers are a strong shared-infrastructure pivot.');
const dnsLookupTXT = recordPlugin('TXT', 'globe', 'SPF/DKIM/verification strings often leak vendors in use.');
const dnsLookupCAA = recordPlugin('CAA', 'shield-alert', 'Names the CAs allowed to issue for the domain.');

// =====================================================================================
// Plugin 2 — RDAP Domain (registration data; the modern, CORS-friendly WHOIS replacement)
// =====================================================================================
function vcardField(entity: any, field: string): string {
    // vcardArray = ["vcard", [ ["version",{},"text","4.0"], ["fn",{},"text","Registrar, Inc."], ... ]]
    const arr = entity?.vcardArray?.[1];
    if (!Array.isArray(arr)) return '';
    const row = arr.find((r: any) => Array.isArray(r) && r[0] === field);
    return row ? String(row[3] ?? '') : '';
}
function findEntity(entities: any[], role: string): any {
    return (entities || []).find((e) => Array.isArray(e?.roles) && e.roles.includes(role));
}
function eventDate(events: any[], action: string): string {
    const e = (events || []).find((x) => x?.eventAction === action);
    return e?.eventDate ? String(e.eventDate).slice(0, 10) : ''; // ISO → YYYY-MM-DD
}

const rdapDomain = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.rdap_domain',
        content_type: 'vineyard:plugin',
        name: 'RDAP Domain',
        version: '1.0.0',
        description:
            "Fills each selected Domain's registrar, creation/expiry dates, status and nameservers from RDAP (the structured WHOIS successor), via rdap.org bootstrap. Keyless, CORS-native, no server.",
        icon: 'scroll-text',
        platforms: WEB_PLATFORMS,
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
            ],
            produces: [],
        },
        scopes: {
            graph: ['node:read', 'node:update'],
            network: [
                {
                    endpoint: 'https://rdap.org/',
                    methods: ['GET'],
                    purpose: 'RDAP bootstrap → authoritative registry (both send CORS *).',
                },
            ],
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },
    async run(ctx): Promise<RunResult> {
        if (!ctx.net?.fetch)
            return { summary: 'Network capability not granted to this plugin', counts: { updated: 0 } };
        const ids = ctx.input.selection;
        if (!ids.length) return { summary: 'Select one or more Domain nodes first', counts: { updated: 0 } };

        let updated = 0;
        for (let i = 0; i < ids.length; i++) {
            if (ctx.signal?.aborted) break;
            const node = await ctx.graph!.get!(ids[i]);
            if (!node || !isDomain(node)) continue;
            const domain = domainOf(node);
            if (!domain) continue;
            ctx.progress?.set?.({ percent: Math.round(((i + 1) / ids.length) * 100), message: `RDAP ${domain}` });

            let doc: any;
            try {
                const res = await ctx.net!.fetch!(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
                    method: 'GET',
                });
                if (!res.ok) continue; // 404 = not found / not an RDAP-served TLD
                doc = await res.json();
            } catch {
                continue;
            }

            const registrar = vcardField(findEntity(doc.entities, 'registrar'), 'fn');
            const created = eventDate(doc.events, 'registration');
            const expires = eventDate(doc.events, 'expiration');
            const nameServers = (doc.nameservers || [])
                .map((n: any) => normHost(String(n?.ldhName ?? '')))
                .filter(Boolean)
                .join('\n');
            const status = Array.isArray(doc.status) ? doc.status.join(', ') : '';

            // Delta only — updateNode fill-merges what we send. Spreading ...node.data re-sends a
            // stale copy of every other field, so a CT-subdomain or DNS run that filled something
            // between this read and the apply had its value overwritten with the pre-read one.
            const patch: Record<string, unknown> = {};
            if (registrar) patch.registrar = registrar;
            if (created) patch.created_date = created;
            if (expires) patch.expiration_date = expires;
            if (nameServers) patch.name_servers = nameServers;
            if (status) patch.status = status;
            if (!Object.keys(patch).length) continue;
            await ctx.graph!.updateNode!(ids[i], patch);
            updated++;
        }
        return { summary: `${updated}/${ids.length} domain(s) enriched from RDAP`, counts: { updated } };
    },
});

// =====================================================================================
// Plugin 3 — Certificate Transparency subdomains (crt.sh)
// =====================================================================================
const MAX_SUBS = 150; // per domain; CT logs can return thousands — keep the graph reviewable

const crtshSubdomains = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.crtsh_subdomains',
        content_type: 'vineyard:plugin',
        name: 'Certificate Transparency Subdomains',
        version: '1.0.0',
        description: `Discovers subdomains of each selected Domain from public Certificate Transparency logs (crt.sh) and adds them as Domain nodes ("subdomain"). Passive, keyless, no server. Capped at ${MAX_SUBS} per domain.`,
        icon: 'badge-check',
        platforms: WEB_PLATFORMS,
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
            ],
            produces: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
            ],
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            network: [
                {
                    endpoint: 'https://crt.sh/',
                    methods: ['GET'],
                    purpose: 'Query Certificate Transparency logs for subdomains.',
                },
            ],
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },
    async run(ctx): Promise<RunResult> {
        if (!ctx.net?.fetch)
            return { summary: 'Network capability not granted to this plugin', counts: { subdomains: 0 } };
        const ids = ctx.input.selection;
        if (!ids.length) return { summary: 'Select one or more Domain nodes first', counts: { subdomains: 0 } };

        let added = 0;
        let truncated = 0;
        for (let i = 0; i < ids.length; i++) {
            if (ctx.signal?.aborted) break;
            const node = await ctx.graph!.get!(ids[i]);
            if (!node || !isDomain(node)) continue;
            const domain = domainOf(node);
            if (!domain) continue;
            ctx.progress?.set?.({ percent: Math.round(((i + 1) / ids.length) * 100), message: `CT logs: ${domain}` });

            let rows: Array<{ name_value?: string; common_name?: string }> = [];
            try {
                const res = await ctx.net!.fetch!(
                    `https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`,
                    { method: 'GET' },
                );
                if (!res.ok) continue;
                rows = (await res.json()) as any[];
            } catch {
                continue; // crt.sh occasionally returns non-JSON under load
            }
            if (!Array.isArray(rows)) continue;

            // Flatten every SAN/CN, strip wildcards, keep true subdomains of this domain, dedupe.
            const subs = new Set<string>();
            for (const r of rows) {
                for (const raw of String(r.name_value ?? '')
                    .split('\n')
                    .concat(String(r.common_name ?? ''))) {
                    const name = raw.replace(/^\*\./, '').trim().toLowerCase();
                    if (name && name !== domain && name.endsWith('.' + domain) && !name.includes(' ')) subs.add(name);
                }
            }

            const list = [...subs];
            if (list.length > MAX_SUBS) truncated += list.length - MAX_SUBS;
            for (const sub of list.slice(0, MAX_SUBS)) {
                if (ctx.signal?.aborted) break;
                const subNode = await ctx.graph!.createNode!({
                    type: 'infrastructure.domain',
                    data: { domain_name: sub },
                });
                await ctx.graph!.createEdge!({ from: ids[i], to: String(subNode.id), label: 'subdomain' });
                added++;
            }
        }
        const note = truncated ? ` (${truncated} more omitted by the ${MAX_SUBS}/domain cap)` : '';
        return { summary: `${added} subdomain(s) discovered from CT logs${note}`, counts: { subdomains: added } };
    },
});

// =====================================================================================
// Plugin 4 — Certificate Transparency subdomains via crt.name (desktop-only, no CORS)
// =====================================================================================
// crt.name's search API (`GET /v1/search?apex=<domain>`) sends NO `access-control-allow-origin`
// header — confirmed: even an OPTIONS preflight 405s with no ACAO — so a browser-side `ctx.net.fetch`
// cannot read the response (opaque/blocked), the same shape as WhatsMyName's per-site checks. This
// plugin instead goes through `ctx.net.probe`, the desktop-only anonymous main-process request, and
// is unavailable in the web build. crt.sh above stays the web-capable CT source; this is an
// additional, desktop-only one with its own quota (every response carries `x-ratelimit-limit: 1000`,
// `x-ratelimit-remaining`) — useful when crt.sh is slow/down or a domain's crt.sh result set is thin.
// The response body is plain text, one hostname per line (including the bare apex), not JSON.
//
// NO per-domain cap here, unlike crt.sh above: crt.sh's 150 cap predates this plugin and stays as
// its own design choice, but crt.name has no equivalent reason to truncate — the daily 1000-request
// quota is already the limiting factor, and the probe's maxBytes (set to the shell's own hard
// ceiling below) is the only real constraint. Every subdomain the API returns is added.
const crtnameSubdomains = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.crtname_subdomains',
        content_type: 'vineyard:plugin',
        name: 'Certificate Transparency Subdomains (crt.name)',
        version: '1.0.0',
        description:
            "Discovers subdomains of each selected Domain from crt.name's Certificate Transparency search API and adds them as Domain nodes (\"subdomain\"). Desktop only — crt.name sends no CORS headers, so a browser cannot read the response; the Vineyard desktop app's anonymous cross-origin probe is used instead. Passive, keyless. crt.name enforces a 1000-request/day quota per source IP.",
        icon: 'radar',
        platforms: DESKTOP_PLATFORMS,
        io: {
            consumes: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
            ],
            produces: [
                { typepack: 'run.vineyard.typepacks.infrastructure', category: 'infrastructure', name: 'domain' },
            ],
        },
        scopes: {
            graph: ['node:read', 'node:create', 'edge:create'],
            web_probe: {
                purpose:
                    "Query crt.name's Certificate Transparency search API for each domain's observed subdomains. Desktop only; anonymous, no cookies, no redirects followed.",
            },
        },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },
    async run(ctx): Promise<RunResult> {
        const ids = ctx.input.selection;
        if (!ids.length) return { summary: 'Select one or more Domain nodes first', counts: { subdomains: 0 } };

        // Desktop-only: crt.name has no CORS, so this needs `ctx.net.probe`, which exists only in
        // the shell. Fail loudly and usefully rather than a silent zero that reads as a clean miss.
        if (!ctx.net?.probe) {
            return {
                summary:
                    'crt.name sends no CORS headers, so a browser cannot read its response — open this project in the Vineyard desktop app and run it again.',
                counts: { subdomains: 0 },
            };
        }

        let added = 0;
        let rateLimited = 0;
        for (let i = 0; i < ids.length; i++) {
            if (ctx.signal?.aborted) break;
            const node = await ctx.graph!.get!(ids[i]);
            if (!node || !isDomain(node)) continue;
            const domain = domainOf(node);
            if (!domain) continue;
            ctx.progress?.set?.({ percent: Math.round(((i + 1) / ids.length) * 100), message: `crt.name: ${domain}` });

            const res = await ctx.net.probe(`https://crt.name/v1/search?apex=${encodeURIComponent(domain)}`, {
                method: 'GET',
                maxBytes: 2 * 1024 * 1024, // the shell's own hard ceiling — not a business-logic cap
                timeoutMs: 15_000,
            });
            // A guard rejection or transport error comes back as status 0 with `error` set; a 429
            // is the daily quota. Either way, move on rather than aborting the whole selection.
            if (res.error || res.status === 0) continue;
            if (res.status === 429) {
                rateLimited++;
                continue;
            }
            if (res.status !== 200) continue;

            // Plain text, one hostname per line (the apex itself is included) — not JSON like crt.sh.
            // Every subdomain crt.name returns is added; no truncation.
            const subs = new Set<string>();
            for (const raw of res.body.split('\n')) {
                const name = raw.replace(/^\*\./, '').trim().toLowerCase();
                if (name && name !== domain && name.endsWith('.' + domain) && !name.includes(' ')) subs.add(name);
            }

            for (const sub of subs) {
                if (ctx.signal?.aborted) break;
                const subNode = await ctx.graph!.createNode!({
                    type: 'infrastructure.domain',
                    data: { domain_name: sub },
                });
                await ctx.graph!.createEdge!({ from: ids[i], to: String(subNode.id), label: 'subdomain' });
                added++;
            }
        }
        const note = rateLimited ? ` (${rateLimited} domain(s) hit crt.name's daily quota)` : '';
        return { summary: `${added} subdomain(s) discovered from crt.name${note}`, counts: { subdomains: added } };
    },
});

// =====================================================================================
// Pack
// =====================================================================================
// Declared as a variable with an explicit type, not a literal argument: VineyardPluginPack's
// interface omits author/license/icon/platforms (a fresh object literal would trip the
// excess-property check), and a bare variable would widen content_type to plain `string` (a
// literal-union mismatch). The annotation pins the literal and keeps the extra metadata, which
// gen-manifest.mjs spreads into the catalog JSON.
const pack: VineyardPluginPack & {
    author: { name: string; url: string };
    license: string;
    icon: string;
    platforms: PluginManifest['platforms'];
} = {
    identifier: 'run.vineyard.pluginpacks.domain_recon',
    content_type: 'vineyard:pluginpack',
    name: 'Domain Recon',
    version: '2.1.1',
    description:
        'Passive, keyless domain enrichment: per-record DNS lookups over DoH (A, AAAA, CNAME, MX, NS, TXT, CAA), RDAP registration data, and Certificate Transparency subdomain discovery from crt.sh (web) and crt.name (desktop-only). No API keys, no server.',
    author: { name: 'VINEYARD', url: 'https://vineyard.run' },
    license: 'Apache-2.0',
    icon: 'globe',
    platforms: WEB_PLATFORMS,
    plugins: [
        dnsLookupA,
        dnsLookupAAAA,
        dnsLookupCNAME,
        dnsLookupMX,
        dnsLookupNS,
        dnsLookupTXT,
        dnsLookupCAA,
        rdapDomain,
        crtshSubdomains,
        crtnameSubdomains,
    ],
};

export const domainReconPack = definePluginPack(pack);
export default domainReconPack;
