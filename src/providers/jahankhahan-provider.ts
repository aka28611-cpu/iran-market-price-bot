import {
  gregorianToJalali,
  jalaliToGregorian,
  TEHRAN_OFFSET_MINUTES,
} from "../datetime";
import { logInfo, logWarn } from "../logging";
import { MAX_REASONABLE_PRICE } from "../validation";
import type {
  MarketReport,
  ReportItem,
  ReportSymbol,
  UsdTehranPrice,
} from "../types";
import type { PriceProvider } from "./provider";

/**
 * Provider برای nerkh.jahankhahan.shop/data/live.json
 *
 * نتیجه ارزیابی Read-Only (مرحله ۶):
 *  • بدون کلید/احراز هویت — GET ساده، پاسخ JSON کوچک (~۸۷۲ بایت)
 *  • واحد قیمتها: تومان (تأییدشده با magnitude و انسجام داخلی)
 *  • مهر زمانی داده: date شمسی + time به وقت تهران (یک مهر برای کل پاسخ)
 *  • خطا: هر وضعیت غیر از ۲۰۰ JSON معتبر = null (fail-closed)
 *
 * تصمیمهای امنیتی:
 *  • redirect: "error" — هرگز redirect دنبال نمی‌شود (درس ارزیابی navasan.net:
 *    دنبال کردن redirect میتواند HTML صفحه اصلی را جای JSON تحویل دهد)
 *  • cache: "no-store" — سرور cache-control ندارد؛ کش heuristic ممنوع است
 *    (ETag بر اساس mtime است و با محتوای یکسان هم عوض میشود — قابل اتکا نیست)
 *  • URL کامل از env میآید (PRICE_API_BASE_URL) — هیچ endpointی hard-code نمیشود
 *  • URL با credential رد میشود
 *
 * فیلدهای «تأییدنشده» (طبق دستور مالک پروژه — مرحله آمادهسازی provider):
 *  • rates.mesghal  → status "UNKNOWN"          (semantics با فرمول استاندارد
 *    4.6083×gold24 سازگار نیست؛ تا تأیید منبع در گزارش production نمایش نمییابد)
 *  • rates.coin     → status "UNVERIFIED_COIN"  (کلید عمومی؛ انتساب قطعی به
 *    سکه امامی مجاز نیست؛ تا تأیید منبع در گزارش production نمایش نمییابد)
 *  این دو فیلد در parse نتیجه حاضرند (برای تأیید آینده) اما هرگز وارد
 *  items گزارش نمیشوند؛ بنابراین فرمتر پیام تلگرام هرگز آنها را رندر نمیکند.
 */

/** خطای پیکربندی provider (مثلاً PRICE_API_BASE_URL غایب/نامعتبر) */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export interface JahankhahanProviderConfig {
  /** URL کامل فایل live.json — از env (PRICE_API_BASE_URL) */
  baseUrl: string;
  /** تزریق fetch برای تست */
  fetchFn?: typeof fetch;
  /** ساعت قابل‌تنظیم برای تست */
  now?: () => Date;
  /** مهلت درخواست (پیشفرض ۱۰ ثانیه) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------- اعتبارسنجی پایه ----------

function isPositiveFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_REASONABLE_PRICE
  );
}

// ---------- مهر زمانی: شمسی + ساعت تهران → ISO ----------

const JALALI_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const TEHRAN_TIME_RE = /^(\d{2}):(\d{2})$/;

/** بازه منطقی سال شمسی منبع (~۲۰۱۶ تا ~۲۱۱۶) */
const MIN_JALALI_YEAR = 1395;
const MAX_JALALI_YEAR = 1495;

/** طول ماههای جلالی: ۱-۶ = ۳۱ روز، ۷-۱۱ = ۳۰، اسفند = ۲۹/۳۰ (کبیسه) */
function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  // اسفند ۳۰ فقط در سال کبیسه وجود دارد — با تبدیل رفت و برگشت بررسی میشود
  const g = jalaliToGregorian(jy, 12, 30);
  const back = gregorianToJalali(g.gy, g.gm, g.gd);
  return back.jy === jy && back.jm === 12 && back.jd === 30 ? 30 : 29;
}

/**
 * تبدیل date شمسی ("YYYY/MM/DD") + time تهران ("HH:MM") داده به ISO 8601 UTC.
 * ورودی نامعتبر → null (بدون تخمین/اصلاح).
 */
export function parseJahankhahanTimestamp(
  date: unknown,
  time: unknown,
): string | null {
  if (typeof date !== "string" || typeof time !== "string") return null;
  const d = JALALI_DATE_RE.exec(date.trim());
  const t = TEHRAN_TIME_RE.exec(time.trim());
  if (!d || !t) return null;

  const jy = Number(d[1]);
  const jm = Number(d[2]);
  const jd = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);

  if (jy < MIN_JALALI_YEAR || jy > MAX_JALALI_YEAR) return null;
  if (jm < 1 || jm > 12) return null;
  if (jd < 1 || jd > jalaliMonthLength(jy, jm)) return null;
  if (hour > 23 || minute > 59) return null;

  const g = jalaliToGregorian(jy, jm, jd);
  // تهران UTC+3:30 بدون DST — ساعت دیواری منهای افست
  const epochMs =
    Date.UTC(g.gy, g.gm - 1, g.gd, hour, minute) -
    TEHRAN_OFFSET_MINUTES * 60_000;
  const parsed = new Date(epochMs);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// ---------- نگاشت فیلدها ----------

interface FieldMapping {
  /** کلید در rates */
  key: string;
  /** نماد گزارش پروژه */
  symbol: ReportSymbol;
  unit: "toman" | "usd";
}

/** فیلدهای تأییدشده — قابل انتشار در گزارش production */
const VERIFIED_FIELD_MAPPINGS: readonly FieldMapping[] = [
  { key: "dollar", symbol: "usd", unit: "toman" },
  { key: "euro", symbol: "eur", unit: "toman" },
  { key: "pound", symbol: "gbp", unit: "toman" },
  { key: "lira", symbol: "try", unit: "toman" },
  { key: "aed", symbol: "aed", unit: "toman" },
  { key: "gold", symbol: "gold18k", unit: "toman" },
  { key: "gold24", symbol: "gold24k", unit: "toman" },
  { key: "bahar", symbol: "bahar", unit: "toman" },
  { key: "half", symbol: "halfCoin", unit: "toman" },
  { key: "quarter", symbol: "quarterCoin", unit: "toman" },
  { key: "gram", symbol: "germi", unit: "toman" },
];

/** وضعیت فیلد تأییدنشده — نگه داشته میشود اما منتشر نمیشود */
export type UnverifiedStatus = "UNKNOWN" | "UNVERIFIED_COIN";

export interface JahankhahanUnverifiedField {
  /** کلید خام در منبع */
  key: string;
  /** نماد بالقوه در صورت تأیید آینده */
  symbol: ReportSymbol;
  status: UnverifiedStatus;
  /** مقدار خام منبع؛ null = در منبع نبود/نامعتبر بود */
  value: number | null;
  /** دلیل نگه داشتن بدون انتشار */
  reason: string;
}

const UNVERIFIED_FIELD_MAPPINGS: readonly {
  key: string;
  symbol: ReportSymbol;
  status: UnverifiedStatus;
  reason: string;
}[] = [
  {
    key: "mesghal",
    symbol: "mesghal",
    status: "UNKNOWN",
    reason:
      "semantics مثقال با فرمول استاندارد (۴.۶۰۸۳×طلای۲۴) سازگار نیست — تا تأیید منبع نمایش داده نمیشود",
  },
  {
    key: "coin",
    symbol: "emami",
    status: "UNVERIFIED_COIN",
    reason:
      "کلید عمومی coin — انتساب قطعی به سکه امامی مجاز نیست؛ تا تأیید منبع نمایش داده نمیشود",
  },
];

export interface JahankhahanParseResult {
  /** فقط فیلدهای تأییدشده — قابل انتشار */
  items: ReportItem[];
  /** فیلدهای تأییدنشده — هرگز وارد items نمیشوند */
  unverified: JahankhahanUnverifiedField[];
  /** کلیدهای موردانتظار که در منبع نبودند/نامعتبر بودند */
  missing: string[];
  /** ISO مهر زمانی داده (از date/time) */
  dataTimestamp: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Parse و اعتبارسنجی payload خام.
 * ورودی نامعتبر (ساختار خراب / بدون مهر زمانی معتبر) → null.
 * فیلد نامعتبر بهصورت آیتم «حذفشده» گزارش میشود (missing) — نه مقدار جایگزین.
 */
export function parseJahankhahanPayload(
  raw: unknown,
): JahankhahanParseResult | null {
  const root = asRecord(raw);
  if (!root) return null;

  // مهر زمانی داده — بدون آن، داده قابل اتکا نیست (fail-closed کل پاسخ)
  const dataTimestamp = parseJahankhahanTimestamp(root.date, root.time);
  if (!dataTimestamp) return null;

  const rates = asRecord(root.rates);
  if (!rates) return null;

  const items: ReportItem[] = [];
  const missing: string[] = [];

  for (const mapping of VERIFIED_FIELD_MAPPINGS) {
    const value = rates[mapping.key];
    if (isPositiveFiniteNumber(value)) {
      items.push({
        symbol: mapping.symbol,
        value,
        unit: mapping.unit,
        updatedAt: dataTimestamp,
      });
    } else {
      missing.push(mapping.key);
    }
  }

  // اونس جهانی (دلار): سطح top-level با fallback به usd.ounce
  const usd = asRecord(root.usd);
  const ounceRaw = root.ounce ?? usd?.ounce;
  if (isPositiveFiniteNumber(ounceRaw)) {
    items.push({
      symbol: "ounce",
      value: ounceRaw,
      unit: "usd",
      updatedAt: dataTimestamp,
    });
  } else {
    missing.push("ounce");
  }

  const unverified: JahankhahanUnverifiedField[] = [];
  for (const mapping of UNVERIFIED_FIELD_MAPPINGS) {
    const value = rates[mapping.key];
    unverified.push({
      key: mapping.key,
      symbol: mapping.symbol,
      status: mapping.status,
      value: isPositiveFiniteNumber(value) ? value : null,
      reason: mapping.reason,
    });
  }

  return { items, unverified, missing, dataTimestamp };
}

// ---------- Provider ----------

export class JahankhahanProvider implements PriceProvider {
  readonly name = "jahankhahan";

  private readonly baseUrl: URL;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => Date;
  private readonly timeoutMs: number;

  constructor(config: JahankhahanProviderConfig) {
    const raw = (config.baseUrl ?? "").trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProviderConfigError(
        "PRICE_API_BASE_URL باید URL مطلق معتبر باشد",
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ProviderConfigError(
        "PRICE_API_BASE_URL فقط http(s) پشتیبانی میشود",
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new ProviderConfigError(
        "PRICE_API_BASE_URL نباید credential تعبیهشده داشته باشد",
      );
    }
    this.baseUrl = url;
    this.fetchFn = config.fetchFn ?? fetch.bind(globalThis);
    this.nowFn = config.now ?? (() => new Date());
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * این منبع فقط «نرخ واحد دلار بازار» دارد (rates.dollar) — میز خرید/فروش
   * فردایی ندارد. ساخت buy=sell=trade از نرخ تکعددی «مقدار جعلی» است و
   * انجام نمیشود؛ null برمیگردد (تصمیم انتشار با جاب — fail-closed).
   */
  async fetchUsdTehran(): Promise<UsdTehranPrice | null> {
    logInfo("provider.jahankhahan.usd-unsupported", {
      provider: this.name,
      reason: "SINGLE_RATE_SOURCE_NO_DESK_BUY_SELL",
    });
    return null;
  }

  async fetchMarketReport(): Promise<MarketReport | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(this.baseUrl.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      logWarn("provider.jahankhahan.fetch-error", {
        provider: this.name,
        error: error instanceof Error ? error.name : "unknown",
      });
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      logWarn("provider.jahankhahan.http-status", {
        provider: this.name,
        status: response.status,
      });
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/application\/json/i.test(contentType)) {
      // تله رایج: HTML صفحه اصلی جای JSON (رفتار navasan.net بدون کلید)
      logWarn("provider.jahankhahan.non-json", {
        provider: this.name,
        contentType,
      });
      return null;
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      logWarn("provider.jahankhahan.bad-json", { provider: this.name });
      return null;
    }

    const parsed = parseJahankhahanPayload(raw);
    if (!parsed) {
      logWarn("provider.jahankhahan.invalid-payload", {
        provider: this.name,
      });
      return null;
    }
    if (parsed.items.length === 0) {
      logWarn("provider.jahankhahan.empty-report", {
        provider: this.name,
        missing: parsed.missing,
      });
      return null;
    }

    if (parsed.unverified.some((f) => f.value !== null)) {
      logInfo("provider.jahankhahan.unverified-withheld", {
        provider: this.name,
        fields: parsed.unverified
          .filter((f) => f.value !== null)
          .map((f) => `${f.key}:${f.status}`),
      });
    }

    return {
      items: parsed.items,
      fetchedAt: this.nowFn().toISOString(),
      source: this.name,
    };
  }
}
