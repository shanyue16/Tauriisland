import type { CSSProperties } from "react";

/**
 * 多行文本截断（`-webkit-box` + `line-clamp`）。
 *
 * `clamp = null` 表示"不截断"（展开态）：此时必须同时把 display 换回块级，
 * 否则 -webkit-box 会把内容压扁。
 *
 * 之前通知提醒与通知列表各写了一份，字面属性完全一样，只有展开时怎么处理不同。
 */
export function lineClampStyle(clamp: number | null): CSSProperties {
  if (clamp === null) {
    return { display: "block", wordBreak: "break-word" };
  }
  return {
    display: "-webkit-box",
    WebkitLineClamp: clamp,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    wordBreak: "break-word",
  };
}
