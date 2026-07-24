export interface LinkSessionEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}


export interface LinkSessionTransfer {
	name?: string;
	active?: boolean;
}

export interface CustomEntryAppender {
	appendCustomEntry(customType: string, data?: unknown): unknown;
}

function normalizeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().replace(/\s+/g, " ");
	return normalized || undefined;
}

function latestCustomData(entries: LinkSessionEntry[], customType: string): unknown {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === customType) return entry.data;
	}

	return undefined;
}

function dataField(data: unknown, field: string): unknown {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	return (data as Record<string, unknown>)[field];
}

export function resolveLinkSessionTransfer(entries: LinkSessionEntry[]): LinkSessionTransfer | undefined {
	const name = normalizeName(dataField(latestCustomData(entries, "link-name"), "name"));
	const savedActive = dataField(latestCustomData(entries, "link-active"), "active");
	const active = typeof savedActive === "boolean" ? savedActive : undefined;

	if (name === undefined && active === undefined) return undefined;
	return { ...(name === undefined ? {} : { name }), ...(active === undefined ? {} : { active }) };
}

export function applyLinkSessionTransfer(
	sessionManager: CustomEntryAppender,
	transfer: LinkSessionTransfer | undefined,
): void {
	if (!transfer) return;
	if (transfer.name !== undefined) sessionManager.appendCustomEntry("link-name", { name: transfer.name });
	if (transfer.active !== undefined) sessionManager.appendCustomEntry("link-active", { active: transfer.active });
}
