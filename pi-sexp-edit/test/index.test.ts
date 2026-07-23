import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const optionalSchema = Symbol("optional-schema");
type MockSchema = Record<PropertyKey, unknown>;

const MockType = {
  Array(items: unknown, options: MockSchema = {}): MockSchema {
    return { type: "array", items, ...options };
  },
  Boolean(options: MockSchema = {}): MockSchema {
    return { type: "boolean", ...options };
  },
  Integer(options: MockSchema = {}): MockSchema {
    return { type: "integer", ...options };
  },
  Object(properties: Record<string, MockSchema>, options: MockSchema = {}): MockSchema {
    const entries = Object.entries(properties);
    return {
      type: "object",
      required: entries
        .filter(([, schema]) => schema[optionalSchema] !== true)
        .map(([name]) => name),
      properties: Object.fromEntries(
        entries.map(([name, schema]) => {
          const { [optionalSchema]: _optional, ...definition } = schema;
          return [name, definition];
        }),
      ),
      ...options,
    };
  },
  Optional(schema: MockSchema): MockSchema {
    return { ...schema, [optionalSchema]: true };
  },
  String(options: MockSchema = {}): MockSchema {
    return { type: "string", ...options };
  },
  Union(anyOf: unknown[]): MockSchema {
    return { anyOf };
  },
};

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum(values: readonly string[], options: MockSchema = {}) {
    return { type: "string", enum: [...values], ...options };
  },
  Type: MockType,
}));

const extensionModule = await import("../index.ts");
const extension = extensionModule.default;

interface CapturedTool {
  description: string;
  execute?: (...args: unknown[]) => unknown;
  label: string;
  name: string;
  parameters: unknown;
}

function captureTools(): CapturedTool[] {
  const tools: CapturedTool[] = [];
  extension({
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  return tools;
}

function schemaAccepts(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const definition = schema as Record<string, unknown>;
  if (Array.isArray(definition.anyOf)) {
    return definition.anyOf.some((branch) => schemaAccepts(branch, value));
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) return false;

  switch (definition.type) {
    case "array": {
      if (!Array.isArray(value)) return false;
      if (typeof definition.minItems === "number" && value.length < definition.minItems) {
        return false;
      }
      return value.every((item) => schemaAccepts(definition.items, item));
    }
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        Number.isInteger(value) &&
        (typeof definition.minimum !== "number" || (value as number) >= definition.minimum) &&
        (typeof definition.maximum !== "number" || (value as number) <= definition.maximum)
      );
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      const properties = (definition.properties ?? {}) as Record<string, unknown>;
      const required = (definition.required ?? []) as string[];
      if (!required.every((name) => Object.hasOwn(object, name))) return false;
      if (definition.additionalProperties === false) {
        if (Object.keys(object).some((name) => !Object.hasOwn(properties, name))) return false;
      }
      return Object.entries(object).every(
        ([name, item]) => !Object.hasOwn(properties, name) || schemaAccepts(properties[name], item),
      );
    }
    case "string":
      return (
        typeof value === "string" &&
        (typeof definition.minLength !== "number" || value.length >= definition.minLength) &&
        (typeof definition.pattern !== "string" || new RegExp(definition.pattern).test(value))
      );
    default:
      return false;
  }
}

function accepts(tool: CapturedTool | undefined, value: unknown): boolean {
  return tool ? schemaAccepts(tool.parameters, value) : false;
}

function propertyDefaults(schema: unknown, property: string): unknown[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item) => propertyDefaults(item, property));
  }
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties as Record<string, Record<string, unknown>> | undefined;
  const ownDefault = properties?.[property]?.default;
  return [
    ...(ownDefault === undefined ? [] : [ownDefault]),
    ...Object.values(record).flatMap((item) => propertyDefaults(item, property)),
  ];
}

function propertyOptions(schema: unknown, property: string, option: string): unknown[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item) => propertyOptions(item, property, option));
  }
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties as Record<string, Record<string, unknown>> | undefined;
  const ownValue = properties?.[property]?.[option];
  return [
    ...(ownValue === undefined ? [] : [ownValue]),
    ...Object.values(record).flatMap((item) => propertyOptions(item, property, option)),
  ];
}

function propertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      Object.keys(properties).forEach((name) => names.add(name));
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return names;
}

interface ExecOptions { signal?: AbortSignal; timeout?: number }
interface ExecResult { code: number; killed?: boolean; stderr: string; stdout: string }
type ProcessRunner = (pi: ExtensionAPI, request: unknown, signal?: AbortSignal) => Promise<unknown>;

function processRunner(): ProcessRunner | undefined {
  return (extensionModule as unknown as { invokeBabashka?: ProcessRunner }).invokeBabashka;
}

function apiWithExec(
  execute: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>,
): ExtensionAPI {
  return { exec: execute } as unknown as ExtensionAPI;
}

async function caught(thunk: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await thunk();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function successEnvelope(state: unknown = { baseline: "ok" }): string {
  return JSON.stringify({ ok: true, protocol_version: 1, result: { text: "ok" }, state });
}

function domainEnvelope(): string {
  return JSON.stringify({
    error: { code: "changed", data: {}, message: "changed" },
    ok: false,
    protocol_version: 1,
    state: { baseline: "latest" },
  });
}

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

  test("registers exactly the two structural tools", () => {
    expect(captureTools().map(({ name }) => name)).toEqual(["sexp_read", "sexp_edit"]);
  });

  test("read accepts exactly path or document and scopes target to document", () => {
    const read = captureTools().find(({ name }) => name === "sexp_read");
    const cases: Array<[unknown, boolean]> = [
      [{ path: "src/example.clj" }, true],
      [{ document: "D4" }, true],
      [{ document: "D4", target: "§7" }, true],
      [{}, false],
      [{ document: "D4", path: "src/example.clj" }, false],
      [{ path: "src/example.clj", target: "§7" }, false],
    ];
    expect(cases.map(([input]) => accepts(read, input))).toEqual(
      cases.map(([, accepted]) => accepted),
    );
  });

  test("read depth bounds and conditional defaults are explicit", () => {
    const read = captureTools().find(({ name }) => name === "sexp_read");
    expect({
      accepted: [
        accepts(read, { depth: 0, path: "a.clj" }),
        accepts(read, { depth: 20, path: "a.clj" }),
        accepts(read, { depth: 2, document: "D1", target: "§1" }),
      ],
      defaults: propertyDefaults(read?.parameters, "depth").sort(),
      includeAtomsDefaults: [...new Set(propertyDefaults(read?.parameters, "include_atoms"))],
      rejected: [
        accepts(read, { depth: -1, path: "a.clj" }),
        accepts(read, { depth: 21, path: "a.clj" }),
        accepts(read, { depth: 1.5, path: "a.clj" }),
      ],
    }).toEqual({
      accepted: [true, true, true],
      defaults: [0, 0, 2],
      includeAtomsDefaults: [false],
      rejected: [false, false, false],
    });
  });

  test("edit requires a document and a non-empty edit array", () => {
    const edit = captureTools().find(({ name }) => name === "sexp_edit");
    expect({
      accepted: accepts(edit, {
        document: "D1",
        edits: [{ operation: "delete", target: "§1" }],
      }),
      empty: accepts(edit, { document: "D1", edits: [] }),
      missingDocument: accepts(edit, {
        edits: [{ operation: "delete", target: "§1" }],
      }),
      missingEdits: accepts(edit, { document: "D1" }),
    }).toEqual({ accepted: true, empty: false, missingDocument: false, missingEdits: false });
  });

  test("operation-specific new_form requirements hold", () => {
    const edit = captureTools().find(({ name }) => name === "sexp_edit");
    const validOperations = [
      { new_form: "(new)", operation: "replace", target: "§1" },
      { new_form: "(new)", operation: "insert_before", target: "§1" },
      { new_form: "(new)", operation: "insert_after", target: "§1" },
      { operation: "delete", target: "§1" },
    ];
    const invalidOperations = [
      { operation: "replace", target: "§1" },
      { operation: "insert_before", target: "§1" },
      { operation: "insert_after", target: "§1" },
      { new_form: "(forbidden)", operation: "delete", target: "§1" },
      { new_form: "(new)", operation: "move", target: "§1" },
    ];
    expect({
      invalid: invalidOperations.map((operation) =>
        accepts(edit, { document: "D1", edits: [operation] }),
      ),
      valid: validOperations.map((operation) =>
        accepts(edit, { document: "D1", edits: [operation] }),
      ),
    }).toEqual({ invalid: [false, false, false, false, false], valid: [true, true, true, true] });
  });

  test("unknown properties fail at every object level", () => {
    const tools = captureTools();
    const read = tools.find(({ name }) => name === "sexp_read");
    const edit = tools.find(({ name }) => name === "sexp_edit");
    expect({
      rejected: [
        accepts(read, { extra: true, path: "a.clj" }),
        accepts(read, { document: "D1", extra: true }),
        accepts(edit, {
          document: "D1",
          edits: [{ operation: "delete", target: "§1" }],
          extra: true,
        }),
        accepts(edit, {
          document: "D1",
          edits: [{ extra: true, operation: "delete", target: "§1" }],
        }),
      ],
      toolsPresent: Boolean(read && edit),
    }).toEqual({ rejected: [false, false, false, false], toolsPresent: true });
  });

  test("edit schema exposes no positional or revision preconditions", () => {
    const edit = captureTools().find(({ name }) => name === "sexp_edit");
    const fields = propertyNames(edit?.parameters);
    expect({
      forbidden: [
        "expected_hash",
        "hash",
        "revision",
        "path",
        "old_form",
        "line",
        "column",
        "offset",
      ].filter((name) => fields.has(name)),
      schemaPresent: Boolean(edit?.parameters),
    }).toEqual({ forbidden: [], schemaPresent: true });
  });

  test("all public handles use one shared marker pattern", () => {
    const tools = captureTools();
    const read = tools.find(({ name }) => name === "sexp_read");
    const edit = tools.find(({ name }) => name === "sexp_edit");
    expect({
      exportedPattern: extensionModule.HANDLE_PATTERN,
      patterns: [
        ...propertyOptions(read?.parameters, "target", "pattern"),
        ...propertyOptions(edit?.parameters, "target", "pattern"),
      ],
      rejectsMalformed: [
        accepts(read, { document: "D1", target: "§A" }),
        accepts(edit, {
          document: "D1",
          edits: [{ operation: "delete", target: "§-" }],
        }),
      ],
    }).toEqual({
      exportedPattern: "^§[0-9a-z]+$",
      patterns: ["^§[0-9a-z]+$", "^§[0-9a-z]+$", "^§[0-9a-z]+$"],
      rejectsMalformed: [false, false],
    });
  });


  test("tool descriptions teach the agent the lifecycle and output contract", () => {
    const tools = Object.fromEntries(captureTools().map((tool) => [tool.name, tool]));
    const read = tools.sexp_read?.description.toLowerCase() ?? "";
    const edit = tools.sexp_edit?.description.toLowerCase() ?? "";
    expect({
      edit: ["immutable", "conflict", "transaction", "repair", "2,000", "50 kb"].every((term) =>
        edit.includes(term),
      ),
      read: ["immutable", "handle", "2,000", "50 kb"].every((term) => read.includes(term)),
      shells: [typeof tools.sexp_read?.execute, typeof tools.sexp_edit?.execute],
    }).toEqual({ edit: true, read: true, shells: ["function", "function"] });
  });

  test("runner uses package resources, fixed argv, and a private request file", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const controller = new AbortController();
    const request = { source: "secret source ; $(touch /tmp/nope)", state: { secret: true } };
    let observed: Record<string, unknown> = {};
    const pi = apiWithExec(async (command, args, options) => {
      const requestPath = args.at(-1)!;
      observed = {
        args, command, options, requestPath,
        configAbsolute: isAbsolute(args[1]!),
        contents: JSON.parse(readFileSync(requestPath, "utf8")),
        existsDuringExec: existsSync(requestPath),
        mode: statSync(requestPath).mode & 0o777,
      };
      return { code: 0, stderr: "", stdout: successEnvelope() };
    });
    const response = (await run(pi, request, controller.signal)) as Record<string, unknown>;
    const args = observed.args as string[];
    const expectedConfig = join(dirname(fileURLToPath(new URL("../index.ts", import.meta.url))), "bb.edn");
    expect({
      argsPrefix: args?.slice(0, 5),
      command: observed.command,
      configAbsolute: observed.configAbsolute,
      configPath: args?.[1],
      contents: observed.contents,
      existsAfter: existsSync(observed.requestPath as string),
      existsDuringExec: observed.existsDuringExec,
      mode: observed.mode,
      requestArgContainsSecret: args?.some((arg) => arg.includes("secret source")),
      responseOk: response.ok,
      signalForwarded: (observed.options as ExecOptions).signal === controller.signal,
      timeout: (observed.options as ExecOptions).timeout,
    }).toEqual({
      argsPrefix: ["--config", expectedConfig, "-m", "pi-sexp-edit.main", "--request"],
      command: "bb", configAbsolute: true, configPath: expectedConfig, contents: request,
      existsAfter: false, existsDuringExec: true, mode: 0o600, requestArgContainsSecret: false,
      responseOk: true, signalForwarded: true, timeout: extensionModule.BABASHKA_TIMEOUT_MS,
    });
  });

  test("request material disappears after every process outcome", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const outcomes = [
      { name: "success", result: { code: 0, stderr: "", stdout: successEnvelope() } },
      { name: "domain", result: { code: 0, stderr: "", stdout: domainEnvelope() } },
      { name: "nonzero", result: { code: 2, stderr: "failed", stdout: "" } },
      { name: "process-error", throws: new Error("spawn failed") },
      { name: "timeout-rejection", throws: new Error("timed out") },
      { name: "cancellation-rejection", throws: new Error("aborted") },
      { name: "timeout-killed", result: { code: 0, killed: true, stderr: "timed out", stdout: "" } },
      { name: "cancellation-killed", result: { code: 0, killed: true, stderr: "aborted", stdout: "" } },
    ];
    const cleaned: Record<string, boolean> = {};
    for (const outcome of outcomes) {
      let requestPath = "";
      const controller = new AbortController();
      const pi = apiWithExec(async (_command, args) => {
        requestPath = args.at(-1)!;
        if (outcome.name.startsWith("cancellation")) controller.abort();
        if (outcome.throws) throw outcome.throws;
        return outcome.result!;
      });
      await caught(() => run(pi, { source: outcome.name }, controller.signal));
      cleaned[outcome.name] = requestPath.length > 0 && !existsSync(requestPath);
    }
    expect(cleaned).toEqual({
      "cancellation-killed": true, "cancellation-rejection": true, domain: true,
      nonzero: true, "process-error": true, success: true,
      "timeout-killed": true, "timeout-rejection": true,
    });
  });

  test("nonzero exits expose only bounded stderr diagnostics", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const maximum = extensionModule.MAX_DIAGNOSTIC_BYTES;
    const error = await caught(() => run(apiWithExec(async () => ({
      code: 7, stderr: "x".repeat(maximum * 2), stdout: "",
    })), { source: "x" }));
    expect({
      bounded: Buffer.byteLength(error?.message ?? "") <= maximum + 256,
      hasExitCode: error?.message.includes("7"), maximum,
    }).toEqual({ bounded: true, hasExitCode: true, maximum: 16_384 });
  });

  test("empty malformed extra wrong-version missing and oversized responses are rejected", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const maximum = extensionModule.MAX_PROTOCOL_BYTES;
    const outputs = {
      empty: "", extra: `${successEnvelope()}\ndebug`, malformed: "{",
      missing: JSON.stringify({ ok: true, protocol_version: 1, result: {} }),
      oversized: "x".repeat(maximum + 1),
      wrongVersion: JSON.stringify({ ok: true, protocol_version: 2, result: {}, state: {} }),
    };
    const rejected: Record<string, boolean> = {};
    for (const [name, stdout] of Object.entries(outputs)) {
      rejected[name] = Boolean(await caught(() => run(
        apiWithExec(async () => ({ code: 0, stderr: "", stdout })), { source: name },
      )));
    }
    expect({ maximum, rejected }).toEqual({
      maximum: 16 * 1024 * 1024,
      rejected: { empty: true, extra: true, malformed: true, missing: true, oversized: true, wrongVersion: true },
    });
  });

  test("valid failure envelopes return state and malformed failures are rejected", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const valid = JSON.parse(domainEnvelope()) as Record<string, unknown>;
    const accepted = (await run(
      apiWithExec(async () => ({ code: 0, stderr: "", stdout: JSON.stringify(valid) })),
      { source: "domain" },
    )) as Record<string, unknown>;
    const validError = valid.error as Record<string, unknown>;
    const malformed = {
      errorCodeType: { ...valid, error: { ...validError, code: 7 } },
      errorDataType: { ...valid, error: { ...validError, data: [] } },
      errorExtra: { ...valid, error: { ...validError, extra: true } },
      errorMessageType: { ...valid, error: { ...validError, message: 7 } },
      errorMissing: { ...valid, error: { code: "changed", message: "changed" } },
      stateType: { ...valid, state: [] },
      topExtra: { ...valid, extra: true },
      topMissing: { error: valid.error, ok: false, protocol_version: 1 },
    };
    const rejected: Record<string, boolean> = {};
    for (const [name, envelope] of Object.entries(malformed)) {
      rejected[name] = Boolean(await caught(() => run(
        apiWithExec(async () => ({ code: 0, stderr: "", stdout: JSON.stringify(envelope) })),
        { source: name },
      )));
    }
    expect({ ok: accepted.ok, rejected, state: accepted.state }).toEqual({
      ok: false,
      rejected: {
        errorCodeType: true, errorDataType: true, errorExtra: true, errorMessageType: true,
        errorMissing: true, stateType: true, topExtra: true, topMissing: true,
      },
      state: { baseline: "latest" },
    });
  });


  test("opaque state is returned only after the full envelope validates", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const state = { handles: { "§1": { hidden: "opaque" } }, token: "trusted-only-after-validation" };
    const accepted = (await run(
      apiWithExec(async () => ({ code: 0, stderr: "", stdout: successEnvelope(state) })),
      { source: "valid" },
    )) as { state: unknown };
    const rejected = await caught(() => run(
      apiWithExec(async () => ({
        code: 0, stderr: "",
        stdout: JSON.stringify({ extra: true, ok: true, protocol_version: 1, result: {}, state }),
      })),
      { source: "invalid" },
    ));
    expect({ accepted: accepted.state, invalidRejected: Boolean(rejected) }).toEqual({
      accepted: state, invalidRejected: true,
    });
  });
});
