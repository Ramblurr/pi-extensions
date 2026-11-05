import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Startup boundaries must stay cheap. index.ts (extension load) defers
// the runtime itself to first use, and runtime.ts defers the native
// Kokoro backend. This walks compiled JS, where type-only imports are
// erased and dynamic import() never matches static `from`/`import "…"` .
const BOUNDARIES: Record<string, string[]> = {
  index: ["runtime", "synthesis", "synthesis-service", "audio", "text", "catalog"],
  runtime: ["kokoro-js"],
};

function staticImports(module: string): string[] {
  const source = readFileSync(new URL(`../src/${module}.js`, import.meta.url), "utf8");
  return [...source.matchAll(/(?:from|import) "\.\/([a-z.-]+)\.js"/g)].map((match) => match[1]!);
}

function eagerGraph(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  for (let module = queue.shift(); module; module = queue.shift()) {
    if (seen.has(module)) continue;
    seen.add(module);
    queue.push(...staticImports(module));
  }
  return seen;
}

for (const [root, forbidden] of Object.entries(BOUNDARIES)) {
  test(`${root}.ts does not statically load deferred modules`, () => {
    const reachable = eagerGraph(root);
    for (const module of forbidden) {
      assert.equal(reachable.has(module), false, `${module}.ts is statically reachable from ${root}.ts`);
    }
  });
}
