import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildBootstrapExtensionSource,
	buildLaunchScriptSource,
	createForkedSessionFile,
	getForkableUserMessages,
	type ForkableUserMessage,
} from "./session-fork.ts";

function resolveExecutable(command: string): string {
	if (command.includes("/")) return command;

	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}

	return command;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildMessageChoices(messages: readonly ForkableUserMessage[]): Map<string, string> {
	const choices = new Map<string, string>();
	messages.forEach((message, index) => {
		const label = `${String(index + 1).padStart(2, "0")} ${truncate(singleLine(message.text), 120)}`;
		choices.set(label, message.entryId);
	});
	return choices;
}

async function openGhosttyWindow(launcherPath: string): Promise<void> {
	const ghostty = process.env.PI_FORK_NEW_GHOSTTY ?? "ghostty";

	await new Promise<void>((resolve, reject) => {
		const child = spawn(resolveExecutable(ghostty), ["+new-window", "-e", launcherPath], {
			detached: true,
			stdio: "ignore",
		});

		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

function writeLaunchFiles(ctx: ExtensionCommandContext, sessionFile: string, editorText: string): { tempDir: string; launcherPath: string } {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-fork-new-"));
	const bootstrapPath = join(tempDir, "restore-editor.ts");
	const launcherPath = join(tempDir, "launching-pi");
	const piExecutable = resolveExecutable(process.env.PI_FORK_NEW_PI ?? "pi");

	writeFileSync(bootstrapPath, buildBootstrapExtensionSource(editorText), { encoding: "utf8", mode: 0o600 });
	writeFileSync(
		launcherPath,
		buildLaunchScriptSource({
			cwd: ctx.cwd,
			piExecutable,
			sessionFile,
			bootstrapExtensionFile: bootstrapPath,
			cleanupPaths: [bootstrapPath, launcherPath],
			tempDir,
		}),
		{ encoding: "utf8", mode: 0o700 },
	);
	chmodSync(launcherPath, 0o700);

	return { tempDir, launcherPath };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fork-new", {
		description: "Fork this session into a new Ghostty window",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/fork-new requires interactive mode", "error");
				return;
			}

			await ctx.waitForIdle();

			const sessionDir = ctx.sessionManager.getSessionDir();
			if (!sessionDir) {
				ctx.ui.notify("/fork-new requires a persisted session (not --no-session)", "error");
				return;
			}

			const entries = ctx.sessionManager.getEntries();
			const messages = getForkableUserMessages(entries);
			if (messages.length === 0) {
				ctx.ui.notify("No user messages to fork from", "info");
				return;
			}

			const choices = buildMessageChoices(messages);
			const selected = await ctx.ui.select("Fork into a new terminal from which user message?", [...choices.keys()]);
			if (!selected) {
				ctx.ui.notify("Fork cancelled", "info");
				return;
			}

			const selectedEntryId = choices.get(selected);
			if (!selectedEntryId) {
				ctx.ui.notify("Fork cancelled", "info");
				return;
			}

			let tempDir: string | undefined;
			try {
				const fork = createForkedSessionFile({
					cwd: ctx.cwd,
					sessionDir,
					sourceSessionFile: ctx.sessionManager.getSessionFile(),
					entries,
					selectedEntryId,
				});
				const launchFiles = writeLaunchFiles(ctx, fork.sessionFile, fork.selectedText);
				tempDir = launchFiles.tempDir;

				await openGhosttyWindow(launchFiles.launcherPath);
				ctx.ui.notify(`Opened fork in new terminal: ${fork.sessionFile}`, "info");
			} catch (error) {
				if (tempDir) rmSync(tempDir, { recursive: true, force: true });
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to open fork: ${message}`, "error");
			}
		},
	});
}
