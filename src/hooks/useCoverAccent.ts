import { useEffect, useState } from "react";
import { extractCoverColor, lighten } from "../utils/coverColor";

/**
 * 封面主色 —— **三态唯一取色来源**：失焦态 / 悬浮态 / 展开态的封面光晕，
 * 以及展开态的丝线、播放键、进度条，全部取这一个颜色，保证"光晕与进度条同源"。
 *
 * - 提取逻辑在 utils/coverColor：按 URL 缓存（含 null）+ in-flight 去重，重复调用不重复计算。
 * - 无封面、或远程封面被 CORS 拒绝 → 回退默认粉 #f472b6 / 蓝 #60a5fa
 *   （与展开态原本的回退值一致，浅色主题下也不至于消失）。
 *
 * 注意：返回值是每次渲染新建的对象，**不要把它塞进依赖数组**。
 */
export function useCoverAccent(coverUrl: string | null | undefined): {
  /** 主色（光晕、进度条已播段起始色、播放键描边） */
  accent: string;
  /** 次色（进度条/丝线渐变末端，由主色提亮而来） */
  accent2: string;
} {
  const [color, setColor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!coverUrl) {
      setColor(null);
      return;
    }
    void extractCoverColor(coverUrl).then((c) => {
      if (!cancelled) setColor(c);
    });
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);

  return {
    accent: color ?? "#f472b6",
    accent2: color ? lighten(color) : "#60a5fa",
  };
}
