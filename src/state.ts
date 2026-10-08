import type { KVLike } from "./env";
import type { MarketReport, UsdTehranPrice } from "./types";

/**
 * وضعیت ربات در Workers KV (binding STATE).
 *
 * خواندن خراب/نامعتبر → null (fail-closed) — هرگز مقدار جایگزین ساخته نمی‌شود.
 */

export const USD_MESSAGE_ID_KEY = "usd:message_id";
export const PAUSED_FLAG_KEY = "flag:paused";
export const LAST_USD_PRICE_KEY = "price:usd:last";
export const LAST_REPORT_KEY = "price:report:last";
export const USD_STATUS_KEY = "status:usd";
export const REPORT_STATUS_KEY = "status:report";

export interface RunStatus {
  /** ISO زمان اجرا */
  at: string;
  /** ok | paused | no-data | invalid | send-error | edit-error | provider-error */
  status: string;
  reason?: string;
}

export async function readJson<T>(kv: KVLike, key: string): Promise<T | null> {
  try {
    const raw = await kv.get(key);
    if (raw === null || raw === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    return null; // داده خراب → null (fail-closed)
  }
}

export async function writeJson(
  kv: KVLike,
  key: string,
  value: unknown,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value));
  } catch {
    // خطای KV جریان اصلی را متوقف نمی‌کند؛ وضعیت در /status قابل مشاهده است
  }
}

export async function isPaused(kv: KVLike): Promise<boolean> {
  try {
    return (await kv.get(PAUSED_FLAG_KEY)) === "1";
  } catch {
    return false; // نبود/خطای KV → انتشار ادامه دارد (fail-open عمدی برای فلگ)
  }
}

export async function setPaused(kv: KVLike, paused: boolean): Promise<void> {
  try {
    if (paused) await kv.put(PAUSED_FLAG_KEY, "1");
    else await kv.delete(PAUSED_FLAG_KEY);
  } catch {
    // ignore
  }
}

export async function getUsdMessageId(kv: KVLike): Promise<number | null> {
  try {
    const raw = await kv.get(USD_MESSAGE_ID_KEY);
    if (raw === null || !/^\d{1,32}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

export async function setUsdMessageId(
  kv: KVLike,
  messageId: number,
): Promise<void> {
  try {
    await kv.put(USD_MESSAGE_ID_KEY, String(messageId));
  } catch {
    // ignore
  }
}

export async function recordRunStatus(
  kv: KVLike,
  key: string,
  status: RunStatus,
): Promise<void> {
  await writeJson(kv, key, status);
}

export async function readLastUsdPrice(
  kv: KVLike,
): Promise<UsdTehranPrice | null> {
  return readJson<UsdTehranPrice>(kv, LAST_USD_PRICE_KEY);
}

export async function readLastReport(
  kv: KVLike,
): Promise<MarketReport | null> {
  return readJson<MarketReport>(kv, LAST_REPORT_KEY);
}
