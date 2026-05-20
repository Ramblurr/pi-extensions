import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	buildLaunchScriptSource,
	createForkedSessionFile,
	getForkableUserMessages,
} from "../session-fork.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-fork-new-test-"));
}

function readJsonl(path: string): any[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("getForkableUserMessages", () => {
	test("returns non-empty text from user message entries", () => {
		const messages = getForkableUserMessages([
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-05-20T00:00:00.000Z",
				message: { role: "user", content: "first prompt", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-05-20T00:00:01.000Z",
				message: { role: "assistant", content: [], timestamp: 2 },
			},
			{
				type: "message",
				id: "u2",
				parentId: "a1",
				timestamp: "2026-05-20T00:00:02.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "second " },
						{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } },
						{ type: "text", text: "prompt" },
					],
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "u3",
				parentId: "u2",
				timestamp: "2026-05-20T00:00:03.000Z",
				message: { role: "user", content: "   ", timestamp: 4 },
			},
		] as any);

		expect(messages).toEqual([
			{ entryId: "u1", text: "first prompt" },
			{ entryId: "u2", text: "second prompt" },
		]);
	});
});

describe("createForkedSessionFile", () => {
	test("forks before the selected user into a new session file without touching the source file", () => {
		const dir = tmpDir();
		const sourceSessionFile = join(dir, "source.jsonl");
		writeFileSync(sourceSessionFile, "source sentinel\n", "utf8");

		const result = createForkedSessionFile({
			cwd: "/repo",
			sessionDir: dir,
			sourceSessionFile,
			selectedEntryId: "u2",
			now: new Date("2026-05-20T12:00:00.000Z"),
			sessionId: "new-session",
			entries: [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-05-20T00:00:00.000Z",
					message: { role: "user", content: "first prompt", timestamp: 1 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-05-20T00:00:01.000Z",
					message: { role: "assistant", content: [], timestamp: 2 },
				},
				{
					type: "message",
					id: "u2",
					parentId: "a1",
					timestamp: "2026-05-20T00:00:02.000Z",
					message: { role: "user", content: "second prompt", timestamp: 3 },
				},
				{
					type: "message",
					id: "a2",
					parentId: "u2",
					timestamp: "2026-05-20T00:00:03.000Z",
					message: { role: "assistant", content: [], timestamp: 4 },
				},
			] as any,
		});

		expect(result).toEqual({
			sessionFile: join(dir, "2026-05-20T12-00-00-000Z_new-session.jsonl"),
			selectedText: "second prompt",
		});
		expect(readFileSync(sourceSessionFile, "utf8")).toBe("source sentinel\n");
		expect(readJsonl(result.sessionFile)).toEqual([
			{
				type: "session",
				version: 3,
				id: "new-session",
				timestamp: "2026-05-20T12:00:00.000Z",
				cwd: "/repo",
				parentSession: sourceSessionFile,
			},
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-05-20T00:00:00.000Z",
				message: { role: "user", content: "first prompt", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-05-20T00:00:01.000Z",
				message: { role: "assistant", content: [], timestamp: 2 },
			},
		]);
	});

	test("forking before the root user creates a header-only session with the prompt returned for editor restore", () => {
		const dir = tmpDir();

		const result = createForkedSessionFile({
			cwd: "/repo",
			sessionDir: dir,
			sourceSessionFile: "/sessions/source.jsonl",
			selectedEntryId: "u1",
			now: new Date("2026-05-20T12:00:00.000Z"),
			sessionId: "new-session",
			entries: [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-05-20T00:00:00.000Z",
					message: { role: "user", content: "root prompt", timestamp: 1 },
				},
			] as any,
		});

		expect(result.selectedText).toBe("root prompt");
		expect(readJsonl(result.sessionFile)).toEqual([
			{
				type: "session",
				version: 3,
				id: "new-session",
				timestamp: "2026-05-20T12:00:00.000Z",
				cwd: "/repo",
				parentSession: "/sessions/source.jsonl",
			},
		]);
	});

	test("copies resolved labels for entries included in the forked path", () => {
		const dir = tmpDir();

		const result = createForkedSessionFile({
			cwd: "/repo",
			sessionDir: dir,
			sourceSessionFile: "/sessions/source.jsonl",
			selectedEntryId: "u2",
			now: new Date("2026-05-20T12:00:00.000Z"),
			sessionId: "new-session",
			entries: [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-05-20T00:00:00.000Z",
					message: { role: "user", content: "first prompt", timestamp: 1 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-05-20T00:00:01.000Z",
					message: { role: "assistant", content: [], timestamp: 2 },
				},
				{
					type: "label",
					id: "label-old",
					parentId: "a1",
					timestamp: "2026-05-20T00:00:02.000Z",
					targetId: "u1",
					label: "checkpoint",
				},
				{
					type: "message",
					id: "u2",
					parentId: "label-old",
					timestamp: "2026-05-20T00:00:03.000Z",
					message: { role: "user", content: "second prompt", timestamp: 3 },
				},
			] as any,
		});

		const entries = readJsonl(result.sessionFile);
		expect(entries).toHaveLength(4);
		expect(entries[3]).toMatchObject({
			type: "label",
			parentId: "a1",
			timestamp: "2026-05-20T00:00:02.000Z",
			targetId: "u1",
			label: "checkpoint",
		});
		expect(entries[3].id).not.toBe("label-old");
	});

	test("reparents copied branch entries when label entries are omitted", () => {
		const dir = tmpDir();

		const result = createForkedSessionFile({
			cwd: "/repo",
			sessionDir: dir,
			sourceSessionFile: "/sessions/source.jsonl",
			selectedEntryId: "u3",
			now: new Date("2026-05-20T12:00:00.000Z"),
			sessionId: "new-session",
			entries: [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-05-20T00:00:00.000Z",
					message: { role: "user", content: "first prompt", timestamp: 1 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-05-20T00:00:01.000Z",
					message: { role: "assistant", content: [], timestamp: 2 },
				},
				{
					type: "label",
					id: "label-old",
					parentId: "a1",
					timestamp: "2026-05-20T00:00:02.000Z",
					targetId: "u1",
					label: "checkpoint",
				},
				{
					type: "message",
					id: "u2",
					parentId: "label-old",
					timestamp: "2026-05-20T00:00:03.000Z",
					message: { role: "user", content: "second prompt", timestamp: 3 },
				},
				{
					type: "message",
					id: "a2",
					parentId: "u2",
					timestamp: "2026-05-20T00:00:04.000Z",
					message: { role: "assistant", content: [], timestamp: 4 },
				},
				{
					type: "message",
					id: "u3",
					parentId: "a2",
					timestamp: "2026-05-20T00:00:05.000Z",
					message: { role: "user", content: "third prompt", timestamp: 5 },
				},
			] as any,
		});

		const entries = readJsonl(result.sessionFile);
		expect(entries.map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
			{ id: "new-session", parentId: undefined },
			{ id: "u1", parentId: null },
			{ id: "a1", parentId: "u1" },
			{ id: "u2", parentId: "a1" },
			{ id: "a2", parentId: "u2" },
			{ id: entries[5].id, parentId: "a2" },
		]);
		expect(entries[5]).toMatchObject({
			type: "label",
			targetId: "u1",
			label: "checkpoint",
		});
	});
});

describe("buildLaunchScriptSource", () => {
	test("launches pi with --session and the bootstrap extension, then cleans temp files", () => {
		const script = buildLaunchScriptSource({
			cwd: "/repo with space",
			piExecutable: "/usr/bin/pi",
			sessionFile: "/tmp/session file.jsonl",
			bootstrapExtensionFile: "/tmp/bootstrap extension.ts",
			cleanupPaths: ["/tmp/bootstrap extension.ts", "/tmp/launching-pi"],
			tempDir: "/tmp/pi fork new",
		});

		expect(script).toContain("cd '/repo with space'");
		expect(script).toContain("'/usr/bin/pi' --session '/tmp/session file.jsonl' --extension '/tmp/bootstrap extension.ts'");
		expect(script).toContain("rm -f -- '/tmp/bootstrap extension.ts' '/tmp/launching-pi'");
		expect(script).toContain("rmdir -- '/tmp/pi fork new'");
		expect(script).not.toContain("--fork");
	});
});
