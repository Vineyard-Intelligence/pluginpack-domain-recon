# dist/

The runnable bundle (`pack.mjs`), built from `src/main.ts` and the plugin SDK it imports
(`src/sdk.ts`) by `build.mjs` (esbuild). The SDK is inlined on purpose — the module is fetched by
URL and runs in a worker with no import map.

Regenerate after editing source, then refresh the catalog manifest from the bundle:

```bash
node build.mjs && node gen-manifest.mjs
```
