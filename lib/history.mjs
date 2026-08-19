// Persistent, local-only Computer Use history store.
//
// Appends one JSON object per line to <dir>/history.jsonl and stores optional
// screenshots under <dir>/shots/. History is best-effort: storage failures are
// reported in stats but never allowed to break Computer Use itself.
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function sanitizeValue(value, key, depth = 0) {
  if (key === "text" || key === "value") return { [`${key}Length`]: value == null ? 0 : String(value).length };
  if (depth >= 4) return "[max-depth]";
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…(${value.length} chars)` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, "", depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const sanitized = sanitizeValue(nestedValue, nestedKey, depth + 1);
      if ((nestedKey === "text" || nestedKey === "value") && sanitized && typeof sanitized === "object") Object.assign(out, sanitized);
      else out[nestedKey] = sanitized;
    }
    return out;
  }
  return value;
}

/** Reduce action params to a compact, privacy-safe audit record. */
export function sanitizeParams(_method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "window") {
      out.window = value && typeof value === "object" ? { app: value.app, id: value.id } : value;
      continue;
    }
    const sanitized = sanitizeValue(value, key);
    if ((key === "text" || key === "value") && sanitized && typeof sanitized === "object") Object.assign(out, sanitized);
    else out[key] = sanitized;
  }
  return out;
}

function decodeDataUrl(url) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(String(url || ""));
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], "base64") };
}

function encodeDataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export class HistoryStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.shotsDir = path.join(dir, "shots");
    this.indexPath = path.join(dir, "history.jsonl");
    this.enabled = false;
    this.captureScreenshots = true;
    this.maxShots = 1;
    this.maxEntries = 0;
    this.retentionDays = 0;
    this.count = 0;
    this.firstTs = null;
    this.nextId = 1;
    this.lastError = null;
    this.reconfigure(options);
  }

  reconfigure(options = {}) {
    const requestedEnabled = options.enabled !== false;
    this.captureScreenshots = options.captureScreenshots !== false;
    this.maxShots = Number(options.maxShots) > 0 ? Number(options.maxShots) : 1;
    this.maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 0;
    this.retentionDays = Number(options.retentionDays) > 0 ? Number(options.retentionDays) : 0;
    this.enabled = requestedEnabled;
    this.lastError = null;
    this.count = 0;
    this.firstTs = null;
    this.nextId = 1;
    if (!requestedEnabled) return;
    try {
      fs.mkdirSync(this.shotsDir, { recursive: true });
      this._recoverBackup();
      this._loadCursor();
      this._maybePrune(true);
    } catch (error) {
      this.enabled = false;
      this.lastError = error.message;
    }
  }

  _readValidRecords() {
    let text;
    try { text = fs.readFileSync(this.indexPath, "utf8"); } catch (error) {
      if (error && error.code === "ENOENT") return { records: [], malformed: false };
      throw error;
    }
    const records = [];
    let malformed = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== "object" || !Number.isFinite(Number(record.id))) malformed = true;
        else records.push(record);
      } catch {
        malformed = true;
      }
    }
    return { records, malformed };
  }

  _rewriteRecords(records) {
    fs.mkdirSync(this.dir, { recursive: true });
    const backup = `${this.indexPath}.bak`;
    const payload = records.length ? records.map((entry) => JSON.stringify(entry)).join("\n") + "\n" : "";
    try { fs.unlinkSync(backup); } catch {}
    const hadCurrent = fs.existsSync(this.indexPath);
    if (hadCurrent) fs.copyFileSync(this.indexPath, backup);
    try {
      fs.writeFileSync(this.indexPath, payload);
    } catch (error) {
      if (hadCurrent && fs.existsSync(backup)) fs.copyFileSync(backup, this.indexPath);
      throw error;
    }
    try { fs.unlinkSync(backup); } catch {}
  }

  _recoverBackup() {
    const backup = `${this.indexPath}.bak`;
    if (!fs.existsSync(backup)) return;
    let currentValid = false;
    try {
      const text = fs.readFileSync(this.indexPath, "utf8");
      currentValid = text.split("\n").filter(Boolean).every((line) => {
        try { return Boolean(JSON.parse(line)); } catch { return false; }
      });
    } catch {}
    if (!currentValid) fs.copyFileSync(backup, this.indexPath);
    try { fs.unlinkSync(backup); } catch {}
  }

  _setCursor(records) {
    this.count = records.length;
    this.firstTs = records.length ? (Number(records[0].ts) || null) : null;
    let maxId = 0;
    for (const entry of records) maxId = Math.max(maxId, Number(entry.id) || 0);
    this.nextId = maxId + 1;
  }

  _loadCursor() {
    const { records, malformed } = this._readValidRecords();
    if (malformed) this._rewriteRecords(records);
    this._setCursor(records);
  }

  _saveShot(id, index, shot) {
    const decoded = decodeDataUrl(shot && shot.url);
    if (!decoded) return null;
    const ext = MIME_EXT[decoded.mime] || "jpg";
    const filename = `${id}_${index}.${ext}`;
    fs.writeFileSync(path.join(this.shotsDir, filename), decoded.data);
    return { path: `shots/${filename}`, mime: decoded.mime, width: shot.width, height: shot.height };
  }

  _withShots(entry) {
    if (!Array.isArray(entry.screenshots)) return entry;
    const screenshots = entry.screenshots.map((shot) => {
      try {
        const buffer = fs.readFileSync(path.join(this.dir, shot.path));
        return { ...shot, url: encodeDataUrl(shot.mime || "image/jpeg", buffer) };
      } catch {
        return { ...shot, url: null };
      }
    });
    return { ...entry, screenshots };
  }

  append(entry) {
    if (!this.enabled) return null;
    const id = this.nextId;
    const ts = Date.now();
    const record = { ...entry, id, ts };
    const writtenShots = [];
    try {
      if (this.captureScreenshots && Array.isArray(record.screenshots)) {
        const refs = [];
        for (const shot of record.screenshots.slice(0, this.maxShots)) {
          const ref = this._saveShot(id, refs.length, shot);
          if (ref) {
            refs.push(ref);
            writtenShots.push(path.join(this.dir, ref.path));
          }
        }
        record.screenshots = refs;
      } else {
        delete record.screenshots;
      }
      fs.appendFileSync(this.indexPath, JSON.stringify(record) + "\n");
    } catch (error) {
      for (const filename of writtenShots) {
        try { fs.unlinkSync(filename); } catch {}
      }
      this.lastError = error.message;
      throw error;
    }
    // The JSONL append is the commit point. Later retention failure must not
    // roll back the authoritative id or delete screenshots now referenced by it.
    this.nextId = id + 1;
    this.count += 1;
    if (this.firstTs == null) this.firstTs = ts;
    this.lastError = null;
    try { this._maybePrune(false); } catch (error) { this.lastError = error.message; }
    return record;
  }

  _maybePrune(force = false) {
    if (!this.enabled) return;
    const cutoff = this.retentionDays > 0 ? Date.now() - this.retentionDays * DAY_MS : 0;
    const overLimit = this.maxEntries > 0 && this.count > this.maxEntries;
    const overRetention = cutoff > 0 && this.firstTs != null && this.firstTs < cutoff;
    if (!force && !overLimit && !overRetention) return;
    const { records, malformed } = this._readValidRecords();
    let keep = records;
    if (cutoff > 0) keep = keep.filter((entry) => (Number(entry.ts) || 0) >= cutoff);
    if (this.maxEntries > 0 && keep.length > this.maxEntries) keep = keep.slice(keep.length - this.maxEntries);
    if (malformed || keep.length !== records.length) this._rewriteRecords(keep);
    this._setCursor(keep);
    if (malformed || keep.length !== records.length) {
      const keepIds = new Set(keep.map((entry) => String(entry.id)));
      this._cleanOrphanShots(keepIds);
    }
  }

  _cleanOrphanShots(keepIds) {
    try {
      for (const filename of fs.readdirSync(this.shotsDir)) {
        if (!keepIds.has(filename.split("_")[0])) fs.unlinkSync(path.join(this.shotsDir, filename));
      }
    } catch {}
  }

  list(options = {}) {
    if (!this.enabled) return [];
    this._maybePrune(true);
    const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), 1000) : 100;
    const since = Number(options.since) || 0;
    const includeScreenshots = options.includeScreenshots === true;
    const { records } = this._readValidRecords();
    const entries = [];
    for (let index = records.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const entry = records[index];
      if ((Number(entry.id) || 0) <= since) continue;
      if (options.sessionId && entry.sessionId !== options.sessionId) continue;
      if (options.app && entry.app !== options.app) continue;
      entries.push(includeScreenshots ? this._withShots(entry) : entry);
    }
    return entries.reverse();
  }

  get(id, options = {}) {
    if (!this.enabled) return null;
    this._maybePrune(true);
    const { records } = this._readValidRecords();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (String(records[index].id) === String(id)) return options.includeScreenshots === true ? this._withShots(records[index]) : records[index];
    }
    return null;
  }

  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.count = 0;
    this.firstTs = null;
    this.nextId = 1;
    this.lastError = null;
    if (this.enabled) fs.mkdirSync(this.shotsDir, { recursive: true });
  }

  stats() {
    return {
      enabled: this.enabled,
      count: this.count,
      firstTs: this.firstTs,
      nextId: this.nextId,
      captureScreenshots: this.captureScreenshots,
      maxEntries: this.maxEntries,
      retentionDays: this.retentionDays,
      lastError: this.lastError,
    };
  }
}
