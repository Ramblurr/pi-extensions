import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateUsage,
  collectUsage,
  writeUsageReport,
} from "../usage-report.js";

const temporaryDirectories = [];
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-report-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSession(agentDir, directoryName, fileName, entries, trailingLines = []) {
  const sessionDirectory = join(agentDir, "sessions", directoryName);
  const sessionFile = join(sessionDirectory, fileName);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(
    sessionFile,
    [...entries.map((entry) => JSON.stringify(entry)), ...trailingLines].join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}

function findCacheFile(cacheDir) {
  const files = readdirSync(cacheDir).filter((file) => file.endsWith(".json"));
  if (files.length !== 1) {
    throw new Error(`Expected one cache file in ${cacheDir}, found ${files.length}`);
  }
  return join(cacheDir, files[0]);
}

function toolCallEntry({
  entryId,
  callId,
  name = "bash",
  timestamp = "2026-04-01T01:00:00.000Z",
}) {
  return {
    type: "message",
    id: entryId,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      timestamp: Date.parse(timestamp),
      content: [{ type: "toolCall", id: callId, name, arguments: {} }],
    },
  };
}

function fixtureAgentDirectory() {
  const agentDir = temporaryDirectory();
  const projectA = "/work/acme, inc";
  const projectB = "/work/beta";

  const copiedUserSkill = {
    type: "message",
    id: "user-skill-1",
    parentId: null,
    timestamp: "2026-01-01T09:00:00.000Z",
    message: {
      role: "user",
      content:
        '<skill name="test-driven-development" location="/skills/test-driven-development/SKILL.md">\nsecret skill body\nExample only: <skill name="nested-example" location="example">do not count</skill>\n</skill>',
      timestamp: Date.parse("2026-01-01T09:00:00.000Z"),
    },
  };
  const copiedAssistantCall = {
    type: "message",
    id: "assistant-1",
    parentId: "user-skill-1",
    timestamp: "2026-01-01T09:01:00.000Z",
    message: {
      role: "assistant",
      timestamp: Date.parse("2026-01-01T09:01:00.000Z"),
      content: [
        {
          type: "toolCall",
          id: "call-read-1",
          name: "read",
          arguments: {
            path: "/skills/skills/skills/test-driven-development/SKILL.md",
          },
        },
        {
          type: "toolCall",
          id: "call-bash-1",
          name: "bash",
          arguments: { command: "true" },
        },
      ],
    },
  };

  writeSession(
    agentDir,
    "project-a",
    "2026-01-01T08-00-00-000Z_session-a.jsonl",
    [
      {
        type: "session",
        version: 3,
        id: "session-a",
        timestamp: "2026-01-01T08:00:00.000Z",
        cwd: projectA,
      },
      copiedUserSkill,
      copiedAssistantCall,
      {
        type: "message",
        id: "result-1",
        parentId: "assistant-1",
        timestamp: "2026-01-01T09:01:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          timestamp: Date.parse("2026-01-01T09:01:01.000Z"),
        },
      },
    ],
    ["not-json"],
  );

  writeSession(
    agentDir,
    "project-b",
    "2026-01-02T08-00-00-000Z_session-b.jsonl",
    [
      {
        type: "session",
        version: 3,
        id: "session-b",
        timestamp: "2026-01-02T08:00:00.000Z",
        cwd: projectB,
        parentSession: "session-a.jsonl",
      },
      copiedUserSkill,
      copiedAssistantCall,
      {
        type: "message",
        id: "ordinary-user-message",
        parentId: "assistant-1",
        timestamp: "2026-01-02T08:30:00.000Z",
        message: {
          role: "user",
          content:
            'Please explain the example <skill name="quoted-example" location="docs">not an invocation</skill>.',
          timestamp: Date.parse("2026-01-02T08:30:00.000Z"),
        },
      },
      {
        type: "message",
        id: "canonical-looking-prose",
        parentId: "ordinary-user-message",
        timestamp: "2026-01-02T08:31:00.000Z",
        message: {
          role: "user",
          content:
            '<skill name="not-a-command" location="docs">\nexample\n</skill> but this is prose',
          timestamp: Date.parse("2026-01-02T08:31:00.000Z"),
        },
      },
      {
        type: "message",
        id: "user-skill-2",
        parentId: "assistant-1",
        timestamp: "2026-01-02T09:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: '<skill name="local-git-reference" location="local">\n',
            },
            { type: "text", text: "another secret body\n</skill>\n\nDo the requested task" },
          ],
          timestamp: Date.parse("2026-01-02T09:00:00.000Z"),
        },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-skill-2",
        timestamp: "2026-01-02T09:01:00.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-01-02T09:01:00.000Z"),
          content: [
            {
              type: "toolCall",
              id: "call-edit-1",
              name: "edit",
              arguments: { path: "README.md" },
            },
          ],
        },
      },
    ],
  );

  writeSession(
    agentDir,
    "project-b",
    "2026-01-03T08-00-00-000Z_session-c.jsonl",
    [
      {
        type: "session",
        version: 3,
        id: "session-c",
        timestamp: "2026-01-03T08:00:00.000Z",
        cwd: projectB,
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-01-03T09:01:00.000Z",
        message: {
          role: "assistant",
          timestamp: Date.parse("2026-01-03T09:01:00.000Z"),
          content: [
            {
              type: "toolCall",
              id: "call-read-1",
              name: "read",
              arguments: {
                path: "/work/beta/.agents/skills/clojure-eval/SKILL.md",
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "clojure-eval-result",
        parentId: "assistant-1",
        timestamp: "2026-01-03T09:01:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "skill contents" }],
          isError: false,
          timestamp: Date.parse("2026-01-03T09:01:01.000Z"),
        },
      },
    ],
  );

  return { agentDir, projectA, projectB };
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = temporaryDirectory();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
});

describe("collectUsage", () => {
  test("collects historical tool and skill usage by project without double-counting fork copies", async () => {
    const { agentDir, projectA, projectB } = fixtureAgentDirectory();

    const usage = await collectUsage(agentDir);
    const aggregates = aggregateUsage(usage);

    expect(usage.diagnostics).toEqual({
      sessionFiles: 3,
      malformedLines: 1,
      filesWithoutHeader: 0,
      ignoredSkillTags: 0,
      duplicateEvents: 3,
    });
    expect(aggregates.aggregateTools).toEqual([
      { tool: "read", count: 2 },
      { tool: "bash", count: 1 },
      { tool: "edit", count: 1 },
    ]);
    expect(aggregates.aggregateSkills).toEqual([
      {
        skill: "test-driven-development",
        agentReads: 1,
        userCommands: 1,
        total: 2,
      },
      { skill: "clojure-eval", agentReads: 1, userCommands: 0, total: 1 },
      {
        skill: "local-git-reference",
        agentReads: 0,
        userCommands: 1,
        total: 1,
      },
    ]);
    expect(aggregates.projects).toEqual([
      {
        project: projectA,
        sessions: 1,
        toolCalls: 2,
        skillUses: 2,
        firstSeen: "2026-01-01T08:00:00.000Z",
        lastSeen: "2026-01-01T09:01:00.000Z",
      },
      {
        project: projectB,
        sessions: 2,
        toolCalls: 2,
        skillUses: 2,
        firstSeen: "2026-01-02T08:00:00.000Z",
        lastSeen: "2026-01-03T09:01:00.000Z",
      },
    ]);
    expect(aggregates.projectTools).toEqual([
      { project: projectA, tool: "bash", count: 1 },
      { project: projectA, tool: "read", count: 1 },
      { project: projectB, tool: "edit", count: 1 },
      { project: projectB, tool: "read", count: 1 },
    ]);
    expect(aggregates.projectSkills).toEqual([
      {
        project: projectA,
        skill: "test-driven-development",
        agentReads: 1,
        userCommands: 1,
        total: 2,
      },
      {
        project: projectB,
        skill: "clojure-eval",
        agentReads: 1,
        userCommands: 0,
        total: 1,
      },
      {
        project: projectB,
        skill: "local-git-reference",
        agentReads: 0,
        userCommands: 1,
        total: 1,
      },
    ]);
    expect(usage.events).toHaveLength(8);
  });

  test("attributes cloned events to the parent session even when filenames sort in the opposite order", async () => {
    const agentDir = temporaryDirectory();
    const copiedCall = {
      type: "message",
      id: "copied-assistant",
      parentId: null,
      timestamp: "2026-02-01T09:00:00.000Z",
      message: {
        role: "assistant",
        timestamp: Date.parse("2026-02-01T09:00:00.000Z"),
        content: [{ type: "toolCall", id: "copied-call", name: "bash", arguments: {} }],
      },
    };
    const parentFile = writeSession(
      agentDir,
      "parent",
      "2099-01-01T00-00-00-000Z_parent.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "parent",
          timestamp: "2026-02-01T08:00:00.000Z",
          cwd: "/work/parent",
        },
        copiedCall,
      ],
    );
    writeSession(
      agentDir,
      "child",
      "2000-01-01T00-00-00-000Z_child.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "child",
          timestamp: "2026-02-02T08:00:00.000Z",
          cwd: "/work/child",
          parentSession: parentFile,
        },
        copiedCall,
      ],
    );

    const usage = await collectUsage(agentDir);

    expect({
      toolEvents: usage.events.filter((event) => event.eventType === "tool"),
      duplicateEvents: usage.diagnostics.duplicateEvents,
    }).toEqual({
      toolEvents: [{
        timestamp: "2026-02-01T09:00:00.000Z",
        date: "2026-02-01",
        project: "/work/parent",
        sessionId: "parent",
        eventType: "tool",
        name: "bash",
        source: "tool-call",
      }],
      duplicateEvents: 1,
    });
  });

  test("recognizes direct root Markdown skills supported by Pi", async () => {
    const agentDir = temporaryDirectory();
    writeSession(
      agentDir,
      "direct-skill",
      "2026-03-01T00-00-00-000Z_direct-skill.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "direct-skill",
          timestamp: "2026-03-01T00:00:00.000Z",
          cwd: "/work/direct-skill",
        },
        {
          type: "message",
          id: "direct-skill-read",
          parentId: null,
          timestamp: "2026-03-01T01:00:00.000Z",
          message: {
            role: "assistant",
            timestamp: Date.parse("2026-03-01T01:00:00.000Z"),
            content: [
              {
                type: "toolCall",
                id: "direct-skill-call",
                name: "read",
                arguments: { path: "/home/user/.pi/agent/skills/elements-of-style.md" },
              },
              {
                type: "toolCall",
                id: "failed-skill-call",
                name: "read",
                arguments: { path: "/home/user/.pi/agent/skills/failed-skill.md" },
              },
              {
                type: "toolCall",
                id: "unfinished-skill-call",
                name: "read",
                arguments: { path: "/home/user/.pi/agent/skills/unfinished-skill.md" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "direct-skill-result",
          parentId: "direct-skill-read",
          timestamp: "2026-03-01T01:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: "direct-skill-call",
            toolName: "read",
            content: [{ type: "text", text: "skill contents" }],
            isError: false,
            timestamp: Date.parse("2026-03-01T01:00:01.000Z"),
          },
        },
        {
          type: "message",
          id: "failed-skill-result",
          parentId: "direct-skill-result",
          timestamp: "2026-03-01T01:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "failed-skill-call",
            toolName: "read",
            content: [{ type: "text", text: "File not found" }],
            isError: true,
            timestamp: Date.parse("2026-03-01T01:00:02.000Z"),
          },
        },
      ],
    );

    const usage = await collectUsage(agentDir);

    expect(usage.events.filter((event) => event.eventType === "skill")).toEqual([{
      timestamp: "2026-03-01T01:00:00.000Z",
      date: "2026-03-01",
      project: "/work/direct-skill",
      sessionId: "direct-skill",
      eventType: "skill",
      name: "elements-of-style",
      source: "agent-read",
    }]);
  });

  test("rejects a missing session directory with an actionable error", async () => {
    const agentDir = temporaryDirectory();

    await expect(collectUsage(agentDir)).rejects.toThrow(
      `Pi session directory not found: ${join(agentDir, "sessions")}`,
    );
  });
});

describe("incremental session cache", () => {
  test("reuses unchanged files and stores event metadata without private bodies", async () => {
    const { agentDir } = fixtureAgentDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");

    const first = await collectUsage(agentDir, { cacheDir });
    const cacheFile = findCacheFile(cacheDir);
    const cachedText = readFileSync(cacheFile, "utf8");
    const second = await collectUsage(agentDir, { cacheDir });

    expect({
      firstCache: {
        parsedFiles: first.cache.parsedFiles,
        reusedFiles: first.cache.reusedFiles,
      },
      secondCache: {
        parsedFiles: second.cache.parsedFiles,
        reusedFiles: second.cache.reusedFiles,
        deletedFiles: second.cache.deletedFiles,
      },
      resultsPreserved: {
        sessions: second.sessions,
        events: second.events,
        diagnostics: second.diagnostics,
      },
      firstResults: {
        sessions: first.sessions,
        events: first.events,
        diagnostics: first.diagnostics,
      },
      cacheUsesAbsolutePaths: JSON.parse(cachedText).files.every((file) =>
        file.path.startsWith("/") && typeof file.size === "string" && typeof file.mtimeNs === "string"
      ),
      leakedBodies: [
        "secret skill body",
        "another secret body",
        "skill contents",
        "Do the requested task",
      ].filter((body) => cachedText.includes(body)),
    }).toEqual({
      firstCache: { parsedFiles: 3, reusedFiles: 0 },
      secondCache: { parsedFiles: 0, reusedFiles: 3, deletedFiles: 0 },
      resultsPreserved: {
        sessions: first.sessions,
        events: first.events,
        diagnostics: first.diagnostics,
      },
      firstResults: {
        sessions: first.sessions,
        events: first.events,
        diagnostics: first.diagnostics,
      },
      cacheUsesAbsolutePaths: true,
      leakedBodies: [],
    });
  });

  test("invalidates only a modified session file", async () => {
    const agentDir = temporaryDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    const sessionFile = writeSession(
      agentDir,
      "project",
      "session.jsonl",
      [{
        type: "session",
        version: 3,
        id: "session",
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd: "/work/project",
      }],
    );
    await collectUsage(agentDir, { cacheDir });
    appendFileSync(
      sessionFile,
      `${JSON.stringify(toolCallEntry({ entryId: "new-entry", callId: "new-call" }))}\n`,
      "utf8",
    );

    const usage = await collectUsage(agentDir, { cacheDir });

    expect({
      cache: {
        parsedFiles: usage.cache.parsedFiles,
        reusedFiles: usage.cache.reusedFiles,
      },
      tools: aggregateUsage(usage).aggregateTools,
    }).toEqual({
      cache: { parsedFiles: 1, reusedFiles: 0 },
      tools: [{ tool: "bash", count: 1 }],
    });
  });

  test("removes deleted session files from cache and results", async () => {
    const agentDir = temporaryDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    const firstFile = writeSession(
      agentDir,
      "project",
      "first.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "first",
          timestamp: "2026-04-01T00:00:00.000Z",
          cwd: "/work/project",
        },
        toolCallEntry({ entryId: "first-entry", callId: "first-call" }),
      ],
    );
    writeSession(
      agentDir,
      "project",
      "second.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "second",
          timestamp: "2026-04-02T00:00:00.000Z",
          cwd: "/work/project",
        },
        toolCallEntry({
          entryId: "second-entry",
          callId: "second-call",
          name: "read",
          timestamp: "2026-04-02T01:00:00.000Z",
        }),
      ],
    );
    await collectUsage(agentDir, { cacheDir });
    rmSync(firstFile);

    const usage = await collectUsage(agentDir, { cacheDir });
    const cachedText = readFileSync(findCacheFile(cacheDir), "utf8");

    expect({
      cache: {
        parsedFiles: usage.cache.parsedFiles,
        reusedFiles: usage.cache.reusedFiles,
        deletedFiles: usage.cache.deletedFiles,
      },
      sessionIds: usage.sessions.map((session) => session.sessionId),
      tools: aggregateUsage(usage).aggregateTools,
      deletedPathCached: cachedText.includes(firstFile),
    }).toEqual({
      cache: { parsedFiles: 0, reusedFiles: 1, deletedFiles: 1 },
      sessionIds: ["second"],
      tools: [{ tool: "read", count: 1 }],
      deletedPathCached: false,
    });
  });

  test("invalidates an incompatible cache schema", async () => {
    const { agentDir } = fixtureAgentDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    await collectUsage(agentDir, { cacheDir });
    const cacheFile = findCacheFile(cacheDir);
    const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    cache.schemaVersion += 1;
    writeFileSync(cacheFile, `${JSON.stringify(cache)}\n`, "utf8");

    const usage = await collectUsage(agentDir, { cacheDir });
    const repairedCache = JSON.parse(readFileSync(cacheFile, "utf8"));

    expect({
      cache: {
        parsedFiles: usage.cache.parsedFiles,
        reusedFiles: usage.cache.reusedFiles,
      },
      reportStillWorks: aggregateUsage(usage).aggregateTools,
      schemaRepaired: repairedCache.schemaVersion !== cache.schemaVersion,
    }).toEqual({
      cache: { parsedFiles: 3, reusedFiles: 0 },
      reportStillWorks: [
        { tool: "read", count: 2 },
        { tool: "bash", count: 1 },
        { tool: "edit", count: 1 },
      ],
      schemaRepaired: true,
    });
  });

  test("recovers from a partially written cache", async () => {
    const { agentDir } = fixtureAgentDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    await collectUsage(agentDir, { cacheDir });
    const cacheFile = findCacheFile(cacheDir);
    writeFileSync(cacheFile, '{"schemaVersion":', "utf8");

    const usage = await collectUsage(agentDir, { cacheDir });

    expect({
      cache: {
        parsedFiles: usage.cache.parsedFiles,
        reusedFiles: usage.cache.reusedFiles,
      },
      cacheIsValidJson: JSON.parse(readFileSync(cacheFile, "utf8")).files.length,
      toolCalls: aggregateUsage(usage).aggregateTools.reduce(
        (sum, tool) => sum + tool.count,
        0,
      ),
    }).toEqual({
      cache: { parsedFiles: 3, reusedFiles: 0 },
      cacheIsValidJson: 3,
      toolCalls: 4,
    });
  });

  test("bypasses reads and writes with noCache and reparses all files when rebuilding", async () => {
    const { agentDir } = fixtureAgentDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    await collectUsage(agentDir, { cacheDir });
    const cacheFile = findCacheFile(cacheDir);
    const originalCache = readFileSync(cacheFile, "utf8");

    const bypassed = await collectUsage(agentDir, { cacheDir, noCache: true });
    const cacheAfterBypass = readFileSync(cacheFile, "utf8");
    const rebuilt = await collectUsage(agentDir, { cacheDir, rebuildCache: true });

    expect({
      bypassed: {
        enabled: bypassed.cache.enabled,
        parsedFiles: bypassed.cache.parsedFiles,
        reusedFiles: bypassed.cache.reusedFiles,
        leftCacheUntouched: cacheAfterBypass === originalCache,
      },
      rebuilt: {
        enabled: rebuilt.cache.enabled,
        parsedFiles: rebuilt.cache.parsedFiles,
        reusedFiles: rebuilt.cache.reusedFiles,
      },
      resultsMatch: bypassed.events.length === rebuilt.events.length,
    }).toEqual({
      bypassed: {
        enabled: false,
        parsedFiles: 3,
        reusedFiles: 0,
        leftCacheUntouched: true,
      },
      rebuilt: { enabled: true, parsedFiles: 3, reusedFiles: 0 },
      resultsMatch: true,
    });
  });

  test("recomputes ancestry ordering and fork deduplication across cached and new files", async () => {
    const agentDir = temporaryDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    const parentFile = join(agentDir, "sessions", "parent", "parent.jsonl");
    const copiedCall = toolCallEntry({
      entryId: "copied-entry",
      callId: "copied-call",
      timestamp: "2026-04-01T01:00:00.000Z",
    });
    writeSession(
      agentDir,
      "child",
      "child.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "child",
          timestamp: "2026-04-02T00:00:00.000Z",
          cwd: "/work/child",
          parentSession: parentFile,
        },
        copiedCall,
      ],
    );
    const beforeParentExists = await collectUsage(agentDir, { cacheDir });
    writeSession(
      agentDir,
      "parent",
      "parent.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "parent",
          timestamp: "2026-04-01T00:00:00.000Z",
          cwd: "/work/parent",
        },
        copiedCall,
      ],
    );

    const usage = await collectUsage(agentDir, { cacheDir });

    expect({
      ownerBeforeParentExists: beforeParentExists.events[0].project,
      cache: {
        parsedFiles: usage.cache.parsedFiles,
        reusedFiles: usage.cache.reusedFiles,
      },
      toolEvents: usage.events.filter((event) => event.eventType === "tool"),
      duplicateEvents: usage.diagnostics.duplicateEvents,
    }).toEqual({
      ownerBeforeParentExists: "/work/child",
      cache: { parsedFiles: 1, reusedFiles: 1 },
      toolEvents: [{
        timestamp: "2026-04-01T01:00:00.000Z",
        date: "2026-04-01",
        project: "/work/parent",
        sessionId: "parent",
        eventType: "tool",
        name: "bash",
        source: "tool-call",
      }],
      duplicateEvents: 1,
    });
  });
});

describe("writeUsageReport", () => {
  test("writes aggregate, per-project, daily, and event CSV data plus a private Markdown report", async () => {
    const { agentDir, projectA } = fixtureAgentDirectory();
    const outputDir = join(temporaryDirectory(), "generated");

    const result = await writeUsageReport({
      agentDir,
      outputDir,
      generatedAt: new Date("2026-01-04T12:00:00.000Z"),
    });

    expect(result).toEqual({
      reportPath: join(outputDir, "report.md"),
      sessionFiles: 3,
      projects: 2,
      toolCalls: 4,
      skillUses: 4,
      upToDate: false,
    });
    for (const fileName of [
      "report.md",
      "aggregate-tools.csv",
      "aggregate-skills.csv",
      "project-tools.csv",
      "project-skills.csv",
      "projects.csv",
      "daily-usage.csv",
      "usage-events.csv",
    ]) {
      expect(existsSync(join(outputDir, fileName))).toBe(true);
    }
    expect(existsSync(join(outputDir, ".pi-usage-report"))).toBe(true);

    const report = readFileSync(join(outputDir, "report.md"), "utf8");
    expect(report).toContain("# Pi Tool and Skill Usage Report");
    expect(report).toContain("## Aggregate tool usage");
    expect(report).toContain("## Aggregate skill usage");
    expect(report).toContain(`## Project: ${projectA}`);
    expect(report).toContain("Forked and cloned entries are deduplicated");
    expect(report).not.toContain("secret skill body");
    expect(report).not.toContain("another secret body");

    expect(readFileSync(join(outputDir, "aggregate-tools.csv"), "utf8")).toBe(
      "tool,count\nread,2\nbash,1\nedit,1\n",
    );
    expect(readFileSync(join(outputDir, "project-tools.csv"), "utf8")).toContain(
      `"${projectA}",bash,1`,
    );
    expect(readFileSync(join(outputDir, "daily-usage.csv"), "utf8")).toContain(
      "2026-01-01,\"/work/acme, inc\",skill,test-driven-development,user-command,1",
    );
    expect(readFileSync(join(outputDir, "usage-events.csv"), "utf8").split("\n")).toHaveLength(
      10,
    );

    writeFileSync(join(outputDir, "stale-from-previous-run.csv"), "stale\n", "utf8");
    await writeUsageReport({
      agentDir,
      outputDir,
      generatedAt: new Date("2026-01-05T12:00:00.000Z"),
    });
    expect(existsSync(join(outputDir, "stale-from-previous-run.csv"))).toBe(false);
  });

  test("neutralizes spreadsheet formulas and escapes Markdown metadata", async () => {
    const agentDir = temporaryDirectory();
    const project = "=<script>alert(1)</script>|danger";
    writeSession(
      agentDir,
      "unsafe",
      "2026-01-01T00-00-00-000Z_unsafe.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "unsafe",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: project,
        },
        {
          type: "message",
          id: "unsafe-tool",
          parentId: null,
          timestamp: "2026-01-01T01:00:00.000Z",
          message: {
            role: "assistant",
            timestamp: Date.parse("2026-01-01T01:00:00.000Z"),
            content: [
              { type: "toolCall", id: "unsafe-call", name: "+SUM(1,1)", arguments: {} },
              {
                type: "toolCall",
                id: "markdown-call",
                name: "![remote](https://example.com/pixel)",
                arguments: {},
              },
            ],
          },
        },
      ],
    );
    const outputDir = join(temporaryDirectory(), "unsafe-output");

    await writeUsageReport({ agentDir, outputDir });

    const projectCsv = readFileSync(join(outputDir, "projects.csv"), "utf8");
    const toolCsv = readFileSync(join(outputDir, "aggregate-tools.csv"), "utf8");
    const report = readFileSync(join(outputDir, "report.md"), "utf8");
    expect({
      projectNeutralized: projectCsv.includes("'=<script>alert(1)</script>|danger"),
      toolNeutralized: toolCsv.includes("\"'+SUM(1,1)\",1"),
      rawHtmlPresent: report.includes("<script>"),
      escapedHeadingPresent: report.includes(
        "## Project: =&lt;script&gt;alert\\(1\\)&lt;/script&gt;\\|danger",
      ),
      remoteMarkdownPresent: report.includes("![remote](https://example.com/pixel)"),
    }).toEqual({
      projectNeutralized: true,
      toolNeutralized: true,
      rawHtmlPresent: false,
      escapedHeadingPresent: true,
      remoteMarkdownPresent: false,
    });
  });

  test("does not rewrite complete output when its source fingerprint is unchanged", async () => {
    const { agentDir } = fixtureAgentDirectory();
    const cacheDir = join(temporaryDirectory(), "cache");
    const outputDir = join(temporaryDirectory(), "output");
    const first = await writeUsageReport({
      agentDir,
      cacheDir,
      outputDir,
      generatedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const firstReport = readFileSync(join(outputDir, "report.md"), "utf8");

    const second = await writeUsageReport({
      agentDir,
      cacheDir,
      outputDir,
      generatedAt: new Date("2026-05-02T00:00:00.000Z"),
    });
    const secondReport = readFileSync(join(outputDir, "report.md"), "utf8");
    rmSync(join(outputDir, "daily-usage.csv"));
    const repaired = await writeUsageReport({
      agentDir,
      cacheDir,
      outputDir,
      generatedAt: new Date("2026-05-03T00:00:00.000Z"),
    });

    expect({
      firstUpToDate: first.upToDate,
      secondUpToDate: second.upToDate,
      secondReportUnchanged: secondReport === firstReport,
      staleGeneratedTimeAbsent: !secondReport.includes("2026-05-02T00:00:00.000Z"),
      repairedUpToDate: repaired.upToDate,
      missingFileRestored: existsSync(join(outputDir, "daily-usage.csv")),
      repairGenerationShown: readFileSync(join(outputDir, "report.md"), "utf8").includes(
        "2026-05-03T00:00:00.000Z",
      ),
    }).toEqual({
      firstUpToDate: false,
      secondUpToDate: true,
      secondReportUnchanged: true,
      staleGeneratedTimeAbsent: true,
      repairedUpToDate: false,
      missingFileRestored: true,
      repairGenerationShown: true,
    });
  });

  test("refuses to replace a non-empty output directory it does not own", async () => {
    const { agentDir } = fixtureAgentDirectory();
    const outputDir = temporaryDirectory();
    const unrelatedFile = join(outputDir, "keep-me.txt");
    writeFileSync(unrelatedFile, "important\n", "utf8");

    await expect(writeUsageReport({ agentDir, outputDir })).rejects.toThrow(
      `Refusing to replace non-empty unowned output directory: ${outputDir}`,
    );
    expect({
      unrelatedContent: readFileSync(unrelatedFile, "utf8"),
      reportExists: existsSync(join(outputDir, "report.md")),
      lockExists: existsSync(`${outputDir}.lock`),
    }).toEqual({
      unrelatedContent: "important\n",
      reportExists: false,
      lockExists: false,
    });
  });
});

describe("report CLI", () => {
  test("generates the report with explicit agent and output directories", () => {
    const { agentDir } = fixtureAgentDirectory();
    const outputDir = join(temporaryDirectory(), "cli-output");
    const script = join(import.meta.dir, "..", "report.js");

    const result = spawnSync(process.execPath, [
      script,
      "--agent-dir",
      agentDir,
      "--output",
      outputDir,
    ], { encoding: "utf8" });

    expect({
      status: result.status,
      stderr: result.stderr,
      reportExists: existsSync(join(outputDir, "report.md")),
      summaryShown: result.stdout.includes("4 tool calls and 4 skill uses across 2 projects"),
    }).toEqual({
      status: 0,
      stderr: "",
      reportExists: true,
      summaryShown: true,
    });
  });

  test("supports no-cache and rebuild-cache flags", () => {
    const { agentDir } = fixtureAgentDirectory();
    const outputDir = join(temporaryDirectory(), "cli-cache-output");
    const cacheHome = temporaryDirectory();
    const script = join(import.meta.dir, "..", "report.js");
    const arguments_ = [script, "--agent-dir", agentDir, "--output", outputDir];
    const environment = { ...process.env, XDG_CACHE_HOME: cacheHome };
    const initial = spawnSync(process.execPath, arguments_, { encoding: "utf8", env: environment });
    const cacheDir = join(cacheHome, "pi-usage-report");
    const cacheFile = findCacheFile(cacheDir);
    writeFileSync(cacheFile, "{", "utf8");

    const bypassed = spawnSync(process.execPath, [...arguments_, "--no-cache"], {
      encoding: "utf8",
      env: environment,
    });
    const bypassLeftCacheUntouched = readFileSync(cacheFile, "utf8") === "{";
    const rebuilt = spawnSync(process.execPath, [...arguments_, "--rebuild-cache"], {
      encoding: "utf8",
      env: environment,
    });

    expect({
      initial: { status: initial.status, stderr: initial.stderr },
      bypassed: {
        status: bypassed.status,
        stderr: bypassed.stderr,
        leftCacheUntouched: bypassLeftCacheUntouched,
      },
      rebuilt: {
        status: rebuilt.status,
        stderr: rebuilt.stderr,
        cacheFiles: JSON.parse(readFileSync(cacheFile, "utf8")).files.length,
      },
    }).toEqual({
      initial: { status: 0, stderr: "" },
      bypassed: { status: 0, stderr: "", leftCacheUntouched: true },
      rebuilt: { status: 0, stderr: "", cacheFiles: 3 },
    });
  });
});
