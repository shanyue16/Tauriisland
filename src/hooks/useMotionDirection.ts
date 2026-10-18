import { useRef } from "react";

/**
 * 一个单调游标（状态层级、页码、设置分区）**最近一次变化的方向**。
 *
 * - `1` 变大（minimal → medium → expanded → maximal，或页码 +1）
 * - `-1` 变小
 * - `0` 还没变过（首帧）
 *
 * 只用于"让内容跟着形态挪一点"这类纯视觉暗示。方向在**渲染期**就地更新（与 React 的
 * derived-state 用法一致），因此 `visible ? 0 : -dir * 4` 这类样式在变化的那一帧就是新方向，
 * 不会出现"旧内容先按老方向弹一下"。
 */
export function useMotionDirection(value: number): -1 | 0 | 1 {
  const lastRef = useRef(value);
  const dirRef = useRef<-1 | 0 | 1>(0);

  if (lastRef.current !== value) {
    dirRef.current = value > lastRef.current ? 1 : -1;
    lastRef.current = value;
  }

  return dirRef.current;
}
