import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * 三个本地源（`nowplaying.ts` / `folia.ts` / `stage.ts`）共用的取数原语。
 *
 * 之前各自抄了一份 `num` / `str` / `getJson` / `isLengthCompatible`：
 * - `num` / `str` 三份完全一样；
 * - 取数那段都是「AbortController + 真超时 + tauriFetch + resp.ok」，
 *   只有**错误文案**与 401 的处置不同；
 * - `isLengthCompatible` 在 nowplaying 与 folia 里逐字相同。
 *
 * 所以这里只抽"请求 + 解析"这一段，**文案仍由各模块自己拼**（设置页会把这行字直接显示给用户，
 * 改动等于改 UI）。超时统一用 `AbortController.abort()`，不是 `Promise.race` 那种假超时。
 */

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 歌词时长是否与我们的曲长相容 —— 「曲名对不上」时的第二个身份依据。
 *
 * 判据刻意不对称：
 * - **不能超**：歌词末行明显晚于曲终（+10s 以上）→ 这段歌词属于更长的录音，丢弃；
 * - **可以早**：尾奏/间奏常常没有人声，歌词比曲子短一截是常态，下限放得很松。
 * - 两侧缺任一个就不走这条路径（宁可不采用，也不冒险）。
 */
export function lengthCompatible(
  gotSpanMs: number | undefined,
  wantMs: number | undefined
): boolean {
  if (!gotSpanMs || !wantMs) return false;
  return gotSpanMs <= wantMs + 10_000 && gotSpanMs >= wantMs * 0.5;
}

/** 取数结果：把「网络层发生了什么」原样交给调用方，文案由调用方决定。 */
export type JsonOutcome =
  | { kind: "ok"; json: unknown }
  /** `bodyText` 是失败响应的原文（读不到时为 null）——只有控制接口会用到它 */
  | { kind: "http"; status: number; bodyText: string | null }
  | { kind: "throw"; timedOut: boolean; name: string; message: string };

export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  /** 原样发送的请求体（POST 用） */
  body?: string;
};

/**
 * 带真超时的 GET/POST（JSON）。
 *
 * 本机回环服务不该慢：没跑起来时 ECONNREFUSED 是毫秒级，界面不该为它等待。
 * 任何异常（abort / 半截 JSON / 连接被拒 / 被 ACL 挡）都会归到 `throw`，**永不抛**。
 */
export async function requestJson(
  url: string,
  timeoutMs: number,
  options: RequestOptions = {}
): Promise<JsonOutcome> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await tauriFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      // 失败时把原文读回来（控制接口会在里面放 code/error）；读不到也不影响结果
      const bodyText = await resp.text().catch(() => null);
      return { kind: "http", status: resp.status, bodyText };
    }
    return { kind: "ok", json: (await resp.json()) as unknown };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    const name = err?.name ?? "";
    return {
      kind: "throw",
      timedOut: name === "AbortError",
      name,
      message: err?.message ?? String(e),
    };
  } finally {
    window.clearTimeout(timer);
  }
}
