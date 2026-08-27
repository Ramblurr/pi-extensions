import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	formatSkillsForPrompt,
	getSettingsListTheme,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_KEY = "resourceExclusions";

type ResourceKind = "skills" | "tools";

export type ResourceExclusions = {
	skills: string[];
	tools: string[];
};

type SettingsShape = Record<string, unknown>;

type ResourceCandidate = {
	name: string;
	description: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNameList(value: unknown, key: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim())) {
		throw new Error(`${SETTINGS_KEY}.${key} must be an array of non-empty strings`);
	}
	return [...new Set(value.map((name) => name.trim()))].sort();
}

export function exclusionsFromSettings(settings: SettingsShape): ResourceExclusions {
	const configured = settings[SETTINGS_KEY];
	if (configured === undefined) return { skills: [], tools: [] };
	if (!isRecord(configured)) throw new Error(`${SETTINGS_KEY} must be an object`);

	return {
		skills: parseNameList(configured.skills, "skills"),
		tools: parseNameList(configured.tools, "tools"),
	};
}

export function settingsWithExclusions(
	settings: SettingsShape,
	exclusions: ResourceExclusions,
): SettingsShape {
	const previous = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
	return {
		...settings,
		[SETTINGS_KEY]: {
			...previous,
			skills: [...new Set(exclusions.skills)].sort(),
			tools: [...new Set(exclusions.tools)].sort(),
		},
	};
}

export function filterSkillsPrompt(
	systemPrompt: string,
	options: BuildSystemPromptOptions,
	excludedNames: ReadonlySet<string>,
): string {
	const skills = options.skills ?? [];
	const includedSkills = skills.filter((skill) => !excludedNames.has(skill.name));
	if (includedSkills.length === skills.length) return systemPrompt;

	const currentBlock = formatSkillsForPrompt(skills);
	if (!currentBlock || !systemPrompt.includes(currentBlock)) return systemPrompt;
	return systemPrompt.replace(currentBlock, formatSkillsForPrompt(includedSkills));
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function readSettings(path: string): SettingsShape {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error("settings.json must contain a JSON object");
	return parsed;
}

function writeSettings(path: string, settings: SettingsShape): void {
	mkdirSync(dirname(path), { recursive: true });
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

	try {
		writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode });
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {}
		throw error;
	}
}

function sortedCandidates(candidates: ResourceCandidate[]): ResourceCandidate[] {
	return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

function skillCandidates(skills: Skill[]): ResourceCandidate[] {
	return sortedCandidates(
		skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
		})),
	);
}

async function selectResources(
	ctx: ExtensionCommandContext,
	kind: ResourceKind,
	candidates: ResourceCandidate[],
	initialIncluded: boolean[],
): Promise<boolean[] | undefined> {
	return ctx.ui.custom<boolean[] | undefined>((tui, theme, _keybindings, done) => {
		const included = [...initialIncluded];
		const title = kind === "skills" ? "Skills" : "Tools";
		const items: SettingItem[] = candidates.map((candidate, index) => ({
			id: String(index),
			label: candidate.name,
			description: candidate.description,
			currentValue: included[index] ? "included" : "excluded",
			values: ["included", "excluded"],
		}));

		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(
			new (class {
				render(): string[] {
					const count = included.filter(Boolean).length;
					return [theme.fg("accent", theme.bold(`${title} (${count}/${candidates.length} included)`))];
				}
				invalidate(): void {}
			})(),
		);

		const settingsList = new SettingsList(
			items,
			Math.min(Math.max(items.length, 3), 15),
			getSettingsListTheme(),
			(id, newValue) => {
				included[Number(id)] = newValue === "included";
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settingsList);
		container.addChild(new Text(theme.fg("dim", "  Ctrl+S save • q/Esc cancel"), 0, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "q") {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.ctrl("s"))) {
					done(included);
					return;
				}
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function setupToolsAndSkillsExtension(pi: ExtensionAPI): void {
	let exclusions: ResourceExclusions = { skills: [], tools: [] };

	const excludedSkills = () => new Set(exclusions.skills);
	const excludedTools = () => new Set(exclusions.tools);

	const applyToolExclusions = () => {
		const excluded = excludedTools();
		const active = pi.getActiveTools();
		const included = active.filter((name) => !excluded.has(name));
		if (included.length !== active.length) pi.setActiveTools(included);
	};

	const loadProjectExclusions = (ctx: ExtensionContext) => {
		if (!ctx.isProjectTrusted()) {
			exclusions = { skills: [], tools: [] };
			return;
		}

		const path = projectSettingsPath(ctx.cwd);
		try {
			exclusions = exclusionsFromSettings(readSettings(path));
		} catch (error) {
			exclusions = { skills: [], tools: [] };
			if (ctx.hasUI) ctx.ui.notify(`Could not read ${path}: ${formatError(error)}`, "error");
		}
	};

	const registerResourceCommand = (kind: ResourceKind) => {
		pi.registerCommand(kind, {
			description: `Include or exclude project ${kind} by name`,
			handler: async (_args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`/${kind} requires TUI mode`, "error");
					return;
				}
				if (!ctx.isProjectTrusted()) {
					ctx.ui.notify("Project settings are unavailable until this project is trusted.", "error");
					return;
				}

				const path = projectSettingsPath(ctx.cwd);
				let settings: SettingsShape;
				let current: ResourceExclusions;
				try {
					settings = readSettings(path);
					current = exclusionsFromSettings(settings);
				} catch (error) {
					ctx.ui.notify(`Could not read ${path}: ${formatError(error)}`, "error");
					return;
				}

				const candidates =
					kind === "skills"
						? skillCandidates(ctx.getSystemPromptOptions().skills ?? [])
						: sortedCandidates(
								pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
							);
				if (candidates.length === 0) {
					ctx.ui.notify(`No ${kind} found.`, "warning");
					return;
				}

				const previouslyExcluded = new Set(current[kind]);
				const selected = await selectResources(
					ctx,
					kind,
					candidates,
					candidates.map((candidate) => !previouslyExcluded.has(candidate.name)),
				);
				if (!selected) {
					ctx.ui.notify(`${kind === "skills" ? "Skill" : "Tool"} setup cancelled.`, "info");
					return;
				}

				const candidateNames = new Set(candidates.map((candidate) => candidate.name));
				const nextExcluded = new Set([...previouslyExcluded].filter((name) => !candidateNames.has(name)));
				for (let index = 0; index < candidates.length; index++) {
					if (!selected[index]) nextExcluded.add(candidates[index].name);
				}

				const next: ResourceExclusions = {
					...current,
					[kind]: [...nextExcluded].sort(),
				};
				try {
					writeSettings(path, settingsWithExclusions(settings, next));
				} catch (error) {
					ctx.ui.notify(`Could not write ${path}: ${formatError(error)}`, "error");
					return;
				}

				const changed = candidates.filter(
					(candidate, index) => previouslyExcluded.has(candidate.name) === selected[index],
				).length;
				const oldExcludedTools = current.tools;
				exclusions = next;
				if (kind === "tools") {
					const active = new Set(pi.getActiveTools());
					const registered = new Set(pi.getAllTools().map((tool) => tool.name));
					for (const name of oldExcludedTools) {
						if (!nextExcluded.has(name) && registered.has(name)) active.add(name);
					}
					for (const name of nextExcluded) active.delete(name);
					pi.setActiveTools([...active]);
				}
				ctx.ui.notify(
					`${kind === "skills" ? "Skill" : "Tool"} exclusions saved to ${path} (${changed} changed).`,
					"info",
				);
			},
		});
	};

	registerResourceCommand("tools");
	registerResourceCommand("skills");

	pi.on("session_start", (_event, ctx) => {
		loadProjectExclusions(ctx);
		applyToolExclusions();
	});

	pi.on("turn_start", () => {
		applyToolExclusions();
	});

	pi.on("before_agent_start", (event) => {
		applyToolExclusions();
		const filteredPrompt = filterSkillsPrompt(event.systemPrompt, event.systemPromptOptions, excludedSkills());
		if (filteredPrompt !== event.systemPrompt) return { systemPrompt: filteredPrompt };
	});

	pi.on("input", (event, ctx) => {
		const match = event.text.match(/^\/skill:([^\s]+)(?:\s|$)/);
		if (!match || !excludedSkills().has(match[1])) return { action: "continue" };
		if (ctx.hasUI) ctx.ui.notify(`Skill "${match[1]}" is excluded for this project.`, "warning");
		return { action: "handled" };
	});

	pi.on("tool_call", (event) => {
		if (excludedTools().has(event.toolName)) {
			return { block: true, reason: `Tool "${event.toolName}" is excluded for this project.` };
		}
	});
}
