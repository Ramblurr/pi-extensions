import { describe, expect, test } from "bun:test";
import { promptGhostSession } from "../ghost-session.ts";

describe("promptGhostSession", () => {
	test("sends an idle ghost prompt without streaming queue options", async () => {
		const calls: Array<{ text: string; options: Record<string, unknown> }> = [];
		const session = {
			isStreaming: false,
			async prompt(text: string, options: Record<string, unknown>) {
				calls.push({ text, options });
			},
		};

		await promptGhostSession(session, "what now?");

		expect(calls).toEqual([
			{
				text: "what now?",
				options: { images: [] },
			},
		]);
	});

	test("queues a ghost prompt as steering while the ghost agent is streaming", async () => {
		const calls: Array<{ text: string; options: Record<string, unknown> }> = [];
		const session = {
			isStreaming: true,
			async prompt(text: string, options: Record<string, unknown>) {
				calls.push({ text, options });
			},
		};

		await promptGhostSession(session, "also check tests");

		expect(calls).toEqual([
			{
				text: "also check tests",
				options: { images: [], streamingBehavior: "steer" },
			},
		]);
	});
});
