export interface GhostPromptSession {
	readonly isStreaming: boolean;
	prompt(
		text: string,
		options?: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void>;
}

export async function promptGhostSession(
	session: GhostPromptSession,
	text: string,
	images: unknown[] = [],
): Promise<void> {
	const options: { images: unknown[]; streamingBehavior?: "steer" | "followUp" } = { images };
	if (session.isStreaming) {
		options.streamingBehavior = "steer";
	}
	await session.prompt(text, options);
}
