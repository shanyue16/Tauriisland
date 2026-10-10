/**
 * 歌词候选打分 — 从搜索结果里挑「就是这一首」。
 *
 * 移植 eIsland matcher 的核心思路（曲名权重最高 → 歌手 → 时长），但**不改写成会拒绝结果的
 * 严格匹配**：eIsland 的 matcher 有 minScore 阈值，低于阈值返回 null（宁可没有也不给错）；
 * 本项目历史上「有时拿不到歌词」正是空手而归造成的，所以这里**永远返回得分最高的那条**
 * （全部同分时保持搜索接口的原始顺序＝eIsland 对 netease/kugou 的 songs[0] 行为）。
 */

import type { Candidate, WantInfo } from "./types";

/** 归一化：抹掉大小写、空白与常见中英标点，让「起风了 (Live)」能和「起风了」对齐 */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[\s\-_·・'"“”‘’,，.。!！?？:：;；()（）[\]【】<>《》/\\|~+&]+/g, "");
}

/** 去掉括号后缀（(Live)/(Remastered)/【】…），用于「主标题」比较 */
function baseTitle(s: string): string {
  return norm((s || "").replace(/[(（[【][^)）\]】]*[)）\]】]/g, ""));
}

function titleScore(want: string, got: string): number {
  const w = norm(want);
  const g = norm(got);
  if (!w || !g) return 0;
  if (w === g) return 1;
  // 主标题一致（差在 (Live)/(伴奏) 这类后缀）→ 高分但不满分
  if (baseTitle(want) === baseTitle(got)) return 0.9;
  if (g.includes(w) || w.includes(g)) return 0.7;
  if (baseTitle(got) && (baseTitle(got).includes(baseTitle(want)) || baseTitle(want).includes(baseTitle(got)))) {
    return 0.6;
  }
  return 0;
}

function artistScore(want: string, got: string[]): number {
  const w = norm(want);
  if (!w) return 0.5; // 歌手未知：不因这一项拉开差距
  let best = 0;
  for (const a of got) {
    const g = norm(a);
    if (!g) continue;
    if (g === w) return 1;
    if (g.includes(w) || w.includes(g)) best = Math.max(best, 0.8);
  }
  return best;
}

function durationScore(wantMs: number | undefined, gotMs: number | undefined): number {
  if (!wantMs || !gotMs) return 0.5; // 缺信息：中性分，不影响排序
  const diff = Math.abs(wantMs - gotMs) / 1000;
  if (diff <= 2) return 1;
  if (diff <= 6) return 0.5;
  return 0;
}

/** 0~100 分：曲名 60 / 歌手 25 / 时长 15 */
export function scoreCandidate(c: Candidate, want: WantInfo): number {
  return (
    titleScore(want.title, c.title) * 60 +
    artistScore(want.artist, c.artists) * 25 +
    durationScore(want.durationMs, c.durationMs) * 15
  );
}

/** 取最高分候选；空列表返回 null（同分时保持接口原顺序） */
export function pickBest(list: Candidate[], want: WantInfo): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = -1;
  for (const c of list) {
    const s = scoreCandidate(c, want);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}
