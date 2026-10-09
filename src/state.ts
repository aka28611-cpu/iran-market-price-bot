import type { KVLike } from "./env";
import { logWarn } from "./logging";
import type { MarketReport, UsdTehranPrice } from "./types";

/**
 * وضعیت ربات در Workers KV (binding STATE).
 *
 * خواندن خراب/نامعتبر → null (fail-closed) — هرگز مقدار جایگزین ساخته نمی‌شود.
 *
 * قابلیت مشاهده (round 15): خطاهای KV قبلاً بی‌صدا بلعیده می‌شدند؛
 * حالا با logWarn دیده می‌شوند (بدون مقدار حساس — فقط نام خطا) تا
 * خرابی binding در production از طریق tail قابل تشخیص باشد.
 */

export const USD_MESSAGE_ID_KEY = "usd:message_id";
export const PAUSED_FLAG_KEY = "flag:paused";
export const LAST_USD_PRICE_KEY = "price:usd:last";
export const LAST_REPORT_KEY = "price:report:last";
export const USD_STATUS_KEY = "status:usd";
export const REPORT_STATUS_KEY = "status:report";
/** آخرین متن پیام ثابت منتشرشده — برای پرش ویرایش بدونتغییر */
export const PIN_TEXT_KEY = "pin:usd:text";
/** آخرین دادهٔ تک‌نرخ دلار (منابع تک‌نرخی) — { value, dataDate? } */
export const PIN_DATA_KEY = "price:pin:data";

// --- کلیدهای جریان دسترسی/عضویت/تیکت ---
/** فهرست JSON شناسه کاربران مجاز (آرایه عددی) */
export const ALLOW_LIST_KEY = "allow:list";
/** آرایه JSON تیکتهای باز */
export const TICKETS_OPEN_KEY = "tickets:open";
/** شمارنده عددی تیکت */
export const TICKETS_COUNT_KEY = "tickets:count";
/** پیشوند تاریخچه تیکت بسته‌شده هر کاربر: tickets:closed:<userId> */
export const TICKETS_CLOSED_PREFIX = "tickets:closed:";
/** پیشوند وضعیت مکالمهٔ جریان‌های متنی (موضوع/متن/پاسخ تیکت): conv:<userId> */
export const CONVERSATION_PREFIX = "conv:";

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
    try {
      return JSON.parse(raw) as T;
    } catch {
      logWarn("kv.read.parse-error", { key, note: "CORRUPT_VALUE" });
      return null; // داده خراب → null (fail-closed)
    }
  } catch (err) {
    logWarn("kv.read.error", {
      key,
      error: err instanceof Error ? err.name : "UNKNOWN",
    });
    return null; // fail-closed
  }
}

export async function writeJson(
  kv: KVLike,
  key: string,
  value: unknown,
  options?: { expirationTtl?: number },
): Promise<boolean> {
  try {
    await kv.put(key, JSON.stringify(value), options);
    return true;
  } catch (err) {
    // جریان اصلی متوقف نمی‌شود؛ اما دیگر بی‌صدا نیست — در tail دیده می‌شود
    logWarn("kv.write.error", {
      key,
      error: err instanceof Error ? err.name : "UNKNOWN",
    });
    return false;
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

// ---------- صرفه‌جویی در سقف نوشتن KV (free plan: ۱۰۰۰ نوشتن/روز) ----------

/**
 * کش درون‌حافظه‌ای برای جلوگیری از نوشتن مکرر وضعیتِ تغییریافته.
 * جاب هر دقیقه اجرا می‌شود؛ نوشتن وضعیت فقط وقتی انجام می‌شود که تغییر کند.
 * (Worker stateless است — در بدترین حالت هر isolate یکبار می‌نویسد.)
 */
const lastRecordedStatus = new Map<string, string>();

/** مثل recordRunStatus ولی فقط در تغییر وضعیت/دلیل می‌نویسد */
export async function recordRunStatusIfChanged(
  kv: KVLike,
  key: string,
  status: RunStatus,
): Promise<boolean> {
  const fingerprint = `${status.status}|${status.reason ?? ""}`;
  if (lastRecordedStatus.get(key) === fingerprint) return false;
  const wrote = await writeJson(kv, key, status);
  if (wrote) lastRecordedStatus.set(key, fingerprint);
  return wrote;
}

export async function readLastUsdPrice(
  kv: KVLike,
): Promise<UsdTehranPrice | null> {
  return readJson<UsdTehranPrice>(kv, LAST_USD_PRICE_KEY);
}

export interface PinnedUsdSingleRate {
  value: number;
  dataDate?: string;
}

/** آخرین دادهٔ تک‌نرخ ذخیرهشده — sanitize کامل (fail-closed) */
export async function readPinnedUsdSingleRate(
  kv: KVLike,
): Promise<PinnedUsdSingleRate | null> {
  const raw = await readJson<unknown>(kv, PIN_DATA_KEY);
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const value = record.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const dataDate =
    typeof record.dataDate === "string" ? record.dataDate : undefined;
  return { value, dataDate };
}

export async function readLastReport(
  kv: KVLike,
): Promise<MarketReport | null> {
  return readJson<MarketReport>(kv, LAST_REPORT_KEY);
}

// ---------- Allowlist کاربران مجاز ----------

/** سقف تعداد کاربران مجاز (بازه نوشتن‌های read-modify-write را مهار می‌کند) */
export const ALLOW_LIST_MAX = 1_000;

function sanitizeAllowedUsers(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (id): id is number =>
      typeof id === "number" && Number.isSafeInteger(id) && id > 0,
  );
}

export async function readAllowedUsers(kv: KVLike): Promise<number[]> {
  const parsed = await readJson<unknown>(kv, ALLOW_LIST_KEY);
  return sanitizeAllowedUsers(parsed);
}

export async function writeAllowedUsers(
  kv: KVLike,
  users: number[],
): Promise<void> {
  // مقادیر تکراری حذف میشود — یک کاربر فقط یکبار در فهرست است
  const unique = Array.from(new Set(users));
  await writeJson(kv, ALLOW_LIST_KEY, unique);
}
