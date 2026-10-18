import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

export default function TimePage() {
  const { t } = useI18n();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hh = now.getHours().toString().padStart(2, "0");
  const mm = now.getMinutes().toString().padStart(2, "0");
  const ss = now.getSeconds().toString().padStart(2, "0");

  const weekday = t(`time.weekday.${now.getDay()}`);
  const dateStr = t("time.date", {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  });

  return (
    // 内边距口径（悬浮态三个页统一）：垂直 py-1 = 线框稿 mini 规格的 4px；
    // 水平左侧 18px（原 14px，用户要求悬浮态内容别贴着窗口边缘），右侧 pr-[26px] 是因为有
    // 多留的 12px 是指示器专用通道，否则右对齐内容（时间/温度/时长）会紧贴上去。
    // 原为 pt-1（只有上 4px、下 0）→ 内容被推低 2px，且与天气/音乐页的垂直内边距不一致，
    // 切页时会有 2px 跳动；现统一为对称 py-1（居中，无偏移、无跳动）。
    <div className="w-full h-full flex flex-col items-center justify-center py-1 px-[18px] pr-[26px]"
         style={{ color: "var(--island-text)" }}>
      <div className="font-semibold tabular-nums leading-tight">
        <span className="text-[22px]">{hh}</span>
        <span className="text-[22px] opacity-70">:</span>
        <span className="text-[22px]">{mm}</span>
        <span className="text-[13px] opacity-50" style={{ marginLeft: 11 }}>{ss}</span>
      </div>
      <div className="text-[10px] opacity-60 mt-0.5">
        {dateStr} · {weekday}
      </div>
    </div>
  );
}
