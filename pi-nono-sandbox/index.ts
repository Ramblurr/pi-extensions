// Adapted from always-further/nono-packs pi at commit 0817a30923eb633da9f3ac87bdfb085e0ead7724.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const DENIAL_PATTERNS = [
	/operation not permitted/i,
	/permission denied/i,
	/\bEACCES\b/i,
	/\bEPERM\b/i,
	/landlock/i,
	/sandbox(?:ed)?:?\s+deny/i,
	/sandbox denied/i,
];

const SYSTEM_CONTEXT = `
You are running inside nono, an outer OS-level sandbox. Its filesystem and network limits are enforced before Pi starts. Pi approvals, retries, chmod, chown, sudo, or macOS Full Disk Access cannot grant access that nono has not allowed.

When an operation fails with a likely sandbox denial, follow the nono-sandbox skill. Offer either a one-off grant or a validated profile draft. Do not promote drafts: report them for integration into ~/nixcfg/modules/dev/llms/nono.nix.
`.trim();

const DENIAL_GUIDANCE = `
[nono sandbox diagnostic]
This looks like an outer nono sandbox denial, not a Unix permission problem.

Diagnose it with:
  nono why --self --path <blocked-path> --op <read|write|readwrite>

Offer exactly two options:
  A. Restart with a one-off --read or --allow grant.
  B. Write ~/.config/nono/profile-drafts/<name>.json and validate it with:
     nono profile validate --draft <name>

Do not promote the draft. Report its path and requested capabilities so it can be integrated into ~/nixcfg/modules/dev/llms/nono.nix.
`.trim();

function insideNono(): boolean {
	return Boolean(process.env.NONO_CAP_FILE);
}

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

function textFromEvent(event: ToolResultEvent): string {
	return event.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function looksLikeDenial(event: ToolResultEvent): boolean {
	if (!event.isError) return false;
	const haystack = [event.toolName, textFromEvent(event), JSON.stringify(event.details ?? {})].join("\n");
	return DENIAL_PATTERNS.some((pattern) => pattern.test(haystack));
}

export default function (pi: ExtensionAPI) {
	if (!insideNono()) return;

	pi.on("resources_discover", async () => ({
		skillPaths: [SKILLS_DIR],
	}));
	pi.on("session_start", async (_event, ctx) => {
		if (insideNono() && ctx.hasUI) {
			ctx.ui.setStatus("nono", "nono sandbox");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!insideNono()) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_CONTEXT}`,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!insideNono() || !looksLikeDenial(event)) return undefined;

		if (ctx.hasUI) {
			ctx.ui.notify("nono sandbox denial detected", "warning");
		}

		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: DENIAL_GUIDANCE,
				},
			],
			isError: true,
		};
	});

	pi.registerCommand("nono-status", {
		description: "Show nono sandbox status for this Pi session",
		handler: async (_args, ctx) => {
			const capFile = process.env.NONO_CAP_FILE;
			if (!capFile) {
				ctx.ui.notify("Pi is not running inside a nono session.", "info");
				return;
			}

			if (!existsSync(capFile)) {
				ctx.ui.notify(`nono capability file is not readable: ${capFile}`, "warning");
				return;
			}

			const summary = readFileSync(capFile, "utf8").split("\n").slice(0, 12).join("\n").trim();
			ctx.ui.notify(summary || `nono capability file is empty: ${capFile}`, "info");
		},
	});
}
