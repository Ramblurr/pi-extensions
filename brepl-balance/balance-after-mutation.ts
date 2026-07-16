import { extname, resolve } from "node:path";
import type { ExecResult as PiExecResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export type ToolContent = ToolResultEvent["content"][number];
export type BalanceToolResultEvent = Pick<ToolResultEvent, "toolName" | "input" | "content" | "isError">;
export type ExecResult = PiExecResult;

export interface BalanceDependencies {
	cwd: string;
	signal?: AbortSignal;
	exec: (
		command: string,
		args: string[],
		options: { signal?: AbortSignal; timeout?: number },
	) => Promise<ExecResult>;
	withFileMutationQueue: (
		path: string,
		operation: () => Promise<ExecResult>,
	) => Promise<ExecResult>;
	truncateDiagnostics: (output: string) => string;
}

export interface ToolResultPatch {
	content: ToolContent[];
	isError: boolean;
}

const CLOJURE_EXTENSIONS = new Set([".edn", ".clj", ".cljc", ".cljs", ".cljd"]);
const BALANCE_TIMEOUT_MS = 30_000;

function failurePatch(event: BalanceToolResultEvent, message: string): ToolResultPatch {
	return {
		content: [...event.content, { type: "text", text: message }],
		isError: true,
	};
}

function formatOutput(result: ExecResult, truncateDiagnostics: (output: string) => string): string {
	const sections = [
		result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
		result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
	].filter(Boolean);

	return sections.length > 0 ? `\n\n${truncateDiagnostics(sections.join("\n\n"))}` : "";
}

export async function balanceAfterMutation(
	event: BalanceToolResultEvent,
	deps: BalanceDependencies,
): Promise<ToolResultPatch | undefined> {
	if ((event.toolName !== "write" && event.toolName !== "edit") || event.isError) return undefined;

	const inputPath = event.input.path;
	if (typeof inputPath !== "string" || inputPath.length === 0) return undefined;

	const normalizedPath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	if (normalizedPath.length === 0 || !CLOJURE_EXTENSIONS.has(extname(normalizedPath).toLowerCase())) {
		return undefined;
	}

	const absolutePath = resolve(deps.cwd, normalizedPath);

	try {
		const result = await deps.withFileMutationQueue(absolutePath, () =>
			deps.exec("brepl", ["balance", absolutePath], {
				signal: deps.signal,
				timeout: BALANCE_TIMEOUT_MS,
			}),
		);

		if (result.code === 0 && !result.killed) return undefined;

		const status = result.killed ? "was terminated" : `failed with exit code ${result.code}`;
		return failurePatch(
			event,
			`ERROR: \`brepl balance\` ${status} for ${absolutePath}. ` +
				"The Clojure file may still contain unbalanced delimiters. " +
				`Inspect and fix the file before continuing.${formatOutput(result, deps.truncateDiagnostics)}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failurePatch(
			event,
			`ERROR: Could not run \`brepl balance\` for ${absolutePath}: ${message}. ` +
				"The Clojure file may still contain unbalanced delimiters. Inspect and fix the file before continuing.",
		);
	}
}
