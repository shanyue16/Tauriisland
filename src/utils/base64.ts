/**
 * base64 → UTF-8 文本（用于各家歌词接口返回的 base64 歌词）。
 *
 * 之前酷狗与 QQ 音乐各写了一份，差别只在出错时扔还是吞 —— 调用方都包了 try/catch，
 * 所以统一成"失败返回空串"，行为等价且少一处 atob 调用点。
 */
export function b64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}
