import { logInfo, logWarn } from "../logging";

/**
 * مراجع مستقل تتر — معماری چندمنبعی (مأموریت ۲۹، مراحل ۲-۴).
 *
 * اصول:
 *  • هر منبع: timeout محدود، خطای مستقل، اعتبارسنجی سخت‌گیرانهٔ ساختار/واحد/مagnitude
 *  • «واحد نامشخص» = رد کامل (حدس واحد ممنوع — ریال/تومان صریح بررسی میشود)
 *  • مبدأ (origin) هر منبع ردیابی میشود تا نرخهای هم‌خانواده بهعنوان
 *    «تأیید مستقل» حساب نشوند (درس ممیزی: jahankhahan = آینهٔ TGJU، ۰.۰۰۰٪).
 *  • مرجع مقاوم = میانه (نه میانگین ساده) + حذف outlier + قاعدهٔ اجماع
 *  • نبود مرجع معتبر/اجماع → عدم انتشار خط تتر (fail-closed) — هرگز از
 *    دلار کپی یا از مقدار قبلی/حدسی ساخته نمیشود.
 *  • دفتر سفارش/میز زندهٔ صرافی (بدون ts) = «زنده» با زمان مشاهده؛
 *    پاسخهای دارای ts (Nobitex isStatsAt) بدون ts معتبر/تازه رد میشوند.
 *
 * شواهد ممیزی ۲۰۲۶-10-12 در docs/SOURCES.md:
 *  • Wallex depth USDTTMN — مستقل، ولی از egress Workers «ناپایدار ۴۰۳» (~۱۸٪ موفق)
 *  • Ramzinex pairs/11 — مستقل، سبک (۹۹۶B)، واحد ریال (خوداظهار irr)
 *  • Nobitex market/stats — مستقل، پاسخ ~۲KB، isStatsAt؛ در sandbox DNS-بلاک
 *    (تأیید نهایی: آمار سلامت زمان-اجرا پس از deploy)
 *  • Bitpin — رد شد (endpoint سبک ندارد؛ 3.2MB = ریسک CPU/حافظهٔ پلن رایگان)
 */

// ---------- شناسهها و پیشفرضها ----------

export type TetherSourceId = "wallex" | "ramzinex" | "nobitex";

export const KNOWN_TETHER_SOURCES: readonly TetherSourceId[] = [
  "wallex",
  "ramzinex",
  "nobitex",
];

export const DEFAULT_TETHER_SOURCES = "wallex,ramzinex,nobitex";

export const WALLEX_DEPTH_URL_DEFAULT =
  "https://api.wallex.ir/v1/depth?symbol=USDTTMN";
export const RAMZINEX_PAIR_URL_DEFAULT =
  "https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/11";
export const NOBITEX_STATS_URL_DEFAULT =
  "https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls";

/** مهلت هر fetch مرجع — کوتاه‌تر از provider اصلی (مرجع نباید جاب را معلق کند) */
const REF_TIMEOUT_MS = 8_000;
/** حدهای عقلانی نرخ تتر مرجع (تومان) — خارج از بازه = دادهٔ خراب */
const REF_MIN_TOMAN = 1_000;
const REF_MAX_TOMAN = 100_000_000;
/**
 * حداکثر عمر آمار Nobitex (isStatsAt) — ۲ ساعت؛ آمار قدیمی مرجعِ زنده نیست.
 * دفتر/میز زندهٔ صرافی ts ندارند و با «زمان مشاهده» زنده فرض میشوند.
 */
const NOBITEX_MAX_STATS_AGE_MS = 2 * 60 * 60 * 1000;
/** آستانهٔ حذف outlier از میانه — کف ۱۰٪ یا ۲× آستانهٔ واگرایی */
const OUTLIER_FLOOR_PCT = 10;

// ---------- فرمت استاندارد داخلی (متادیتای کامل) ----------

/** نرخ نرمالشده به تومان + متادیتای منشأ */
export interface SourceQuote {
  /** شناسهٔ منبع */
  source: TetherSourceId;
  /**
   * مبدأ داده — دو منبع با مبدأ یکسان «تأیید مستقل» نیستند
   * (wallex/ramzinex/nobitex = صرافیهای متمایز = مبدأهای مستقل)
   */
  origin: string;
  asset: "usdt";
  /** نرخ به «تومان» (ریالها اینجا ÷۱۰ شدهاند) */
  valueToman: number;
  /** مهر زمانی «خودِ دادهٔ منبع» — null = دفتر/میز زنده (زمان = مشاهده) */
  dataTs: string | null;
  /** زمان مشاهده (ISO) — پایان fetch موفق */
  observedAt: string;
  /** نوع نرخ: میانهٔ دفتر / میز صرافی / آمار آماری */
  rateType: "book-mid" | "desk-mid" | "stats-desk-mid";
  /** واحد خام منبع (قبل از نرمالسازی) */
  unitSource: "toman" | "rial";
}

/** نتیجهٔ هر منبع — مستقل؛ خرابی یکی بقیه را نمیاندازد */
export interface TetherSourceOutcome {
  source: TetherSourceId;
  origin: string;
  quote: SourceQuote | null;
  latencyMs: number;
  /** کد خطا/رد (داخلی — لاگ و سلامت)؛ null = موفق */
  error: string | null;
}

/** پیکربندی منابع تتر (ساختهشده از env توسط cross-check.ts) */
export interface TetherRefConfig {
  enabled: boolean;
  tetherSources: readonly TetherSourceId[];
  wallexUrl: string;
  ramzinexUrl: string;
  nobitexUrl: string;
  /** آستانهٔ واگرایی تتر (٪) — از CROSS_CHECK_TETHER_TOLERANCE_PCT */
  tetherTolerancePct: number;
}

// ---------- ابزار مشترک ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** عدد مثبت متناهی در بازهٔ مرجع تتر (تومان) */
function saneToman(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= REF_MIN_TOMAN &&
    value <= REF_MAX_TOMAN
  );
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface FetchOutcome {
  parsed: unknown;
  latencyMs: number;
  error: string | null;
}

/** GET JSON با timeout/abort + بررسی status/content-type — هرگز throw نمیکند */
async function fetchJsonWithTimeout(
  url: string,
  fetchFn: typeof fetch,
  source: string,
  timeoutMs = REF_TIMEOUT_MS,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      // همان درس production: workerd فقط follow/manual میپذیرد
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      logWarn("refs.http-status", { source, status: response.status });
      return {
        parsed: null,
        latencyMs: Date.now() - t0,
        error: `HTTP_${response.status}`,
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/application\/json/i.test(contentType)) {
      logWarn("refs.non-json", { source, contentType });
      return {
        parsed: null,
        latencyMs: Date.now() - t0,
        error: "NON_JSON",
      };
    }
    const parsed = await response.json();
    return { parsed, latencyMs: Date.now() - t0, error: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    logWarn("refs.fetch-error", { source, error: name });
    return {
      parsed: null,
      latencyMs: Date.now() - t0,
      error: name === "AbortError" ? "TIMEOUT" : "NETWORK",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- آداپتورها (هرکدام اعتبارسنجی سخت‌گیرانهٔ خودش) ----------

/** Wallex — دفتر سفارش USDTTMN (تومان)؛ میانهٔ best bid/ask */
async function fetchWallexSource(
  url: string,
  fetchFn: typeof fetch,
  now: () => Date,
): Promise<TetherSourceOutcome> {
  const base = {
    source: "wallex" as const,
    origin: "wallex",
    latencyMs: 0,
  };
  const { parsed, latencyMs, error } = await fetchJsonWithTimeout(
    url,
    fetchFn,
    "wallex",
  );
  if (error || parsed === null) {
    return { ...base, quote: null, latencyMs, error };
  }
  const result = asRecord(asRecord(parsed)?.["result"]);
  const ask = Array.isArray(result?.["ask"])
    ? (result?.["ask"] as unknown[])
    : null;
  const bid = Array.isArray(result?.["bid"])
    ? (result?.["bid"] as unknown[])
    : null;
  if (!ask?.length || !bid?.length) {
    logWarn("refs.wallex.invalid-payload", { source: "wallex" });
    return { ...base, quote: null, latencyMs, error: "INVALID_PAYLOAD" };
  }
  const priceOf = (level: unknown): number | null => {
    const p = asRecord(level)?.["price"];
    const n = toNumber(p);
    return n !== null && n > 0 ? n : null;
  };
  const asks = ask.map(priceOf).filter((p): p is number => p !== null);
  const bids = bid.map(priceOf).filter((p): p is number => p !== null);
  if (!asks.length || !bids.length) {
    logWarn("refs.wallex.invalid-levels", { source: "wallex" });
    return { ...base, quote: null, latencyMs, error: "INVALID_LEVELS" };
  }
  const bestAsk = Math.min(...asks);
  const bestBid = Math.max(...bids);
  if (bestBid > bestAsk) {
    // دفتر معکوس = دادهٔ خراب
    logWarn("refs.wallex.crossed-book", { source: "wallex" });
    return { ...base, quote: null, latencyMs, error: "CROSSED_BOOK" };
  }
  const mid = (bestAsk + bestBid) / 2;
  if (!saneToman(mid)) {
    logWarn("refs.wallex.implausible", { source: "wallex" });
    return { ...base, quote: null, latencyMs, error: "IMPLAUSIBLE" };
  }
  return {
    ...base,
    latencyMs,
    quote: {
      source: "wallex",
      origin: "wallex",
      asset: "usdt",
      valueToman: Math.round(mid),
      dataTs: null, // دفتر زنده
      observedAt: now().toISOString(),
      rateType: "book-mid",
      unitSource: "toman",
    },
    error: null,
  };
}

/** Ramzinex — جفت USDT/IRT (ریالِ خوداظهار)؛ میانهٔ میز خرید/فروش */
async function fetchRamzinexSource(
  url: string,
  fetchFn: typeof fetch,
  now: () => Date,
): Promise<TetherSourceOutcome> {
  const base = {
    source: "ramzinex" as const,
    origin: "ramzinex",
    latencyMs: 0,
  };
  const { parsed, latencyMs, error } = await fetchJsonWithTimeout(
    url,
    fetchFn,
    "ramzinex",
  );
  if (error || parsed === null) {
    return { ...base, quote: null, latencyMs, error };
  }
  const data = asRecord(asRecord(parsed)?.["data"]);
  if (!data) {
    logWarn("refs.ramzinex.invalid-payload", { source: "ramzinex" });
    return { ...base, quote: null, latencyMs, error: "INVALID_PAYLOAD" };
  }
  // خودتأییدی جفت: باید USDT باشد (محافظت در برابر تغییر pair_id)
  const baseSym = String(
    asRecord(data["base_currency_symbol"])?.["en"] ?? "",
  ).toLowerCase();
  if (baseSym !== "usdt") {
    logWarn("refs.ramzinex.pair-mismatch", { source: "ramzinex", baseSym });
    return { ...base, quote: null, latencyMs, error: "PAIR_MISMATCH" };
  }
  // واحد صریح: فقط ریال پذیرفته میشود (حدس واحد ممنوع)
  const quoteSym = String(
    asRecord(data["quote_currency_symbol"])?.["en"] ?? "",
  ).toLowerCase();
  if (quoteSym !== "irr" && quoteSym !== "ir") {
    logWarn("refs.ramzinex.unit-unknown", { source: "ramzinex", quoteSym });
    return { ...base, quote: null, latencyMs, error: "UNIT_UNKNOWN" };
  }
  if (data["is_delist"] !== 0 && data["is_delist"] !== "0") {
    logWarn("refs.ramzinex.delisted", { source: "ramzinex" });
    return { ...base, quote: null, latencyMs, error: "DELISTED" };
  }
  if (
    data["is_temporarily_suspended"] !== 0 &&
    data["is_temporarily_suspended"] !== "0"
  ) {
    logWarn("refs.ramzinex.suspended", { source: "ramzinex" });
    return { ...base, quote: null, latencyMs, error: "SUSPENDED" };
  }
  const buy = toNumber(data["buy"]);
  const sell = toNumber(data["sell"]);
  if (buy === null || sell === null || buy <= 0 || sell <= 0) {
    logWarn("refs.ramzinex.invalid-levels", { source: "ramzinex" });
    return { ...base, quote: null, latencyMs, error: "INVALID_LEVELS" };
  }
  if (buy > sell) {
    logWarn("refs.ramzinex.crossed-desk", { source: "ramzinex" });
    return { ...base, quote: null, latencyMs, error: "CROSSED_DESK" };
  }
  const midToman = (buy + sell) / 2 / 10; // ریال → تومان
  if (!saneToman(midToman)) {
    logWarn("refs.ramzinex.implausible", { source: "ramzinex" });
    return { ...base, quote: null, latencyMs, error: "IMPLAUSIBLE" };
  }
  return {
    ...base,
    latencyMs,
    quote: {
      source: "ramzinex",
      origin: "ramzinex",
      asset: "usdt",
      valueToman: Math.round(midToman),
      dataTs: null, // میز زندهٔ صرافی
      observedAt: now().toISOString(),
      rateType: "desk-mid",
      unitSource: "rial",
    },
    error: null,
  };
}

/** Nobitex — آمار بازار USDT/RLS (ریال)؛ isStatsAt الزامی + میز mid */
async function fetchNobitexSource(
  url: string,
  fetchFn: typeof fetch,
  now: () => Date,
): Promise<TetherSourceOutcome> {
  const base = {
    source: "nobitex" as const,
    origin: "nobitex",
    latencyMs: 0,
  };
  const { parsed, latencyMs, error } = await fetchJsonWithTimeout(
    url,
    fetchFn,
    "nobitex",
  );
  if (error || parsed === null) {
    return { ...base, quote: null, latencyMs, error };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { ...base, quote: null, latencyMs, error: "INVALID_PAYLOAD" };
  }
  const status = String(root["status"] ?? "");
  if (status !== "" && status !== "ok") {
    logWarn("refs.nobitex.api-status", { source: "nobitex", status });
    return { ...base, quote: null, latencyMs, error: "API_STATUS" };
  }
  // کلید ساختاری صریح: dstCurrency=rls → «usdt-rls» (ریال) — بدون حدس واحد
  const stats = asRecord(root["stats"]);
  const entry = asRecord(stats?.["usdt-rls"]);
  if (!entry) {
    logWarn("refs.nobitex.invalid-payload", { source: "nobitex" });
    return { ...base, quote: null, latencyMs, error: "INVALID_PAYLOAD" };
  }
  if (entry["isClosed"] === true) {
    logWarn("refs.nobitex.market-closed", { source: "nobitex" });
    return { ...base, quote: null, latencyMs, error: "MARKET_CLOSED" };
  }
  // مهر زمانی آمار (epoch) — الزامی؛ نبود/کهنگی = رد
  const statsAtRaw = toNumber(entry["isStatsAt"]);
  const statsTsMs =
    statsAtRaw === null
      ? null
      : statsAtRaw > 1_000_000_000_000 // epoch ms (~۱.۷۹e۱۲)
        ? Math.round(statsAtRaw)
        : statsAtRaw > 1_000_000_000 // epoch ثانیه (~۱.۷۹e۹)
          ? Math.round(statsAtRaw * 1000)
          : null;
  if (statsTsMs === null) {
    logWarn("refs.nobitex.no-valid-ts", { source: "nobitex" });
    return { ...base, quote: null, latencyMs, error: "NO_VALID_TS" };
  }
  const ageMs = now().getTime() - statsTsMs;
  if (ageMs > NOBITEX_MAX_STATS_AGE_MS || ageMs < -5 * 60_000) {
    logWarn("refs.nobitex.stale", {
      source: "nobitex",
      ageMin: Math.round(ageMs / 60_000),
    });
    return { ...base, quote: null, latencyMs, error: "STALE_STATS" };
  }
  const buy = toNumber(entry["bestBuy"]);
  const sell = toNumber(entry["bestSell"]);
  if (buy === null || sell === null || buy <= 0 || sell <= 0) {
    logWarn("refs.nobitex.invalid-levels", { source: "nobitex" });
    return { ...base, quote: null, latencyMs, error: "INVALID_LEVELS" };
  }
  if (buy > sell) {
    logWarn("refs.nobitex.crossed-desk", { source: "nobitex" });
    return { ...base, quote: null, latencyMs, error: "CROSSED_DESK" };
  }
  const midToman = (buy + sell) / 2 / 10; // ریال → تومان
  if (!saneToman(midToman)) {
    logWarn("refs.nobitex.implausible", { source: "nobitex" });
    return { ...base, quote: null, latencyMs, error: "IMPLAUSIBLE" };
  }
  return {
    ...base,
    latencyMs,
    quote: {
      source: "nobitex",
      origin: "nobitex",
      asset: "usdt",
      valueToman: Math.round(midToman),
      dataTs: new Date(statsTsMs).toISOString(),
      observedAt: now().toISOString(),
      rateType: "stats-desk-mid",
      unitSource: "rial",
    },
    error: null,
  };
}

// ---------- جمعآوری موازی ----------

/**
 * همهٔ منابع تتر فعال را «موازی» میگیرد (Promise.all؛ هر آداپتور
 * خودش خطا میگیرد — خرابی یک منبع بقیه را معلق/خراب نمیکند).
 * خروجی: ترتیب پایدار KNOWN_TETHER_SOURCES.
 */
export async function collectTetherReferences(
  cfg: TetherRefConfig,
  fetchFn: typeof fetch,
  now: () => Date = () => new Date(),
): Promise<TetherSourceOutcome[]> {
  const jobs: Array<Promise<TetherSourceOutcome>> = [];
  for (const id of KNOWN_TETHER_SOURCES) {
    if (!cfg.tetherSources.includes(id)) continue;
    if (id === "wallex") {
      jobs.push(fetchWallexSource(cfg.wallexUrl, fetchFn, now));
    } else if (id === "ramzinex") {
      jobs.push(fetchRamzinexSource(cfg.ramzinexUrl, fetchFn, now));
    } else {
      jobs.push(fetchNobitexSource(cfg.nobitexUrl, fetchFn, now));
    }
  }
  return Promise.all(jobs);
}

// ---------- موتور اعتبارسنجی (مرحلهٔ ۳) ----------

/** میانهٔ مقاوم — مرتبسازی و عضو میانی (میانگین دو عضو وسط برای زوج) */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(med);
}

export type TetherVerdictReason =
  | "OK"
  | "NO_REFERENCE"
  | "NO_CONSENSUS"
  | "DIVERGED";

export interface TetherValidationResult {
  /** انتشار خط تتر مجاز است؟ (فقط با مرجع معتبر + اجماع + داخل آستانه) */
  publish: boolean;
  reason: TetherVerdictReason;
  /** مرجع مقاوم (میانهٔ بازماندهها؛ تومان) — null بدون مرجع */
  reference: number | null;
  /** اختلاف درصد primary نسبت به مرجع */
  diffPct: number | null;
  /** تعداد منابع معتبر بعد از حذف outlier */
  validSources: number;
  /** تعداد «مبدأهای مستقل» بازماندهها */
  originCount: number;
  /** فقط یک مرجع مستقل معتبر مانده (پرچم صادقانه — انتشار ادامه دارد) */
  singleReference: boolean;
  /** منابع حذفشده بهعنوان outlier (لاگ هشدار) */
  outliersDropped: string[];
  /** جزئیات هر منبع (سلامت/لاگ/KV) */
  outcomes: readonly TetherSourceOutcome[];
}

/**
 * اعتبارسنجی نرخ تتر primary در برابر مراجع مستقل:
 *  ۱) منابع معتبر → میانهٔ مقاوم
 *  ۲) outlier (|q−میانه| > max(۱۰٪, ۲×آستانه)) حذف + هشدار؛ میانهٔ بازمحاسبه
 *  ۳) اجماع بازماندهها: spread > ۲×آستانه → عدم اجماع → عدم انتشار
 *  ۴) |primary − مرجع| > آستانه → diverged → عدم انتشار
 *  ۵) صفر مرجع → عدم انتشار (fail-closed — نه کپی از دلار، نه مقدار قبلی)
 *  ۶) مبدأ یکتا → پرچم singleReference (صادق؛ انتشار ادامه دارد)
 * نرخ «منتشرشده» همیشه مقدار خودِ primary است — مرجعها فقط اعتبارسنجی
 * میکنند (جایگزینی مقدار ممنوع).
 */
export function evaluateTetherReferences(
  primaryToman: number | null,
  outcomes: readonly TetherSourceOutcome[],
  tolerancePct: number,
): TetherValidationResult {
  const valid = outcomes.filter((o) => o.quote !== null);
  const base: Pick<
    TetherValidationResult,
    "reference" | "diffPct" | "validSources" | "originCount" | "outcomes"
  > = {
    reference: null,
    diffPct: null,
    validSources: 0,
    originCount: 0,
    outcomes,
  };
  if (primaryToman === null || !Number.isFinite(primaryToman)) {
    return {
      ...base,
      publish: false,
      reason: "NO_REFERENCE",
      singleReference: false,
      outliersDropped: [],
    };
  }
  if (valid.length === 0) {
    return {
      ...base,
      publish: false,
      reason: "NO_REFERENCE",
      singleReference: false,
      outliersDropped: [],
    };
  }

  // حذف outlier نسبت به میانهٔ مقاوم
  const firstMedian = median(valid.map((o) => o.quote!.valueToman))!;
  const outlierPct = Math.max(OUTLIER_FLOOR_PCT, 2 * tolerancePct);
  const survivors: TetherSourceOutcome[] = [];
  const outliersDropped: string[] = [];
  for (const o of valid) {
    const q = o.quote!.valueToman;
    const devPct = (Math.abs(q - firstMedian) / firstMedian) * 100;
    if (devPct > outlierPct) {
      outliersDropped.push(o.source);
      logWarn("refs.outlier-dropped", {
        source: o.source,
        value: q,
        median: firstMedian,
        devPct: Math.round(devPct * 10) / 10,
      });
    } else {
      survivors.push(o);
    }
  }
  if (survivors.length === 0) {
    // همه به یکدیگر ناسازگارند — هیچ مرجع قابل اتکایی نیست
    logWarn("refs.no-survivor", { sources: outliersDropped });
    return {
      ...base,
      publish: false,
      reason: "NO_CONSENSUS",
      singleReference: false,
      outliersDropped,
    };
  }

  const reference = median(survivors.map((o) => o.quote!.valueToman))!;
  const origins = new Set(survivors.map((o) => o.origin));

  // قاعدهٔ اجماع: با ≥۲ بازمانده، spread بزرگ = مراجع ناسازگار → اعتماد ممنوع
  if (survivors.length >= 2) {
    const values = survivors.map((o) => o.quote!.valueToman);
    const spreadPct = ((Math.max(...values) - Math.min(...values)) / Math.min(...values)) * 100;
    if (spreadPct > 2 * tolerancePct) {
      logWarn("refs.no-consensus", {
        sources: survivors.map((o) => o.source),
        spreadPct: Math.round(spreadPct * 10) / 10,
        reference,
      });
      return {
        ...base,
        publish: false,
        reason: "NO_CONSENSUS",
        singleReference: false,
        outliersDropped,
      };
    }
  }

  const diffPct = ((primaryToman - reference) / reference) * 100;
  const rounded = Math.round(diffPct * 10) / 10;
  if (Math.abs(diffPct) > tolerancePct) {
    logWarn("refs.diverged", {
      primary: primaryToman,
      reference,
      diffPct: rounded,
      sources: survivors.map((o) => o.source),
    });
    return {
      ...base,
      publish: false,
      reason: "DIVERGED",
      reference,
      diffPct: rounded,
      validSources: survivors.length,
      originCount: origins.size,
      singleReference: origins.size === 1,
      outliersDropped,
    };
  }

  const singleReference = origins.size === 1;
  if (singleReference) {
    // پرچم صادقانه: اعتبارسنجی تک‌مرجع — در لاگ ثبت میشود (ادامهٔ انتشار)
    logInfo("refs.single-reference", {
      source: survivors[0]?.source,
      reference,
    });
  } else {
    logInfo("refs.consensus", {
      sources: survivors.map((o) => o.source),
      reference,
      diffPct: rounded,
    });
  }
  return {
    publish: true,
    reason: "OK",
    reference,
    diffPct: rounded,
    validSources: survivors.length,
    originCount: origins.size,
    singleReference,
    outliersDropped,
    outcomes,
  };
}
