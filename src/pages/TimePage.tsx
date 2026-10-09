import { useEffect, useState } from "react";

export default function TimePage() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hh = now.getHours().toString().padStart(2, "0");
  const mm = now.getMinutes().toString().padStart(2, "0");
  const ss = now.getSeconds().toString().padStart(2, "0");

  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  return (
    // pr-[26px] 而不是对称的 14px：悬浮态右侧有一条**竖排页码指示器**（right:8），
    // 右对齐内容（时间/温度）会紧贴到它旁边。多留的 12px 是给指示器的专用通道。
    <div className="w-full h-full flex flex-col items-center justify-center pt-1 px-[14px] pr-[26px]"
         style={{ color: "var(--island-text)" }}>
      <div className="font-semibold tabular-nums leading-tight">
        <span className="text-[22px]">{hh}</span>
        <span className="text-[22px] opacity-70">:</span>
        <span className="text-[22px]">{mm}</span>
        <span className="text-[13px] opacity-50" style={{ marginLeft: 11 }}>{ss}</span>
      </div>
      <div className="text-[10px] opacity-60 mt-0.5">
        {dateStr} · {weekdays[now.getDay()]}
      </div>
    </div>
  );
}
