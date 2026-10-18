import { useState } from "react";

import { useI18n } from "../../i18n";

/**
 * 两份「名字列表」设置项共用的增删逻辑（通知黑名单 / 音乐白名单）。
 *
 * 之前两边各写一份 `exists / addEntry / removeEntry` + 一份 `hint` state，
 * 只差字段名与文案前缀。这里把状态所有权留在调用方（`list` + `commit` 传进来），
 * 组件仍然用自己那份 `useSettings()` 快照，避免多订阅一次 store。
 */

export type HintTone = "ok" | "warn";

export interface Hint {
  text: string;
  tone: HintTone;
}

export interface NameListKeys {
  empty: string;
  exists: string;
  added: string;
  removed: string;
}

export function useNameList(opts: {
  list: string[];
  commit: (next: string[]) => void;
  keys: NameListKeys;
}) {
  const { list, commit, keys } = opts;
  const { t } = useI18n();
  const [hint, setHint] = useState<Hint | null>(null);

  /** 大小写无关的重复判定（Windows 应用名大小写不敏感） */
  const exists = (name: string) => list.some((entry) => entry.toLowerCase() === name.toLowerCase());

  /** 添加一项；返回是否成功（供输入框决定是否清空） */
  const addEntry = (raw: string): boolean => {
    const name = raw.trim();
    if (!name) {
      setHint({ text: t(keys.empty), tone: "warn" });
      return false;
    }
    if (exists(name)) {
      setHint({ text: t(keys.exists, { name }), tone: "warn" });
      return false;
    }
    commit([...list, name]);
    setHint({ text: t(keys.added, { name }), tone: "ok" });
    return true;
  };

  const removeEntry = (name: string) => {
    commit(list.filter((entry) => entry !== name));
    setHint({ text: t(keys.removed, { name }), tone: "ok" });
  };

  return { hint, setHint, exists, addEntry, removeEntry };
}
