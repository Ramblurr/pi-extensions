import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import heartbeatExtension from "../index.ts";

type Handler = (...args: unknown[]) => unknown;
type Entry = { type: "custom"; customType: string; data: unknown };

function makeHarness(initialEntries: Entry[] = []) {
	const entries = [...initialEntries];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler; description?: string }>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const userMessages: Array<{ content: string; options?: unknown }> = [];
	let idle = true;

	const ctx = {
		hasUI: true,
		isIdle: () => idle,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
		},
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
		},
	};

	const pi = {
		on: (event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerCommand: (name: string, command: { handler: Handler; description?: string }) => {
			commands.set(name, command);
		},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
		sendUserMessage: (content: string, options?: unknown) => {
			userMessages.push({ content, options });
		},
	};

	heartbeatExtension(pi as never);

	return {
		ctx,
		entries,
		notifications,
		statuses,
		userMessages,
		commands,
		setIdle(value: boolean) {
			idle = value;
		},
		async command(args: string) {
			const command = commands.get("heartbeat");
			if (!command) throw new Error("heartbeat command was not registered");
			await command.handler(args, ctx);
		},
		async emit(event: string, value: unknown = { type: event }, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) await handler(value, eventCtx);
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("pi-heartbeat extension contract", () => {
	test("registers one command and reports stopped status with both usage forms", async () => {
		const harness = makeHarness();

		expect([...harness.commands.keys()]).toEqual(["heartbeat"]);
		await harness.command("");

		expect(harness.notifications).toEqual([
			{
				message:
					"Heartbeat: stopped\nUsage: /heartbeat <SECONDS> <PROMPT>\n       /heartbeat stop",
				level: "info",
			},
		]);
	});

	test("starts after one complete idle interval and shows only the compact footer", async () => {
		const harness = makeHarness();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		await harness.command("2   check   in");

		expect(harness.statuses.at(-1)).toEqual({ key: "heartbeat", text: "♥ 2s" });
		expect(harness.entries.at(-1)).toEqual({
			type: "custom",
			customType: "heartbeat-state",
			data: { status: "active", seconds: 2, prompt: "check   in" },
		});
		expect(harness.notifications.at(-1)).toEqual({ message: "Heartbeat started: every 2s", level: "info" });
		expect(harness.notifications.at(-1)?.message).not.toContain("check");

		await harness.command("");
		expect(harness.notifications.at(-1)).toEqual({
			message: "Heartbeat: active every 2s\nUsage: /heartbeat <SECONDS> <PROMPT>\n       /heartbeat stop",
			level: "info",
		});
		expect(harness.notifications.at(-1)?.message).not.toContain("check");

		await vi.advanceTimersByTime(1_999);
		expect(harness.userMessages).toEqual([]);
		await vi.advanceTimersByTime(1);
		expect(harness.userMessages).toEqual([{ content: "check   in", options: undefined }]);
	});

	test("preserves a working heartbeat when start input is invalid", async () => {
		const harness = makeHarness();
		await harness.command("10 keep this");
		const entries = [...harness.entries];
		const statuses = [...harness.statuses];
		const timerCount = vi.getTimerCount();
		const notificationCount = harness.notifications.length;

		for (const args of ["0 bad", "-1 bad", "1.5 x", "2147484 too late", "9007199254740993 bad", "10", "10   "]) {
			await harness.command(args);
		}

		expect(harness.entries).toEqual(entries);
		expect(harness.statuses).toEqual(statuses);
		expect(vi.getTimerCount()).toBe(timerCount);
		expect(harness.notifications.slice(notificationCount).every(({ level }) => level === "warning")).toBe(true);
	});

	test("atomically replaces the old timer and keeps only the new prompt", async () => {
		const harness = makeHarness();
		await harness.command("10 old prompt");
		await vi.advanceTimersByTime(5_000);

		await harness.command("2 new prompt");
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTime(2_000);
		expect(harness.userMessages).toEqual([{ content: "new prompt", options: undefined }]);
	});

	test("resets elapsed idle time on activity and starts fresh after settlement", async () => {
		const harness = makeHarness();
		await harness.command("10 check in");
		await vi.advanceTimersByTime(4_000);

		harness.setIdle(false);
		await harness.emit("agent_start", { type: "agent_start" });
		await vi.advanceTimersByTime(60_000);
		expect(harness.userMessages).toEqual([]);

		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled" });
		await vi.advanceTimersByTime(9_999);
		expect(harness.userMessages).toEqual([]);
		await vi.advanceTimersByTime(1);
		expect(harness.userMessages).toEqual([{ content: "check in", options: undefined }]);
	});

	test("skips a timer callback that races with agent activity", async () => {
		const harness = makeHarness();
		await harness.command("1 raced");
		harness.setIdle(false);
		await vi.advanceTimersByTime(1_000);
		expect(harness.userMessages).toEqual([]);

		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled" });
		await vi.advanceTimersByTime(1_000);
		expect(harness.userMessages).toEqual([{ content: "raced", options: undefined }]);
	});

	test("stops idempotently, persists stopped state, cancels the timer, and clears the footer", async () => {
		const harness = makeHarness();
		await harness.command("1 stop me");
		await harness.command("stop");
		const entriesAfterFirstStop = [...harness.entries];

		expect(harness.entries.at(-1)).toEqual({
			type: "custom",
			customType: "heartbeat-state",
			data: { status: "stopped" },
		});
		expect(harness.statuses.at(-1)).toEqual({ key: "heartbeat", text: undefined });
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTime(5_000);
		await harness.command("stop");
		expect(harness.entries).toEqual(entriesAfterFirstStop);
		expect(harness.notifications.at(-1)).toEqual({ message: "Heartbeat stopped", level: "info" });
	});

	test("restores the latest active or stopped state with a fresh interval", async () => {
		const first = makeHarness();
		await first.command("2 restored prompt");

		const reloaded = makeHarness(first.entries);
		await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
		expect(reloaded.statuses.at(-1)).toEqual({ key: "heartbeat", text: "♥ 2s" });
		await vi.advanceTimersByTime(1_999);
		expect(reloaded.userMessages).toEqual([]);
		await vi.advanceTimersByTime(1);
		expect(reloaded.userMessages).toEqual([{ content: "restored prompt", options: undefined }]);

		await first.command("stop");
		const resumedStopped = makeHarness(first.entries);
		await resumedStopped.emit("session_start", { type: "session_start", reason: "resume" });
		expect(resumedStopped.statuses.at(-1)).toEqual({ key: "heartbeat", text: undefined });
		expect(vi.getTimerCount()).toBe(0);
	});

	test("does not invent heartbeat state in a new session and cleans up on shutdown", async () => {
		const harness = makeHarness();
		await harness.emit("session_start", { type: "session_start", reason: "new" });
		expect(harness.notifications).toEqual([]);
		expect(harness.statuses.at(-1)).toEqual({ key: "heartbeat", text: undefined });

		await harness.command("1 old instance");
		await harness.emit("session_shutdown", { type: "session_shutdown" });
		expect(harness.statuses.at(-1)).toEqual({ key: "heartbeat", text: undefined });
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTime(1_000);
		expect(harness.userMessages).toEqual([]);
	});

	test("uses the latest valid persisted state on the active branch", async () => {
		const entries: Entry[] = [
			{ type: "custom", customType: "heartbeat-state", data: { status: "active", seconds: 2, prompt: "old" } },
			{ type: "custom", customType: "heartbeat-state", data: { status: "active", seconds: 0, prompt: "invalid" } },
			{ type: "custom", customType: "other-extension", data: { status: "active" } },
		];
		const harness = makeHarness(entries);
		await harness.emit("session_start", { type: "session_start", reason: "resume" });

		expect(harness.statuses.at(-1)).toEqual({ key: "heartbeat", text: "♥ 2s" });
		await vi.advanceTimersByTime(2_000);
		expect(harness.userMessages).toEqual([{ content: "old", options: undefined }]);
	});
});
