import type { CSSProperties } from "react";

/**
 * 设置页两种重复出现的行内样式。
 *
 * 之前 NotificationSettings / WhitelistSettings 各抄了一份一模一样的 `btnStyle`
 * （其中一份还套了 `useMemo(() => ({...}), [])` —— 常量对象 memo 没有意义），
 * 输入框的 `--input-bg` 三件套在两个文件里重复了 8 次。
 *
 * 只管视觉，不含 padding：纵向密度是各分区自己的事（输入框有 px-3/py-1.5 与 px-2/py-1 两种）。
 */

/** 次要按钮：7px 12px、8 号圆角、surface-2 底 */
export const BTN_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid var(--island-border)",
  background: "var(--surface-2)",
  color: "var(--island-text)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** 文本/密码输入框的配色与边框（宽高由调用方给） */
export const FIELD_STYLE: CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--island-border)",
  color: "var(--island-text)",
};
