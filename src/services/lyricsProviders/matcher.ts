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

/**
 * 判定「这个候选就是我们要找的那首歌」—— 供外部源做**是否采用**的门禁。
 *
 * 与 [`pickBest`] 的取向相反：pickBest 是「从一堆搜索结果里挑最像的」，**永远不拒绝**；
 * 这里**必须能拒绝**。因为本机第三方程序报的是「它自己在放什么」，
 * 与岛上 SMTC 的曲目对不上时，用了它就会把**别人的歌词**显示在岛上。
 *
 * 判据：曲名必须高度吻合（≥0.9，涵盖「只差 (Live)/(伴奏) 这类后缀」）**且**总分 ≥70。
 * 光看总分不够 —— 时长(15) + 歌手(25) 两项就能堆到 40，
 * 同一个歌手的另一首歌可能靠这两项蒙混过关；曲名才是真正的判别项。
 *
 * 实测：Folia 的标题卡 `"ひとり旅 - 瀬名航/鎖那 (さな)"` 对 SMTC 的
 * `ひとり旅 / 瀬名航` 得分 ≈92（曲名满分），而普通歌词行（无 " - "，解析不出歌手）
 * 只有 ≈20 —— 判据能把两者干净地分开。
 */
export function isSameTrack(c: Candidate, want: WantInfo): boolean {
  return titleScore(want.title, c.title) >= 0.9 && scoreCandidate(c, want) >= 70;
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
