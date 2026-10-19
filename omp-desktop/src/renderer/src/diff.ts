export type DiffLine = { type: "same" | "add" | "del"; text: string; no: number };

/**
 * 行级 LCS diff —— 不引第三方依赖，几百行内足够快。
 * 超过阈值的超大文件退化成"全删 + 全增"，避免 O(n*m) 卡死 UI。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = (oldText ?? "").split(/\r?\n/);
  const b = (newText ?? "").split(/\r?\n/);

  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text, i) => ({ type: "del" as const, text, no: i + 1 })),
      ...b.map((text, i) => ({ type: "add" as const, text, no: i + 1 })),
    ];
  }

  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i], no: i + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i], no: i + 1 });
      i++;
    } else {
      out.push({ type: "add", text: b[j], no: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i], no: ++i });
  while (j < m) out.push({ type: "add", text: b[j], no: ++j });
  return out;
}

/** 只保留变化行上下各 2 行，折叠大段未变内容。 */
export function compactDiff(lines: DiffLine[], context = 2): (DiffLine | { type: "gap"; text: string; no: number })[] {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.type === "same") return;
    for (let k = idx - context; k <= idx + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });
  if (keep.size === 0) return lines;
  const out: (DiffLine | { type: "gap"; text: string; no: number })[] = [];
  let gap = 0;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      if (gap > 0) {
        out.push({ type: "gap", text: `⋯ ${gap} 行未变`, no: idx });
        gap = 0;
      }
      out.push(l);
    } else {
      gap++;
    }
  });
  if (gap > 0) out.push({ type: "gap", text: `⋯ ${gap} 行未变`, no: lines.length });
  return out;
}
