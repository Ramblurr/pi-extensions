#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeUsageReport } from "./usage-report.js";

function defaultAgentDirectory() {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "pi", "agent");
}

function usage() {
  return `Usage: bun run report.js [options]

Options:
  --agent-dir PATH  Pi agent data directory (default: $PI_CODING_AGENT_DIR,
                    then $XDG_CONFIG_HOME/pi/agent, then ~/.config/pi/agent)
  --output PATH     Report output directory (default: ./output)
  --no-cache        Parse every session and do not read or update the cache
  --rebuild-cache   Parse every session and replace the cache
  -h, --help        Show this help
`;
}

function parseArguments(arguments_) {
  const options = {
    agentDir: defaultAgentDirectory(),
    outputDir: resolve(process.cwd(), "output"),
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--no-cache" || argument === "--rebuild-cache") {
      if (argument === "--no-cache") options.noCache = true;
      else options.rebuildCache = true;
      continue;
    }
    if (argument === "--agent-dir" || argument === "--output") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${argument}`);
      }
      if (argument === "--agent-dir") options.agentDir = resolve(value);
      else options.outputDir = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.noCache && options.rebuildCache) {
    throw new Error("--no-cache and --rebuild-cache cannot be used together");
  }

  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const result = await writeUsageReport(options);
    process.stdout.write(
      `${result.upToDate ? "Up to date:" : "Wrote"} ${result.reportPath}\n` +
        `${result.toolCalls} tool calls and ${result.skillUses} skill uses across ${result.projects} projects ` +
        `from ${result.sessionFiles} session files.\n`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n\n${usage()}`);
  process.exitCode = 1;
}
