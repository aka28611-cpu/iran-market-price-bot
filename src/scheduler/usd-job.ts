import type { Env } from "../env";
import { isAllowedPublishTarget } from "../auth/allowlist";
import { logInfo, logWarn } from "../logging";
import {
  DEFAULT_MARKET_HOURS,
  evaluateMarketSession,
  type MarketHoursConfig,
} from "../market-hours";
import type { PriceProvider } from "../providers/provider";
import { getProvider } from "../providers/registry";
import { TelegramClient } from "../telegram/client";
import {
  formatUsdMessage,
  formatUsdMessageClosed,
  formatPinnedUsdSingleRate,
} from "../telegram/format";
import {
  getUsdMessageId,
  isPaused,
  LAST_USD_PRICE_KEY,
  readLastUsdPrice,
  recordRunStatusIfChanged,
  readJson,
  setUsdMessageId,
  USD_STATUS_KEY,
  writeJson,
  PIN_TEXT_KEY,
  PIN_DATA_KEY,
  readPinnedUsdSingleRate,
  type PinnedUsdSingleRate,
} from "../state";
import { validateUsdPrice, validateUsdPriceShape } from "../validation";

/**
 * جاب هر ۱ دقیقه — بروزرسانی «پیام ثابت» دلار با editMessageText.
 *
 * دو مسیر داده (هر دو fail-closed):
 *  ۱) میز خرید/فروش (provider فردایی): fetchUsdTehran → خرید/فروش/معامله
 *  ۲) منابع تک‌نرخی (مثل jahankhahan): fetchMarketReport → نرخ واحد دلار
 *     — خرید=فروش از نرخ واحد «ساخته نمیشود»؛ فقط همان یک نرخ واقعی.
 *
 * صرفه‌جویی KV (free plan: ۱۰۰۰ نوشتن/روز):
 *  • وضعیت اجرا فقط در تغییر مینویسد (recordRunStatusIfChanged)
 *  • متن/دادهٔ پیام ثابت فقط وقتی مینویسد که تغییر کند
 *  • ویرایش پیام وقتی متن تغییر نکرده انجام نمیشود (نه خطای not-modified، نه اسپم)
 *
 *  • ساعت بازار UNKNOWN → هیچ چیزی منتشر نمیشود (قیمت مشکوک ممنوع)
 *  • بازار CLOSED → provider صدا زده نمیشود؛ فقط «آخرین داده معتبر»
 *    کش‌شده با نشان «بازار بسته» نمایش داده میشود
 *  • هیچ مقدار جایگزین (fallback) ارسال نمیشود
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
}

export type JobStatus =
  | "ok"
  | "paused"
  | "no-data"
  | "invalid"
  | "send-error"
  | "edit-error"
  | "provider-error"
  | "market-closed"
  | "market-unknown";

export interface JobResult {
  status: JobStatus;
  reason?: string;
}

export function describeJobResult(result: JobResult): string {
  switch (result.status) {
    case "ok":
      return result.reason === "UNCHANGED"
        ? "✅ قیمت بدون تغییر است — پیام کانال بهروز است."
        : "✅ پیام دلار در کانال بروزرسانی شد.";
    case "paused":
      return "⏸ انتشار متوقف است؛ با /resume ادامه دهید.";
    case "no-data":
      return "⚠️ داده‌ای از provider دریافت نشد — چیزی منتشر نشد (بدون مقدار جایگزین).";
    case "invalid":
      return `⚠️ داده نامعتبر بود (${result.reason ?? "?"}) — چیزی منتشر نشد.`;
    case "send-error":
      return `❌ خطا در ارسال پیام به کانال: ${result.reason ?? "?"}`;
    case "edit-error":
      return `❌ خطا در ویرایش پیام: ${result.reason ?? "?"}`;
    case "provider-error":
      return `❌ خطای provider: ${result.reason ?? "?"}`;
    case "market-closed":
      return "🌙 بازار بسته است — پیام ثابت با «آخرین قیمت معتبر» بروزرسانی شد.";
    case "market-unknown":
      return "❓ وضعیت ساعت بازار نامشخص است — برای امنیت هیچ چیزی منتشر نشد.";
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
      const unchanged = text === (await readJson<string>(env.STATE, PIN_TEXT_KEY));
      if (unchanged) {
        const result = await record("ok", "UNCHANGED");
        return result;
      }
      const published = await publishPinnedMessage(env, deps, text, record);
      if (published) return published;
      await writeJson(env.STATE, PIN_TEXT_KEY, text);
      await writeJson(env.STATE, LAST_USD_PRICE_KEY, price);
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

  const text = formatPinnedUsdSingleRate(usdItem.value, report.dataDate, false);
  const unchanged = text === (await readJson<string>(env.STATE, PIN_TEXT_KEY));
  if (unchanged) {
    const result = await record("ok", "UNCHANGED");
    return result;
  }

  const published = await publishPinnedMessage(env, deps, text, record);
  if (published) return published;

  // نوشتن فقط در تغییر (صرفه‌جویی سقف KV)
  await writeJson(env.STATE, PIN_TEXT_KEY, text);
  const pinnedData: PinnedUsdSingleRate = {
    value: usdItem.value,
    dataDate: report.dataDate,
  };
  await writeJson(env.STATE, PIN_DATA_KEY, pinnedData);
  const result = await record("ok");
  logInfo("job.usd", { status: result.status, provider: provider.name, mode: "single-rate" });
  return result;
}

/**
 * بازار بسته: provider صدا زده نمیشود (بدون fetch جدید)؛
 * پیام ثابت با «آخرین داده معتبر» کش‌شده + نشان بسته بودن بروزرسانی
 * میشود. نبود/خرابی کش = عدم انتشار (هیچ مقدار جایگزین ساخته نمی‌شود).
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
    const published = await publishPinnedMessage(env, deps, text, record);
    if (published) return published;
    await writeJson(env.STATE, PIN_TEXT_KEY, text);
    const result = await record("market-closed");
    logInfo("job.usd", { status: result.status, market: "CLOSED" });
    return result;
  }

  // اولویت ۲: آخرین نرخ تک‌قیمت (منابع تک‌نرخی)
  const pinned = await readPinnedUsdSingleRate(env.STATE);
  if (pinned) {
    const text = formatPinnedUsdSingleRate(pinned.value, pinned.dataDate, true);
    const unchanged = text === (await readJson<string>(env.STATE, PIN_TEXT_KEY));
    if (unchanged) {
      const result = await record("market-closed", "UNCHANGED");
      return result;
    }
    const published = await publishPinnedMessage(env, deps, text, record);
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
 * انتشار/ویرایش «پیام ثابت» دلار — مقصد انتشار فقط از allowlist (CHANNEL_ID).
 * خروجی: null = موفق؛ غیر null = نتیجه ثبت‌شده خطا (send-error / edit-error).
 */
async function publishPinnedMessage(
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
  const messageId = await getUsdMessageId(env.STATE);

  if (messageId === null) {
    // اولین اجرا: ساخت «پیام ثابت» و ذخیره id آن
    const sent = await tg.sendMessage(target, text);
    if (!sent.ok || sent.messageId === undefined) {
      const result = await record("send-error", sent.error);
      logWarn("job.usd", { status: result.status, reason: sent.error });
      return result;
    }
    await setUsdMessageId(env.STATE, sent.messageId);
    return null;
  }

  // اجراهای بعدی: ویرایش همان پیام — پیام جدیدی ساخته نمی‌شود
  const edited = await tg.editMessageText(target, messageId, text);
  if (!edited.ok) {
    const result = await record("edit-error", edited.error);
    logWarn("job.usd", { status: result.status, reason: edited.error });
    return result;
  }
  return null;
}
