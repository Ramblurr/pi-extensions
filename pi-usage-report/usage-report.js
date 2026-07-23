import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const UNKNOWN_PROJECT = "<unknown>";
const REPORT_MARKER_CONTENT = "pi-usage-report-v1\n";
export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_PARSER_VERSION = "pi-session-events-v1";
const OUTPUT_SCHEMA_VERSION = 1;
const OUTPUT_STATE_FILE = ".pi-usage-report-state";
const REPORT_DATA_FILES = [
  "report.md",
  "aggregate-tools.csv",
  "aggregate-skills.csv",
  "project-tools.csv",
  "project-skills.csv",
  "projects.csv",
  "daily-usage.csv",
  "usage-events.csv",
];

function toIsoTimestamp(primary, fallback = undefined) {
  const value = primary ?? fallback;
  if (value === undefined || value === null || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function skillNameFromReadPath(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const directorySkill = normalized.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i);
  const directSkill = normalized.match(/(?:^|\/)skills\/([^/]+)\.md$/i);
  const encodedName = directorySkill?.[1] ?? directSkill?.[1];
  if (!encodedName) return undefined;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function skillNamesFromUserMessage(content) {
  const match = content.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  return match ? { names: [match[1]], ignored: 0 } : { names: [], ignored: 0 };
}

function eventDate(timestamp) {
  return timestamp ? timestamp.slice(0, 10) : "";
}

function usageEvent({ timestamp, project, sessionId, eventType, name, source }) {
  return {
    timestamp,
    date: eventDate(timestamp),
    project,
    sessionId,
    eventType,
    name,
    source,
  };
}

async function parseSessionFile(file) {
  let project = UNKNOWN_PROJECT;
  let sessionId = basename(file, ".jsonl");
  let sessionTimestamp = "";
  let parentSession = "";
  let hasHeader = false;
  const events = [];
  const diagnostics = {
    malformedLines: 0,
    filesWithoutHeader: 0,
    ignoredSkillTags: 0,
  };
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        diagnostics.malformedLines += 1;
        continue;
      }

      if (entry?.type === "session" && !hasHeader) {
        hasHeader = true;
        project = typeof entry.cwd === "string" && entry.cwd ? entry.cwd : UNKNOWN_PROJECT;
        sessionId = typeof entry.id === "string" && entry.id ? entry.id : sessionId;
        sessionTimestamp = toIsoTimestamp(entry.timestamp);
        parentSession = typeof entry.parentSession === "string" ? entry.parentSession : "";
        continue;
      }

      if (entry?.type !== "message" || !entry.message) continue;
      const message = entry.message;
      const timestamp = toIsoTimestamp(message.timestamp, entry.timestamp || sessionTimestamp);

      if (message.role === "toolResult") {
        if (typeof message.toolCallId === "string") {
          events.push({
            kind: "tool-result",
            toolCallId: message.toolCallId,
            isError: message.isError === true,
          });
        }
        continue;
      }

      if (message.role === "user") {
        const { names, ignored } = skillNamesFromUserMessage(textContent(message.content));
        diagnostics.ignoredSkillTags += ignored;
        for (const [index, name] of names.entries()) {
          events.push({
            kind: "user-skill",
            key: ["user-skill", entry.id ?? "", timestamp, index, name].join("\u0000"),
            event: usageEvent({
              timestamp,
              project,
              sessionId,
              eventType: "skill",
              name,
              source: "user-command",
            }),
          });
        }
        continue;
      }

      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const [index, block] of message.content.entries()) {
        if (!block || block.type !== "toolCall" || typeof block.name !== "string") continue;
        const toolCallId = typeof block.id === "string" ? block.id : "";
        const toolEvent = usageEvent({
          timestamp,
          project,
          sessionId,
          eventType: "tool",
          name: block.name,
          source: "tool-call",
        });
        let skill = null;
        if (block.name === "read" && toolCallId) {
          const skillName = skillNameFromReadPath(block.arguments?.path);
          if (skillName) {
            skill = usageEvent({
              timestamp,
              project,
              sessionId,
              eventType: "skill",
              name: skillName,
              source: "agent-read",
            });
          }
        }
        events.push({
          kind: "tool-call",
          key: [
            "tool",
            entry.id ?? "",
            timestamp,
            block.id ?? index,
            index,
            block.name,
          ].join("\u0000"),
          event: toolEvent,
          toolCallId,
          skill,
        });
      }
    }
  } finally {
    input.destroy();
  }

  if (!hasHeader) diagnostics.filesWithoutHeader = 1;
  return {
    path: file,
    session: {
      file,
      sessionId,
      project,
      timestamp: sessionTimestamp,
      parentSession,
    },
    events,
    diagnostics,
  };
}

function compareSessionMetadata(left, right) {
  const leftTimestamp = left.session.timestamp || "\uffff";
  const rightTimestamp = right.session.timestamp || "\uffff";
  return leftTimestamp.localeCompare(rightTimestamp) || left.path.localeCompare(right.path);
}

function orderParsedFiles(parsedFiles) {
  const byPath = new Map(parsedFiles.map((item) => [item.path, item]));
  const children = new Map(parsedFiles.map((item) => [item, []]));
  const indegree = new Map(parsedFiles.map((item) => [item, 0]));

  for (const item of parsedFiles) {
    if (!item.session.parentSession) continue;
    const parent = byPath.get(resolve(dirname(item.path), item.session.parentSession));
    if (!parent || parent === item) continue;
    children.get(parent).push(item);
    indegree.set(item, indegree.get(item) + 1);
  }

  const ready = parsedFiles
    .filter((item) => indegree.get(item) === 0)
    .sort(compareSessionMetadata);
  const ordered = [];
  while (ready.length > 0) {
    const item = ready.shift();
    ordered.push(item);
    for (const child of children.get(item)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort(compareSessionMetadata);
      }
    }
  }

  if (ordered.length < parsedFiles.length) {
    const included = new Set(ordered);
    ordered.push(
      ...parsedFiles.filter((item) => !included.has(item)).sort(compareSessionMetadata),
    );
  }
  return ordered;
}

async function listSessionFiles(sessionDirectory) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(resolve(path));
    }
  }

  await walk(sessionDirectory);
  return files;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === [...expectedKeys].sort()[index]);
}

function validUsageEvent(event) {
  return hasExactKeys(event, [
    "timestamp",
    "date",
    "project",
    "sessionId",
    "eventType",
    "name",
    "source",
  ]) && Object.values(event).every((value) => typeof value === "string");
}

function validCachedEvent(event) {
  if (event?.kind === "user-skill") {
    return hasExactKeys(event, ["kind", "key", "event"]) &&
      typeof event.key === "string" && validUsageEvent(event.event);
  }
  if (event?.kind === "tool-result") {
    return hasExactKeys(event, ["kind", "toolCallId", "isError"]) &&
      typeof event.toolCallId === "string" && typeof event.isError === "boolean";
  }
  if (event?.kind === "tool-call") {
    return hasExactKeys(event, ["kind", "key", "event", "toolCallId", "skill"]) &&
      typeof event.key === "string" &&
      typeof event.toolCallId === "string" &&
      validUsageEvent(event.event) &&
      (event.skill === null || validUsageEvent(event.skill));
  }
  return false;
}

function validCacheFile(file) {
  return hasExactKeys(file, [
    "path",
    "size",
    "mtimeNs",
    "session",
    "events",
    "diagnostics",
  ]) &&
    typeof file.path === "string" &&
    resolve(file.path) === file.path &&
    typeof file.size === "string" && /^\d+$/.test(file.size) &&
    typeof file.mtimeNs === "string" && /^-?\d+$/.test(file.mtimeNs) &&
    hasExactKeys(file.session, [
      "file",
      "sessionId",
      "project",
      "timestamp",
      "parentSession",
    ]) &&
    file.session.file === file.path &&
    [
      file.session.sessionId,
      file.session.project,
      file.session.timestamp,
      file.session.parentSession,
    ].every((value) => typeof value === "string") &&
    Array.isArray(file.events) && file.events.every(validCachedEvent) &&
    hasExactKeys(file.diagnostics, [
      "malformedLines",
      "filesWithoutHeader",
      "ignoredSkillTags",
    ]) &&
    Object.values(file.diagnostics).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
}

function validCache(cache, sessionDirectory) {
  if (!hasExactKeys(cache, ["schemaVersion", "parserVersion", "sessionDirectory", "files"])) {
    return false;
  }
  if (cache.schemaVersion !== CACHE_SCHEMA_VERSION ||
      cache.parserVersion !== CACHE_PARSER_VERSION ||
      cache.sessionDirectory !== sessionDirectory ||
      !Array.isArray(cache.files) ||
      !cache.files.every(validCacheFile)) {
    return false;
  }
  return new Set(cache.files.map((file) => file.path)).size === cache.files.length;
}

export function defaultCacheDirectory() {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "pi-usage-report");
}

function cacheFilePath(cacheDir, sessionDirectory) {
  const sourceHash = createHash("sha256").update(sessionDirectory).digest("hex").slice(0, 24);
  return join(resolve(cacheDir), `sessions-${sourceHash}.json`);
}

async function readSessionCache(path, sessionDirectory) {
  try {
    const cache = JSON.parse(await readFile(path, "utf8"));
    return validCache(cache, sessionDirectory) ? cache : null;
  } catch {
    return null;
  }
}

async function writeSessionCache(path, cache) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function sessionFileStats(files) {
  const results = await Promise.all(files.map(async (path) => {
    try {
      const metadata = await stat(path, { bigint: true });
      return {
        path,
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }));
  return results.filter(Boolean);
}

function sourceFingerprint(files) {
  const hash = createHash("sha256");
  hash.update(`${CACHE_SCHEMA_VERSION}\u0000${CACHE_PARSER_VERSION}\u0000`);
  for (const file of files) {
    hash.update(`${file.path}\u0000${file.size}\u0000${file.mtimeNs}\u0000`);
  }
  return hash.digest("hex");
}

export async function collectUsage(
  agentDir,
  { cacheDir = defaultCacheDirectory(), noCache = false, rebuildCache = false } = {},
) {
  if (noCache && rebuildCache) {
    throw new Error("noCache and rebuildCache cannot be used together");
  }
  const sessionDirectory = resolve(agentDir, "sessions");
  try {
    await access(sessionDirectory);
  } catch {
    throw new Error(`Pi session directory not found: ${sessionDirectory}`);
  }

  const listedFiles = await listSessionFiles(sessionDirectory);
  const currentFiles = await sessionFileStats(listedFiles);
  const cachePath = cacheFilePath(cacheDir, sessionDirectory);
  const loadedCache = noCache || rebuildCache
    ? null
    : await readSessionCache(cachePath, sessionDirectory);
  const cachedByPath = new Map((loadedCache?.files ?? []).map((file) => [file.path, file]));
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const deletedFiles = loadedCache
    ? loadedCache.files.filter((file) => !currentPaths.has(file.path)).length
    : 0;
  let parsedFiles = 0;
  let reusedFiles = 0;
  const parsed = [];

  for (const file of currentFiles) {
    const cached = cachedByPath.get(file.path);
    if (cached && cached.size === file.size && cached.mtimeNs === file.mtimeNs) {
      parsed.push(cached);
      reusedFiles += 1;
      continue;
    }
    const parsedFile = await parseSessionFile(file.path);
    parsed.push({ ...parsedFile, size: file.size, mtimeNs: file.mtimeNs });
    parsedFiles += 1;
  }

  let cacheWriteFailed = false;
  if (!noCache && (!loadedCache || parsedFiles > 0 || deletedFiles > 0 || rebuildCache)) {
    const cache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      parserVersion: CACHE_PARSER_VERSION,
      sessionDirectory,
      files: [...parsed].sort((left, right) => left.path.localeCompare(right.path)),
    };
    try {
      await writeSessionCache(cachePath, cache);
    } catch {
      cacheWriteFailed = true;
    }
  }

  const sessions = [];
  const events = [];
  const seenEvents = new Set();
  const pendingSkillReads = new Map();
  const diagnostics = {
    sessionFiles: parsed.length,
    malformedLines: 0,
    filesWithoutHeader: 0,
    ignoredSkillTags: 0,
    duplicateEvents: 0,
  };

  for (const file of orderParsedFiles(parsed)) {
    sessions.push(file.session);
    diagnostics.malformedLines += file.diagnostics.malformedLines;
    diagnostics.filesWithoutHeader += file.diagnostics.filesWithoutHeader;
    diagnostics.ignoredSkillTags += file.diagnostics.ignoredSkillTags;

    for (const record of file.events) {
      if (record.kind === "tool-result") {
        const pendingSkill = pendingSkillReads.get(record.toolCallId);
        if (pendingSkill) {
          pendingSkillReads.delete(record.toolCallId);
          if (!record.isError) events.push(pendingSkill);
        }
        continue;
      }

      if (seenEvents.has(record.key)) {
        diagnostics.duplicateEvents += 1;
        continue;
      }
      seenEvents.add(record.key);
      events.push(record.event);
      if (record.kind === "tool-call" && record.skill && record.toolCallId) {
        pendingSkillReads.set(record.toolCallId, record.skill);
      }
    }
  }

  events.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) ||
      left.project.localeCompare(right.project) ||
      left.eventType.localeCompare(right.eventType) ||
      left.name.localeCompare(right.name) ||
      left.source.localeCompare(right.source),
  );

  return {
    sessions,
    events,
    diagnostics,
    cache: {
      enabled: !noCache,
      path: noCache ? "" : cachePath,
      parsedFiles,
      reusedFiles,
      deletedFiles,
      writeFailed: cacheWriteFailed,
      sourceFingerprint: sourceFingerprint(currentFiles),
    },
  };
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map, keyName) {
  return [...map.entries()]
    .map(([name, count]) => ({ [keyName]: name, count }))
    .sort((left, right) => right.count - left.count || left[keyName].localeCompare(right[keyName]));
}

function updateRange(summary, timestamp) {
  if (!timestamp) return;
  if (!summary.firstSeen || timestamp < summary.firstSeen) summary.firstSeen = timestamp;
  if (!summary.lastSeen || timestamp > summary.lastSeen) summary.lastSeen = timestamp;
}

export function aggregateUsage(usage) {
  const tools = new Map();
  const skills = new Map();
  const projectToolCounts = new Map();
  const projectSkillCounts = new Map();
  const projectSummaries = new Map();
  const dailyCounts = new Map();

  function projectSummary(project) {
    if (!projectSummaries.has(project)) {
      projectSummaries.set(project, {
        project,
        sessions: 0,
        toolCalls: 0,
        skillUses: 0,
        firstSeen: "",
        lastSeen: "",
      });
    }
    return projectSummaries.get(project);
  }

  for (const session of usage.sessions) {
    const summary = projectSummary(session.project);
    summary.sessions += 1;
    updateRange(summary, session.timestamp);
  }

  for (const event of usage.events) {
    const summary = projectSummary(event.project);
    updateRange(summary, event.timestamp);
    const dailyKey = [
      event.date,
      event.project,
      event.eventType,
      event.name,
      event.source,
    ].join("\u0000");
    increment(dailyCounts, dailyKey);

    if (event.eventType === "tool") {
      summary.toolCalls += 1;
      increment(tools, event.name);
      increment(projectToolCounts, `${event.project}\u0000${event.name}`);
      continue;
    }

    summary.skillUses += 1;
    if (!skills.has(event.name)) skills.set(event.name, { agentReads: 0, userCommands: 0 });
    const aggregateSkill = skills.get(event.name);
    if (event.source === "agent-read") aggregateSkill.agentReads += 1;
    if (event.source === "user-command") aggregateSkill.userCommands += 1;

    const projectSkillKey = `${event.project}\u0000${event.name}`;
    if (!projectSkillCounts.has(projectSkillKey)) {
      projectSkillCounts.set(projectSkillKey, { agentReads: 0, userCommands: 0 });
    }
    const projectSkill = projectSkillCounts.get(projectSkillKey);
    if (event.source === "agent-read") projectSkill.agentReads += 1;
    if (event.source === "user-command") projectSkill.userCommands += 1;
  }

  const aggregateTools = sortedCounts(tools, "tool");
  const aggregateSkills = [...skills.entries()]
    .map(([skill, counts]) => ({
      skill,
      ...counts,
      total: counts.agentReads + counts.userCommands,
    }))
    .sort((left, right) => right.total - left.total || left.skill.localeCompare(right.skill));
  const projectTools = [...projectToolCounts.entries()]
    .map(([key, count]) => {
      const [project, tool] = key.split("\u0000");
      return { project, tool, count };
    })
    .sort(
      (left, right) =>
        left.project.localeCompare(right.project) ||
        right.count - left.count ||
        left.tool.localeCompare(right.tool),
    );
  const projectSkills = [...projectSkillCounts.entries()]
    .map(([key, counts]) => {
      const [project, skill] = key.split("\u0000");
      return {
        project,
        skill,
        ...counts,
        total: counts.agentReads + counts.userCommands,
      };
    })
    .sort(
      (left, right) =>
        left.project.localeCompare(right.project) ||
        right.total - left.total ||
        left.skill.localeCompare(right.skill),
    );
  const projects = [...projectSummaries.values()].sort((left, right) =>
    left.project.localeCompare(right.project),
  );
  const dailyUsage = [...dailyCounts.entries()]
    .map(([key, count]) => {
      const [date, project, eventType, name, source] = key.split("\u0000");
      return { date, project, eventType, name, source, count };
    })
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.project.localeCompare(right.project) ||
        left.eventType.localeCompare(right.eventType) ||
        left.name.localeCompare(right.name) ||
        left.source.localeCompare(right.source),
    );

  return {
    aggregateTools,
    aggregateSkills,
    projectTools,
    projectSkills,
    projects,
    dailyUsage,
  };
}

function csvValue(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows, columns) {
  const lines = [columns.map((column) => csvValue(column.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvValue(row[column.key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function markdownValue(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]{}()!|])/g, "\\$1")
    .replace(/[\r\n]+/g, " ");
}

function markdownTable(headers, rows) {
  if (rows.length === 0) return "_No data._\n";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownValue).join(" | ")} |`),
    "",
  ].join("\n");
}

function renderMarkdown({ usage, aggregates, agentDir, generatedAt }) {
  const toolCalls = aggregates.aggregateTools.reduce((sum, row) => sum + row.count, 0);
  const skillUses = aggregates.aggregateSkills.reduce((sum, row) => sum + row.total, 0);
  const firstSeen = aggregates.projects
    .map((project) => project.firstSeen)
    .filter(Boolean)
    .sort()[0] ?? "n/a";
  const lastSeen = aggregates.projects
    .map((project) => project.lastSeen)
    .filter(Boolean)
    .sort()
    .at(-1) ?? "n/a";
  const lines = [
    "# Pi Tool and Skill Usage Report",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    "",
    `Source: ${markdownValue(agentDir)}`,
    "",
    "## Coverage",
    "",
    markdownTable(
      ["Sessions", "Projects", "Tool calls", "Skill uses", "First seen", "Last seen"],
      [[usage.diagnostics.sessionFiles, aggregates.projects.length, toolCalls, skillUses, firstSeen, lastSeen]],
    ).trimEnd(),
    "",
    "## Methodology",
    "",
    "- Tool usage comes from assistant `toolCall` blocks, not tool-result messages.",
    "- Agent skill use is inferred from successful `read` calls ending in `skills/<name>/SKILL.md` or direct `skills/<name>.md` files.",
    "- User skill commands are matched against Pi's canonical expanded `<skill name=\"…\" location=\"…\">` message format.",
    "- Successful skill-file reads count once as a `read` tool call and once as a skill use; failed or unfinished reads remain only in tool totals.",
    "- Projects are the exact `cwd` values in session headers; worktrees and subdirectories remain separate.",
    "- Forked and cloned entries are deduplicated and attributed to their earliest session copy.",
    "- Prompt, response, and tool-result bodies are never written to the report or CSV files.",
    "",
    "## Diagnostics",
    "",
    markdownTable(
      ["Malformed lines", "Headerless files", "Ignored unnamed skill tags", "Duplicate events"],
      [[
        usage.diagnostics.malformedLines,
        usage.diagnostics.filesWithoutHeader,
        usage.diagnostics.ignoredSkillTags,
        usage.diagnostics.duplicateEvents,
      ]],
    ).trimEnd(),
    "",
    "## Aggregate tool usage",
    "",
    markdownTable(
      ["Tool", "Calls"],
      aggregates.aggregateTools.map((row) => [row.tool, row.count]),
    ).trimEnd(),
    "",
    "## Aggregate skill usage",
    "",
    markdownTable(
      ["Skill", "Agent reads", "User commands", "Total"],
      aggregates.aggregateSkills.map((row) => [
        row.skill,
        row.agentReads,
        row.userCommands,
        row.total,
      ]),
    ).trimEnd(),
    "",
    "## Projects",
    "",
    markdownTable(
      ["Project", "Sessions", "Tool calls", "Skill uses", "First seen", "Last seen"],
      aggregates.projects.map((row) => [
        row.project,
        row.sessions,
        row.toolCalls,
        row.skillUses,
        row.firstSeen || "n/a",
        row.lastSeen || "n/a",
      ]),
    ).trimEnd(),
    "",
  ];

  for (const project of aggregates.projects) {
    const tools = aggregates.projectTools.filter((row) => row.project === project.project);
    const skills = aggregates.projectSkills.filter((row) => row.project === project.project);
    lines.push(
      `## Project: ${markdownValue(project.project)}`,
      "",
      `Sessions: ${project.sessions} · Tool calls: ${project.toolCalls} · Skill uses: ${project.skillUses}`,
      "",
      "### Tools",
      "",
      markdownTable(
        ["Tool", "Calls"],
        tools.map((row) => [row.tool, row.count]),
      ).trimEnd(),
      "",
      "### Skills",
      "",
      markdownTable(
        ["Skill", "Agent reads", "User commands", "Total"],
        skills.map((row) => [row.skill, row.agentReads, row.userCommands, row.total]),
      ).trimEnd(),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function outputIsCurrent(outputDir, sourceFingerprint) {
  const target = resolve(outputDir);
  const expectedFiles = [
    ".pi-usage-report",
    OUTPUT_STATE_FILE,
    ...REPORT_DATA_FILES,
  ].sort();
  try {
    const entries = (await readdir(target)).sort();
    if (entries.length !== expectedFiles.length ||
        !entries.every((entry, index) => entry === expectedFiles[index])) {
      return false;
    }
    if (await readFile(join(target, ".pi-usage-report"), "utf8") !== REPORT_MARKER_CONTENT) {
      return false;
    }
    const state = JSON.parse(await readFile(join(target, OUTPUT_STATE_FILE), "utf8"));
    return hasExactKeys(state, ["schemaVersion", "sourceFingerprint"]) &&
      state.schemaVersion === OUTPUT_SCHEMA_VERSION &&
      state.sourceFingerprint === sourceFingerprint;
  } catch {
    return false;
  }
}

async function assertReplaceableOutputDirectory(target) {
  if (!(await pathExists(target))) return;
  let entries;
  try {
    entries = await readdir(target);
  } catch {
    throw new Error(`Refusing to replace non-empty unowned output directory: ${target}`);
  }
  if (entries.length === 0) return;

  let marker = "";
  try {
    marker = await readFile(join(target, ".pi-usage-report"), "utf8");
  } catch {
    // Missing or unreadable markers do not establish ownership.
  }
  if (marker !== REPORT_MARKER_CONTENT) {
    throw new Error(`Refusing to replace non-empty unowned output directory: ${target}`);
  }
}

async function publishReportFiles(files, outputDir) {
  const target = resolve(outputDir);
  const parent = dirname(target);
  const lock = `${target}.lock`;
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Another report publication is in progress: ${lock}`);
    }
    throw error;
  }

  let staging = "";
  let backup = "";
  try {
    await assertReplaceableOutputDirectory(target);
    staging = await mkdtemp(join(parent, `.${basename(target)}.tmp-`));
    await Promise.all(
      Object.entries(files).map(([fileName, content]) =>
        writeFile(join(staging, fileName), content, "utf8"),
      ),
    );

    if (await pathExists(target)) {
      backup = `${target}.backup-${process.pid}-${Date.now()}`;
      await rename(target, backup);
    }
    try {
      await rename(staging, target);
      staging = "";
    } catch (error) {
      if (backup) {
        await rename(backup, target);
        backup = "";
      }
      throw error;
    }
    if (backup) {
      await rm(backup, { recursive: true, force: true });
      backup = "";
    }
    return target;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function writeUsageReport({
  agentDir,
  outputDir,
  generatedAt = new Date(),
  cacheDir = defaultCacheDirectory(),
  noCache = false,
  rebuildCache = false,
}) {
  const usage = await collectUsage(agentDir, { cacheDir, noCache, rebuildCache });
  const aggregates = aggregateUsage(usage);
  const target = resolve(outputDir);
  const result = {
    reportPath: join(target, "report.md"),
    sessionFiles: usage.diagnostics.sessionFiles,
    projects: aggregates.projects.length,
    toolCalls: aggregates.aggregateTools.reduce((sum, row) => sum + row.count, 0),
    skillUses: aggregates.aggregateSkills.reduce((sum, row) => sum + row.total, 0),
  };
  if (await outputIsCurrent(target, usage.cache.sourceFingerprint)) {
    return { ...result, upToDate: true };
  }

  const files = {
    ".pi-usage-report": REPORT_MARKER_CONTENT,
    [OUTPUT_STATE_FILE]: `${JSON.stringify({
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      sourceFingerprint: usage.cache.sourceFingerprint,
    })}\n`,
    "report.md": renderMarkdown({ usage, aggregates, agentDir, generatedAt }),
    "aggregate-tools.csv": csv(aggregates.aggregateTools, [
      { header: "tool", key: "tool" },
      { header: "count", key: "count" },
    ]),
    "aggregate-skills.csv": csv(aggregates.aggregateSkills, [
      { header: "skill", key: "skill" },
      { header: "agent_reads", key: "agentReads" },
      { header: "user_commands", key: "userCommands" },
      { header: "total", key: "total" },
    ]),
    "project-tools.csv": csv(aggregates.projectTools, [
      { header: "project", key: "project" },
      { header: "tool", key: "tool" },
      { header: "count", key: "count" },
    ]),
    "project-skills.csv": csv(aggregates.projectSkills, [
      { header: "project", key: "project" },
      { header: "skill", key: "skill" },
      { header: "agent_reads", key: "agentReads" },
      { header: "user_commands", key: "userCommands" },
      { header: "total", key: "total" },
    ]),
    "projects.csv": csv(aggregates.projects, [
      { header: "project", key: "project" },
      { header: "sessions", key: "sessions" },
      { header: "tool_calls", key: "toolCalls" },
      { header: "skill_uses", key: "skillUses" },
      { header: "first_seen", key: "firstSeen" },
      { header: "last_seen", key: "lastSeen" },
    ]),
    "daily-usage.csv": csv(aggregates.dailyUsage, [
      { header: "date", key: "date" },
      { header: "project", key: "project" },
      { header: "event_type", key: "eventType" },
      { header: "name", key: "name" },
      { header: "source", key: "source" },
      { header: "count", key: "count" },
    ]),
    "usage-events.csv": csv(usage.events, [
      { header: "timestamp", key: "timestamp" },
      { header: "date", key: "date" },
      { header: "project", key: "project" },
      { header: "session_id", key: "sessionId" },
      { header: "event_type", key: "eventType" },
      { header: "name", key: "name" },
      { header: "source", key: "source" },
    ]),
  };
  await publishReportFiles(files, target);
  return { ...result, upToDate: false };
}
