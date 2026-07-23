import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../index.ts";

describe("package", () => {
  test("loads the extension factory", () => {
    expect(typeof extension).toBe("function");
  });

  test("runs Clojure tests outside the package directory", () => {
    const packageRoot = dirname(fileURLToPath(new URL("../index.ts", import.meta.url)));
    const workingDirectory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-test-"));

    try {
      const result = Bun.spawnSync(
        ["bb", "--config", join(packageRoot, "bb.edn"), "test"],
        { cwd: workingDirectory, stderr: "pipe", stdout: "pipe" },
      );
      const stdout = result.stdout.toString();

      expect({
        exitCode: result.exitCode,
        ranDependencies: stdout.includes("Testing pi-sexp-edit.dependencies-test"),
        ranParser: stdout.includes("Testing pi-sexp-edit.parse-test"),
      }).toEqual({
        exitCode: 0,
        ranDependencies: true,
        ranParser: true,
      });
    } finally {
      rmSync(workingDirectory, { force: true, recursive: true });
    }
  });

  test("rejects a focused helper that is not a test", () => {
    const packageRoot = dirname(fileURLToPath(new URL("../index.ts", import.meta.url)));
    const result = Bun.spawnSync(
      [
        "bb",
        "--config",
        join(packageRoot, "bb.edn"),
        "test",
        "--focus",
        "pi-sexp-edit.parse-test/entry-with-source",
      ],
      { cwd: packageRoot, stderr: "pipe", stdout: "pipe" },
    );

    expect(result.exitCode).not.toBe(0);
  });
});
