/**
 * 判断某个元素（含祖先链）当前是否还能朝 deltaY 方向继续滚动。
 *
 * 用途：展开态通知页是一个内部滚动列表，但**岛根节点**在收到滚轮时会 preventDefault
 * 并翻页，导致列表永远滚不动、滚一下就直接切到别的页。
 *
 * 解法是让"翻页"与"页内滚动"不互相抢：滚轮事件里如果内容还能滚，就把这次滚轮交给
 * 内容（不翻页、不 preventDefault）；只有内容已经滚到头了，才当作翻页手势。
 */
export function canScrollableAncestorScroll(
  start: Element | null,
  deltaY: number,
  root: Element | null
): boolean {
  const dir = deltaY > 0 ? 1 : -1;
  let el: Element | null = start;

  while (el && el !== root) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if (dir > 0 && !atBottom) return true;
        if (dir < 0 && !atTop) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

/** 判断滚轮目标是否落在可滚动区域内（不含"是否已滚到头"的判断） */
export function isInsideScrollable(start: Element | null, root: Element | null): boolean {
  let el: Element | null = start;
  while (el && el !== root) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return true;
    }
    el = el.parentElement;
  }
  return false;
}

// ⚠️ 别用 isInsideScrollable 做"落在滚动区就 return"的守卫。
// 曾经的 bug：handleWheel 里先问 canScrollableAncestorScroll（内容还能滚？），
// 再问 isInsideScrollable（在滚动区内？）→ 后者让"设置面板滚到顶后继续上滚"
// 永远被拦下，用户无法从 maximal 回展开态。
// 正确做法只有前者：内容能滚才让位，滚到边界就交给状态机。
// 该函数保留供将来的滚动区域判断使用。
