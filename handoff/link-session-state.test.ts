import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLinkSessionTransfer,
  resolveLinkSessionTransfer,
  type LinkSessionEntry,
  type LinkSessionTransfer,
} from "./link-session-state.ts";

interface AppendedEntry {
  customType: string;
  data: unknown;
}

class RecordingSessionManager {
  readonly entries: AppendedEntry[] = [];

  appendCustomEntry(customType: string, data?: unknown): string {
    this.entries.push({ customType, data });
    return `entry-${this.entries.length}`;
  }
}

function customEntry(index: number, customType: string, data: unknown): LinkSessionEntry {
  return {
    type: "custom",
    id: `custom-${index}`,
    parentId: index === 1 ? null : `custom-${index - 1}`,
    timestamp: `2026-07-23T00:00:0${index}.000Z`,
    customType,
    data,
  } as LinkSessionEntry;
}

function seededEntries(entries: LinkSessionEntry[]): AppendedEntry[] {
  const manager = new RecordingSessionManager();
  const transfer = resolveLinkSessionTransfer(entries);
  applyLinkSessionTransfer(manager, transfer);
  return manager.entries;
}

test("resolves persisted state without access to pi-link flags", () => {
  const entries = [
    customEntry(1, "link-name", { name: "  review   worker  " }),
    customEntry(2, "link-active", { active: true }),
  ];
  let transfer: LinkSessionTransfer | undefined;

  assert.doesNotThrow(() => {
    transfer = (resolveLinkSessionTransfer as (entries: LinkSessionEntry[]) => LinkSessionTransfer | undefined)(entries);
  });
  assert.deepEqual(transfer, { name: "review worker", active: true });
});

test("seeds the saved name and active connection intent", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "link-name", { name: "worker" }),
      customEntry(2, "link-active", { active: true }),
    ]),
    [
      { customType: "link-name", data: { name: "worker" } },
      { customType: "link-active", data: { active: true } },
    ],
  );
});

test("preserves an explicit disconnect", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "link-name", { name: "worker" }),
      customEntry(2, "link-active", { active: false }),
    ]),
    [
      { customType: "link-name", data: { name: "worker" } },
      { customType: "link-active", data: { active: false } },
    ],
  );
});

test("a saved name alone does not imply connection", () => {
  assert.deepEqual(seededEntries([customEntry(1, "link-name", { name: "worker" })]), [
    { customType: "link-name", data: { name: "worker" } },
  ]);
});

test("uses the latest link name entry", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "link-name", { name: "worker" }),
      customEntry(2, "link-name", { name: "worker-2" }),
      customEntry(3, "link-active", { active: true }),
    ]),
    [
      { customType: "link-name", data: { name: "worker-2" } },
      { customType: "link-active", data: { active: true } },
    ],
  );
});

test("uses the latest link-active entry", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "link-name", { name: "worker" }),
      customEntry(2, "link-active", { active: false }),
      customEntry(3, "link-active", { active: true }),
    ]),
    [
      { customType: "link-name", data: { name: "worker" } },
      { customType: "link-active", data: { active: true } },
    ],
  );
});

test("a malformed latest link-active entry masks older history without throwing", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "link-name", { name: "worker" }),
      customEntry(2, "link-active", { active: true }),
      customEntry(3, "link-active", { active: null }),
    ]),
    [{ customType: "link-name", data: { name: "worker" } }],
  );
});

test("ignores unrelated custom entries", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "other-extension", { name: "worker", active: true }),
      { type: "message", id: "message-1", data: { name: "worker" } } as LinkSessionEntry,
    ]),
    [],
  );
});

test("a malformed latest name masks older name history", () => {
  assert.deepEqual(
    seededEntries([
      customEntry(1, "link-name", { name: "worker" }),
      customEntry(2, "link-name", { name: "   " }),
      customEntry(3, "link-active", { active: true }),
    ]),
    [{ customType: "link-active", data: { active: true } }],
  );
});

test("leaves a session without pi-link state unchanged", () => {
  assert.deepEqual(seededEntries([]), []);
});
