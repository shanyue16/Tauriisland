import { useEffect, useRef, useState, type CSSProperties } from "react";

// 歌词文案的交叉淡入淡出容器。
//
// 为什么不用 key 直接重挂载：直接换文本会在一帧内把旧文字抽走，行宽/字宽瞬间变化 →
// 视觉上是"闪"。这里保留上一行 260ms，让旧行淡出上浮、新行淡入归位，且两层都是
// 绝对定位/固定行高，容器高度不随文字变化 → 父级布局零抖动。
const FADE_MS = 260;

export default function LyricCrossfade({
  text,
  className = "",
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [cur, setCur] = useState(text);
  const [prev, setPrev] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (text === cur) return;
    setPrev(cur);
    setCur(text);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setPrev(null);
      timer.current = null;
    }, FADE_MS);
  }, [text, cur]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  return (
    <span className={`lyric-stage ${className}`} style={style}>
      {prev !== null && prev !== cur && (
        <span className="lyric-out" aria-hidden="true">
          {prev}
        </span>
      )}
      <span key={cur} className="lyric-in">
        {cur}
      </span>
    </span>
  );
}
