/**
 * portal 浮层的主题变量搬运。
 *
 * 背景：岛的配色不是主题类名，而是一组 CSS 变量以 **inline style 挂在岛根节点**上
 * （见 Island.tsx 的 rootStyle —— 深色/亮色两套值在 :985 与 :1015 附近）。
 * 因此 `var(--popover-bg)` 在岛内能解析；而 portal 到 `document.body` 的浮层
 * （Dropdown 展开框、Hint 悬浮提示）**拿不到这层继承**，会退回 index.css 里 `:root`
 * 的深色默认值 —— 表现就是「亮色主题下浮层是黑底」。
 *
 * 做法：浮层打开时从触发元素上把变量**解析成具体值**，再写到浮层自己身上。
 * 于是浮层内部的 `var(...)` 照旧可用，且与岛当前主题一致；不用把变量挂到 body
 * （挂 body 会污染全页面，且切换主题时要手动同步）。
 */
const TOKENS = [
  "--popover-bg",
  "--popover-shadow",
  "--island-border",
  "--island-text",
  "--island-text-muted",
  "--island-accent",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--sidebar-tab-active",
  "--input-bg",
] as const;

export type PortalThemeVars = Partial<Record<(typeof TOKENS)[number], string>>;

/**
 * 读取 `anchor` 元素上已解析的主题变量。
 * anchor 必须位于岛内部（能继承到岛根节点的变量），一般是触发器 / 被悬停的元素。
 */
export function readPortalThemeVars(anchor: Element | null): PortalThemeVars {
  if (!anchor || typeof window === "undefined") return {};
  const computed = window.getComputedStyle(anchor);
  const vars: PortalThemeVars = {};
  for (const token of TOKENS) {
    const value = computed.getPropertyValue(token).trim();
    if (value) vars[token] = value;
  }
  return vars;
}
