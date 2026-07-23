import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
});
