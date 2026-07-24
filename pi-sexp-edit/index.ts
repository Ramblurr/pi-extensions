import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue as queueFileMutation,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  open as openFile,
  readFile as readFileBytes,
  realpath,
  rename as renameFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HANDLE_MARKER = "§";
export const HANDLE_PATTERN = `^${HANDLE_MARKER}[0-9a-z]+$`;

export const BABASHKA_TIMEOUT_MS = 30_000;
export const MAX_DIAGNOSTIC_BYTES = 16_384;
export const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
export const BB_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "bb.edn",
);

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

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function invalidProtocol(reason: string): never {
  throw new Error(`Invalid Babashka protocol response: ${reason}`);
}

function validateEnvelope(value: unknown): ProtocolEnvelope {
  if (!isRecord(value)) invalidProtocol("response must be an object");
  if (value.protocol_version !== 1)
    invalidProtocol("unsupported protocol version");
  if (value.ok !== true && value.ok !== false)
    invalidProtocol("ok must be boolean");
  if (value.state !== null && !isRecord(value.state))
    invalidProtocol("state must be opaque object or null");

  if (value.ok === true) {
    if (!hasExactKeys(value, ["ok", "protocol_version", "result", "state"])) {
      invalidProtocol("success envelope fields are not exact");
    }
    if (!isRecord(value.result))
      invalidProtocol("success result must be an object");
    return value as unknown as ProtocolSuccess;
  }

  if (!hasExactKeys(value, ["error", "ok", "protocol_version", "state"])) {
    invalidProtocol("failure envelope fields are not exact");
  }
  if (!isRecord(value.error))
    invalidProtocol("failure error must be an object");
  if (!hasExactKeys(value.error, ["code", "data", "message"])) {
    invalidProtocol("failure error fields are not exact");
  }
  if (
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string"
  ) {
    invalidProtocol("failure error code and message must be strings");
  }
  if (!isRecord(value.error.data))
    invalidProtocol("failure error data must be an object");
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
      return new TextDecoder("utf-8", { fatal: true }).decode(
        encoded.subarray(0, end),
      );
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
      [
        "--config",
        BB_CONFIG_PATH,
        "-m",
        "pi-sexp-edit.main",
        "--request",
        requestPath,
      ],
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

const supportedExtensions = new Set([
  ".bb",
  ".clj",
  ".cljc",
  ".cljd",
  ".cljs",
  ".edn",
]);

export class DocumentRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
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

export async function canonicalizeDocumentPath(
  path: string,
  cwd: string,
): Promise<string> {
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
    throw new DocumentRegistryError(
      "path-not-found",
      `Document path does not exist: ${absolute}`,
    );
  }
  requireSupportedExtension(canonical);
  const metadata = await stat(canonical);
  if (!metadata.isFile()) {
    throw new DocumentRegistryError(
      "path-not-file",
      `Document path is not a file: ${canonical}`,
    );
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

export interface SexpExtensionDependencies {
  invokeBabashka: typeof invokeBabashka;
  formatOutput: typeof formatBoundedOutput;
  openFile: typeof openFile;
  readFile(path: string): Promise<Uint8Array>;
  rename(source: string, destination: string): Promise<void>;
  stat: typeof stat;
  unlink(path: string): Promise<void>;
  withFileMutationQueue<T>(path: string, task: () => Promise<T>): Promise<T>;
}

export class SexpDomainError extends Error {
  readonly code: string;
  readonly target?: string;

  constructor(error: ProtocolFailure["error"], _state: OpaqueState) {
    const formatted = formatToolError(
      Object.assign(new Error(error.message), {
        code: error.code,
        data: error.data,
      }),
    );
    super(formatted.message);
    this.name = "SexpDomainError";
    this.code = error.code;
    this.target = (formatted as Error & { target?: string }).target;
  }
}

const defaultDependencies: SexpExtensionDependencies = {
  formatOutput: formatBoundedOutput,
  invokeBabashka,
  openFile,
  readFile: readFileBytes,
  rename: renameFile,
  stat,
  unlink,
  withFileMutationQueue: queueFileMutation,
};

const observationFailureCodes = new Set([
  "ambiguous",
  "changed",
  "deleted",
  "unknown",
]);
const editObservationFailureCodes = new Set([
  "ambiguous",
  "batch-conflict",
  "invalid-candidate",
  "invalid-form",
  "repair-failed",
  "changed",
  "deleted",
  "unknown",
]);

function decodeSource(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

async function removeTemporaryFile(
  path: string,
  dependencies: Pick<SexpExtensionDependencies, "unlink">,
): Promise<void> {
  try {
    await dependencies.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function atomicReplaceFile(
  path: string,
  candidateSource: string,
  mode: number,
  dependencyOverrides: Partial<SexpExtensionDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const temporaryPath = join(
    dirname(path),
    `.pi-sexp-edit-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await dependencies.openFile(temporaryPath, "wx", 0o600);
    await handle.writeFile(candidateSource, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await dependencies.rename(temporaryPath, path);
  } finally {
    try {
      if (handle) await handle.close();
    } finally {
      await removeTemporaryFile(temporaryPath, dependencies);
    }
  }
}

export interface BoundedOutput {
  fullOutputPath?: string;
  text: string;
  truncation: {
    outputBytes: number;
    outputLines: number;
    totalBytes: number;
    totalLines: number;
  };
}

async function writePrivateOutput(output: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sexp-edit-output-"));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "full-output.txt");
    await writeFile(path, output, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export async function formatBoundedOutput(
  output: string,
): Promise<BoundedOutput> {
  const truncated = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const truncation = {
    outputBytes: truncated.outputBytes,
    outputLines: truncated.outputLines,
    totalBytes: truncated.totalBytes,
    totalLines: truncated.totalLines,
  };
  if (!truncated.truncated) return { text: output, truncation };

  const fullOutputPath = await writePrivateOutput(output);
  const notice =
    `[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines ` +
    `(${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). ` +
    `Full output: ${fullOutputPath}]`;
  return {
    fullOutputPath,
    text:
      truncated.content.length > 0 ? `${truncated.content}\n${notice}` : notice,
    truncation,
  };
}

async function discardBoundedOutput(output: BoundedOutput): Promise<void> {
  if (!output.fullOutputPath) return;
  try {
    await rm(dirname(output.fullOutputPath), { force: true, recursive: true });
  } catch {
    // Preserve the primary write failure; this artifact contains no opaque state.
  }
}

function displayHandles(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.join(" ") : "none";
}

function displayJson(value: unknown, fallback: unknown): string {
  return JSON.stringify(value ?? fallback);
}

function joinDiffAndExcerpts(diff: string, excerpts: string): string {
  if (diff.length === 0) return excerpts;
  if (excerpts.length === 0) return diff;
  return `${diff}${diff.endsWith("\n") ? "\n" : "\n\n"}${excerpts}`;
}

export function formatEditOutput(
  documentId: string,
  result: Record<string, unknown>,
): string {
  const metadata = [
    `document: ${documentId}`,
    `external_changes_reconciled: ${String(result["external-changes-reconciled?"] ?? false)}`,
    `applied_edits: ${String(result["applied-edits"] ?? 0)}`,
    `repairs: ${displayJson(result.repairs, [])}`,
    `retired_handles: ${displayHandles(result["retired-handles"])}`,
    `created_handles: ${displayHandles(result["created-handles"])}`,
    `omitted_internal_counts: ${displayJson(result["omitted-internal-counts"], {})}`,
  ].join("\n");
  const diff = typeof result.diff === "string" ? result.diff : "";
  const excerpts = typeof result.excerpts === "string" ? result.excerpts : "";
  const body = joinDiffAndExcerpts(diff, excerpts);
  return body.length > 0 ? `${metadata}\n\n${body}` : metadata;
}

function validHandleArray(value: unknown): value is string[] {
  const pattern = new RegExp(HANDLE_PATTERN);
  return (
    Array.isArray(value) &&
    value.every((handle) => typeof handle === "string" && pattern.test(handle))
  );
}

function validateEditResult(
  result: Record<string, unknown>,
  edits: SexpEditInput["edits"],
): Record<string, unknown> {
  if (
    !Number.isInteger(result["applied-edits"]) ||
    result["applied-edits"] !== edits.length
  ) {
    invalidProtocol("applied edits must equal the requested edit count");
  }
  if (typeof result["external-changes-reconciled?"] !== "boolean") {
    invalidProtocol("external changes reconciled must be a boolean");
  }
  for (const field of [
    "created-handles",
    "excerpt-handles",
    "retired-handles",
  ]) {
    if (!validHandleArray(result[field])) {
      invalidProtocol(`${field} must be an array of canonical handles`);
    }
  }
  if (!Array.isArray(result.repairs)) {
    invalidProtocol("repairs must be an array");
  }
  const repairedEdits = new Set<number>();
  for (const repair of result.repairs) {
    if (
      !isRecord(repair) ||
      !hasExactKeys(repair, ["after", "before", "edit-index", "target"])
    ) {
      invalidProtocol("repair fields must be exact");
    }
    const editIndex = repair["edit-index"];
    if (
      !Number.isInteger(editIndex) ||
      (editIndex as number) < 0 ||
      (editIndex as number) >= edits.length ||
      repairedEdits.has(editIndex as number)
    ) {
      invalidProtocol("repair edit index must be unique and in range");
    }
    const edit = edits[editIndex as number];
    if (
      !edit ||
      !("new_form" in edit) ||
      typeof repair.target !== "string" ||
      repair.target !== edit.target ||
      typeof repair.before !== "string" ||
      repair.before !== edit.new_form ||
      typeof repair.after !== "string" ||
      repair.after.trim().length === 0 ||
      repair.after === repair.before
    ) {
      invalidProtocol("repair must match its requested form operation");
    }
    repairedEdits.add(editIndex as number);
  }
  const omitted = result["omitted-internal-counts"];
  if (
    !isRecord(omitted) ||
    !Object.values(omitted).every(
      (count) => Number.isInteger(count) && (count as number) >= 0,
    )
  ) {
    invalidProtocol("omitted internal counts must be non-negative integers");
  }
  for (const field of ["candidate-source", "diff", "excerpts"]) {
    if (typeof result[field] !== "string") {
      invalidProtocol(`${field} must be a string`);
    }
  }
  return result;
}

const errorExplanations: Record<string, string> = {
  ambiguous: "The target no longer maps to exactly one unchanged form.",
  "batch-conflict":
    "The transactional edit batch contains conflicting targets or boundaries.",
  changed: "The target changed since its immutable handle was issued.",
  deleted: "The target was deleted since its immutable handle was issued.",
  "invalid-candidate":
    "The complete edited file is not a valid structural candidate.",
  "invalid-form": "An edit operation or supplied form is invalid.",
  "repair-failed":
    "Delimiter repair was unsafe or did not produce valid source.",
  unknown:
    "The target handle or document is unknown in this extension instance.",
  "write-failed":
    "Atomic file replacement failed; candidate state was not committed.",
};

export function formatToolError(error: unknown): Error {
  const value = error as Error & { code?: unknown; data?: unknown };
  const code = typeof value?.code === "string" ? value.code : "internal-error";
  if (code === "internal-error") {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(truncateUtf8(message, MAX_DIAGNOSTIC_BYTES));
  }
  const data = isRecord(value.data) ? value.data : {};
  const target = typeof data.target === "string" ? data.target : undefined;
  const targets = Array.isArray(data.targets)
    ? data.targets
        .filter((item): item is string => typeof item === "string")
        .slice(0, 32)
        .map((item) => truncateUtf8(item, 128))
    : [];
  const excerpt =
    typeof data.excerpt === "string"
      ? truncateUtf8(data.excerpt, 2_048)
      : undefined;
  const replacement =
    typeof data["replacement-handle"] === "string"
      ? data["replacement-handle"]
      : undefined;
  const parts = [
    `[${code}]`,
    errorExplanations[code] ?? "The structural operation failed.",
    target ? `Target: ${target}.` : undefined,
    targets.length > 0 ? `Targets: ${targets.join(", ")}.` : undefined,
    excerpt ? `Current excerpt: ${excerpt}` : undefined,
    replacement
      ? `Replacement handle shown for retry: ${replacement}.`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  const formatted = new Error(
    truncateUtf8(parts.join(" "), MAX_DIAGNOSTIC_BYTES),
  );
  Object.assign(formatted, { code, target });
  return formatted;
}

function publicUnknownDocument(documentId: string): Error {
  return formatToolError(
    Object.assign(new Error("Unknown document"), {
      code: "unknown",
      data: { target: documentId },
    }),
  );
}

function getPublicDocument(
  documents: DocumentRegistry,
  documentId: string,
): DocumentRecord {
  try {
    return documents.getDocument(documentId);
  } catch (error) {
    if (
      error instanceof DocumentRegistryError &&
      error.code === "unknown-document"
    ) {
      throw publicUnknownDocument(documentId);
    }
    throw error;
  }
}

function unwired(toolName: string, _documents: DocumentRegistry): never {
  throw new Error(`${toolName} execution is not wired yet`);
}

export function createSexpExtension(
  pi: ExtensionAPI,
  dependencyOverrides: Partial<SexpExtensionDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const documents = createDocumentRegistry();

  pi.registerTool({
    name: "sexp_read",
    label: "S-expression Read",
    description: readDescription,
    parameters: sexpReadSchema,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const record =
        "path" in parameters
          ? await documents.openPath(parameters.path, context.cwd)
          : getPublicDocument(documents, parameters.document);

      return record.lock.run(async () => {
        const bytes = await dependencies.readFile(record.canonicalPath);
        const source = decodeSource(bytes);
        const payload: Record<string, unknown> = {
          "canonical-path": record.canonicalPath,
          depth: parameters.depth ?? ("target" in parameters ? 2 : 0),
          "document-id": record.documentId,
          "include-atoms?": parameters.include_atoms ?? false,
          source,
        };
        if (record.state !== undefined) payload.state = record.state;
        if ("target" in parameters) payload.target = parameters.target;

        const envelope = await dependencies.invokeBabashka(
          pi,
          { operation: "read", protocol_version: 1, request: payload },
          signal,
        );
        if (!envelope.ok) {
          if (observationFailureCodes.has(envelope.error.code)) {
            if (!isRecord(envelope.state))
              invalidProtocol("observation state must be an object");
            record.state = envelope.state;
          }
          throw new SexpDomainError(envelope.error, envelope.state);
        }
        if (!isRecord(envelope.state))
          invalidProtocol("read state must be an object");
        if (typeof envelope.result.text !== "string") {
          invalidProtocol("read result text must be a string");
        }

        record.state = envelope.state;
        const output = await dependencies.formatOutput(envelope.result.text);
        return {
          content: [{ type: "text" as const, text: output.text }],
          details: {
            document: record.documentId,
            ...(output.fullOutputPath
              ? { fullOutputPath: output.fullOutputPath }
              : {}),
            truncation: output.truncation,
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "sexp_edit",
    label: "S-expression Edit",
    description: editDescription,
    parameters: sexpEditSchema,
    async execute(_toolCallId, parameters, signal) {
      const record = getPublicDocument(documents, parameters.document);
      if (record.state === undefined) {
        throw publicUnknownDocument(parameters.document);
      }

      return record.lock.run(() =>
        dependencies.withFileMutationQueue(record.canonicalPath, async () => {
          const bytes = await dependencies.readFile(record.canonicalPath);
          const source = decodeSource(bytes);
          const metadata = await dependencies.stat(record.canonicalPath);
          const envelope = await dependencies.invokeBabashka(
            pi,
            {
              operation: "edit",
              protocol_version: 1,
              request: {
                "canonical-path": record.canonicalPath,
                "document-id": record.documentId,
                edits: parameters.edits,
                source,
                state: record.state,
              },
            },
            signal,
          );

          if (!envelope.ok) {
            if (editObservationFailureCodes.has(envelope.error.code)) {
              if (!isRecord(envelope.state)) {
                invalidProtocol("edit observation state must be an object");
              }
              record.state = envelope.state;
            }
            throw new SexpDomainError(envelope.error, envelope.state);
          }
          if (!isRecord(envelope.state)) {
            invalidProtocol("edit state must be an object");
          }
          const result = validateEditResult(envelope.result, parameters.edits);
          const candidateSource = result["candidate-source"] as string;
          const fullOutput = formatEditOutput(record.documentId, result);
          const output = await dependencies.formatOutput(fullOutput);

          try {
            await atomicReplaceFile(
              record.canonicalPath,
              candidateSource,
              metadata.mode & 0o7777,
              dependencies,
            );
          } catch (error) {
            await discardBoundedOutput(output);
            throw formatToolError(
              Object.assign(
                new Error("Atomic file replacement failed", { cause: error }),
                {
                  code: "write-failed",
                  data: { target: parameters.edits[0]?.target },
                },
              ),
            );
          }
          record.state = envelope.state;
          return {
            content: [{ type: "text" as const, text: output.text }],
            details: {
              document: record.documentId,
              ...(output.fullOutputPath
                ? { fullOutputPath: output.fullOutputPath }
                : {}),
              truncation: output.truncation,
            },
          };
        }),
      );
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createSexpExtension(pi);
}
