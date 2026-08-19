import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryStore, sanitizeParams } from "../lib/history.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-history-contract-"));
try {
  const store = new HistoryStore(dir, { enabled: true, captureScreenshots: false, maxEntries: 2, retentionDays: 30 });
  const sanitized = sanitizeParams("type_text", { text: "secret", nested: { value: "hidden" } });
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|hidden/);
  assert.equal(sanitized.textLength, 6);
  assert.equal(sanitized.nested.valueLength, 6);

  const first = store.append({ id: 999, ts: 1, sessionId: "one", action: "first", summary: "first", screenshots: [] });
  assert.equal(first.id, 1, "caller cannot override authoritative id");
  assert.ok(first.ts > 1, "caller cannot override authoritative timestamp");
  store.append({ sessionId: "one", action: "second", summary: "second", screenshots: [] });
  store.append({ sessionId: "one", action: "third", summary: "third", screenshots: [] });
  assert.equal(store.list({ limit: 10 }).length, 2, "maxEntries prunes old history");

  fs.appendFileSync(path.join(dir, "history.jsonl"), "{torn\n");
  const recovered = new HistoryStore(dir, { enabled: true, captureScreenshots: false, maxEntries: 10, retentionDays: 30 });
  const entries = recovered.list({ limit: 10 });
  assert.equal(entries.length, 2, "torn JSONL tail is repaired");
  assert.ok(recovered.stats().nextId > entries.at(-1).id, "recovered id remains monotonic");
  assert.equal(Object.hasOwn(recovered.stats(), "dir"), false, "public stats do not expose filesystem paths");
  console.log("PASS history store contract: privacy, authoritative ids, retention, and torn-tail recovery");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
