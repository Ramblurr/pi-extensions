#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptDirectory, "../catalog/catalog.json");
const output = resolve(scriptDirectory, "../src/catalog.generated.ts");
const catalog = JSON.parse(await readFile(source, "utf8"));

if (catalog.version !== 1 || !Array.isArray(catalog.models)) {
  throw new Error("Expected a version 1 pi-speak catalog");
}

const generated = `// Generated from catalog/catalog.json by scripts/generate-catalog.mjs.
// Do not edit by hand.

export const CATALOG_MODELS_GENERATED = ${JSON.stringify(catalog.models, null, 2)} as const;
`;
await writeFile(output, generated);
console.error(`Wrote ${output} with ${catalog.models.length} models`);
