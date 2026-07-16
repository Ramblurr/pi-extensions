import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	balanceAfterMutation,
	type BalanceDependencies,
	type BalanceToolResultEvent,
	type ExecResult,
} from "../balance-after-mutation.ts";

const successfulExecResult: ExecResult = {
	stdout: "",
	stderr: "",
	code: 0,
	killed: false,
};

function toolResult(overrides: Partial<BalanceToolResultEvent> = {}): BalanceToolResultEvent {
	return {
		toolName: "edit",
		input: { path: "src/example.clj" },
		content: [{ type: "text", text: "Applied edit" }],
		isError: false,
		...overrides,
	};
}

function dependencies(execResult: ExecResult = successfulExecResult) {
	const execCalls: Array<{
		command: string;
		args: string[];
		options: { signal?: AbortSignal; timeout?: number };
	}> = [];
	const queuedPaths: string[] = [];

	const deps: BalanceDependencies = {
		cwd: "/workspace",
		exec: async (command, args, options) => {
			execCalls.push({ command, args, options });
			return execResult;
		},
		withFileMutationQueue: async (path, operation) => {
			queuedPaths.push(path);
			return operation();
		},
		truncateDiagnostics: (output) => output,
	};

	return { deps, execCalls, queuedPaths };
}

describe("balanceAfterMutation", () => {
	test("runs brepl balance after write and edit results for every supported Clojure extension", async () => {
		const { deps, execCalls, queuedPaths } = dependencies();
		const cases = [
			["write", "deps.edn"],
			["edit", "src/a.clj"],
			["write", "src/a.cljc"],
			["edit", "src/a.cljs"],
			["write", "src/a.cljd"],
			["edit", "src/UPPER.CLJ"],
		] as const;

		for (const [toolName, path] of cases) {
			await balanceAfterMutation(toolResult({ toolName, input: { path } }), deps);
		}

		const expectedPaths = cases.map(([, path]) => resolve(deps.cwd, path));
		expect(queuedPaths).toEqual(expectedPaths);
		expect(execCalls).toEqual(
			expectedPaths.map((path) => ({
				command: "brepl",
				args: ["balance", path],
				options: { signal: undefined, timeout: 30_000 },
			})),
		);
	});

	test("normalizes built-in tool paths and forwards cancellation", async () => {
		const { deps, execCalls, queuedPaths } = dependencies();
		const controller = new AbortController();
		deps.cwd = "/repo";
		deps.signal = controller.signal;

		await balanceAfterMutation(toolResult({ input: { path: "@src/file.cljc" } }), deps);
		await balanceAfterMutation(toolResult({ input: { path: "/tmp/absolute.cljs" } }), deps);

		expect(queuedPaths).toEqual(["/repo/src/file.cljc", "/tmp/absolute.cljs"]);
		expect(execCalls.map((call) => call.options.signal)).toEqual([controller.signal, controller.signal]);
	});

	test("ignores other tools, failed mutations, missing paths, and non-Clojure files", async () => {
		const { deps, execCalls, queuedPaths } = dependencies();
		const ignoredEvents = [
			toolResult({ toolName: "read" }),
			toolResult({ isError: true }),
			toolResult({ input: {} }),
			toolResult({ input: { path: 42 } }),
			toolResult({ input: { path: "" } }),
			toolResult({ input: { path: "notes.txt" } }),
			toolResult({ input: { path: "src/example.clj.bak" } }),
		];

		for (const event of ignoredEvents) {
			expect(await balanceAfterMutation(event, deps)).toBeUndefined();
		}

		expect(execCalls).toEqual([]);
		expect(queuedPaths).toEqual([]);
	});

	test("leaves a successful mutation result unchanged when balancing succeeds", async () => {
		const { deps } = dependencies({
			stdout: "Balanced src/example.clj\n",
			stderr: "",
			code: 0,
			killed: false,
		});

		expect(await balanceAfterMutation(toolResult(), deps)).toBeUndefined();
	});

	test("injects command diagnostics and marks the tool result as an error when brepl exits non-zero", async () => {
		const { deps } = dependencies({
			stdout: "partial output\n",
			stderr: "could not parse reader conditional\n",
			code: 2,
			killed: false,
		});
		const event = toolResult();

		const patch = await balanceAfterMutation(event, deps);

		expect(patch?.isError).toBe(true);
		expect(patch?.content.slice(0, event.content.length)).toEqual(event.content);
		const message = patch?.content.at(-1);
		expect(message?.type).toBe("text");
		if (message?.type !== "text") throw new Error("Expected text diagnostic");
		expect(message.text).toContain("`brepl balance` failed");
		expect(message.text).toContain("/workspace/src/example.clj");
		expect(message.text).toContain("exit code 2");
		expect(message.text).toContain("could not parse reader conditional");
		expect(message.text).toContain("partial output");
		expect(message.text).toContain("Inspect and fix the file before continuing");
	});

	test("bounds command diagnostics before injecting them into context", async () => {
		const { deps } = dependencies({
			stdout: "x".repeat(100_000),
			stderr: "y".repeat(100_000),
			code: 1,
			killed: false,
		});
		let untruncatedOutput = "";
		deps.truncateDiagnostics = (output) => {
			untruncatedOutput = output;
			return "[bounded diagnostics]";
		};

		const patch = await balanceAfterMutation(toolResult(), deps);

		expect(untruncatedOutput.length).toBeGreaterThan(100_000);
		const message = patch?.content.at(-1);
		expect(message?.type === "text" && message.text).toContain("[bounded diagnostics]");
		expect(message?.type === "text" && message.text).not.toContain("x".repeat(100_000));
	});

	test("injects an error when brepl is killed even if it reports exit code zero", async () => {
		const { deps } = dependencies({
			stdout: "",
			stderr: "",
			code: 0,
			killed: true,
		});

		const patch = await balanceAfterMutation(toolResult(), deps);

		expect(patch?.isError).toBe(true);
		const message = patch?.content.at(-1);
		expect(message?.type === "text" && message.text).toContain("was terminated");
	});

	test("injects an error when brepl cannot be executed", async () => {
		const { deps } = dependencies();
		deps.exec = async () => {
			throw new Error("spawn brepl ENOENT");
		};

		const patch = await balanceAfterMutation(toolResult(), deps);

		expect(patch?.isError).toBe(true);
		const message = patch?.content.at(-1);
		expect(message?.type === "text" && message.text).toContain("Could not run `brepl balance`");
		expect(message?.type === "text" && message.text).toContain("spawn brepl ENOENT");
	});
});
