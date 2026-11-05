import { mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

const outputDirectory = await mkdtemp(join(process.cwd(), ".pi-speak-test-"));
try {
  await run(process.execPath, [
    join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "false",
    "--outDir",
    outputDirectory,
  ]);
  await run(process.execPath, [
    "--test",
    ...(await readdir(join(outputDirectory, "test")))
      .filter((name) => name.endsWith(".test.js"))
      .sort()
      .map((name) => join(outputDirectory, "test", name)),
  ]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
