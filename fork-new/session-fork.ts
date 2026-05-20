import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CURRENT_SESSION_VERSION = 3;

type SessionEntryBase = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
};

type MessageEntry = SessionEntryBase & {
	type: "message";
	message: {
		role: string;
		content?: unknown;
		[key: string]: unknown;
	};
};

type LabelEntry = SessionEntryBase & {
	type: "label";
	targetId: string;
	label?: string;
};

export type ForkableSessionEntry = SessionEntryBase;

export interface ForkableUserMessage {
	entryId: string;
	text: string;
}

export interface CreateForkedSessionFileOptions {
	cwd: string;
	sessionDir: string;
	sourceSessionFile?: string;
	entries: readonly ForkableSessionEntry[];
	selectedEntryId: string;
	now?: Date;
	sessionId?: string;
}

export interface CreateForkedSessionFileResult {
	sessionFile: string;
	selectedText: string;
}

export interface BuildLaunchScriptSourceOptions {
	cwd: string;
	piExecutable: string;
	sessionFile: string;
	bootstrapExtensionFile?: string;
	cleanupPaths?: string[];
	tempDir?: string;
}

function isMessageEntry(entry: ForkableSessionEntry): entry is MessageEntry {
	return entry.type === "message" && typeof (entry as { message?: unknown }).message === "object" && (entry as { message?: unknown }).message !== null;
}

function isLabelEntry(entry: ForkableSessionEntry): entry is LabelEntry {
	return entry.type === "label" && typeof (entry as { targetId?: unknown }).targetId === "string";
}

export function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((part): part is { type: string; text: string } => {
			return (
				part !== null &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join("");
}

export function getForkableUserMessages(entries: readonly ForkableSessionEntry[]): ForkableUserMessage[] {
	const messages: ForkableUserMessage[] = [];

	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		if (entry.message.role !== "user") continue;

		const text = extractUserMessageText(entry.message.content);
		if (text.trim().length === 0) continue;

		messages.push({ entryId: entry.id, text });
	}

	return messages;
}

function pathToLeaf(entries: readonly ForkableSessionEntry[], leafId: string | null): ForkableSessionEntry[] {
	if (leafId === null) return [];

	const byId = new Map<string, ForkableSessionEntry>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}

	const path: ForkableSessionEntry[] = [];
	const seen = new Set<string>();
	let current = byId.get(leafId);

	if (!current) {
		throw new Error(`Entry ${leafId} not found`);
	}

	while (current) {
		if (seen.has(current.id)) {
			throw new Error(`Cycle detected in session at entry ${current.id}`);
		}
		seen.add(current.id);
		path.unshift(current);

		if (current.parentId === null) break;
		const parent = byId.get(current.parentId);
		if (!parent) {
			throw new Error(`Parent entry ${current.parentId} for ${current.id} not found`);
		}
		current = parent;
	}

	return path;
}

function generateSessionId(): string {
	return randomUUID();
}

function generateEntryId(usedIds: Set<string>): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!usedIds.has(id)) return id;
	}
	return randomUUID();
}

function resolvedLabels(entries: readonly ForkableSessionEntry[]): Array<{ targetId: string; label: string; timestamp: string }> {
	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();

	for (const entry of entries) {
		if (!isLabelEntry(entry)) continue;

		if (entry.label) {
			labelsById.set(entry.targetId, entry.label);
			labelTimestampsById.set(entry.targetId, entry.timestamp);
		} else {
			labelsById.delete(entry.targetId);
			labelTimestampsById.delete(entry.targetId);
		}
	}

	return [...labelsById.entries()].map(([targetId, label]) => ({
		targetId,
		label,
		timestamp: labelTimestampsById.get(targetId) ?? new Date().toISOString(),
	}));
}

function withoutLabelsReparented(path: readonly ForkableSessionEntry[]): ForkableSessionEntry[] {
	const result: ForkableSessionEntry[] = [];
	let parentId: string | null = null;

	for (const entry of path) {
		if (entry.type === "label") continue;

		const reparented = { ...entry, parentId };
		result.push(reparented);
		parentId = entry.id;
	}

	return result;
}

export function createForkedSessionFile(options: CreateForkedSessionFileOptions): CreateForkedSessionFileResult {
	if (!options.sessionDir) {
		throw new Error("Cannot create a fork without a session directory");
	}

	const selectedEntry = options.entries.find((entry) => entry.id === options.selectedEntryId);
	if (!selectedEntry || !isMessageEntry(selectedEntry) || selectedEntry.message.role !== "user") {
		throw new Error("Selected entry is not a user message");
	}

	const selectedText = extractUserMessageText(selectedEntry.message.content);
	const targetLeafId = selectedEntry.parentId;
	const branchPath = pathToLeaf(options.entries, targetLeafId);
	const branchPathWithoutLabels = withoutLabelsReparented(branchPath);
	const pathEntryIds = new Set(branchPathWithoutLabels.map((entry) => entry.id));
	const usedIds = new Set(options.entries.map((entry) => entry.id));

	let parentId = branchPathWithoutLabels[branchPathWithoutLabels.length - 1]?.id ?? null;
	const labelEntries: LabelEntry[] = [];
	for (const label of resolvedLabels(options.entries)) {
		if (!pathEntryIds.has(label.targetId)) continue;

		const id = generateEntryId(usedIds);
		usedIds.add(id);
		const entry: LabelEntry = {
			type: "label",
			id,
			parentId,
			timestamp: label.timestamp,
			targetId: label.targetId,
			label: label.label,
		};
		labelEntries.push(entry);
		parentId = id;
	}

	const now = options.now ?? new Date();
	const timestamp = now.toISOString();
	const sessionId = options.sessionId ?? generateSessionId();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = join(options.sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	const tempFile = join(options.sessionDir, `.${fileTimestamp}_${sessionId}.${process.pid}.${randomUUID()}.tmp`);
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd: options.cwd,
		parentSession: options.sourceSessionFile,
	};
	const fileEntries = [header, ...branchPathWithoutLabels, ...labelEntries];
	const content = `${fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

	mkdirSync(options.sessionDir, { recursive: true });
	writeFileSync(tempFile, content, { encoding: "utf8", mode: 0o600 });
	renameSync(tempFile, sessionFile);

	return { sessionFile, selectedText };
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildLaunchScriptSource(options: BuildLaunchScriptSourceOptions): string {
	const args = [`--session ${shellQuote(options.sessionFile)}`];
	if (options.bootstrapExtensionFile) {
		args.push(`--extension ${shellQuote(options.bootstrapExtensionFile)}`);
	}

	const cleanupLines: string[] = [];
	if (options.cleanupPaths && options.cleanupPaths.length > 0) {
		cleanupLines.push(`	rm -f -- ${options.cleanupPaths.map(shellQuote).join(" ")}`);
	}
	if (options.tempDir) {
		cleanupLines.push(`	rmdir -- ${shellQuote(options.tempDir)} 2>/dev/null || true`);
	}
	if (cleanupLines.length === 0) {
		cleanupLines.push("	:");
	}

	return `#!/usr/bin/env bash
set -euo pipefail

cleanup() {
${cleanupLines.join("\n")}
}
trap cleanup EXIT

cd ${shellQuote(options.cwd)}
${shellQuote(options.piExecutable)} ${args.join(" ")}
`;
}

export function buildBootstrapExtensionSource(editorText: string): string {
	return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EDITOR_TEXT = ${JSON.stringify(editorText)};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;
		if (!ctx.hasUI) return;
		ctx.ui.setEditorText(EDITOR_TEXT);
		ctx.ui.notify("Fork ready. Submit when ready.", "info");
	});
}
`;
}
