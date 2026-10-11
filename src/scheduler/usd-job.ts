import type { Env } from "../env";
import { isAllowedPublishTarget } from "../auth/allowlist";
import { logInfo, logWarn } from "../logging";
import {
  DEFAULT_MARKET_HOURS,
  evaluateMarketSession,
  type MarketHoursConfig,
} from "../market-hours";
import {
  compareWithReference,
  crossCheckConfigFromEnv,
  fetchTgjuQuote,
  fetchWallexUsdtToman,
  TGJU_SYMBOL_MAP,
} from "../providers/cross-check";
import type { PriceProvider } from "../providers/provider";
import { getProvider } from "../providers/registry";
import { TelegramClient } from "../telegram/client";
import {
  formatUsdMessage,
  formatUsdMessageClosed,
  formatPinnedUsdSingleRate,
} from "../telegram/format";
import {
  acquireUsdSendLock,
  isPaused,
  LAST_USD_PRICE_KEY,
  markUsdLastEvent,
  readLastUsdPrice,
  readUsdLastEvent,
  recordRunStatusIfChanged,
  readJson,
  releaseUsdSendLock,
  setUsdMessageId,
  USD_STATUS_KEY,
  writeJson,
  PIN_TEXT_KEY,
  PIN_DATA_KEY,
  readPinnedUsdSingleRate,
  type PinnedUsdSingleRate,
} from "../state";
import {
  MAX_REASONABLE_PRICE,
  validateUsdPrice,
  validateUsdPriceShape,
} from "../validation";

/**
 * جاب هر ۵ دقیقه (عبارت cron با گام ۵ دقیقه) — «پیام جدید» در هر اجرای
 * معتبر (دستور مالک ۲۰۲۶-۱۰-۱۱ / راند ۲۸):
 *  • هر اجرای زمان‌بندی‌شدهٔ معتبر → یک پیام جدید با sendMessage.
 *  • پیام‌های قبلی هرگز ویرایش (editMessageText) یا حذف نمی‌شوند.
 *  • حتی با قیمت یکسان، اجرای معتبر بعدی باز هم پیام جدید می‌سازد.
 *  • اجرای مجدد «همان رویداد» (scheduledTime یکسان) پیام مضاعف
 *    نمی‌سازد (گارد usd:last_event + قفل مشورتی KV).
 *  • ساعات fetch/انتشار واقعی با منطق بازار (market-hours) تعیین می‌شود.
 *
 * دو مسیر داده (هر دو fail-closed):
 *  ۱) میز خرید/فروش (provider فردایی): fetchUsdTehran → خرید/فروش/معامله
 *  ۲) منابع تک‌نرخی (مثل jahankhahan): fetchMarketReport → نرخ واحد دلار
 *     — خرید=فروش از نرخ واحد «ساخته نمی‌شود»؛ فقط همان یک نرخ واقعی.
 *
 * صرفه‌جویی KV (free plan: ۱۰۰۰ نوشتن/روز):
 *  • وضعیت اجرا فقط در تغییر می‌نویسد (recordRunStatusIfChanged)
 *  • متن/دادهٔ ذخیره‌شده فقط وقتی می‌نویسد که تغییر کند
 *    (id رویداد و id آخرین پیام در هر ارسال موفق نوشته می‌شوند)
 *
 *  • ساعت بازار UNKNOWN → هیچ چیزی منتشر نمی‌شود (قیمت مشکوک ممنوع)
 *  • بازار CLOSED → provider صدا زده نمی‌شود؛ فقط در «گذار» به بسته
 *    شدن یک پیام با «آخرین دادهٔ معتبر» + نشان «بازار بسته» ارسال می‌شود
 *  • هیچ مقدار جایگزین (fallback) ارسال نمی‌شود
 */

/**
 * قالب پیام ثابت (مالک پروژه، ۱۴۰۵/۰۷) — ارقام انگلیسی + بولد HTML:
 *   💸 دلار فردایی تهران 💵 **N** خرید 💸
 *   💸 دلار فردایی تهران 💵 **N** فروش 💵
 *   💸 دلار فردایی تهران 💵 **N** معامله ✅
 *   ━━━━━━━━━━━━━━
 *   💵 قیمت تتر: **N تومان**
 * • نام منبع/زمان دریافت/جزئیات فنی در پیام عمومی نیست
 * • تتر = نرخ مستقل (symbol="usdt" در گزارش) — هرگز برابر دلار فرض نمیشود؛
 *   غایب/نامعتبر = حذف خط تتر از پیام (نه جایگزین)
 * • ارسال با parse_mode=HTML (متن <b> دارد)
 */
export interface JobDeps {
  /** تزریق fetch برای تست */
  fetchFn?: typeof fetch;
  /** ساعت قابل‌تنظیم برای تست */
  now?: () => Date;
  /** override provider برای تست */
  provider?: PriceProvider;
  /** override ساعت بازار برای تست (پیش‌فرض: src/market-hours.ts) */
  marketHours?: MarketHoursConfig;
  /**
   * scheduledTime رویداد Cron (epoch ms از event.scheduledTime).
   * اجرای مجدد «همان رویداد» → پیام مضاعف ساخته نمی‌شود؛ رویداد بعدی
   * (متفاوت) همیشه پیام جدید می‌سازد. غایب (فراخوانی دستی) → فقط قفل.
   */
  scheduledTime?: number;
}

export type JobStatus =
  | "ok"
  | "paused"
  | "no-data"
  | "invalid"
  | "send-error"
  | "provider-error"
  | "market-closed"
  | "market-unknown"
  | "suppressed";

export interface JobResult {
  status: JobStatus;
  reason?: string;
}

export function describeJobResult(result: JobResult): string {
  switch (result.status) {
    case "ok":
      return "✅ پیام دلار جدید در کانال منتشر شد.";
    case "paused":
      return "⏸ انتشار متوقف است؛ با /resume ادامه دهید.";
    case "no-data":
      return "⚠️ داده‌ای از provider دریافت نشد — چیزی منتشر نشد (بدون مقدار جایگزین).";
    case "invalid":
      return `⚠️ داده نامعتبر بود (${result.reason ?? "?"}) — چیزی منتشر نشد.`;
    case "send-error":
      return `❌ خطا در ارسال پیام به کانال: ${result.reason ?? "?"}`;
    case "provider-error":
      return `❌ خطای provider: ${result.reason ?? "?"}`;
    case "market-closed":
      return "🌙 بازار بسته است — پیام با «آخرین قیمت معتبر» ارسال شد.";
    case "market-unknown":
      return "❓ وضعیت ساعت بازار نامشخص است — برای امنیت هیچ چیزی منتشر نشد.";
    case "suppressed":
      return "⏱ اجرای تکراری (هم‌زمان یا مجددِ همان رویداد) — برای جلوگیری از پیام مضاعف نادیده گرفته شد.";
  }
}

type Recorder = (
  status: JobStatus,
  reason?: string,
) => Promise<JobResult>;

export async function runUsdRefresh(
  env: Env,
  deps: JobDeps = {},
): Promise<JobResult> {
  const now = deps.now ?? (() => new Date());
  // صرفه‌جویی KV: وضعیت فقط در تغییر مینویسد
  const record: Recorder = async (status, reason) => {
    await recordRunStatusIfChanged(env.STATE, USD_STATUS_KEY, {
      at: now().toISOString(),
      status,
      reason,
    });
    return { status, reason };
  };

  try {
    if (await isPaused(env.STATE)) {
      const result = await record("paused");
      logInfo("job.usd", { status: result.status });
      return result;
    }

    // ساعت بازار — منبع یگانه: src/market-hours.ts
    const marketHours = deps.marketHours ?? DEFAULT_MARKET_HOURS;
    const market = evaluateMarketSession(
      now(),
      marketHours.defaultSession,
      marketHours,
    );

    if (market.state === "UNKNOWN") {
      // fail-closed: قیمت مشکوک در وضعیت نامشخص هرگز منتشر نمی‌شود
      const result = await record("market-unknown", "MARKET_HOURS_UNKNOWN");
      logWarn("job.usd", { status: result.status });
      return result;
    }

    if (market.state === "CLOSED") {
      return await refreshWhileMarketClosed(env, deps, record);
    }

    // ---- OPEN: مسیر ۱ — میز خرید/فروش (providerهای فردایی) ----
    const provider = deps.provider ?? getProvider(env);
    const price = await provider.fetchUsdTehran();
    if (price) {
      const verdict = validateUsdPrice(price, now().getTime());
      if (!verdict.ok) {
        const result = await record("invalid", verdict.reason);
        logWarn("job.usd", {
          status: result.status,
          reason: verdict.reason,
          provider: provider.name,
        });
        return result;
      }

      const text = formatUsdMessage(price);
      // مدل پیام جدید (راند ۲۸): هر اجرای معتبر پیام جدید می‌سازد — حتی
      // با قیمت یکسان؛ پیام قبلی هرگز ویرایش نمی‌شود.
      const lastPinText = await readJson<string>(env.STATE, PIN_TEXT_KEY);
      const published = await sendChannelMessage(env, deps, text, record);
      if (published) return published;
      // KV فقط در تغییر می‌نویسد (سقف نوشتن روزانه)
      if (text !== lastPinText) {
        await writeJson(env.STATE, PIN_TEXT_KEY, text);
        await writeJson(env.STATE, LAST_USD_PRICE_KEY, price);
      }
      const result = await record("ok");
      logInfo("job.usd", { status: result.status, provider: provider.name });
      return result;
    }

    // ---- OPEN: مسیر ۲ — منبع تک‌نرخی (نرخ واحد دلار از گزارش بازار) ----
    return await refreshSingleRate(env, deps, record);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "UNKNOWN";
    const result = await record("provider-error", reason);
    logWarn("job.usd", { status: result.status });
    return result;
  }
}

/** مسیر منبع تک‌نرخی: نرخ واحد دلار از fetchMarketReport */
async function refreshSingleRate(
  env: Env,
  deps: JobDeps,
  record: Recorder,
): Promise<JobResult> {
  const now = deps.now ?? (() => new Date());
  const provider = deps.provider ?? getProvider(env);

  let report;
  try {
    report = await provider.fetchMarketReport();
  } catch (err) {
    const reason = err instanceof Error ? err.message : "UNKNOWN";
    const result = await record("provider-error", reason);
    logWarn("job.usd", { status: result.status });
    return result;
  }

  if (!report) {
    const result = await record("no-data", "SINGLE_RATE_SOURCE_UNAVAILABLE");
    logInfo("job.usd", { status: result.status, provider: provider.name });
    return result;
  }

  const usdItem = report.items.find(
    (item) => item.symbol === "usd" && typeof item.value === "number" && item.value > 0,
  );
  if (!usdItem || usdItem.value == null) {
    const result = await record("no-data", "USD_ITEM_UNAVAILABLE");
    logInfo("job.usd", { status: result.status, provider: provider.name });
    return result;
  }

  // نرخ مستقل تتر — فقط مقدار عددی معتبر؛ غایب/نامعتبر = حذف خط تتر
  // (هرگز از نرخ دلار ساخته نمیشود — دستور مالک پروژه)
  const tetherItem = report.items.find(
    (item) =>
      item.symbol === "usdt" &&
      typeof item.value === "number" &&
      Number.isFinite(item.value) &&
      item.value > 0 &&
      item.value <= MAX_REASONABLE_PRICE,
  );
  const tether = tetherItem?.value ?? null;

  // مدل پیام جدید (راند ۲۸): حتی با قیمت یکسان پیام جدید ارسال می‌شود؛
  // این خواندن فقط برای «نوشتن در تغییر» (سقف KV) است — گیتِ ارسال نیست.
  const lastPinText = await readJson<string>(env.STATE, PIN_TEXT_KEY);

  // ---- اعتبارسنجی متقاطع (بند ۳ مأموریت + دستور مالک ۲۰۲۶-۱۰-۱۱) ----
  // در هر انتشار اجرا می‌شود (هر اجرای معتبر = پیام جدید؛ قیمت یکسان هم
  // باید قبل از انتشار مجدد اعتبارسنجی شود).
  //  • دلار diverged → کل انتشار بلاک + دلیل در status (نرخ مشکوک ممنوع)
  //  • تتر diverged → فقط خط تتر حذف میشود (دادهٔ مشکوک حذف، نه کل پیام)
  //  • تتر بدون مرجع Wallex معتبر → خط تتر منتشر نمیشود (fail-closed؛
  //    مقدار قبلی هم «نرخ تازه» فرض نمیشود) — وضعیت فقط در لاگ/KV
  //  • دلار با مرجع TGJU قطع → advisory: انتشار ادامه (دادهٔ منبع اصلی
  //    خودش معتبر است) + قطع مرجع در لاگ و reason ثبت میشود (متن فنی
  //    هرگز به پیام عمومی نمیرود — قالب عمومی فقط قیمت است).
  const fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
  const cc = crossCheckConfigFromEnv(env);
  let publishUsd = usdItem.value;
  let publishTether = tether;
  // دلیل ثبتشده در status KV (فقط داخلی — هرگز در پیام عمومی):
  //  • TETHER_OMITTED_NO_REFERENCE — مرجع Wallex قطع/نامعتبر
  //  • TETHER_OMITTED_CROSS_CHECK — اختلاف غیرعادی تتر
  //  • CROSS_CHECK_ADVISORY_TGJU_DOWN — مرجع TGJU قطع (انتشار دلار ادامه)
  let okReason: string | undefined;
  if (cc.enabled) {
    const usdRef = await fetchTgjuQuote(
      TGJU_SYMBOL_MAP.usd ?? "price_dollar_rl",
      cc.tgjuUrl,
      fetchFn,
      now,
    );
    const usdOutcome = compareWithReference(
      publishUsd,
      usdRef,
      cc.fxTolerancePct,
    );
    if (usdOutcome.verdict === "diverged") {
      const result = await record(
        "invalid",
        `CROSS_CHECK_DIVERGENCE_USD_${usdOutcome.diffPct}PCT`,
      );
      logWarn("job.usd", {
        status: result.status,
        reason: "CROSS_CHECK_DIVERGENCE",
        symbol: "usd",
        diffPct: usdOutcome.diffPct,
        reference: usdOutcome.reference,
      });
      return result;
    }
    if (usdOutcome.verdict === "reference-unavailable") {
      // مرجع مقایسه قطع است: انتشار دلار ادامه دارد (منبع اصلی معتبر
      // است) — قطع مرجع فقط در لاگ و status KV ثبت میشود؛ هیچ متن
      // فنی به کانال نمیرود (دستور مالک ۲۰۲۶-۱۰-۱۱).
      okReason = "CROSS_CHECK_ADVISORY_TGJU_DOWN";
      logWarn("job.usd", {
        status: "ok",
        reason: okReason,
        symbol: "usd",
        note: "reference unavailable — advisory (publish continues)",
      });
    }
    if (publishTether !== null) {
      const tetherRef = await fetchWallexUsdtToman(cc.wallexUrl, fetchFn);
      const tetherOutcome = compareWithReference(
        publishTether,
        tetherRef,
        cc.tetherTolerancePct,
      );
      if (tetherOutcome.verdict === "diverged") {
        // حذف خط تتر — نرخ مشکوک هرگز منتشر نمیشود (نه جایگزینی)
        publishTether = null;
        okReason = "TETHER_OMITTED_CROSS_CHECK";
        logWarn("job.usd", {
          status: "ok",
          reason: okReason,
          symbol: "usdt",
          diffPct: tetherOutcome.diffPct,
          reference: tetherOutcome.reference,
        });
      } else if (tetherOutcome.verdict === "reference-unavailable") {
        // دستور مالک (۲۰۲۶-۱۰-۱۱): تتر بدون مرجع مستقل معتبر منتشر
        // نمیشود؛ مقدار قبلی هم «نرخ تازه» نمایش داده نمیشود — خط تتر
        // حذف و وضعیت فقط در لاگ/KV ثبت میشود (بدون متن فنی عمومی).
        publishTether = null;
        okReason = "TETHER_OMITTED_NO_REFERENCE";
        logWarn("job.usd", {
          status: "ok",
          reason: okReason,
          symbol: "usdt",
          note: "wallex reference unavailable — tether line withheld",
        });
      }
    }
  }

  const finalText = formatPinnedUsdSingleRate(publishUsd, publishTether, false);
  const published = await sendChannelMessage(env, deps, finalText, record);
  if (published) return published;

  // نوشتن فقط در تغییر (صرفهٔ سقف KV) — پیام جدید در هر اجرا ارسال می‌شود
  if (finalText !== lastPinText) {
    await writeJson(env.STATE, PIN_TEXT_KEY, finalText);
    const pinnedData: PinnedUsdSingleRate = {
      value: publishUsd,
      dataDate: report.dataDate,
      ...(publishTether !== null ? { tether: publishTether } : {}),
    };
    await writeJson(env.STATE, PIN_DATA_KEY, pinnedData);
  }
  const result = await record("ok", okReason);
  logInfo("job.usd", {
    status: result.status,
    reason: result.reason,
    provider: provider.name,
    mode: "single-rate",
    tether: publishTether !== null ? "independent" : "absent",
  });
  return result;
}

/**
 * بازار بسته: provider صدا زده نمی‌شود (بدون fetch جدید)؛ فقط در «گذار»
 * به بسته شدن یک پیام جدید با «آخرین دادهٔ معتبر» + نشان بسته ارسال
 * می‌شود (اجراهای بستهٔ بعدی چیزی نمی‌فرستند — دادهٔ کهنه اسپم نمی‌شود).
 * نبود/خرابی کش = عدم انتشار (هیچ مقدار جایگزین ساخته نمی‌شود).
 */
async function refreshWhileMarketClosed(
  env: Env,
  deps: JobDeps,
  record: Recorder,
): Promise<JobResult> {
  // اولویت ۱: آخرین قیمت میز (providerهای فردایی)
  const cached = await readLastUsdPrice(env.STATE);
  if (cached) {
    // اعتبارسنجی ساختاری (بدون چک تازگی — در بازار بسته داده کهنه طبیعی است)
    const verdict = validateUsdPriceShape(cached);
    if (!verdict.ok) {
      const result = await record("invalid", `CLOSED_${verdict.reason ?? "INVALID"}`);
      logWarn("job.usd", {
        status: "invalid",
        market: "CLOSED",
        reason: verdict.reason,
      });
      return result;
    }

    const text = formatUsdMessageClosed(cached);
    const unchanged = text === (await readJson<string>(env.STATE, PIN_TEXT_KEY));
    if (unchanged) {
      const result = await record("market-closed", "UNCHANGED");
      return result;
    }
    const published = await sendChannelMessage(env, deps, text, record);
    if (published) return published;
    await writeJson(env.STATE, PIN_TEXT_KEY, text);
    const result = await record("market-closed");
    logInfo("job.usd", { status: result.status, market: "CLOSED" });
    return result;
  }

  // اولویت ۲: آخرین نرخ تک‌قیمت (منابع تک‌نرخی)
  const pinned = await readPinnedUsdSingleRate(env.STATE);
  if (pinned) {
    const text = formatPinnedUsdSingleRate(
      pinned.value,
      pinned.tether ?? null,
      true,
    );
    const unchanged = text === (await readJson<string>(env.STATE, PIN_TEXT_KEY));
    if (unchanged) {
      const result = await record("market-closed", "UNCHANGED");
      return result;
    }
    const published = await sendChannelMessage(env, deps, text, record);
    if (published) return published;
    await writeJson(env.STATE, PIN_TEXT_KEY, text);
    const result = await record("market-closed");
    logInfo("job.usd", { status: result.status, market: "CLOSED", mode: "single-rate" });
    return result;
  }

  const result = await record("no-data", "MARKET_CLOSED_NO_CACHE");
  logInfo("job.usd", { status: "no-data", market: "CLOSED" });
  return result;
}

/**
 * انتشار «پیام جدید» در کانال — مقصد انتشار فقط از allowlist (CHANNEL_ID).
 *
 * مدل پیام جدید (راند ۲۸): هر اجرای معتبر یک پیام تازه با sendMessage
 * می‌سازد؛ پیام‌های قبلی هرگز ویرایش یا حذف نمی‌شوند.
 *
 * ضد پیام مضاعف (Cron Triggers «حداقل یک‌بار» اجرا می‌شوند):
 *  ۱) گارد رویداد: scheduledTime مساوی آخرین رویداد پردازش‌شده →
 *     suppressed (اجرای مجدد همان رویداد پیام تکراری نمی‌سازد)؛
 *     رویداد بعدی (۵ دقیقه بعد) همیشه پیام جدید می‌سازد.
 *  ۲) قفل مشورتی KV: اجرای هم‌زمان → suppressed (best-effort؛
 *     KV اتمی نیست — مستند در ممیزی).
 * رویداد قبل از side effect «پردازش‌شده» علامت می‌خورد؛ خطای ارسال با
 * اجرای زمان‌بندی‌شدهٔ بعدی بازیابی می‌شود.
 * خروجی: null = موفق؛ غیر null = نتیجهٔ ثبت‌شده خطا (send-error).
 */
async function sendChannelMessage(
  env: Env,
  deps: JobDeps,
  text: string,
  record: Recorder,
): Promise<JobResult | null> {
  const target = env.CHANNEL_ID;
  if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
    const result = await record("send-error", "TARGET_NOT_ALLOWED");
    logWarn("job.usd", { status: result.status });
    return result;
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
    fetchFn: deps.fetchFn,
  });

  // گارد ۱ — اجرای مجدد همان رویداد Cron (scheduledTime یکسان):
  // پیام مضاعف ساخته نمی‌شود؛ این گارد فقط «ارسال» را می‌پوشاند.
  const eventTime = deps.scheduledTime;
  if (typeof eventTime === "number" && Number.isFinite(eventTime)) {
    const lastEvent = await readUsdLastEvent(env.STATE);
    if (lastEvent !== null && lastEvent === eventTime) {
      const result = await record("suppressed", "DUPLICATE_SAME_EVENT");
      logWarn("job.usd", { status: result.status, reason: result.reason });
      return result;
    }
  }

  // گارد ۲ — قفل مشورتی KV: دو اجرای هم‌زمان نباید دو پیام بسازند
  // (KV اتمی نیست؛ این قفل بهترین تلاش است — مستند در ممیزی، P3).
  const locked = await acquireUsdSendLock(env.STATE);
  if (!locked) {
    const result = await record("suppressed", "DUPLICATE_RUN_LOCKED");
    logWarn("job.usd", { status: result.status, reason: result.reason });
    return result;
  }
  try {
    // رویداد را قبل از side effect علامت‌گذاری می‌کنیم: اجرای مجدد
    // متوالیِ همان رویداد دیگر به sendMessage نمی‌رسد.
    if (typeof eventTime === "number" && Number.isFinite(eventTime)) {
      await markUsdLastEvent(env.STATE, eventTime);
    }
    const sent = await tg.sendMessage(target, text, { parseMode: "HTML" });
    if (!sent.ok || sent.messageId === undefined) {
      const result = await record("send-error", sent.error);
      logWarn("job.usd", { status: result.status, reason: sent.error });
      return result;
    }
    // آخرین پیام منتشرشده — فقط برای مشاهده/وریفای production؛
    // هرگز برای ویرایش خوانده نمی‌شود.
    await setUsdMessageId(env.STATE, sent.messageId);
    return null;
  } finally {
    await releaseUsdSendLock(env.STATE);
  }
}
