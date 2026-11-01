import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Record = { path: string; existed: boolean; text: string | null };

const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const root = () => join(app.getPath("userData"), "checkpoints");

const turnDir = (sessionId: string, turnId: string) => join(root(), safe(sessionId), safe(turnId));

/** 记录某轮里某个文件的“改前”内容；同一轮同一路径只记第一次。 */
export function saveCheckpoint(sessionId: string, turnId: string, path: string, oldText: string | null): void {
  if (!sessionId || !turnId || !path) return;
  try {
    const dir = turnDir(sessionId, turnId);
    mkdirSync(dir, { recursive: true });
    const key = createHash("sha1").update(path.toLowerCase()).digest("hex");
    const file = join(dir, `${key}.json`);
    if (existsSync(file)) return;
    const record: Record = { path, existed: oldText !== null, text: oldText };
    writeFileSync(file, JSON.stringify(record), "utf8");
  } catch {
    /* 快照失败不影响对话 */
  }
}

/** 回滚某一轮：有备份的写回，原来不存在的删掉。 */
export function restoreCheckpoint(
  sessionId: string,
  turnId: string,
): { restored: number; removed: number; failed: number } {
  const dir = turnDir(sessionId, turnId);
  const result = { restored: 0, removed: 0, failed: 0 };
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, entry), "utf8")) as Record;
      if (record.existed) {
        writeFileSync(record.path, record.text ?? "", "utf8");
        result.restored++;
      } else {
        rmSync(record.path, { force: true });
        result.removed++;
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** 回退到某轮之前：从最新一轮往前逐轮回滚，确保多个轮次改同一文件时结果正确。 */
export function restoreCheckpointRange(
  sessionId: string,
  turnIds: string[],
): { restored: number; removed: number; failed: number } {
  const total = { restored: 0, removed: 0, failed: 0 };
  for (const turnId of [...turnIds].reverse()) {
    const r = restoreCheckpoint(sessionId, turnId);
    total.restored += r.restored;
    total.removed += r.removed;
    total.failed += r.failed;
    try {
      rmSync(turnDir(sessionId, turnId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return total;
}

/** 会话删除时清掉它的快照。 */
export function dropCheckpoints(sessionId: string): void {
  try {
    rmSync(join(root(), safe(sessionId)), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

