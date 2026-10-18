import { useEffect, type RefObject } from "react";

/**
 * 让"页内列表滚动"与"岛根节点滚轮翻页"不互相抢。
 *
 * 岛根节点收到 wheel 会 preventDefault 并翻页；列表里如果想垂直滚动，
 * 就必须在**还能滚**的时候把事件 stopPropagation 掉，滚到端头才让给翻页。
 *
 * 之前通知页与日程页各写了一遍同样的 useEffect（连注释都一样），
 * 唯一的差别是依赖项列表 —— 所以抽成 hook，把"什么时候重新绑定"交给调用方。
 *
 * @param ref  滚动容器
 * @param deps 重新绑定的依赖（通常是"内容长度"，换页/新增条目后高度会变）
 */
export function useInnerScroll(
  ref: RefObject<HTMLElement | null>,
  deps: unknown[] = []
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const dir = e.deltaY > 0 ? 1 : -1;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const canScroll = !(dir > 0 ? atBottom : atTop);
      // 还能滚 → 吃掉事件（根节点不再翻页）；已到端 → 放行给翻页，但也不 stopPropagation，
      // 这样"边界抖动"不会把一次手势拆成两页。
      if (canScroll) e.stopPropagation();
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
