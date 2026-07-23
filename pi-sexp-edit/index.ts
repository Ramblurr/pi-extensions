import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HANDLE_MARKER = "§";
export const HANDLE_PATTERN = `^${HANDLE_MARKER}[0-9a-z]+$`;

export const BABASHKA_TIMEOUT_MS = 30_000;
export const MAX_DIAGNOSTIC_BYTES = 16_384;
export const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
export const BB_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "bb.edn");

export type OpaqueState = Record<string, unknown> | null;

export interface ProtocolSuccess {
  ok: true;
  protocol_version: 1;
  result: Record<string, unknown>;
  state: OpaqueState;
}

export interface ProtocolFailure {
  error: { code: string; data: Record<string, unknown>; message: string };
  ok: false;
  protocol_version: 1;
  state: OpaqueState;
}

export type ProtocolEnvelope = ProtocolSuccess | ProtocolFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function invalidProtocol(reason: string): never {
  throw new Error(`Invalid Babashka protocol response: ${reason}`);
}

function validateEnvelope(value: unknown): ProtocolEnvelope {
  if (!isRecord(value)) invalidProtocol("response must be an object");
  if (value.protocol_version !== 1) invalidProtocol("unsupported protocol version");
  if (value.ok !== true && value.ok !== false) invalidProtocol("ok must be boolean");
  if (value.state !== null && !isRecord(value.state)) invalidProtocol("state must be opaque object or null");

  if (value.ok === true) {
    if (!hasExactKeys(value, ["ok", "protocol_version", "result", "state"])) {
      invalidProtocol("success envelope fields are not exact");
    }
    if (!isRecord(value.result)) invalidProtocol("success result must be an object");
    return value as unknown as ProtocolSuccess;
  }

  if (!hasExactKeys(value, ["error", "ok", "protocol_version", "state"])) {
    invalidProtocol("failure envelope fields are not exact");
  }
  if (!isRecord(value.error)) invalidProtocol("failure error must be an object");
  if (!hasExactKeys(value.error, ["code", "data", "message"])) {
    invalidProtocol("failure error fields are not exact");
  }
  if (typeof value.error.code !== "string" || typeof value.error.message !== "string") {
    invalidProtocol("failure error code and message must be strings");
  }
  if (!isRecord(value.error.data)) invalidProtocol("failure error data must be an object");
  return value as unknown as ProtocolFailure;
}

function parseEnvelope(stdout: string): ProtocolEnvelope {
  if (Buffer.byteLength(stdout) > MAX_PROTOCOL_BYTES) {
    invalidProtocol(`response exceeds ${MAX_PROTOCOL_BYTES} bytes`);
  }
  if (stdout.trim().length === 0) invalidProtocol("response is empty");
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    invalidProtocol("stdout must contain exactly one JSON object");
  }
  return validateEnvelope(decoded);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

export async function invokeBabashka(
  pi: ExtensionAPI,
  request: unknown,
  signal?: AbortSignal,
): Promise<ProtocolEnvelope> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-sexp-edit-"));
  try {
    await chmod(temporaryDirectory, 0o700);
    const requestPath = join(temporaryDirectory, "request.json");
    await writeFile(requestPath, JSON.stringify(request), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(requestPath, 0o600);

    const result = await pi.exec(
      "bb",
      ["--config", BB_CONFIG_PATH, "-m", "pi-sexp-edit.main", "--request", requestPath],
      { signal, timeout: BABASHKA_TIMEOUT_MS },
    );
    if (result.code !== 0 || result.killed) {
      const diagnostic = truncateUtf8(result.stderr, MAX_DIAGNOSTIC_BYTES);
      throw new Error(
        `Babashka exited with code ${result.code}${diagnostic ? `: ${diagnostic}` : ""}`,
      );
    }
    return parseEnvelope(result.stdout);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

const supportedExtensions = new Set([".bb", ".clj", ".cljc", ".cljd", ".cljs", ".edn"]);

export class DocumentRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DocumentRegistryError";
    this.code = code;
  }
}

export function normalizeToolPath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function requireSupportedExtension(path: string): void {
  if (!supportedExtensions.has(extname(path))) {
    throw new DocumentRegistryError(
      "unsupported-extension",
      "Expected a .clj, .cljs, .cljc, .bb, .edn, or .cljd file",
    );
  }
}

export async function canonicalizeDocumentPath(path: string, cwd: string): Promise<string> {
  const normalized = normalizeToolPath(path);
  if (normalized.length === 0) {
    throw new DocumentRegistryError("path-not-found", "Document path is empty");
  }
  const absolute = resolve(cwd, normalized);
  requireSupportedExtension(absolute);

  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new DocumentRegistryError("path-not-found", `Document path does not exist: ${absolute}`);
  }
  requireSupportedExtension(canonical);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) {
    throw new DocumentRegistryError("path-not-file", `Document path is not a file: ${canonical}`);
  }
  return canonical;
}

export class FifoLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    return predecessor.then(task).finally(release);
  }
}

export interface DocumentRecord {
  canonicalPath: string;
  documentId: string;
  lock: FifoLock;
  state?: OpaqueState;
}

export class DocumentRegistry {
  private readonly byDocumentId = new Map<string, DocumentRecord>();
  private readonly byPath = new Map<string, DocumentRecord>();
  private nextDocumentId = 1;

  async openPath(path: string, cwd: string): Promise<DocumentRecord> {
    const canonicalPath = await canonicalizeDocumentPath(path, cwd);
    const existing = this.byPath.get(canonicalPath);
    if (existing) return existing;

    const documentId = `D${this.nextDocumentId.toString(36)}`;
    this.nextDocumentId += 1;
    const record: DocumentRecord = {
      canonicalPath,
      documentId,
      lock: new FifoLock(),
    };
    this.byPath.set(canonicalPath, record);
    this.byDocumentId.set(documentId, record);
    return record;
  }

  getDocument(documentId: string): DocumentRecord {
    const record = this.byDocumentId.get(documentId);
    if (!record) {
      throw new DocumentRegistryError(
        "unknown-document",
        `Unknown document ID: ${documentId}`,
      );
    }
    return record;
  }
}

export function createDocumentRegistry(): DocumentRegistry {
  return new DocumentRegistry();
}


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

function unwired(toolName: string, _documents: DocumentRegistry): never {
  throw new Error(`${toolName} execution is not wired yet`);
}

export default function (pi: ExtensionAPI): void {
  const documents = createDocumentRegistry();
  pi.registerTool({
    name: "sexp_read",
    label: "S-expression Read",
    description: readDescription,
    parameters: sexpReadSchema,
    async execute() {
      return unwired("sexp_read", documents);
    },
  });

  pi.registerTool({
    name: "sexp_edit",
    label: "S-expression Edit",
    description: editDescription,
    parameters: sexpEditSchema,
    async execute() {
      return unwired("sexp_edit", documents);
    },
  });
}
