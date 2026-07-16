import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { balanceAfterMutation } from "./balance-after-mutation.ts";

function truncateDiagnostics(output: string): string {
	const result = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!result.truncated) return result.content;

	return (
		`${result.content}\n\n[brepl diagnostics truncated: showing the last ` +
		`${result.outputLines} of ${result.totalLines} lines ` +
		`(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).]`
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) =>
		balanceAfterMutation(event, {
			cwd: ctx.cwd,
			signal: ctx.signal,
			exec: (command, args, options) => pi.exec(command, args, options),
			withFileMutationQueue: (path, operation) => withFileMutationQueue(path, operation),
			truncateDiagnostics,
		}),
	);
}
