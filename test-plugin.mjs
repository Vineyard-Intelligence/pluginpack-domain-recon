// Functional test harness for the RDAP Domain plugin in pluginpack-domain-recon/dist/pack.mjs.
// Run: node test-plugin.mjs
//
// The plugin asks rdap.org, whose redirect to the registry ctx.net.fetch follows, so the fake net
// answers the rdap.org URL with the registry's answer, as the host would. The answer follows the
// RFC 9083 domain object shape (entities with vcardArray, events, nameservers, status).
import pack from "./dist/pack.mjs";

const rdapPlugin = pack.plugins.find((p) => p.manifest.identifier === "run.vineyard.plugins.rdap_domain");
const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);

function makeGraph(nodeById) {
  const createdNodes = [];
  const createdEdges = [];
  const updates = [];
  return {
    createdNodes,
    createdEdges,
    updates,
    async get(id) {
      return nodeById[id] || null;
    },
    async createNode(draft) {
      const node = { id: `n${createdNodes.length + 1}`, type: draft.type, data: draft.data };
      createdNodes.push(node);
      return node;
    },
    async updateNode(id, data) {
      updates.push({ id, data });
    },
    async createEdge(edge) {
      createdEdges.push(edge);
    },
  };
}

/** `respond` returns {status, body, headers} or {throws: true} for a request that never landed. */
function makeNet(respond) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const r = respond(url, init, calls.length);
      if (r.throws) throw new TypeError("Failed to fetch");
      const { status, body, headers } = r;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: headers ?? {},
        async json() {
          return JSON.parse(text);
        },
        async text() {
          return text;
        },
      };
    },
  };
}

function ctxFor({ nodes, selection, respond }) {
  const graph = makeGraph(nodes);
  const net = makeNet(respond);
  const logs = [];
  return {
    graph,
    net,
    logs,
    ctx: {
      run: { runId: "r1", projectId: "p1", pluginId: "run.vineyard.plugins.rdap_domain", grantedScopes: {}, platform: "web" },
      input: { selection },
      params: {},
      graph,
      net,
      progress: { set() {}, log: (m) => logs.push(m) },
      signal: undefined,
    },
  };
}

const domainBody = {
  objectClassName: "domain",
  ldhName: "EXAMPLE.COM",
  status: ["client delete prohibited", "client transfer prohibited"],
  entities: [
    {
      objectClassName: "entity",
      roles: ["registrar"],
      vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar, Inc."]]],
    },
  ],
  events: [
    { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
  ],
  nameservers: [{ objectClassName: "nameserver", ldhName: "A.IANA-SERVERS.NET." }, { ldhName: "b.iana-servers.net" }],
};
// Spaced as the registry sent it, so a re-serialised parse would not match the kept text.
const domainText = JSON.stringify(domainBody, null, 1);
const notFoundBody = { errorCode: 404, title: "Not Found", description: ["The domain was not found."] };
const RESPONSE_HEADERS = { "content-type": "application/rdap+json", etag: '"r-1"' };
// What an IANA bootstrap answer looks like (dns.json). The plugin must never fetch or keep one.
const IANA_MARK = "data.iana.org";

const domainNode = (id, name) => ({ id, type: "infrastructure.domain", data: { domain_name: name } });

function retainSpy(answer = async () => ({ kept: true })) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return answer(...args);
  };
  fn.calls = calls;
  return fn;
}
const leaks = (calls) => {
  const s = JSON.stringify(calls);
  return ["http://", "https://", "rdap.org", IANA_MARK, "init", "url"].filter((x) => s.includes(x));
};

// ---- baseline: the plugin's own mapping ---------------------------------------------------------
{
  const t = ctxFor({ nodes: { d1: domainNode("d1", "Example.com") }, selection: ["d1"], respond: () => ({ status: 200, body: domainText }) });
  const res = await rdapPlugin.run(t.ctx);
  check("rdap: one request, to rdap.org", t.net.calls.length === 1 && t.net.calls[0].url === "https://rdap.org/domain/example.com");
  check("rdap: maps registrar, dates, nameservers and status", res.counts.updated === 1 && JSON.stringify(t.graph.updates[0]) === JSON.stringify({ id: "d1", data: { registrar: "Example Registrar, Inc.", created_date: "1995-08-14", expiration_date: "2027-08-13", name_servers: "a.iana-servers.net\nb.iana-servers.net", status: "client delete prohibited, client transfer prohibited" } }));
}

// ---- raw results: ctx.retain ------------------------------------------------------------------
// Invariants, from the plugin raw results spec (§5, §12):
//   - RDAP Domain keeps the registry's answer for each domain on that domain's node, op "rdap", as
//     the text the registry sent. A 404 (no such domain / no RDAP for the TLD) is kept too; a 429,
//     a 5xx and a request that never landed are not.
//   - Only status, headers and body are handed over: no URL, nothing about the request.
//   - No bootstrap answer is ever kept: rdap.org's redirect is followed by the host.
//   - A refusal object or a throw from retain never fails the run, and is logged once per reason.
//   - A host without ctx.retain (every desktop build before it) runs exactly as before.
{
  const nodes = { d1: domainNode("d1", "example.com") };
  const spy = retainSpy();
  const t = ctxFor({ nodes, selection: ["d1"], respond: () => ({ status: 200, body: domainText, headers: RESPONSE_HEADERS }) });
  t.ctx.retain = spy;
  const res = await rdapPlugin.run(t.ctx);
  check("retain rdap: one call, on the looked-up domain, op rdap", spy.calls.length === 1 && spy.calls[0][0] === "d1" && spy.calls[0][1] === "rdap");
  check("retain rdap: the registry answer's own text, byte for byte", spy.calls[0]?.[2].body === domainText);
  check("retain rdap: status and the response's own headers", spy.calls[0]?.[2].status === 200 && spy.calls[0]?.[2].headers.etag === '"r-1"');
  check("retain rdap: only body, headers and status", spy.calls[0] && Object.keys(spy.calls[0][2]).sort().join() === "body,headers,status");
  check("retain rdap: no URL or request detail", leaks(spy.calls).length === 0);
  check("retain rdap: no bootstrap fetched, so none kept", t.net.calls.every((c) => !c.url.includes(IANA_MARK)) && spy.calls.length === 1);
  check("retain rdap: no history option asked for", spy.calls[0]?.length === 3);

  // The same run on a host without retain: same graph, same result.
  const old = ctxFor({ nodes, selection: ["d1"], respond: () => ({ status: 200, body: domainText, headers: RESPONSE_HEADERS }) });
  const oldRes = await rdapPlugin.run(old.ctx);
  check("old host: no ctx.retain, the lookup runs as before", !("retain" in old.ctx) && JSON.stringify(oldRes) === JSON.stringify(res));
  check("old host: ...and stages the same graph writes", JSON.stringify(old.graph.updates) === JSON.stringify(t.graph.updates) && old.graph.createdNodes.length === 0);
  check("old host: says nothing about raw results", !old.logs.some((l) => /not kept/.test(l)));
  const notFn = ctxFor({ nodes, selection: ["d1"], respond: () => ({ status: 200, body: domainText }) });
  notFn.ctx.retain = true;
  const notFnRes = await rdapPlugin.run(notFn.ctx).catch((e) => e);
  check("old host: a retain that is not a function is left alone", !(notFnRes instanceof Error) && notFnRes.counts.updated === 1);
}
{
  // 404 kept as evidence; 429, 503 and a network failure kept nowhere.
  const spy = retainSpy();
  const t = ctxFor({
    nodes: {
      a: domainNode("a", "missing.example"),
      b: domainNode("b", "example.com"),
      c: domainNode("c", "busy.example"),
      d: domainNode("d", "down.example"),
      e: domainNode("e", "offline.example"),
    },
    selection: ["a", "b", "c", "d", "e"],
    respond: (url) =>
      url.endsWith("missing.example")
        ? { status: 404, body: notFoundBody }
        : url.endsWith("busy.example")
          ? { status: 429, body: { errorCode: 429 } }
          : url.endsWith("down.example")
            ? { status: 503, body: "<html>Service Unavailable</html>" }
            : url.endsWith("offline.example")
              ? { throws: true }
              : { status: 200, body: domainText },
  });
  t.ctx.retain = spy;
  const res = await rdapPlugin.run(t.ctx);
  check("retain rdap: a 404 is kept on its own domain, and 200s as usual", spy.calls.map((c) => `${c[0]}:${c[1]}:${c[2].status}`).join() === "a:rdap:404,b:rdap:200");
  check("retain rdap: the 404 keeps the registry's own error text", spy.calls[0]?.[2].body === JSON.stringify(notFoundBody));
  check("retain rdap: 429, 503 and a network failure are not kept", !spy.calls.some((c) => ["c", "d", "e"].includes(c[0])));
  check("retain rdap: misses still write nothing", res.counts.updated === 1 && t.graph.updates.length === 1 && t.graph.updates[0].id === "b");
}
{
  // A host that answers a refused request with status 0 rather than throwing: never kept.
  const spy = retainSpy();
  const t = ctxFor({ nodes: { a: domainNode("a", "example.com") }, selection: ["a"], respond: () => ({ status: 0, body: "" }) });
  t.ctx.retain = spy;
  await rdapPlugin.run(t.ctx);
  check("retain rdap: status 0 is not a response and is not kept", spy.calls.length === 0);
}
{
  // A refusal is an object, not a throw — and either way the run carries on.
  const refuse = retainSpy(async () => ({ kept: false, reason: "over this run's raw-result budget" }));
  const t = ctxFor({
    nodes: { a: domainNode("a", "one.example"), b: domainNode("b", "two.example"), c: domainNode("c", "three.example") },
    selection: ["a", "b", "c"],
    respond: () => ({ status: 200, body: domainText }),
  });
  t.ctx.retain = refuse;
  const res = await rdapPlugin.run(t.ctx).catch((e) => e);
  check("retain refusal: the run still succeeds", !(res instanceof Error) && res.counts.updated === 3 && refuse.calls.length === 3);
  check("retain refusal: said once, not once per domain", t.logs.filter((l) => /^Raw rdap result not kept — over this run's raw-result budget$/.test(l)).length === 1);

  const thrower = retainSpy(async () => {
    throw new Error("host blew up");
  });
  const h = ctxFor({ nodes: { a: domainNode("a", "one.example"), b: domainNode("b", "two.example") }, selection: ["a", "b"], respond: () => ({ status: 200, body: domainText }) });
  h.ctx.retain = thrower;
  const hres = await rdapPlugin.run(h.ctx).catch((e) => e);
  check("retain throw: the run still succeeds with everything mapped", !(hres instanceof Error) && hres.counts.updated === 2 && h.graph.updates.length === 2);
  check("retain throw: logged once, without the host's message", h.logs.filter((l) => /^Raw rdap result not kept — the host could not keep it$/.test(l)).length === 1 && !h.logs.some((l) => /blew up/.test(l)));
}
{
  // Only RDAP Domain keeps anything: a DNS lookup on a host with retain keeps nothing.
  const dnsA = pack.plugins.find((p) => p.manifest.identifier === "run.vineyard.plugins.dns_lookup_a");
  const spy = retainSpy();
  const t = ctxFor({ nodes: { a: domainNode("a", "example.com") }, selection: ["a"], respond: () => ({ status: 200, body: { Status: 0, Answer: [{ type: 1, data: "192.0.2.1" }] } }) });
  t.ctx.retain = spy;
  await dnsA.run(t.ctx);
  check("other plugins: DNS Lookup (A) keeps nothing", t.graph.createdNodes.length === 1 && spy.calls.length === 0);
}
{
  check("pack version is 2.3.0", pack.version === "2.3.0");
  check("RDAP Domain version is 1.1.0", rdapPlugin.manifest.version === "1.1.0");
}
for (const n of ok) console.log(`  ok   ${n}`);
for (const n of fail) console.log(`  FAIL ${n}`);
console.log(fail.length ? `\n${fail.length} FAILED` : `\nall ${ok.length} checks passed`);
process.exit(fail.length ? 1 : 0);
