import { TEHRAN_OFFSET_MINUTES } from "../datetime";
import { logInfo, logWarn } from "../logging";
import type { ReportItem, ReportSymbol } from "../types";

/**
 * اعتبارسنجی متقاطع (Cross-Check) — مقایسهٔ دادهٔ منبع اصلی با مرجع مستقل
 * قبل از انتشار، طبق بند ۳ مأموریت: «اختلاف غیرعادی → عدم انتشار + ثبت دلیل».
 *
 * مراجع انتخاب‌شده (ارزیابی ۲۰۲۶-۱۰-۱۱ — شواهد در docs/SOURCES.md):
 *  • TGJU  — call1.tgju.org/ajax.json (عمومی، بدون کلید، cache ۳۰۰ ثانیه).
 *    نکتهٔ مهم صداقت: مقادیر jahankhahan با TGJU «یکسان» است (اختلاف ۰.۰۰۰٪
 *    در دلار/تتر/طلا/سکه‌ها) — یعنی این مرجع دادهٔ همان بالادست است و
 *    «آشکارساز خرابیِ سمت jahankhahan» است (واحد ریال/تومان، قطع منبع،
 *    مقدار خراب، کهنگی نسبی)، نه داور مستقلِ درستی نرخ بازار.
 *  • Wallex — api.wallex.ir/v1/depth?symbol=USDTTMN (دفتر سفارش واقعی
 *    صرافی؛ مرجع «واقعاً مستقل» برای تتر). قیمت مرجع = میانگین best bid/ask.
 *
 * واحد: نمادهای TGJU ریالیاند → تبدیل به تومان (/10) در همین ماژول.
 * قیمت Wallex از قبل به تومان است (TMN).
 *
 * رفتار fail-safe:
 *  • مرجع در دسترس نبود/parse نشد → «reference-unavailable» → انتشار ادامه
 *    می‌یابد (چک advisory) + لاگ؛ مرجعِ رایگان نباید نقطهٔ شکست انتشار باشد.
 *  • اختلاف بیش از آستانه → «diverged» → تصمیم انتشار با جاب (حذف داده یا
 *    کل انتشار) — هرگز «نادیده گرفتن» اختلاف.
 *  • هیچ مقداری از مرجع جایگزین منبع اصلی نمی‌شود (اصل fail-closed پروژه).
 */

export const TGJU_DEFAULT_URL = "https://call1.tgju.org/ajax.json";
export const WALLEX_DEPTH_DEFAULT_URL =
  "https://api.wallex.ir/v1/depth?symbol=USDTTMN";

/** مهلت درخواست مرجع (هم‌اندازه provider اصلی) */
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * حداکثر عمر مجاز «مرجع» TGJU — همان پنجرهٔ ۷۲ ساعتهٔ منبع اصلی
 * (پوشش تعطیلی هفتگی بازار). مهر زمانی قدیمی‌تر → مرجع قابل استفاده نیست.
 */
const MAX_REFERENCE_AGE_MS = 72 * 60 * 60 * 1000;

export interface CrossCheckConfig {
  enabled: boolean;
  /** آستانهٔ اختلاف ارزها (٪) — دلار/یورو/پوند/درهم/لیر */
  fxTolerancePct: number;
  /** آستانهٔ اختلاف طلا و سکه (٪) — نوسان بالاتر این گروه */
  goldTolerancePct: number;
  /** آستانهٔ اختلاف تتر (٪) — مرجع صرافیِ مستقل، اسپرد واقعی دارد */
  tetherTolerancePct: number;
  tgjuUrl: string;
  wallexUrl: string;
}

/** ساخت پیکربندی از env (parseشده در src/env.ts — مقادیر از قبل معتبرند) */
export function crossCheckConfigFromEnv(env: {
  CROSS_CHECK_ENABLED: boolean;
  CROSS_CHECK_FX_TOLERANCE_PCT: number;
  CROSS_CHECK_GOLD_TOLERANCE_PCT: number;
  CROSS_CHECK_TETHER_TOLERANCE_PCT: number;
  TGJU_REFERENCE_URL: string;
  WALLEX_MARKETS_URL: string;
}): CrossCheckConfig {
  return {
    enabled: env.CROSS_CHECK_ENABLED,
    fxTolerancePct: env.CROSS_CHECK_FX_TOLERANCE_PCT,
    goldTolerancePct: env.CROSS_CHECK_GOLD_TOLERANCE_PCT,
    tetherTolerancePct: env.CROSS_CHECK_TETHER_TOLERANCE_PCT,
    tgjuUrl: env.TGJU_REFERENCE_URL,
    wallexUrl: env.WALLEX_MARKETS_URL,
  };
}

/** نگاشت نماد گزارش → کلید TGJU (همهٔ این نمادها در TGJU «ریالی»اند) */
export const TGJU_SYMBOL_MAP: Readonly<Partial<Record<ReportSymbol, string>>> =
  {
    usd: "price_dollar_rl",
    usdt: "crypto-tether-irr",
    eur: "price_eur",
    gbp: "price_gbp",
    try: "price_try",
    aed: "price_aed",
    gold18k: "geram18",
    gold24k: "geram24",
    mesghal: "mesghal",
    emami: "sekee",
    bahar: "sekeb",
    halfCoin: "nim",
    quarterCoin: "rob",
    germi: "gerami",
    // ounce در TGJU نماد تومانی ندارد (دلاری است) → بدون چک
  };

/** گروه آستانهٔ هر نماد — بر اساس نوع بازار (ارز/طلا/تتر) */
export function tolerancePctFor(
  symbol: ReportSymbol,
  cfg: CrossCheckConfig,
): number {
  if (symbol === "usdt") return cfg.tetherTolerancePct;
  const goldGroup: readonly ReportSymbol[] = [
    "gold18k",
    "gold24k",
    "mesghal",
    "emami",
    "bahar",
    "halfCoin",
    "quarterCoin",
    "germi",
  ];
  return goldGroup.includes(symbol) ? cfg.goldTolerancePct : cfg.fxTolerancePct;
}

// ---------- پاسخ مرجع ----------

export interface ReferenceQuote {
  /** مقدار به «تومان» */
  value: number;
  /** مهر زمانی دادهٔ مرجع (ISO) — Wallex دفتر زنده است و ts ندارد */
  ts: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** «2,651,000» / 2651000 → عدد تومان (نماد ریالی ÷ ۱۰) */
function rialStringToToman(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const cleaned = String(raw).replace(/,/g, "").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 10);
}

const TGJU_TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** مهر زمانی TGJU «YYYY-MM-DD HH:MM:SS» به وقت تهران → ISO؛ نامعتبر → null */
function parseTgjuTimestamp(ts: unknown): Date | null {
  if (typeof ts !== "string") return null;
  const m = TGJU_TS_RE.exec(ts.trim());
  if (!m) return null;
  const epochMs =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) -
    TEHRAN_OFFSET_MINUTES * 60_000;
  const parsed = new Date(epochMs);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** GET JSON با redirect manual (workerd) + timeout — ناموفق → null */
async function fetchJson(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown | null> {
  const source = new URL(url).hostname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      logWarn("crosscheck.http-status", { source, status: response.status });
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/application\/json/i.test(contentType)) {
      logWarn("crosscheck.non-json", { source, contentType });
      return null;
    }
    return await response.json();
  } catch (err) {
    logWarn("crosscheck.fetch-error", {
      source,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Snapshot نمادهای TGJU — یک fetch برای همهٔ نمادها (صرفهٔ درخواست).
 * خروجی: Map<کلیدTGJU, نرخ تومان>. مرجع در دسترس نیست → null.
 */
export async function fetchTgjuSnapshot(
  url: string,
  fetchFn: typeof fetch,
  now: () => Date = () => new Date(),
): Promise<Map<string, ReferenceQuote> | null> {
  const raw = await fetchJson(url, fetchFn);
  const root = asRecord(raw);
  const current = asRecord(root?.["current"]);
  if (!current) {
    logWarn("crosscheck.tgju.invalid-payload", { source: "tgju" });
    return null;
  }

  const quotes = new Map<string, ReferenceQuote>();
  const nowMs = now().getTime();
  let stale = 0;
  for (const [key, item] of Object.entries(current)) {
    const rec = asRecord(item);
    if (!rec) continue;
    const value = rialStringToToman(rec.p);
    if (value === null) continue;
    const tsDate = parseTgjuTimestamp(rec.ts);
    // مهر کهنهٔ نماد → آن نماد مرجع معتبری نیست (کل snapshot نمیپرد)
    if (tsDate && nowMs - tsDate.getTime() > MAX_REFERENCE_AGE_MS) {
      stale += 1;
      continue;
    }
    quotes.set(key, { value, ts: tsDate ? tsDate.toISOString() : null });
  }
  if (quotes.size === 0) {
    logWarn("crosscheck.tgju.empty", { source: "tgju", stale });
    return null;
  }
  if (stale > 0) {
    logInfo("crosscheck.tgju.stale-symbols-skipped", { source: "tgju", stale });
  }
  return quotes;
}

/** نرخ تومانی یک نماد مشخص TGJU — یک fetch */
export async function fetchTgjuQuote(
  tgjuKey: string,
  url: string,
  fetchFn: typeof fetch,
  now: () => Date = () => new Date(),
): Promise<ReferenceQuote | null> {
  const snapshot = await fetchTgjuSnapshot(url, fetchFn, now);
  return snapshot?.get(tgjuKey) ?? null;
}

/**
 * نرخ مرجع تتر از Wallex — میانگین بهترین خرید/فروش دفتر سفارش (تومان).
 * مرجع در دسترس نیست → null.
 */
export async function fetchWallexUsdtToman(
  url: string,
  fetchFn: typeof fetch,
): Promise<ReferenceQuote | null> {
  const raw = await fetchJson(url, fetchFn);
  const root = asRecord(raw);
  const result = asRecord(root?.["result"]);
  const ask = Array.isArray(result?.["ask"]) ? (result?.["ask"] as unknown[]) : null;
  const bid = Array.isArray(result?.["bid"]) ? (result?.["bid"] as unknown[]) : null;
  if (!ask?.length || !bid?.length) {
    logWarn("crosscheck.wallex.invalid-payload", { source: "wallex" });
    return null;
  }
  const priceOf = (level: unknown): number | null => {
    const rec = asRecord(level);
    const p = rec?.["price"];
    const n = typeof p === "number" ? p : Number(p);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const asks = ask.map(priceOf).filter((p): p is number => p !== null);
  const bids = bid.map(priceOf).filter((p): p is number => p !== null);
  if (!asks.length || !bids.length) {
    logWarn("crosscheck.wallex.invalid-levels", { source: "wallex" });
    return null;
  }
  const bestAsk = Math.min(...asks);
  const bestBid = Math.max(...bids);
  const mid = (bestAsk + bestBid) / 2;
  if (bestBid > bestAsk) {
    // دفتر سفارش معکلس (bid>ask) = دادهٔ خراب → مرجع قابل استفاده نیست
    logWarn("crosscheck.wallex.crossed-book", { source: "wallex" });
    return null;
  }
  return { value: Math.round(mid), ts: null };
}

// ---------- مقایسه ----------

export type CrossCheckVerdict =
  | "match"
  | "diverged"
  | "reference-unavailable";

export interface CrossCheckOutcome {
  verdict: CrossCheckVerdict;
  /** اختلاف درصد (علامت‌دار) — فقط وقتی مرجع موجود است */
  diffPct: number | null;
  /** نرخ مرجع (تومان) */
  reference: number | null;
}

/**
 * مقایسهٔ نرخ منبع با مرجع — آستانه بر حسب درصد.
 * مرجع غایب/نامعتبر → reference-unavailable (advisory؛ انتشار آزاد).
 * |diff| > tolerance → diverged (تصمیم انتشار با جاب).
 */
export function compareWithReference(
  value: number,
  reference: ReferenceQuote | null,
  tolerancePct: number,
): CrossCheckOutcome {
  if (
    reference === null ||
    !Number.isFinite(reference.value) ||
    reference.value <= 0 ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return { verdict: "reference-unavailable", diffPct: null, reference: null };
  }
  const diffPct = ((value - reference.value) / reference.value) * 100;
  const rounded = Math.round(diffPct * 10) / 10;
  if (Math.abs(diffPct) > tolerancePct) {
    return { verdict: "diverged", diffPct: rounded, reference: reference.value };
  }
  return { verdict: "match", diffPct: rounded, reference: reference.value };
}

// ---------- چک گزارش ۶ ساعته (همهٔ آیتمها با یک fetch) ----------

export interface ReportCrossCheckResult {
  /** آیتمها بعد از حذف موارد diverged (مرجع موجود و اختلاف غیرعادی) */
  items: ReportItem[];
  /** نمادهای حذفشده به دلیل اختلاف */
  dropped: ReportSymbol[];
  /** TGJU در دسترس بود؟ (false = چک انجام نشد — advisory) */
  tgjuAvailable: boolean;
  /** Wallex در دسترس بود؟ */
  wallexAvailable: boolean;
}

/**
 * اعتبارسنجی متقاطع آیتمهای گزارش:
 *  • یک fetch از TGJU + یک fetch از Wallex (تتر)
 *  • آیتم بدون نگاشت TGJU (مثل ounce دلاری) → بدون چک، باقی میماند
 *  • diverged → آیتم «حذف» میشود (نه جایگزینی، نه انتشار نرخ مشکوک)
 *  • مرجع غایب → آیتمها دست نخورده میمانند + لاگ (advisory)
 */
export async function crossCheckReportItems(
  cfg: CrossCheckConfig,
  items: ReportItem[],
  fetchFn: typeof fetch,
  now: () => Date = () => new Date(),
): Promise<ReportCrossCheckResult> {
  const result: ReportCrossCheckResult = {
    items,
    dropped: [],
    tgjuAvailable: false,
    wallexAvailable: false,
  };
  if (!cfg.enabled) return result;

  const [tgju, wallex] = await Promise.all([
    fetchTgjuSnapshot(cfg.tgjuUrl, fetchFn, now),
    fetchWallexUsdtToman(cfg.wallexUrl, fetchFn),
  ]);
  result.tgjuAvailable = tgju !== null;
  result.wallexAvailable = wallex !== null;

  const kept: ReportItem[] = [];
  for (const item of items) {
    // تتر → مرجع Wallex (مستقل)؛ بقیه → TGJU
    if (item.symbol === "usdt") {
      if (typeof item.value === "number" && wallex) {
        const outcome = compareWithReference(
          item.value,
          wallex,
          cfg.tetherTolerancePct,
        );
        if (outcome.verdict === "diverged") {
          result.dropped.push(item.symbol);
          logWarn("crosscheck.report.item-diverged", {
            symbol: item.symbol,
            reference: outcome.reference,
            diffPct: outcome.diffPct,
          });
          continue; // حذف آیتم از گزارش
        }
      }
      kept.push(item);
      continue;
    }

    const tgjuKey = TGJU_SYMBOL_MAP[item.symbol];
    if (item.value === null || !tgjuKey || !tgju) {
      kept.push(item); // بدون نگاشت/مرجع → بدون چک
      continue;
    }
    const quote = tgju.get(tgjuKey);
    if (!quote) {
      kept.push(item); // نماد در snapshot نبود → بدون چک
      continue;
    }
    const outcome = compareWithReference(
      item.value,
      quote,
      tolerancePctFor(item.symbol, cfg),
    );
    if (outcome.verdict === "diverged") {
      result.dropped.push(item.symbol);
      logWarn("crosscheck.report.item-diverged", {
        symbol: item.symbol,
        reference: outcome.reference,
        diffPct: outcome.diffPct,
      });
      continue;
    }
    kept.push(item);
  }
  result.items = kept;
  return result;
}
