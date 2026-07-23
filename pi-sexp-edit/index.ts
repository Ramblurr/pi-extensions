import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HANDLE_MARKER = "§";
export const HANDLE_PATTERN = `^${HANDLE_MARKER}[0-9a-z]+$`;

const strictObjectOptions = { additionalProperties: false } as const;

const pathReadSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Clojure-family file path, relative to the current working directory or absolute",
      minLength: 1,
    }),
    depth: Type.Optional(
      Type.Integer({
        default: 0,
        description: "Structural descendant expansion depth",
        maximum: 20,
        minimum: 0,
      }),
    ),
    include_atoms: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Allocate visible handles for atomic forms",
      }),
    ),
  },
  strictObjectOptions,
);

const documentReadSchema = Type.Object(
  {
    document: Type.String({ description: "Open document ID", minLength: 1 }),
    depth: Type.Optional(
      Type.Integer({
        default: 0,
        description: "Structural descendant expansion depth",
        maximum: 20,
        minimum: 0,
      }),
    ),
    include_atoms: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Allocate visible handles for atomic forms",
      }),
    ),
  },
  strictObjectOptions,
);

const targetReadSchema = Type.Object(
  {
    document: Type.String({ description: "Open document ID", minLength: 1 }),
    target: Type.String({
      description: "Active immutable handle to inspect",
      pattern: HANDLE_PATTERN,
    }),
    depth: Type.Optional(
      Type.Integer({
        default: 2,
        description: "Structural descendant expansion depth",
        maximum: 20,
        minimum: 0,
      }),
    ),
    include_atoms: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Allocate visible handles for atomic forms",
      }),
    ),
  },
  strictObjectOptions,
);

export const sexpReadSchema = Type.Union([
  pathReadSchema,
  documentReadSchema,
  targetReadSchema,
]);

export type SexpReadInput = Static<typeof sexpReadSchema>;

const formEditSchema = Type.Object(
  {
    target: Type.String({
      description: "Active immutable target handle",
      pattern: HANDLE_PATTERN,
    }),
    operation: StringEnum(
      ["replace", "insert_before", "insert_after"] as const,
      {
        description: "Structural operation to apply at the target",
      },
    ),
    new_form: Type.String({
      description: "One or more complete Clojure forms",
      minLength: 1,
    }),
  },
  strictObjectOptions,
);

const deleteEditSchema = Type.Object(
  {
    target: Type.String({
      description: "Active immutable target handle",
      pattern: HANDLE_PATTERN,
    }),
    operation: StringEnum(["delete"] as const, {
      description: "Delete the exact target form",
    }),
  },
  strictObjectOptions,
);

const editOperationSchema = Type.Union([formEditSchema, deleteEditSchema]);

export const sexpEditSchema = Type.Object(
  {
    document: Type.String({ description: "Open document ID", minLength: 1 }),
    edits: Type.Array(editOperationSchema, {
      description:
        "Structural edits resolved together against one pre-edit tree",
      minItems: 1,
    }),
  },
  strictObjectOptions,
);

export type SexpEditInput = Static<typeof sexpEditSchema>;

const readDescription =
  "Use sexp_read to open or refresh Clojure-family source, or inspect it through immutable document-scoped handles. " +
  "Opening or refreshing reconciles external changes without modifying the file; retired handles never retarget. " +
  "Output is capped at Pi's standard 2,000 lines or 50 KB and reports truncation.";

const editDescription =
  "Use sexp_edit to apply one transactional structural edit batch to immutable handles in an open document. " +
  "A changed, deleted, ambiguous, or retired target causes a conflict; all operations succeed or none do. " +
  "Missing delimiters may be repaired only when unambiguous, and every repair is reported. " +
  "Returns affected handles, a unified diff, and continuation excerpts capped at 2,000 lines or 50 KB.";

function unwired(toolName: string): never {
  throw new Error(`${toolName} execution is not wired yet`);
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sexp_read",
    label: "S-expression Read",
    description: readDescription,
    parameters: sexpReadSchema,
    async execute() {
      return unwired("sexp_read");
    },
  });

  pi.registerTool({
    name: "sexp_edit",
    label: "S-expression Edit",
    description: editDescription,
    parameters: sexpEditSchema,
    async execute() {
      return unwired("sexp_edit");
    },
  });
}
