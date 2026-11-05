#!/usr/bin/env node
// Verifies src/catalog.generated.ts is up to date.
// Mirrors pi-transcribe's scripts/verify-catalog.mjs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed`))));
  });
}

const generatedPath = join(process.cwd(), "src", "catalog.generated.ts");
const before = await readFile(generatedPath, "utf8").catch(() => "");
await run(process.execPath, [join(process.cwd(), "scripts", "generate-catalog.mjs")]);
const after = await readFile(generatedPath, "utf8");
if (before !== after) {
  console.error("catalog.generated.ts is out of date. Run: npm run catalog:generate");
  process.exit(1);
}
console.log("catalog.generated.ts is up to date");
