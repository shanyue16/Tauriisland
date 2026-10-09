/**
 * 页面路由表 —— 所有"翻页/跨态切换"都通过这里，不要在 Island.tsx 里硬编码页索引。
 *
 * 为什么单独抽出来：以前 Island.tsx 的滚轮处理里散落着 `currentPage === 2`、
 * `setCurrentPage(2)`、`SETTINGS_PAGE_INDEX` 这类魔法数字。加一页或调一次顺序
 * 就会静默失效（例如"设置页上滚回到音乐页"就是这么来的）。集中到本表后，
 * 增删页面只需改这里。
 */

export interface PageDef<K extends string = string> {
  key: K;
  label: string;
}

/** 悬浮态（medium）的页 —— 顺序即滚轮顺序 */
export const MEDIUM_PAGES: PageDef[] = [
  { key: "time", label: "时间" },
  { key: "weather", label: "天气" },
  { key: "music", label: "音乐" },
];

/** 展开态（expanded）的页 —— 顺序即滚轮顺序 */
export const EXPANDED_PAGES: PageDef[] = [
  { key: "music", label: "音乐" },
  { key: "calendar", label: "日历" },
  { key: "notification", label: "通知" },
];

/** 音乐页在两个态里的索引不同（悬浮态在最后、展开态在最前），用 key 查而不是写死数字 */
export function indexOfPage(pages: PageDef[], key: string): number {
  const i = pages.findIndex((p) => p.key === key);
  return i < 0 ? 0 : i;
}

export const MEDIUM_MUSIC_INDEX = indexOfPage(MEDIUM_PAGES, "music");
export const EXPANDED_MUSIC_INDEX = indexOfPage(EXPANDED_PAGES, "music");
export const EXPANDED_NOTIFICATION_INDEX = indexOfPage(EXPANDED_PAGES, "notification");

/**
 * 悬浮态 currentPage 的合法取值是 0..MEDIUM_PAGES.length-1。
 * 另外保留一个"设置面板"哨兵值（maximal 态用）。
 */
export const SETTINGS_PAGE_INDEX = MEDIUM_PAGES.length;

/** 判断悬浮态当前页是否是最后一页（再下滚就该进展开态） */
export function isLastMediumPage(currentPage: number): boolean {
  return currentPage >= MEDIUM_PAGES.length - 1;
}

/** 判断展开态当前页是否是最后一页（再下滚就该进设置面板） */
export function isLastExpandedPage(expandedPage: number): boolean {
  return expandedPage >= EXPANDED_PAGES.length - 1;
}

/**
 * 从"设置面板(maximal)"往回滚时应落到哪一页。
 *
 * 规则：**回到进来之前那一页**（记住 lastExpandedPage），而不是固定回音乐页。
 * 这样"在设置页上滚"会回到用户原本看的通知页/日历页。
 */
export function expandedPageOnReturn(lastExpandedPage: number): number {
  const max = EXPANDED_PAGES.length - 1;
  return Math.min(Math.max(lastExpandedPage, 0), max);
}

/** 从展开态往回滚时应落到悬浮态的哪一页（记住进来之前那一页） */
export function mediumPageOnReturn(lastMediumPage: number): number {
  const max = MEDIUM_PAGES.length - 1;
  return Math.min(Math.max(lastMediumPage, 0), max);
}
