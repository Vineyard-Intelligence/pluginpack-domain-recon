// Regenerates plugins/domain-recon.manifest.json from the bundle in dist/pack.mjs.
//
// The two copies have to agree, and the JS is authoritative — it is what actually runs — so this
// pours the pack's manifests into the JSON the catalog reads. Same pattern as
// pluginpack-virustotal-community.
//
// Run after a build:  node gen-manifest.mjs
import { writeFileSync } from 'node:fs';

const pack = (await import('./dist/pack.mjs')).default;
const doc = { ...pack, plugins: pack.plugins.map((p) => p.manifest) };
writeFileSync(
    new URL('./plugins/domain-recon.manifest.json', import.meta.url),
    JSON.stringify(doc, null, 2) + '\n',
);
console.log(`wrote plugins/domain-recon.manifest.json — ${doc.plugins.length} plugins`);
