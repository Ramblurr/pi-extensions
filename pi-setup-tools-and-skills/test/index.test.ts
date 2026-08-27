import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function formatSkillsForPrompt(skills: Array<{ name: string; description: string; filePath: string }>): string {
	if (skills.length === 0) return "";
	return `\n\n<available_skills>\n${skills
		.map(
			(skill) =>
				`  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n    <location>${skill.filePath}</location>\n  </skill>`,
		)
		.join("\n")}\n</available_skills>`;
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	DynamicBorder: class {},
	formatSkillsForPrompt,
	getSettingsListTheme: () => ({}),
}));

mock.module("@earendil-works/pi-tui", () => ({
	Container: class {},
	Key: { ctrl: (key: string) => `ctrl+${key}` },
	matchesKey: (data: string, key: string) => data === key,
	SettingsList: class {},
	Text: class {},
}));

const {
	default: setupToolsAndSkillsExtension,
	exclusionsFromSettings,
	filterSkillsPrompt,
	settingsWithExclusions,
} = await import("../index.ts");

function skill(name: string) {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		disableModelInvocation: false,
		sourceInfo: {
			path: `/skills/${name}/SKILL.md`,
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	};
}

describe("resource exclusion settings", () => {
	test("defaults to empty exclusions", () => {
		expect(exclusionsFromSettings({ theme: "dark" })).toEqual({ skills: [], tools: [] });
	});

	test("normalizes names and rejects malformed lists", () => {
		expect(
			exclusionsFromSettings({
				resourceExclusions: {
					skills: [" zeta ", "alpha", "alpha"],
					tools: ["write", "read"],
				},
			}),
		).toEqual({ skills: ["alpha", "zeta"], tools: ["read", "write"] });
		expect(() => exclusionsFromSettings({ resourceExclusions: { tools: "bash" } })).toThrow(
			"resourceExclusions.tools must be an array of non-empty strings",
		);
	});

	test("updates its own key without dropping unrelated settings or nested fields", () => {
		expect(
			settingsWithExclusions(
				{ theme: "dark", resourceExclusions: { note: "keep me", tools: ["old"] } },
				{ skills: ["zeta", "alpha"], tools: [] },
			),
		).toEqual({
			theme: "dark",
			resourceExclusions: {
				note: "keep me",
				skills: ["alpha", "zeta"],
				tools: [],
			},
		});
	});
});

describe("skill prompt filtering", () => {
	test("removes excluded skill metadata while preserving the rest of the prompt", () => {
		const skills = [skill("alpha"), skill("beta")];
		const options = { cwd: "/project", skills };
		const prompt = `prefix${formatSkillsForPrompt(skills)}\nsuffix`;
		const filtered = filterSkillsPrompt(prompt, options, new Set(["beta"]));

		expect(filtered).toContain("prefix");
		expect(filtered).toContain("<name>alpha</name>");
		expect(filtered).not.toContain("<name>beta</name>");
		expect(filtered).toContain("suffix");
	});

	test("leaves custom prompts without Pi's skill block unchanged", () => {
		const options = { cwd: "/project", skills: [skill("alpha")] };
		expect(filterSkillsPrompt("custom prompt", options, new Set(["alpha"]))).toBe("custom prompt");
	});
});

describe("extension enforcement", () => {
	test("loads project exclusions, removes active tools, filters skills, and blocks stale calls", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-resource-exclusions-"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ resourceExclusions: { tools: ["bash"], skills: ["beta"] } }),
		);

		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		let activeTools = ["read", "bash"];
		const pi = {
			on: (event: string, handler: (event: any, ctx: any) => any) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerCommand: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
			getAllTools: () => [],
		};
		const ctx = {
			cwd,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { notify: () => {} },
		};

		try {
			setupToolsAndSkillsExtension(pi as never);
			await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
			expect(activeTools).toEqual(["read"]);

			const skills = [skill("alpha"), skill("beta")];
			const prompt = `prefix${formatSkillsForPrompt(skills)}\nsuffix`;
			const promptResult = await handlers.get("before_agent_start")?.[0]?.(
				{ systemPrompt: prompt, systemPromptOptions: { cwd, skills } },
				ctx,
			);
			expect(promptResult.systemPrompt).toContain("<name>alpha</name>");
			expect(promptResult.systemPrompt).not.toContain("<name>beta</name>");

			const blocked = await handlers.get("tool_call")?.[0]?.({ toolName: "bash" }, ctx);
			expect(blocked).toEqual({ block: true, reason: 'Tool "bash" is excluded for this project.' });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
