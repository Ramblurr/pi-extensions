import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  open as nodeOpen,
  readFile as readFileBytes,
  rename as renameFile,
} from "node:fs/promises";

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
  Object(
    properties: Record<string, MockSchema>,
    options: MockSchema = {},
  ): MockSchema {
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

function mockTruncateHead(
  content: string,
  options: { maxBytes?: number; maxLines?: number } = {},
) {
  const maxBytes = options.maxBytes ?? 50 * 1024;
  const maxLines = options.maxLines ?? 2000;
  const totalBytes = Buffer.byteLength(content);
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      firstLineExceedsLimit: false,
      lastLinePartial: false,
      maxBytes,
      maxLines,
      outputBytes: totalBytes,
      outputLines: totalLines,
      totalBytes,
      totalLines,
      truncated: false,
      truncatedBy: null,
    };
  }
  if (Buffer.byteLength(lines[0] ?? "") > maxBytes) {
    return {
      content: "",
      firstLineExceedsLimit: true,
      lastLinePartial: false,
      maxBytes,
      maxLines,
      outputBytes: 0,
      outputLines: 0,
      totalBytes,
      totalLines,
      truncated: true,
      truncatedBy: "bytes",
    };
  }
  const selected: string[] = [];
  let countedBytes = 0;
  let truncatedBy: "bytes" | "lines" = "lines";
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const bytes = Buffer.byteLength(lines[index] ?? "") + (index > 0 ? 1 : 0);
    if (countedBytes + bytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    selected.push(lines[index] ?? "");
    countedBytes += bytes;
  }
  if (selected.length >= maxLines && countedBytes <= maxBytes)
    truncatedBy = "lines";
  const result = selected.join("\n");
  return {
    content: result,
    firstLineExceedsLimit: false,
    lastLinePartial: false,
    maxBytes,
    maxLines,
    outputBytes: Buffer.byteLength(result),
    outputLines: selected.length,
    totalBytes,
    totalLines,
    truncated: true,
    truncatedBy,
  };
}

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum(values: readonly string[], options: MockSchema = {}) {
    return { type: "string", enum: [...values], ...options };
  },
  Type: MockType,
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
  DEFAULT_MAX_BYTES: 50 * 1024,
  DEFAULT_MAX_LINES: 2000,
  formatSize(bytes: number) {
    return `${bytes}B`;
  },
  truncateHead: mockTruncateHead,
  async withFileMutationQueue(_path: string, task: () => Promise<unknown>) {
    return task();
  },
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
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return false;
  const definition = schema as Record<string, unknown>;
  if (Array.isArray(definition.anyOf)) {
    return definition.anyOf.some((branch) => schemaAccepts(branch, value));
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value))
    return false;

  switch (definition.type) {
    case "array": {
      if (!Array.isArray(value)) return false;
      if (
        typeof definition.minItems === "number" &&
        value.length < definition.minItems
      ) {
        return false;
      }
      return value.every((item) => schemaAccepts(definition.items, item));
    }
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        Number.isInteger(value) &&
        (typeof definition.minimum !== "number" ||
          (value as number) >= definition.minimum) &&
        (typeof definition.maximum !== "number" ||
          (value as number) <= definition.maximum)
      );
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const object = value as Record<string, unknown>;
      const properties = (definition.properties ?? {}) as Record<
        string,
        unknown
      >;
      const required = (definition.required ?? []) as string[];
      if (!required.every((name) => Object.hasOwn(object, name))) return false;
      if (definition.additionalProperties === false) {
        if (
          Object.keys(object).some((name) => !Object.hasOwn(properties, name))
        )
          return false;
      }
      return Object.entries(object).every(
        ([name, item]) =>
          !Object.hasOwn(properties, name) ||
          schemaAccepts(properties[name], item),
      );
    }
    case "string":
      return (
        typeof value === "string" &&
        (typeof definition.minLength !== "number" ||
          value.length >= definition.minLength) &&
        (typeof definition.pattern !== "string" ||
          new RegExp(definition.pattern).test(value))
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
  const properties = record.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const ownDefault = properties?.[property]?.default;
  return [
    ...(ownDefault === undefined ? [] : [ownDefault]),
    ...Object.values(record).flatMap((item) =>
      propertyDefaults(item, property),
    ),
  ];
}

function propertyOptions(
  schema: unknown,
  property: string,
  option: string,
): unknown[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item) => propertyOptions(item, property, option));
  }
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const ownValue = properties?.[property]?.[option];
  return [
    ...(ownValue === undefined ? [] : [ownValue]),
    ...Object.values(record).flatMap((item) =>
      propertyOptions(item, property, option),
    ),
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
    if (
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties)
    ) {
      Object.keys(properties).forEach((name) => names.add(name));
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return names;
}

interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
}
interface ExecResult {
  code: number;
  killed?: boolean;
  stderr: string;
  stdout: string;
}
type ProcessRunner = (
  pi: ExtensionAPI,
  request: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

function processRunner(): ProcessRunner | undefined {
  return (extensionModule as unknown as { invokeBabashka?: ProcessRunner })
    .invokeBabashka;
}

function apiWithExec(
  execute: (
    command: string,
    args: string[],
    options: ExecOptions,
  ) => Promise<ExecResult>,
): ExtensionAPI {
  return { exec: execute } as unknown as ExtensionAPI;
}

async function caught(
  thunk: () => Promise<unknown>,
): Promise<Error | undefined> {
  try {
    await thunk();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function successEnvelope(state: unknown = { baseline: "ok" }): string {
  return JSON.stringify({
    ok: true,
    protocol_version: 1,
    result: { text: "ok" },
    state,
  });
}

function domainEnvelope(): string {
  return JSON.stringify({
    error: { code: "changed", data: {}, message: "changed" },
    ok: false,
    protocol_version: 1,
    state: { baseline: "latest" },
  });
}

interface TestLock {
  run<T>(task: () => Promise<T> | T): Promise<T>;
}

interface TestDocumentRecord {
  canonicalPath: string;
  documentId: string;
  lock: TestLock;
  state?: unknown;
}

interface TestRegistry {
  getDocument(documentId: string): TestDocumentRecord;
  openPath(path: string, cwd: string): Promise<TestDocumentRecord>;
}

function registryFactory(): (() => TestRegistry) | undefined {
  return (
    extensionModule as unknown as {
      createDocumentRegistry?: () => TestRegistry;
    }
  ).createDocumentRegistry;
}

interface RuntimeDependencies {
  invokeBabashka: (
    pi: ExtensionAPI,
    request: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  formatOutput?: (output: string) => Promise<{
    fullOutputPath?: string;
    text: string;
    truncation: {
      outputBytes: number;
      outputLines: number;
      totalBytes: number;
      totalLines: number;
    };
  }>;
  readFile?: (path: string) => Promise<Uint8Array>;
  rename?: (source: string, destination: string) => Promise<void>;
  openFile?: (path: string, flags: string, mode: number) => Promise<unknown>;
  withFileMutationQueue?: <T>(
    path: string,
    task: () => Promise<T>,
  ) => Promise<T>;
}

type RuntimeFactory = (
  pi: ExtensionAPI,
  dependencies: RuntimeDependencies,
) => void;

function runtimeFactory(): RuntimeFactory | undefined {
  return (
    extensionModule as unknown as { createSexpExtension?: RuntimeFactory }
  ).createSexpExtension;
}

function captureRuntimeTools(
  dependencies: RuntimeDependencies,
): CapturedTool[] {
  const factory = runtimeFactory();
  if (!factory) return [];
  const tools: CapturedTool[] = [];
  factory(
    {
      async exec() {
        throw new Error("unexpected real exec");
      },
      registerTool(tool: CapturedTool) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI,
    dependencies,
  );
  return tools;
}

async function executeReadTool(
  tool: CapturedTool | undefined,
  parameters: unknown,
  cwd: string,
  signal = new AbortController().signal,
): Promise<Record<string, unknown>> {
  if (!tool?.execute) throw new Error("sexp_read is not registered");
  return (await tool.execute("call", parameters, signal, undefined, {
    cwd,
  })) as Record<string, unknown>;
}

async function executeEditTool(
  tool: CapturedTool | undefined,
  parameters: unknown,
  cwd: string,
  signal = new AbortController().signal,
): Promise<Record<string, unknown>> {
  if (!tool?.execute) throw new Error("sexp_edit is not registered");
  return (await tool.execute("call", parameters, signal, undefined, {
    cwd,
  })) as Record<string, unknown>;
}

function readSuccess(state: unknown, text = "§1 (value)"): unknown {
  return {
    ok: true,
    protocol_version: 1,
    result: { hash: "must-not-leak", revision: 42, text },
    state,
  };
}

function editSuccess(state: unknown, candidateSource = "(new)"): unknown {
  return {
    ok: true,
    protocol_version: 1,
    result: {
      "applied-edits": 1,
      "created-handles": ["§2"],
      "candidate-source": candidateSource,
      diff: "--- file\n+++ file\n-old\n+new\n",
      excerpts: "§2 (new)",
      "excerpt-handles": ["§2"],
      "external-changes-reconciled?": false,
      "omitted-internal-counts": {},
      repairs: [],
      "retired-handles": ["§1"],
    },
    state,
  };
}

async function instrumentedOpen(
  path: string,
  flags: string,
  mode: number,
  operations: string[],
  failAt?: "write" | "sync" | "chmod" | "close",
): Promise<unknown> {
  operations.push(`open:${mode.toString(8)}`);
  const handle = await nodeOpen(path, flags, mode);
  let closeFailed = false;
  return {
    async writeFile(source: string, encoding: string) {
      operations.push("write");
      if (failAt === "write") throw new Error("write failed");
      return handle.writeFile(source, encoding);
    },
    async sync() {
      operations.push("sync");
      if (failAt === "sync") throw new Error("sync failed");
      return handle.sync();
    },
    async chmod(candidateMode: number) {
      operations.push(`chmod:${candidateMode.toString(8)}`);
      if (failAt === "chmod") throw new Error("chmod failed");
      return handle.chmod(candidateMode);
    },
    async close() {
      operations.push("close");
      if (failAt === "close") {
        if (!closeFailed) {
          closeFailed = true;
          await handle.close();
        }
        throw new Error("close failed");
      }
      return handle.close();
    },
  };
}

function task23Ready(): boolean {
  return (
    typeof (extensionModule as unknown as { atomicReplaceFile?: unknown })
      .atomicReplaceFile === "function"
  );
}

function task24Ready(): boolean {
  const module = extensionModule as unknown as Record<string, unknown>;
  return ["formatBoundedOutput", "formatEditOutput", "formatToolError"].every(
    (name) => typeof module[name] === "function",
  );
}

describe("package", () => {
  test("loads the extension factory", () => {
    expect(typeof extension).toBe("function");
  });

  test("runs Clojure tests outside the package directory", () => {
    const packageRoot = dirname(
      fileURLToPath(new URL("../index.ts", import.meta.url)),
    );
    const workingDirectory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-test-"));

    try {
      const result = Bun.spawnSync(
        ["bb", "--config", join(packageRoot, "bb.edn"), "test"],
        { cwd: workingDirectory, stderr: "pipe", stdout: "pipe" },
      );
      const stdout = result.stdout.toString();

      expect({
        exitCode: result.exitCode,
        ranDependencies: stdout.includes(
          "Testing pi-sexp-edit.dependencies-test",
        ),
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
    const packageRoot = dirname(
      fileURLToPath(new URL("../index.ts", import.meta.url)),
    );
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
    expect(captureTools().map(({ name }) => name)).toEqual([
      "sexp_read",
      "sexp_edit",
    ]);
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
      includeAtomsDefaults: [
        ...new Set(propertyDefaults(read?.parameters, "include_atoms")),
      ],
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
    }).toEqual({
      accepted: true,
      empty: false,
      missingDocument: false,
      missingEdits: false,
    });
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
    }).toEqual({
      invalid: [false, false, false, false, false],
      valid: [true, true, true, true],
    });
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
    const tools = Object.fromEntries(
      captureTools().map((tool) => [tool.name, tool]),
    );
    const read = tools.sexp_read?.description.toLowerCase() ?? "";
    const edit = tools.sexp_edit?.description.toLowerCase() ?? "";
    expect({
      edit: [
        "immutable",
        "conflict",
        "transaction",
        "repair",
        "2,000",
        "50 kb",
      ].every((term) => edit.includes(term)),
      read: ["immutable", "handle", "2,000", "50 kb"].every((term) =>
        read.includes(term),
      ),
      shells: [
        typeof tools.sexp_read?.execute,
        typeof tools.sexp_edit?.execute,
      ],
    }).toEqual({ edit: true, read: true, shells: ["function", "function"] });
  });

  test("runner uses package resources, fixed argv, and a private request file", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const controller = new AbortController();
    const request = {
      source: "secret source ; $(touch /tmp/nope)",
      state: { secret: true },
    };
    let observed: Record<string, unknown> = {};
    const pi = apiWithExec(async (command, args, options) => {
      const requestPath = args.at(-1)!;
      observed = {
        args,
        command,
        options,
        requestPath,
        configAbsolute: isAbsolute(args[1]!),
        contents: JSON.parse(readFileSync(requestPath, "utf8")),
        existsDuringExec: existsSync(requestPath),
        mode: statSync(requestPath).mode & 0o777,
      };
      return { code: 0, stderr: "", stdout: successEnvelope() };
    });
    const response = (await run(pi, request, controller.signal)) as Record<
      string,
      unknown
    >;
    const args = observed.args as string[];
    const expectedConfig = join(
      dirname(fileURLToPath(new URL("../index.ts", import.meta.url))),
      "bb.edn",
    );
    expect({
      argsPrefix: args?.slice(0, 5),
      command: observed.command,
      configAbsolute: observed.configAbsolute,
      configPath: args?.[1],
      contents: observed.contents,
      existsAfter: existsSync(observed.requestPath as string),
      existsDuringExec: observed.existsDuringExec,
      mode: observed.mode,
      requestArgContainsSecret: args?.some((arg) =>
        arg.includes("secret source"),
      ),
      responseOk: response.ok,
      signalForwarded:
        (observed.options as ExecOptions).signal === controller.signal,
      timeout: (observed.options as ExecOptions).timeout,
    }).toEqual({
      argsPrefix: [
        "--config",
        expectedConfig,
        "-m",
        "pi-sexp-edit.main",
        "--request",
      ],
      command: "bb",
      configAbsolute: true,
      configPath: expectedConfig,
      contents: request,
      existsAfter: false,
      existsDuringExec: true,
      mode: 0o600,
      requestArgContainsSecret: false,
      responseOk: true,
      signalForwarded: true,
      timeout: extensionModule.BABASHKA_TIMEOUT_MS,
    });
  });

  test("request material disappears after every process outcome", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const outcomes = [
      {
        name: "success",
        result: { code: 0, stderr: "", stdout: successEnvelope() },
      },
      {
        name: "domain",
        result: { code: 0, stderr: "", stdout: domainEnvelope() },
      },
      { name: "nonzero", result: { code: 2, stderr: "failed", stdout: "" } },
      { name: "process-error", throws: new Error("spawn failed") },
      { name: "timeout-rejection", throws: new Error("timed out") },
      { name: "cancellation-rejection", throws: new Error("aborted") },
      {
        name: "timeout-killed",
        result: { code: 0, killed: true, stderr: "timed out", stdout: "" },
      },
      {
        name: "cancellation-killed",
        result: { code: 0, killed: true, stderr: "aborted", stdout: "" },
      },
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
      cleaned[outcome.name] =
        requestPath.length > 0 && !existsSync(requestPath);
    }
    expect(cleaned).toEqual({
      "cancellation-killed": true,
      "cancellation-rejection": true,
      domain: true,
      nonzero: true,
      "process-error": true,
      success: true,
      "timeout-killed": true,
      "timeout-rejection": true,
    });
  });

  test("nonzero exits expose only bounded stderr diagnostics", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const maximum = extensionModule.MAX_DIAGNOSTIC_BYTES;
    const error = await caught(() =>
      run(
        apiWithExec(async () => ({
          code: 7,
          stderr: "x".repeat(maximum * 2),
          stdout: "",
        })),
        { source: "x" },
      ),
    );
    expect({
      bounded: Buffer.byteLength(error?.message ?? "") <= maximum + 256,
      hasExitCode: error?.message.includes("7"),
      maximum,
    }).toEqual({ bounded: true, hasExitCode: true, maximum: 16_384 });
  });

  test("empty malformed extra wrong-version missing and oversized responses are rejected", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const maximum = extensionModule.MAX_PROTOCOL_BYTES;
    const outputs = {
      empty: "",
      extra: `${successEnvelope()}\ndebug`,
      malformed: "{",
      missing: JSON.stringify({ ok: true, protocol_version: 1, result: {} }),
      oversized: "x".repeat(maximum + 1),
      wrongVersion: JSON.stringify({
        ok: true,
        protocol_version: 2,
        result: {},
        state: {},
      }),
    };
    const rejected: Record<string, boolean> = {};
    for (const [name, stdout] of Object.entries(outputs)) {
      rejected[name] = Boolean(
        await caught(() =>
          run(
            apiWithExec(async () => ({ code: 0, stderr: "", stdout })),
            { source: name },
          ),
        ),
      );
    }
    expect({ maximum, rejected }).toEqual({
      maximum: 16 * 1024 * 1024,
      rejected: {
        empty: true,
        extra: true,
        malformed: true,
        missing: true,
        oversized: true,
        wrongVersion: true,
      },
    });
  });

  test("valid failure envelopes return state and malformed failures are rejected", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const valid = JSON.parse(domainEnvelope()) as Record<string, unknown>;
    const accepted = (await run(
      apiWithExec(async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify(valid),
      })),
      { source: "domain" },
    )) as Record<string, unknown>;
    const validError = valid.error as Record<string, unknown>;
    const malformed = {
      errorCodeType: { ...valid, error: { ...validError, code: 7 } },
      errorDataType: { ...valid, error: { ...validError, data: [] } },
      errorExtra: { ...valid, error: { ...validError, extra: true } },
      errorMessageType: { ...valid, error: { ...validError, message: 7 } },
      errorMissing: {
        ...valid,
        error: { code: "changed", message: "changed" },
      },
      stateType: { ...valid, state: [] },
      topExtra: { ...valid, extra: true },
      topMissing: { error: valid.error, ok: false, protocol_version: 1 },
    };
    const rejected: Record<string, boolean> = {};
    for (const [name, envelope] of Object.entries(malformed)) {
      rejected[name] = Boolean(
        await caught(() =>
          run(
            apiWithExec(async () => ({
              code: 0,
              stderr: "",
              stdout: JSON.stringify(envelope),
            })),
            { source: name },
          ),
        ),
      );
    }
    expect({ ok: accepted.ok, rejected, state: accepted.state }).toEqual({
      ok: false,
      rejected: {
        errorCodeType: true,
        errorDataType: true,
        errorExtra: true,
        errorMessageType: true,
        errorMissing: true,
        stateType: true,
        topExtra: true,
        topMissing: true,
      },
      state: { baseline: "latest" },
    });
  });

  test("opaque state is returned only after the full envelope validates", async () => {
    const run = processRunner();
    expect(typeof run).toBe("function");
    if (!run) return;
    const state = {
      handles: { "§1": { hidden: "opaque" } },
      token: "trusted-only-after-validation",
    };
    const accepted = (await run(
      apiWithExec(async () => ({
        code: 0,
        stderr: "",
        stdout: successEnvelope(state),
      })),
      { source: "valid" },
    )) as { state: unknown };
    const rejected = await caught(() =>
      run(
        apiWithExec(async () => ({
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            extra: true,
            ok: true,
            protocol_version: 1,
            result: {},
            state,
          }),
        })),
        { source: "invalid" },
      ),
    );
    expect({
      accepted: accepted.state,
      invalidRejected: Boolean(rejected),
    }).toEqual({
      accepted: state,
      invalidRejected: true,
    });
  });

  test("relative absolute and one-leading-at paths resolve canonically", async () => {
    const createRegistry = registryFactory();
    expect(typeof createRegistry).toBe("function");
    if (!createRegistry) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-registry-"));
    try {
      const ordinary = join(directory, "ordinary.clj");
      const atNamed = join(directory, "@ordinary.clj");
      writeFileSync(ordinary, "(ordinary)");
      writeFileSync(atNamed, "(at-named)");
      const registry = createRegistry();
      const relative = await registry.openPath("ordinary.clj", directory);
      const absolute = await registry.openPath(ordinary, "/unrelated/cwd");
      const oneAt = await registry.openPath("@ordinary.clj", directory);
      const twoAt = await registry.openPath("@@ordinary.clj", directory);
      expect({
        absolute: absolute.canonicalPath,
        oneAt: oneAt.canonicalPath,
        relative: relative.canonicalPath,
        sameRecord: relative === absolute && relative === oneAt,
        twoAt: twoAt.canonicalPath,
      }).toEqual({
        absolute: realpathSync(ordinary),
        oneAt: realpathSync(ordinary),
        relative: realpathSync(ordinary),
        sameRecord: true,
        twoAt: realpathSync(atNamed),
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("symlink aliases reopen one canonical document record", async () => {
    const createRegistry = registryFactory();
    expect(typeof createRegistry).toBe("function");
    if (!createRegistry) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-registry-"));
    try {
      const source = join(directory, "source.clj");
      const alias = join(directory, "alias.clj");
      const unsupportedTarget = join(directory, "target.txt");
      const deceptiveAlias = join(directory, "deceptive.clj");
      const unsupportedAlias = join(directory, "unsupported.txt");
      writeFileSync(source, "(same)");
      writeFileSync(unsupportedTarget, "plain");
      symlinkSync(source, alias);
      symlinkSync(unsupportedTarget, deceptiveAlias);
      symlinkSync(source, unsupportedAlias);
      const registry = createRegistry();
      const direct = await registry.openPath(source, directory);
      const linked = await registry.openPath(alias, directory);
      const canonicalMismatch = await caught(() =>
        registry.openPath(deceptiveAlias, directory),
      );
      const requestedMismatch = await caught(() =>
        registry.openPath(unsupportedAlias, directory),
      );
      expect({
        canonical: linked.canonicalPath,
        mismatchCodes: [canonicalMismatch, requestedMismatch].map(
          (error) => (error as Error & { code?: string })?.code,
        ),
        sameId: direct.documentId === linked.documentId,
        sameRecord: direct === linked,
      }).toEqual({
        canonical: realpathSync(source),
        mismatchCodes: ["unsupported-extension", "unsupported-extension"],
        sameId: true,
        sameRecord: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("only existing regular supported Clojure-family files open", async () => {
    const createRegistry = registryFactory();
    expect(typeof createRegistry).toBe("function");
    if (!createRegistry) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-registry-"));
    try {
      const supported = ["clj", "cljs", "cljc", "bb", "edn", "cljd"];
      const registry = createRegistry();
      const opened: boolean[] = [];
      for (const extension of supported) {
        const path = join(directory, `sample.${extension}`);
        writeFileSync(path, "(ok)");
        opened.push(Boolean(await registry.openPath(path, directory)));
      }
      const unsupported = join(directory, "sample.txt");
      writeFileSync(unsupported, "text");
      const childDirectory = join(directory, "directory.clj");
      mkdirSync(childDirectory);
      const errors = await Promise.all([
        caught(() =>
          registry.openPath(join(directory, "missing.clj"), directory),
        ),
        caught(() => registry.openPath(childDirectory, directory)),
        caught(() => registry.openPath(unsupported, directory)),
      ]);
      expect({
        errorCodes: errors.map(
          (error) => (error as Error & { code?: string })?.code,
        ),
        opened,
      }).toEqual({
        errorCodes: [
          "path-not-found",
          "path-not-file",
          "unsupported-extension",
        ],
        opened: supported.map(() => true),
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("document IDs records states and fresh registries stay isolated", async () => {
    const createRegistry = registryFactory();
    expect(typeof createRegistry).toBe("function");
    if (!createRegistry) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-registry-"));
    try {
      const firstPath = join(directory, "first.clj");
      const secondPath = join(directory, "second.edn");
      writeFileSync(firstPath, "(first)");
      writeFileSync(secondPath, "[:second]");
      const registry = createRegistry();
      const first = await registry.openPath(firstPath, directory);
      const reopened = await registry.openPath(firstPath, directory);
      const second = await registry.openPath(secondPath, directory);
      const records = [first, second];
      for (let index = 3; index <= 10; index += 1) {
        const path = join(directory, `${index}.clj`);
        writeFileSync(path, `(${index})`);
        records.push(await registry.openPath(path, directory));
      }
      first.state = { handles: ["§1"] };
      second.state = { handles: ["§2"] };
      const fresh = createRegistry();
      const unknown = await caught(async () =>
        fresh.getDocument(first.documentId),
      );
      const freshFirst = await fresh.openPath(firstPath, directory);
      expect({
        firstId: first.documentId,
        firstLookup: registry.getDocument(first.documentId) === first,
        firstState: first.state,
        freshFirstId: freshFirst.documentId,
        freshUnknown: (unknown as Error & { code?: string })?.code,
        ninthId: records[8]?.documentId,
        reopened: reopened === first,
        secondId: second.documentId,
        secondState: second.state,
        tenthId: records[9]?.documentId,
      }).toEqual({
        firstId: "D1",
        firstLookup: true,
        firstState: { handles: ["§1"] },
        freshFirstId: "D1",
        freshUnknown: "unknown-document",
        ninthId: "D9",
        reopened: true,
        secondId: "D2",
        secondState: { handles: ["§2"] },
        tenthId: "Da",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("each record owns one FIFO lock shared by reads and edits", async () => {
    const createRegistry = registryFactory();
    expect(typeof createRegistry).toBe("function");
    if (!createRegistry) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-registry-"));
    try {
      const firstPath = join(directory, "first.clj");
      const secondPath = join(directory, "second.clj");
      writeFileSync(firstPath, "(first)");
      writeFileSync(secondPath, "(second)");
      const registry = createRegistry();
      const first = await registry.openPath(firstPath, directory);
      const second = await registry.openPath(secondPath, directory);
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = first.lock.run(async () => {
        order.push("read:start");
        await gate;
        order.push("read:end");
      });
      const edit = registry.getDocument(first.documentId).lock.run(async () => {
        order.push("edit");
      });
      await Promise.resolve();
      release();
      await Promise.all([read, edit]);
      expect({
        distinctRecordLocks: first.lock !== second.lock,
        order,
        sharedLookupLock:
          registry.getDocument(first.documentId).lock === first.lock,
      }).toEqual({
        distinctRecordLocks: true,
        order: ["read:start", "read:end", "edit"],
        sharedLookupLock: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("opening and reopening send latest source and commit only successful state", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(one)");
      const requests: Array<Record<string, unknown>> = [];
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          requests.push(request as Record<string, unknown>);
          return readSuccess(
            { generation: requests.length },
            `§1 (rendered-${requests.length})`,
          );
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const first = await executeReadTool(read, { path }, directory);
      writeFileSync(path, "(two)");
      const second = await executeReadTool(read, { path }, directory);
      const firstPayload = requests[0]?.request as Record<string, unknown>;
      const secondPayload = requests[1]?.request as Record<string, unknown>;
      expect({
        firstDepth: firstPayload.depth,
        firstHasState: Object.hasOwn(firstPayload, "state"),
        firstSource: firstPayload.source,
        noHashOrRevision:
          !JSON.stringify(first).includes("hash") &&
          !JSON.stringify(first).includes("revision"),
        outputs: [first.content, second.content],
        secondSource: secondPayload.source,
        secondState: secondPayload.state,
        rootKeys: Object.keys(requests[0] ?? {}).sort(),
        rootOperation: requests[0]?.operation,
        rootVersion: requests[0]?.protocol_version,
      }).toEqual({
        firstDepth: 0,
        firstHasState: false,
        firstSource: "(one)",
        noHashOrRevision: true,
        outputs: [
          [{ type: "text", text: "§1 (rendered-1)" }],
          [{ type: "text", text: "§1 (rendered-2)" }],
        ],
        rootKeys: ["operation", "protocol_version", "request"],
        rootOperation: "read",
        rootVersion: 1,
        secondSource: "(two)",
        secondState: { generation: 1 },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("failed opening leaves state absent for retry", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(source)");
      const requests: Array<Record<string, unknown>> = [];
      let attempt = 0;
      const read = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          requests.push(request as Record<string, unknown>);
          attempt += 1;
          if (attempt === 1) throw new Error("process failed");
          return readSuccess({ good: true });
        },
      }).find(({ name }) => name === "sexp_read");
      await caught(() => executeReadTool(read, { path }, directory));
      await executeReadTool(read, { path }, directory);
      expect(
        requests.map(({ request }) =>
          Object.hasOwn(request as object, "state"),
        ),
      ).toEqual([false, false]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("inspection uses stored canonical path and read option defaults", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const source = join(directory, "source.clj");
      const alias = join(directory, "alias.clj");
      writeFileSync(source, "(source)");
      symlinkSync(source, alias);
      const requests: Array<Record<string, unknown>> = [];
      const read = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          requests.push(request as Record<string, unknown>);
          return readSuccess({ generation: requests.length });
        },
      }).find(({ name }) => name === "sexp_read");
      await executeReadTool(read, { path: alias }, directory);
      rmSync(alias);
      await executeReadTool(
        read,
        { document: "D1", target: "§1" },
        "/wrong/cwd",
      );
      await executeReadTool(
        read,
        { depth: 7, document: "D1", include_atoms: true, target: "§1" },
        "/wrong/cwd",
      );
      await executeReadTool(read, { document: "D1" }, "/wrong/cwd");
      const payloads = requests.map(
        ({ request }) => request as Record<string, unknown>,
      );
      expect({
        atomOptions: payloads.map((payload) => payload["include-atoms?"]),
        canonicalPaths: payloads.map((payload) => payload["canonical-path"]),
        depths: payloads.map((payload) => payload.depth),
        documents: payloads.map((payload) => payload["document-id"]),
        targets: payloads.map((payload) => payload.target ?? null),
      }).toEqual({
        atomOptions: [false, false, true, false],
        canonicalPaths: [
          realpathSync(source),
          realpathSync(source),
          realpathSync(source),
          realpathSync(source),
        ],
        depths: [0, 2, 7, 0],
        documents: ["D1", "D1", "D1", "D1"],
        targets: [null, "§1", "§1", null],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("malformed source preserves good state and successful reconciliation commits", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(good)");
      const good = { generation: "good" };
      const reconciled = { generation: "reconciled" };
      const requests: Array<Record<string, unknown>> = [];
      const responses = [
        readSuccess(good),
        {
          error: { code: "parse-error", data: {}, message: "bad" },
          ok: false,
          protocol_version: 1,
          state: { generation: "poison" },
        },
        readSuccess(reconciled),
        readSuccess({ generation: "final" }),
      ];
      const read = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          requests.push(request as Record<string, unknown>);
          return responses.shift();
        },
      }).find(({ name }) => name === "sexp_read");
      await executeReadTool(read, { path }, directory);
      writeFileSync(path, "(");
      await caught(() => executeReadTool(read, { path }, directory));
      writeFileSync(path, "(externally-changed)");
      await executeReadTool(read, { path }, directory);
      await executeReadTool(read, { document: "D1" }, directory);
      const states = requests.map(
        ({ request }) => (request as Record<string, unknown>).state ?? null,
      );
      expect(states).toEqual([null, good, good, reconciled]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("target observation failures commit retirement state and prevent resurrection", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(foo)");
      const active = { handles: { "§1": { status: "active" } } };
      const retired = { handles: {}, retired: { "§1": { reason: "changed" } } };
      const requests: Array<Record<string, unknown>> = [];
      const responses = [
        readSuccess(active),
        {
          error: {
            code: "changed",
            data: { target: "§1" },
            message: "changed",
          },
          ok: false,
          protocol_version: 1,
          state: retired,
        },
        {
          error: {
            code: "changed",
            data: { target: "§1" },
            message: "retired",
          },
          ok: false,
          protocol_version: 1,
          state: retired,
        },
      ];
      const read = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          requests.push(request as Record<string, unknown>);
          return responses.shift();
        },
      }).find(({ name }) => name === "sexp_read");
      await executeReadTool(read, { path }, directory);
      writeFileSync(path, "(bar)");
      await caught(() =>
        executeReadTool(read, { document: "D1", target: "§1" }, directory),
      );
      writeFileSync(path, "(foo)");
      await caught(() =>
        executeReadTool(read, { document: "D1", target: "§1" }, directory),
      );
      const states = requests.map(
        ({ request }) => (request as Record<string, unknown>).state ?? null,
      );
      expect(states).toEqual([null, active, retired]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("invalid UTF-8 fails before Babashka and does not establish state", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, Buffer.from([0x28, 0xff, 0x29]));
      const requests: Array<Record<string, unknown>> = [];
      const read = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          requests.push(request as Record<string, unknown>);
          return readSuccess({ good: true });
        },
      }).find(({ name }) => name === "sexp_read");
      const invalid = await caught(() =>
        executeReadTool(read, { path }, directory),
      );
      writeFileSync(path, "\ufeff(valid)");
      await executeReadTool(read, { path }, directory);
      const payload = requests[0]?.request as Record<string, unknown>;
      expect({
        invalidRejected: Boolean(invalid),
        requests: requests.length,
        retryHasState: Object.hasOwn(payload, "state"),
        sourcePreservesBom: payload.source === "\ufeff(valid)",
      }).toEqual({
        invalidRejected: true,
        requests: 1,
        retryHasState: false,
        sourcePreservesBom: true,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("same-document reads serialize while different documents overlap", async () => {
    const createRuntime = runtimeFactory();
    expect(typeof createRuntime).toBe("function");
    if (!createRuntime) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-read-"));
    try {
      const firstPath = join(directory, "first.clj");
      const secondPath = join(directory, "second.clj");
      writeFileSync(firstPath, "(first)");
      writeFileSync(secondPath, "(second)");
      let handler: (
        request: Record<string, unknown>,
      ) => Promise<unknown> = async () => readSuccess({ open: true });
      const read = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          return handler(request as Record<string, unknown>);
        },
      }).find(({ name }) => name === "sexp_read");
      await executeReadTool(read, { path: firstPath }, directory);
      await executeReadTool(read, { path: secondPath }, directory);

      let sameCalls = 0;
      let releaseSame!: () => void;
      let firstEntered!: () => void;
      const sameGate = new Promise<void>((resolve) => {
        releaseSame = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      handler = async () => {
        sameCalls += 1;
        if (sameCalls === 1) {
          firstEntered();
          await sameGate;
        }
        return readSuccess({ sameCalls });
      };
      const one = executeReadTool(read, { document: "D1" }, directory);
      await entered;
      const two = executeReadTool(read, { document: "D1" }, directory);
      await Bun.sleep(5);
      const queuedCalls = sameCalls;
      releaseSame();
      await Promise.all([one, two]);

      let active = 0;
      let maximumActive = 0;
      let barrierCount = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      handler = async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        barrierCount += 1;
        if (barrierCount === 2) releaseBarrier();
        await barrier;
        active -= 1;
        return readSuccess({ parallel: true });
      };
      await Promise.all([
        executeReadTool(read, { document: "D1" }, directory),
        executeReadTool(read, { document: "D2" }, directory),
      ]);
      expect({ maximumActive, queuedCalls }).toEqual({
        maximumActive: 2,
        queuedCalls: 1,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("unknown edit documents fail before queue file reads or Babashka", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    let invocations = 0;
    let queues = 0;
    let reads = 0;
    const edit = captureRuntimeTools({
      async invokeBabashka() {
        invocations += 1;
        return editSuccess({});
      },
      async readFile(path) {
        reads += 1;
        return readFileBytes(path);
      },
      async withFileMutationQueue(_path, task) {
        queues += 1;
        return task();
      },
    }).find(({ name }) => name === "sexp_edit");
    const error = await caught(() =>
      executeEditTool(
        edit,
        {
          document: "D404",
          edits: [{ operation: "delete", target: "§1" }],
        },
        process.cwd(),
      ),
    );
    expect({
      code: (error as Error & { code?: string })?.code,
      message: error?.message,
      invocations,
      queues,
      reads,
    }).toEqual({
      code: "unknown",
      message:
        "[unknown] The target handle or document is unknown in this extension instance. Target: D404.",
      invocations: 0,
      queues: 0,
      reads: 0,
    });
  });

  test("edit lock encloses canonical queue latest read and one complete batch", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const events: string[] = [];
      const requests: Array<Record<string, unknown>> = [];
      let blockQueue = false;
      let releaseQueue!: () => void;
      let queueEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        queueEntered = resolve;
      });
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          const value = request as Record<string, unknown>;
          requests.push(value);
          events.push(`invoke:${value.operation}`);
          if (value.operation === "read") return readSuccess({ open: true });
          const envelope = editSuccess({ edited: true }) as {
            result: Record<string, unknown>;
          };
          envelope.result["applied-edits"] = 2;
          return envelope;
        },
        async readFile(file) {
          events.push("read");
          return readFileBytes(file);
        },
        async withFileMutationQueue(file, task) {
          events.push(`queue:${file}`);
          if (blockQueue) {
            queueEntered();
            await gate;
          }
          return task();
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      writeFileSync(path, "(latest)");
      events.length = 0;
      blockQueue = true;
      const editPromise = executeEditTool(
        edit,
        {
          document: "D1",
          edits: [
            { new_form: "(A)", operation: "replace", target: "§1" },
            { new_form: "(B)", operation: "insert_after", target: "§2" },
          ],
        },
        directory,
      );
      await entered;
      const readPromise = executeReadTool(read, { document: "D1" }, directory);
      await Bun.sleep(5);
      const invocationsWhileQueued = requests.length;
      releaseQueue();
      await Promise.all([editPromise, readPromise]);
      const editRequest = requests[1] as Record<string, unknown>;
      const payload = editRequest.request as Record<string, unknown>;
      expect({
        batch: payload.edits,
        events: events.slice(0, 4),
        invocationsWhileQueued,
        queueCanonical: events[0],
        root: {
          keys: Object.keys(editRequest).sort(),
          operation: editRequest.operation,
          version: editRequest.protocol_version,
        },
        source: payload.source,
      }).toEqual({
        batch: [
          { new_form: "(A)", operation: "replace", target: "§1" },
          { new_form: "(B)", operation: "insert_after", target: "§2" },
        ],
        events: [`queue:${realpathSync(path)}`, "read", "invoke:edit", "read"],
        invocationsWhileQueued: 1,
        queueCanonical: `queue:${realpathSync(path)}`,
        root: {
          keys: ["operation", "protocol_version", "request"],
          operation: "edit",
          version: 1,
        },
        source: "(latest)",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("domain conflict writes nothing but commits returned observation state", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const observed = { observation: "latest" };
      const requests: Array<Record<string, unknown>> = [];
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          const value = request as Record<string, unknown>;
          requests.push(value);
          if (value.operation === "read")
            return readSuccess(
              requests.length === 1 ? { open: true } : { after: true },
            );
          return {
            error: {
              code: "batch-conflict",
              data: { targets: ["§1", "§2"] },
              message: "conflict",
            },
            ok: false,
            protocol_version: 1,
            state: observed,
          };
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      const error = await caught(() =>
        executeEditTool(
          edit,
          {
            document: "D1",
            edits: [{ operation: "delete", target: "§1" }],
          },
          directory,
        ),
      );
      await executeReadTool(read, { document: "D1" }, directory);
      const followup = requests.at(-1)?.request as Record<string, unknown>;
      expect({
        code: (error as Error & { code?: string })?.code,
        message: error?.message,
        file: readFileSync(path, "utf8"),
        followupState: followup.state,
        leftovers: readdirSync(directory).filter((name) =>
          name.includes("pi-sexp-edit"),
        ),
      }).toEqual({
        code: "batch-conflict",
        message:
          "[batch-conflict] The transactional edit batch contains conflicting targets or boundaries. Targets: §1, §2.",
        file: "(old)",
        followupState: observed,
        leftovers: [],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("successful edits atomically replace bytes preserve mode then commit candidate state", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      chmodSync(path, 0o640);
      const candidateState = { candidate: true };
      const requests: Array<Record<string, unknown>> = [];
      const queuePaths: string[] = [];
      const operations: string[] = [];
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          const value = request as Record<string, unknown>;
          requests.push(value);
          return value.operation === "read"
            ? readSuccess(
                requests.length === 1 ? { open: true } : { after: true },
              )
            : editSuccess(candidateState);
        },
        async openFile(file, flags, mode) {
          return instrumentedOpen(file, flags, mode, operations);
        },
        async rename(source, destination) {
          operations.push("rename");
          return renameFile(source, destination);
        },
        async withFileMutationQueue(file, task) {
          queuePaths.push(file);
          return task();
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      const result = await executeEditTool(
        edit,
        {
          document: "D1",
          edits: [{ new_form: "(new)", operation: "replace", target: "§1" }],
        },
        directory,
      );
      await executeReadTool(read, { document: "D1" }, directory);
      const followup = requests.at(-1)?.request as Record<string, unknown>;
      expect({
        file: readFileSync(path, "utf8"),
        mode: statSync(path).mode & 0o777,
        queuePaths,
        operations,
        resultText: result.content,
        stateAfterRename: followup.state,
        tempFiles: readdirSync(directory).filter((name) =>
          name.includes("pi-sexp-edit"),
        ),
      }).toEqual({
        file: "(new)",
        mode: 0o640,
        queuePaths: [realpathSync(path)],
        operations: [
          "open:600",
          "write",
          "sync",
          "chmod:640",
          "close",
          "rename",
        ],
        resultText: [
          {
            type: "text",
            text:
              "document: D1\n" +
              "external_changes_reconciled: false\n" +
              "applied_edits: 1\n" +
              "repairs: []\n" +
              "retired_handles: §1\n" +
              "created_handles: §2\n" +
              "omitted_internal_counts: {}\n\n" +
              "--- file\n+++ file\n-old\n+new\n\n§2 (new)",
          },
        ],
        stateAfterRename: candidateState,
        tempFiles: [],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("rename failure cleans candidate and leaves file and state uncommitted", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const oldState = { open: true };
      const candidateState = { candidate: true };
      const requests: Array<Record<string, unknown>> = [];
      let renamePaths: string[] = [];
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          const value = request as Record<string, unknown>;
          requests.push(value);
          return value.operation === "read"
            ? readSuccess(requests.length === 1 ? oldState : { after: true })
            : editSuccess(candidateState);
        },
        async rename(source, destination) {
          renamePaths = [source, destination];
          throw new Error("rename failed");
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      const error = await caught(() =>
        executeEditTool(
          edit,
          {
            document: "D1",
            edits: [{ new_form: "(new)", operation: "replace", target: "§1" }],
          },
          directory,
        ),
      );
      await executeReadTool(read, { document: "D1" }, directory);
      const followup = requests.at(-1)?.request as Record<string, unknown>;
      expect({
        error: error?.message,
        file: readFileSync(path, "utf8"),
        sameDirectory: dirname(renamePaths[0] ?? "") === dirname(path),
        state: followup.state,
        tempFiles: readdirSync(directory).filter((name) =>
          name.includes("pi-sexp-edit"),
        ),
      }).toEqual({
        error:
          "[write-failed] Atomic file replacement failed; candidate state was not committed. Target: §1.",
        file: "(old)",
        sameDirectory: true,
        state: oldState,
        tempFiles: [],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("post-observation edit failures commit state except parse-error", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const oldState = { observation: "old" };
      const states = ["invalid-form", "repair-failed", "invalid-candidate"].map(
        (code) => ({ observation: code }),
      );
      const failures = [
        ...states.map((state, index) => ({
          error: {
            code: ["invalid-form", "repair-failed", "invalid-candidate"][index],
            data: {},
            message: "failure",
          },
          ok: false,
          protocol_version: 1,
          state,
        })),
        {
          error: {
            code: "parse-error",
            data: {},
            message: "malformed current",
          },
          ok: false,
          protocol_version: 1,
          state: { observation: "poison" },
        },
        {
          error: { code: "invalid-form", data: {}, message: "final" },
          ok: false,
          protocol_version: 1,
          state: states[2],
        },
      ];
      const requests: Array<Record<string, unknown>> = [];
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          const value = request as Record<string, unknown>;
          requests.push(value);
          return value.operation === "read"
            ? readSuccess(oldState)
            : failures.shift();
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      for (let index = 0; index < 5; index += 1) {
        await caught(() =>
          executeEditTool(
            edit,
            {
              document: "D1",
              edits: [{ operation: "delete", target: "§1" }],
            },
            directory,
          ),
        );
      }
      const sentStates = requests
        .filter(({ operation }) => operation === "edit")
        .map(({ request }) => (request as Record<string, unknown>).state);
      expect(sentStates).toEqual([
        oldState,
        states[0],
        states[1],
        states[2],
        states[2],
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("write sync chmod and close failures always clean and never commit state", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const root = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const results: Record<string, unknown> = {};
      for (const stage of ["write", "sync", "chmod", "close"] as const) {
        const directory = join(root, stage);
        mkdirSync(directory);
        const path = join(directory, "sample.clj");
        writeFileSync(path, "(old)");
        const oldState = { stage: "old" };
        const requests: Array<Record<string, unknown>> = [];
        const operations: string[] = [];
        const tools = captureRuntimeTools({
          async invokeBabashka(_pi, request) {
            const value = request as Record<string, unknown>;
            requests.push(value);
            return value.operation === "read"
              ? readSuccess(requests.length === 1 ? oldState : { after: true })
              : editSuccess({ stage: "candidate" });
          },
          async openFile(file, flags, mode) {
            return instrumentedOpen(file, flags, mode, operations, stage);
          },
        });
        const read = tools.find(({ name }) => name === "sexp_read");
        const edit = tools.find(({ name }) => name === "sexp_edit");
        await executeReadTool(read, { path }, directory);
        await caught(() =>
          executeEditTool(
            edit,
            {
              document: "D1",
              edits: [
                { new_form: "(new)", operation: "replace", target: "§1" },
              ],
            },
            directory,
          ),
        );
        await executeReadTool(read, { document: "D1" }, directory);
        results[stage] = {
          clean: readdirSync(directory).every(
            (name) => !name.includes("pi-sexp-edit"),
          ),
          file: readFileSync(path, "utf8"),
          operations,
          state: (requests.at(-1)?.request as Record<string, unknown>).state,
        };
      }
      expect(results).toEqual({
        write: {
          clean: true,
          file: "(old)",
          operations: ["open:600", "write", "close"],
          state: { stage: "old" },
        },
        sync: {
          clean: true,
          file: "(old)",
          operations: ["open:600", "write", "sync", "close"],
          state: { stage: "old" },
        },
        chmod: {
          clean: true,
          file: "(old)",
          operations: ["open:600", "write", "sync", "chmod:644", "close"],
          state: { stage: "old" },
        },
        close: {
          clean: true,
          file: "(old)",
          operations: [
            "open:600",
            "write",
            "sync",
            "chmod:644",
            "close",
            "close",
          ],
          state: { stage: "old" },
        },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("near-NAME_MAX targets use a short same-directory temporary basename", async () => {
    expect(task23Ready()).toBe(true);
    if (!task23Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, `${"x".repeat(240)}.clj`);
      writeFileSync(path, "(old)");
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          return (request as Record<string, unknown>).operation === "read"
            ? readSuccess({ open: true })
            : editSuccess({ candidate: true });
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      const error = await caught(() =>
        executeEditTool(
          edit,
          {
            document: "D1",
            edits: [{ new_form: "(new)", operation: "replace", target: "§1" }],
          },
          directory,
        ),
      );
      expect({
        error: error?.message ?? null,
        file: readFileSync(path, "utf8"),
      }).toEqual({ error: null, file: "(new)" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("edit formatter reports every required public transaction field", () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const format = (
      extensionModule as unknown as {
        formatEditOutput(
          document: string,
          result: Record<string, unknown>,
        ): string;
      }
    ).formatEditOutput;
    const text = format("D4", {
      "applied-edits": 2,
      "created-handles": ["§k", "§m"],
      diff: "--- file\n+++ file\n-old\n+new\n",
      excerpts: "§k (new)",
      "excerpt-handles": ["§k"],
      "external-changes-reconciled?": true,
      "omitted-internal-counts": { "retired-handles": 3 },
      repairs: [
        { after: "(fixed)", before: "(fixed", "edit-index": 0, target: "§e" },
      ],
      "retired-handles": ["§e", "§7"],
    });
    expect({
      applied: text.includes("applied_edits: 2"),
      created: text.includes("created_handles: §k §m"),
      diff: text.includes("--- file\n+++ file"),
      document: text.includes("document: D4"),
      external: text.includes("external_changes_reconciled: true"),
      omitted: text.includes('omitted_internal_counts: {"retired-handles":3}'),
      repairs: text.includes(
        'repairs: [{"after":"(fixed)","before":"(fixed","edit-index":0,"target":"§e"}]',
      ),
      retired: text.includes("retired_handles: §e §7"),
      excerpts: text.includes("§k (new)"),
    }).toEqual({
      applied: true,
      created: true,
      diff: true,
      document: true,
      external: true,
      omitted: true,
      repairs: true,
      retired: true,
      excerpts: true,
    });
  });

  test("shared head bounding discloses private full output and exact counts", async () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const format = (
      extensionModule as unknown as {
        formatBoundedOutput(output: string): Promise<Record<string, unknown>>;
      }
    ).formatBoundedOutput;
    const lineOutput = Array.from(
      { length: 2002 },
      (_, index) => `line-${index}\n`,
    ).join("");
    const byteOutput = "λ".repeat(30_000);
    const lineResult = await format(lineOutput);
    const byteResult = await format(byteOutput);
    const linePath = lineResult.fullOutputPath as string;
    const bytePath = byteResult.fullOutputPath as string;
    try {
      expect({
        byteCounts: byteResult.truncation,
        byteNotice: (byteResult.text as string).includes(
          "showing 0 of 1 lines",
        ),
        bytePrivate: (statSync(bytePath).mode & 0o777) === 0o600,
        directoriesPrivate:
          (statSync(dirname(linePath)).mode & 0o777) === 0o700 &&
          (statSync(dirname(bytePath)).mode & 0o777) === 0o700,
        lineCounts: lineResult.truncation,
        lineFull: readFileSync(linePath, "utf8") === lineOutput,
        lineNotice: (lineResult.text as string).includes(
          "showing 2000 of 2002 lines",
        ),
        linePathDisclosed: (lineResult.text as string).includes(linePath),
        linePrivate: (statSync(linePath).mode & 0o777) === 0o600,
      }).toEqual({
        byteCounts: {
          outputBytes: 0,
          outputLines: 0,
          totalBytes: 60_000,
          totalLines: 1,
        },
        byteNotice: true,
        bytePrivate: true,
        directoriesPrivate: true,
        lineCounts: {
          outputBytes: 18_889,
          outputLines: 2000,
          totalBytes: 18_910,
          totalLines: 2002,
        },
        lineFull: true,
        lineNotice: true,
        linePathDisclosed: true,
        linePrivate: true,
      });
    } finally {
      rmSync(dirname(linePath), { force: true, recursive: true });
      rmSync(dirname(bytePath), { force: true, recursive: true });
    }
  });

  test("structured public errors are bounded explanatory and state-free", () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const format = (
      extensionModule as unknown as { formatToolError(error: unknown): Error }
    ).formatToolError;
    const codes = [
      "unknown",
      "changed",
      "deleted",
      "ambiguous",
      "batch-conflict",
      "invalid-form",
      "repair-failed",
      "invalid-candidate",
      "write-failed",
    ];
    const messages = Object.fromEntries(
      codes.map((code) => {
        const error = Object.assign(new Error("raw failure"), {
          code,
          data: {
            excerpt: code === "changed" ? "§2 (current)" : undefined,
            "replacement-handle": code === "changed" ? "§2" : undefined,
            targets: code === "batch-conflict" ? ["§1", "§2"] : undefined,
            source: "SECRET-SOURCE",
            target: "§1",
          },
          state: { huge: "SECRET-STATE" },
        });
        return [code, format(error).message];
      }),
    );
    expect({
      allCodes: codes.every((code) => messages[code]?.includes(code)),
      allExplain: codes.every(
        (code) => (messages[code]?.length ?? 0) > code.length + 8,
      ),
      batchTargets: messages["batch-conflict"]?.includes("Targets: §1, §2"),
      changedContext:
        messages.changed?.includes("§2 (current)") &&
        messages.changed?.includes("§2"),
      hasTarget: codes.every((code) => messages[code]?.includes("§1")),
      noSecrets: !JSON.stringify(messages).includes("SECRET"),
      bounded: Object.values(messages).every(
        (message) => Buffer.byteLength(message) <= 16_384,
      ),
    }).toEqual({
      allCodes: true,
      allExplain: true,
      batchTargets: true,
      changedContext: true,
      hasTarget: true,
      noSecrets: true,
      bounded: true,
    });
  });

  test("read and edit both apply the shared public output bound", async () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    const outputDirectories: string[] = [];
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const huge = Array.from(
        { length: 2002 },
        (_, index) => `public-${index}\n`,
      ).join("");
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          if ((request as Record<string, unknown>).operation === "read") {
            return readSuccess({ open: true }, huge);
          }
          const envelope = editSuccess({ edited: true }) as {
            result: Record<string, unknown>;
          };
          envelope.result.diff = huge;
          return envelope;
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      const readResult = await executeReadTool(read, { path }, directory);
      const editResult = await executeEditTool(
        edit,
        {
          document: "D1",
          edits: [{ new_form: "(new)", operation: "replace", target: "§1" }],
        },
        directory,
      );
      const readDetails = readResult.details as Record<string, unknown>;
      const editDetails = editResult.details as Record<string, unknown>;
      const readPath = readDetails.fullOutputPath as string;
      const editPath = editDetails.fullOutputPath as string;
      outputDirectories.push(dirname(readPath), dirname(editPath));
      expect({
        editNotice: editResult.content[0]?.text.includes("[Output truncated:"),
        editPath: editResult.content[0]?.text.includes(editPath),
        editTotal: (editDetails.truncation as Record<string, unknown>)
          .totalLines,
        readNotice: readResult.content[0]?.text.includes(
          "showing 2000 of 2002 lines",
        ),
        readPath: readResult.content[0]?.text.includes(readPath),
        readTotal: (readDetails.truncation as Record<string, unknown>)
          .totalLines,
      }).toEqual({
        editNotice: true,
        editPath: true,
        editTotal: 2012,
        readNotice: true,
        readPath: true,
        readTotal: 2002,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
      for (const outputDirectory of outputDirectories) {
        rmSync(outputDirectory, { force: true, recursive: true });
      }
    }
  });

  test("failed initial open leaves edits with the public unknown code", async () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      let invocations = 0;
      const tools = captureRuntimeTools({
        async invokeBabashka() {
          invocations += 1;
          throw new Error("initial open failed");
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await caught(() => executeReadTool(read, { path }, directory));
      const error = await caught(() =>
        executeEditTool(
          edit,
          {
            document: "D1",
            edits: [{ operation: "delete", target: "§1" }],
          },
          directory,
        ),
      );
      expect({
        code: (error as Error & { code?: string })?.code,
        invocations,
        message: error?.message,
      }).toEqual({
        code: "unknown",
        invocations: 1,
        message:
          "[unknown] The target handle or document is unknown in this extension instance. Target: D1.",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("malformed required edit metadata preserves file and state before any write", async () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const repair = (overrides: Record<string, unknown> = {}) => ({
      after: "(fixed)",
      before: "(new)",
      "edit-index": 0,
      target: "§1",
      ...overrides,
    });
    const cases: Array<[string, (result: Record<string, unknown>) => void]> = [
      [
        "applied-edits",
        (result) => {
          delete result["applied-edits"];
        },
      ],
      [
        "applied-count",
        (result) => {
          result["applied-edits"] = 2;
        },
      ],
      [
        "created-handles",
        (result) => {
          result["created-handles"] = [7];
        },
      ],
      [
        "excerpt-handles",
        (result) => {
          delete result["excerpt-handles"];
        },
      ],
      [
        "external-flag",
        (result) => {
          result["external-changes-reconciled?"] = "false";
        },
      ],
      [
        "omitted-counts",
        (result) => {
          result["omitted-internal-counts"] = { retired: "one" };
        },
      ],
      [
        "repairs",
        (result) => {
          delete result.repairs;
        },
      ],
      [
        "repair-record",
        (result) => {
          result.repairs = [{ after: "(ok)" }];
        },
      ],
      [
        "repair-extra",
        (result) => {
          result.repairs = [repair({ source: "SECRET" })];
        },
      ],
      [
        "repair-negative",
        (result) => {
          result.repairs = [repair({ "edit-index": -1 })];
        },
      ],
      [
        "repair-range",
        (result) => {
          result.repairs = [repair({ "edit-index": 4 })];
        },
      ],
      [
        "repair-duplicate",
        (result) => {
          result.repairs = [repair(), repair()];
        },
      ],
      [
        "repair-target",
        (result) => {
          result.repairs = [repair({ target: "§2" })];
        },
      ],
      [
        "repair-before",
        (result) => {
          result.repairs = [repair({ before: "(other" })];
        },
      ],
      [
        "repair-unchanged",
        (result) => {
          result.repairs = [repair({ after: "(new)" })];
        },
      ],
      [
        "repair-empty",
        (result) => {
          result.repairs = [repair({ after: "" })];
        },
      ],
      [
        "retired-handles",
        (result) => {
          result["retired-handles"] = null;
        },
      ],
    ];
    const root = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const outcomes: Record<string, unknown> = {};
      for (const [name, corrupt] of cases) {
        const directory = join(root, name);
        mkdirSync(directory);
        const path = join(directory, "sample.clj");
        writeFileSync(path, "(old)");
        const oldState = { case: name, generation: "old" };
        const requests: Array<Record<string, unknown>> = [];
        let writes = 0;
        const tools = captureRuntimeTools({
          async invokeBabashka(_pi, request) {
            const value = request as Record<string, unknown>;
            requests.push(value);
            if (value.operation === "read") return readSuccess(oldState);
            const envelope = structuredClone(
              editSuccess({ generation: "candidate" }),
            ) as { result: Record<string, unknown> };
            corrupt(envelope.result);
            return envelope;
          },
          async openFile() {
            writes += 1;
            throw new Error("must not write");
          },
        });
        const read = tools.find(
          ({ name: toolName }) => toolName === "sexp_read",
        );
        const edit = tools.find(
          ({ name: toolName }) => toolName === "sexp_edit",
        );
        await executeReadTool(read, { path }, directory);
        const error = await caught(() =>
          executeEditTool(
            edit,
            {
              document: "D1",
              edits: [
                { new_form: "(new)", operation: "replace", target: "§1" },
              ],
            },
            directory,
          ),
        );
        await executeReadTool(read, { document: "D1" }, directory);
        const followup = requests.at(-1)?.request as Record<string, unknown>;
        outcomes[name] = {
          error: error?.message.includes("Invalid Babashka protocol response"),
          file: readFileSync(path, "utf8"),
          state: followup.state,
          writes,
        };
      }
      expect(
        Object.values(outcomes).every((outcome) => {
          const value = outcome as {
            error: boolean;
            file: string;
            state: { generation: string };
            writes: number;
          };
          return (
            value.error &&
            value.file === "(old)" &&
            value.state.generation === "old" &&
            value.writes === 0
          );
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("edit output artifact failure occurs before mutation and preserves state", async () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const oldState = { generation: "old" };
      const requests: Array<Record<string, unknown>> = [];
      let formats = 0;
      let writes = 0;
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          const value = request as Record<string, unknown>;
          requests.push(value);
          return value.operation === "read"
            ? readSuccess(oldState)
            : editSuccess({ generation: "candidate" });
        },
        async formatOutput(output) {
          formats += 1;
          if (formats === 2) throw new Error("artifact failed");
          return {
            text: output,
            truncation: {
              outputBytes: 1,
              outputLines: 1,
              totalBytes: 1,
              totalLines: 1,
            },
          };
        },
        async openFile() {
          writes += 1;
          throw new Error("must not write");
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      const error = await caught(() =>
        executeEditTool(
          edit,
          {
            document: "D1",
            edits: [{ new_form: "(new)", operation: "replace", target: "§1" }],
          },
          directory,
        ),
      );
      await executeReadTool(read, { document: "D1" }, directory);
      expect({
        error: error?.message,
        file: readFileSync(path, "utf8"),
        state: (requests.at(-1)?.request as Record<string, unknown>).state,
        writes,
      }).toEqual({
        error: "artifact failed",
        file: "(old)",
        state: oldState,
        writes: 0,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("prepared truncated edit artifact is removed when atomic replacement fails", async () => {
    expect(task24Ready()).toBe(true);
    if (!task24Ready()) return;
    const directory = mkdtempSync(join(tmpdir(), "pi-sexp-edit-"));
    let artifactPath: string | undefined;
    try {
      const path = join(directory, "sample.clj");
      writeFileSync(path, "(old)");
      const format = (
        extensionModule as unknown as {
          formatBoundedOutput(output: string): Promise<{
            fullOutputPath?: string;
            text: string;
            truncation: {
              outputBytes: number;
              outputLines: number;
              totalBytes: number;
              totalLines: number;
            };
          }>;
        }
      ).formatBoundedOutput;
      const huge = Array.from(
        { length: 2002 },
        (_, index) => `diff-${index}\n`,
      ).join("");
      const tools = captureRuntimeTools({
        async invokeBabashka(_pi, request) {
          if ((request as Record<string, unknown>).operation === "read")
            return readSuccess({ open: true });
          const envelope = editSuccess({ candidate: true }) as {
            result: Record<string, unknown>;
          };
          envelope.result.diff = huge;
          return envelope;
        },
        async formatOutput(output) {
          const result = await format(output);
          if (result.fullOutputPath) artifactPath = result.fullOutputPath;
          return result;
        },
        async rename() {
          throw new Error("rename failed");
        },
      });
      const read = tools.find(({ name }) => name === "sexp_read");
      const edit = tools.find(({ name }) => name === "sexp_edit");
      await executeReadTool(read, { path }, directory);
      await caught(() =>
        executeEditTool(
          edit,
          {
            document: "D1",
            edits: [{ new_form: "(new)", operation: "replace", target: "§1" }],
          },
          directory,
        ),
      );
      expect({
        artifactCreated: typeof artifactPath === "string",
        artifactExists: existsSync(artifactPath ?? ""),
      }).toEqual({ artifactCreated: true, artifactExists: false });
    } finally {
      rmSync(directory, { force: true, recursive: true });
      if (artifactPath)
        rmSync(dirname(artifactPath), { force: true, recursive: true });
    }
  });
});
