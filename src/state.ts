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

/**
 * آخرین پیام منتشرشدهٔ جاب ۵ دقیقه (فقط برای مشاهده/وریفای production؛
 * هرگز برای ویرایش خوانده نمیشود — پیامهای قبلی دست‌نخورده میمانند).
 */
export const USD_MESSAGE_ID_KEY = "usd:message_id";
export const PAUSED_FLAG_KEY = "flag:paused";
export const LAST_USD_PRICE_KEY = "price:usd:last";
export const LAST_REPORT_KEY = "price:report:last";
export const USD_STATUS_KEY = "status:usd";
export const REPORT_STATUS_KEY = "status:report";
/** آخرین متن پیام منتشرشده — برای نوشتنِ فقط-در-تغییر و مسیر بازار بسته */
export const PIN_TEXT_KEY = "pin:usd:text";
/** آخرین دادهٔ تک‌نرخ دلار (منابع تک‌نرخی) — { value, dataDate? } */
export const PIN_DATA_KEY = "price:pin:data";
/**
 * آخرین رویداد Cron پردازش‌شدهٔ جاب ۵ دقیقه (epoch ms از
 * event.scheduledTime) — ضد اجرای مجدد «همان رویداد»: تکرار delivery
 * نباید پیام مضاعف بسازد؛ رویداد بعدی (۵ دقیقه بعد) همیشه پیام جدید
 * میسازد، حتی با قیمت یکسان.
 */
export const USD_LAST_EVENT_KEY = "usd:last_event";

// --- سلامت منابع مرجع (مأموریت ۲۹) ---
/**
 * snapshot سلامت منابع تتر/مراجع (JSON) — نوشتن «تجمعی با حداقل فاصلهٔ
 * ۳۰ دقیقه» (حفظ سقف نوشتن KV: حداکثر ~۴۸+۴ نوشتن/روز) + همیشه در جاب
 * گزارش ۶ ساعته. merge با snapshot قبلی → آخرین موفقیت/خطای هر منبع
 * بین نوشتنها هم حفظ میشود.
 */
export const REF_HEALTH_KEY = "health:refs";
/** حداقل فاصلهٔ دو نوشتن سلامت (ms) */
export const REF_HEALTH_MIN_WRITE_INTERVAL_MS = 30 * 60 * 1000;

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
  /** ok | paused | no-data | invalid | send-error | provider-error | suppressed | market-* */
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

/** آخرین رویداد Cron پردازش‌شده (epoch ms) — null = هیچ/خراب (fail-closed) */
export async function readUsdLastEvent(
  kv: KVLike,
): Promise<number | null> {
  const value = await readJson<number>(kv, USD_LAST_EVENT_KEY);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** علامت‌گذاری رویداد به‌عنوان پردازش‌شده (قبل از side effect ارسال) */
export async function markUsdLastEvent(
  kv: KVLike,
  scheduledTime: number,
): Promise<void> {
  await writeJson(kv, USD_LAST_EVENT_KEY, scheduledTime);
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
  /** آخرین نرخ مستقل تتر (تومان) — غایب = خط تتر در پیام نمایش داده نمیشود */
  tether?: number;
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
  // تتر فقط مقدار عددی معتبر پذیرفته میشود — هرگز از دلار ساخته نمیشود
  const tetherRaw = record.tether;
  const tether =
    typeof tetherRaw === "number" && Number.isFinite(tetherRaw) && tetherRaw > 0
      ? tetherRaw
      : undefined;
  return { value, dataDate, ...(tether !== undefined ? { tether } : {}) };
}

export async function readLastReport(
  kv: KVLike,
): Promise<MarketReport | null> {
  return readJson<MarketReport>(kv, LAST_REPORT_KEY);
}

// ---------- قفل مشاوره‌ای (جلوگیری از ارسال تکراری در اجرای هم‌زمان) ----------

/**
 * Cloudflare Cron Triggers «حداقل یکبار» اجرا را تضمین میکنند و در رخدادهای
 * زیرساختی ممکن است اجرای تکراری/هم‌زمان رخ دهد. KV قفل اتمی ندارد
 * (eventual consistency) — این قفل «بهترین تلاش» (best-effort) است و
 * پنجرهٔ race ارسال اولین پیام را از ثانیهها به تأخیر انتشار KV
 * (میلی‌ثانیهها) می‌راند. راه‌حل اتمی واقعی Durable Objects است (خارج از
 * دامنهٔ این پروژه — در README/ممیزی مستند شده).
 *
 * TTL حداقل KV ۶۰ ثانیه است → قفل ۶۰ ثانیه‌ای: کوتاه‌تر از فاصلهٔ cron
 * ۵ دقیقه‌ای، بلندتر از یک فراخوانی تلگرام.
 */
export const USD_SEND_LOCK_KEY = "lock:usd:send";

/**
 * تلاش برای گرفتن قفل ارسال. true = قفل گرفته شد (اجازه ادامه)؛
 * false = اجرای دیگری در جریان است (این اجرا باید نادیده گرفته شود).
 * خطای KV → true (قفل مشورتی نباید انتشار سالم را بلاک کند).
 */
export async function acquireUsdSendLock(
  kv: KVLike,
  ttlSeconds = 60,
): Promise<boolean> {
  try {
    const existing = await kv.get(USD_SEND_LOCK_KEY);
    if (existing !== null) return false;
    await kv.put(USD_SEND_LOCK_KEY, "1", { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return true;
  }
}

/** آزادسازی قفل — خطا عمداً بلعیده میشود (TTL پشتیبان است) */
export async function releaseUsdSendLock(kv: KVLike): Promise<void> {
  try {
    await kv.delete(USD_SEND_LOCK_KEY);
  } catch {
    // ignore — TTL 60s خودش پاک میکند
  }
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

// --- سلامت منابع مرجع (مأموریت ۲۹ — آمار per-source در KV) ---

/** وضعیت یک منبع مرجع در یک snapshot */
export interface RefSourceHealthEntry {
  /** ok | error */
  status: "ok" | "error";
  /** آخرین مقدار معتبر (تومان) — فقط هنگام ok */
  valueToman?: number;
  /** تأخیر آخرین fetch موفق (ms) */
  latencyMs?: number;
  /** آخرین خطا (کد داخلی) */
  lastError?: string;
  /** ISO آخرین موفقیت — بین snapshotها merge میشود */
  lastSuccessAt?: string;
  /** ISO آخرین خطا — بین snapshotها merge میشود */
  lastErrorAt?: string;
}

/** snapshot سلامت منابع مرجع */
export interface RefHealthSnapshot {
  /** ISO نوشتن snapshot */
  at: string;
  /** منابع تتر (wallex/ramzinex/nobitex) */
  tether: Record<string, RefSourceHealthEntry>;
}

/**
 * ساخت snapshot سلامت از نتایج زمان-اجرا (TetherSourceOutcome) — merge با
 * snapshot قبلی KV تا lastSuccessAt/lastErrorAt بین نوشتنها حفظ شود.
 */
export function buildRefHealthSnapshot(
  previous: RefHealthSnapshot | null,
  outcomes: ReadonlyArray<{
    source: string;
    quote: { valueToman: number } | null;
    latencyMs: number;
    error: string | null;
  }>,
  now: Date,
): RefHealthSnapshot {
  const tether: Record<string, RefSourceHealthEntry> = {};
  for (const o of outcomes) {
    const prev = previous?.tether?.[o.source];
    const ok = o.quote !== null;
    tether[o.source] = ok
      ? {
          status: "ok",
          valueToman: o.quote!.valueToman,
          latencyMs: o.latencyMs,
          lastSuccessAt: now.toISOString(),
          ...(prev?.lastErrorAt && !prev.lastSuccessAt
            ? { lastError: prev.lastError, lastErrorAt: prev.lastErrorAt }
            : {}),
        }
      : {
          status: "error",
          lastError: o.error ?? "UNKNOWN",
          lastErrorAt: now.toISOString(),
          ...(prev?.lastSuccessAt
            ? { lastSuccessAt: prev.lastSuccessAt, valueToman: prev.valueToman, latencyMs: prev.latencyMs }
            : {}),
        };
  }
  return { at: now.toISOString(), tether };
}

/**
 * نوشتن سلامت با «سرکوب زمانی»: حداکثر یک نوشتن در هر ۳۰ دقیقه
 * (force=true برای جاب گزارش ۶ ساعته). خروجی: نوشته شد؟
 */
export async function writeRefHealthIfDue(
  kv: KVLike,
  outcomes: ReadonlyArray<{
    source: string;
    quote: { valueToman: number } | null;
    latencyMs: number;
    error: string | null;
  }>,
  now: Date,
  force = false,
): Promise<boolean> {
  try {
    const previous = await readJson<RefHealthSnapshot>(kv, REF_HEALTH_KEY);
    if (!force && previous?.at) {
      const lastAt = Date.parse(previous.at);
      if (
        Number.isFinite(lastAt) &&
        now.getTime() - lastAt < REF_HEALTH_MIN_WRITE_INTERVAL_MS
      ) {
        return false; // هنوز تازه است — بدون نوشتن (سقف KV)
      }
    }
    const snapshot = buildRefHealthSnapshot(previous, outcomes, now);
    return await writeJson(kv, REF_HEALTH_KEY, snapshot);
  } catch (err) {
    logWarn("kv.ref-health.write-error", {
      error: err instanceof Error ? err.name : "UNKNOWN",
    });
    return false;
  }
}
