import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "heartbeat";
const STATE_ENTRY_TYPE = "heartbeat-state";
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_INTERVAL_SECONDS = Math.floor(MAX_TIMEOUT_MS / 1_000);
const USAGE = "Usage: /heartbeat <SECONDS> <PROMPT>\n       /heartbeat stop";

type HeartbeatConfig = {
	seconds: number;
	prompt: string;
};

type PersistedHeartbeatState =
	| { status: "active"; seconds: number; prompt: string }
	| { status: "stopped" };

type SessionEntry = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSafeInterval(seconds: unknown): seconds is number {
	return (
		typeof seconds === "number" &&
		Number.isSafeInteger(seconds) &&
		seconds > 0 &&
		seconds <= MAX_INTERVAL_SECONDS
	);
}

function parsePersistedState(value: unknown): PersistedHeartbeatState | undefined {
	if (!isRecord(value) || (value.status !== "active" && value.status !== "stopped")) {
		return undefined;
	}

	if (value.status === "stopped") return { status: "stopped" };
	if (!isSafeInterval(value.seconds) || typeof value.prompt !== "string" || !value.prompt.trim()) {
		return undefined;
	}

	return {
		status: "active",
		seconds: value.seconds,
		prompt: value.prompt.trim(),
	};
}

function sessionBranchEntries(ctx: ExtensionContext): SessionEntry[] {
	try {
		const branch = ctx.sessionManager.getBranch();
		if (Array.isArray(branch)) return branch as SessionEntry[];
	} catch {
		// Fall back to the complete entry list for lightweight hosts.
	}

	try {
		const entries = ctx.sessionManager.getEntries();
		if (Array.isArray(entries)) return entries as SessionEntry[];
	} catch {
		// A session-less host simply has no persisted heartbeat state.
	}

	return [];
}

function latestPersistedState(ctx: ExtensionContext): PersistedHeartbeatState | undefined {
	let latest: PersistedHeartbeatState | undefined;

	for (const entry of sessionBranchEntries(ctx)) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const state = parsePersistedState(entry.data);
		if (state) latest = state;
	}

	return latest;
}

function parseStartArguments(args: string): HeartbeatConfig | undefined {
	const trimmed = args.trim();
	const separator = trimmed.search(/\s/);
	if (separator < 0) return undefined;

	const secondsText = trimmed.slice(0, separator);
	if (!/^[0-9]+$/.test(secondsText)) return undefined;

	const seconds = Number(secondsText);
	const prompt = trimmed.slice(separator).trim();
	if (!isSafeInterval(seconds) || !prompt) return undefined;

	return { seconds, prompt };
}

export default function heartbeatExtension(pi: ExtensionAPI): void {
	let config: HeartbeatConfig | undefined;
	let persistedStatus: "active" | "stopped" | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timerGeneration = 0;

	const setStatus = (ctx: ExtensionContext, active: HeartbeatConfig | undefined) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(EXTENSION_ID, active ? `♥ ${active.seconds}s` : undefined);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const cancelTimer = () => {
		timerGeneration++;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const scheduleTimer = (ctx: ExtensionContext) => {
		cancelTimer();
		if (!config || !ctx.isIdle()) return;

		const scheduledConfig = config;
		const generation = timerGeneration;
		const timeout = setTimeout(() => {
			if (timer === timeout) timer = undefined;
			if (generation !== timerGeneration || config !== scheduledConfig) return;
			if (!ctx.isIdle()) return;
			pi.sendUserMessage(scheduledConfig.prompt);
		}, scheduledConfig.seconds * 1_000);
		timer = timeout;
	};

	const persist = (state: PersistedHeartbeatState) => {
		pi.appendEntry(STATE_ENTRY_TYPE, state);
		persistedStatus = state.status;
	};

	pi.on("session_start", (_event, ctx) => {
		cancelTimer();
		const restored = latestPersistedState(ctx);
		persistedStatus = restored?.status;
		config = restored?.status === "active" ? { seconds: restored.seconds, prompt: restored.prompt } : undefined;
		setStatus(ctx, config);

		scheduleTimer(ctx);
	});

	pi.on("agent_start", (_event, _ctx) => {
		cancelTimer();
	});

	pi.on("agent_settled", (_event, ctx) => {
		scheduleTimer(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancelTimer();
		config = undefined;
		persistedStatus = undefined;
		setStatus(ctx, undefined);
	});

	pi.registerCommand("heartbeat", {
		description: "Prompt the current agent after a period of continuous idle time",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed) {
				const status = config ? `Heartbeat: active every ${config.seconds}s` : "Heartbeat: stopped";
				notify(ctx, `${status}\n${USAGE}`, "info");
				return;
			}

			if (trimmed === "stop") {
				cancelTimer();
				config = undefined;
				if (persistedStatus !== "stopped") persist({ status: "stopped" });
				setStatus(ctx, undefined);
				notify(ctx, "Heartbeat stopped", "info");
				return;
			}

			const nextConfig = parseStartArguments(args);
			if (!nextConfig) {
				notify(ctx, USAGE, "warning");
				return;
			}

			cancelTimer();
			config = nextConfig;
			persist({ status: "active", ...nextConfig });
			setStatus(ctx, config);
			notify(ctx, `Heartbeat started: every ${nextConfig.seconds}s`, "info");
			scheduleTimer(ctx);
		},
	});
}
