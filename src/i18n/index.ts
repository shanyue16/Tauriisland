import { useSettings } from "../stores/settings";
import { en } from "./en";
import { zhCN } from "./zh-CN";
import type { Dict, LangCode, Language, Params } from "./types";

/**
 * 自研轻量 i18n（零新依赖）。
 *
 * - 字典：`zh-CN.ts`（权威中文）+ `en.ts`（英文）。加语言 = 新增字典文件 + 在 DICTS 注册一行。
 * - 语言设置：`settings.language` = "auto" | "zh-CN" | "en"，默认 "auto"。
 *   "auto" 跟随 `navigator.language`：zh → 中文、en → 英文，其它/无法探测回退中文。
 * - 切换：`setLanguage()` 写 settings store，复用其 200ms 去抖落盘；store 订阅同步当前语言。
 * - React 组件请用 `useI18n()`；非 React 代码可用 `t()` / `subscribe()` / `getLanguage()`。
 */

const DICTS: Record<Language, Dict> = {
  "zh-CN": zhCN,
  en,
};
const FALLBACK: Language = "zh-CN";

/** 系统语言只探测一次（navigator.language 在运行期基本不变） */
let cachedSystem: Language | null = null;

export function detectSystemLanguage(): Language {
  if (cachedSystem) return cachedSystem;
  const raw = typeof navigator !== "undefined" ? navigator.language : "";
  const lower = raw.toLowerCase();
  cachedSystem = lower.startsWith("zh")
    ? "zh-CN"
    : lower.startsWith("en")
      ? "en"
      : FALLBACK;
  return cachedSystem;
}

/** 把设置值解析成实际生效语言 */
export function resolveLanguage(setting: LangCode): Language {
  if (setting === "zh-CN" || setting === "en") return setting;
  return detectSystemLanguage();
}

function translate(key: string, params: Params | undefined, lang: Language): string {
  let text = DICTS[lang][key] ?? DICTS[FALLBACK][key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

let currentLang: Language = resolveLanguage(useSettings.getState().settings.language);

const listeners = new Set<() => void>();

// 订阅 settings store：语言设置变化时更新当前语言并通知外部订阅者。
// 组件内请用 useI18n()（zustand selector 已保证重渲染）。
useSettings.subscribe((state, prev) => {
  if (state.settings.language !== prev.settings.language) {
    currentLang = resolveLanguage(state.settings.language);
    for (const l of listeners) l();
  }
});

/** 订阅语言变化；返回取消订阅函数 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前生效语言（模块级快照） */
export function getLanguage(): Language {
  return currentLang;
}

/** 切换语言并持久化（复用 settings store 落盘机制） */
export function setLanguage(lang: LangCode): void {
  useSettings.getState().updateSettings({ language: lang });
}

/** 非 React 调用点使用的 t()：读当前生效语言 */
export function t(key: string, params?: Params): string {
  return translate(key, params, currentLang);
}

/** React Hook：返回当前语言、设置值、绑定当前语言的 t() 与 setLanguage() */
export function useI18n() {
  const setting = useSettings((s) => s.settings.language);
  const lang = resolveLanguage(setting);
  return {
    lang,
    setting,
    t: (key: string, params?: Params) => translate(key, params, lang),
    setLanguage,
  };
}
