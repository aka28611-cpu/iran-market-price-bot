import type { Env } from "../env";
import { isAllowedPublishTarget } from "../auth/allowlist";
import {
  extractUpdateMessage,
  isAuthorizedAdmin,
  parseCommandName,
} from "../auth/telegram-auth";
import { faMoney, faTimestamp } from "../datetime";
import { logError, logInfo, logWarn } from "../logging";
import type { PriceProvider } from "../providers/provider";
import { getProvider } from "../providers/registry";
import { rateLimit } from "../ratelimit";
import {
  isPaused,
  readLastUsdPrice,
  readJson,
  REPORT_STATUS_KEY,
  setPaused,
  USD_STATUS_KEY,
  type RunStatus,
} from "../state";
import { validateUsdPrice } from "../validation";
import { TelegramClient } from "./client";
import { formatUsdMessage } from "./format";
import {
  runUsdRefresh,
  describeJobResult,
  type JobDeps,
} from "../scheduler/usd-job";

/**
 * پردازش updateهای Telegram — فقط دستورات ادمین.
 *
 * جریان امنیتی:
 *  1) استخراج امن message (اعتبارسنجی ساختار)
 *  2) authorization: from.id === ADMIN_USER_ID — غیرادمین بی‌پاسخ
 *  3) rate limit per user
 *  4) اجرای دستور؛ پاسخ فقط به چت «فرستنده احرازشده» می‌رود
 *  5) انتشار (/test) فقط به CHANNEL_ID از allowlist — هرگز chat ورودی
 */

const START_TEXT = [
  "🤖 ربات قیمت بازار ایران",
  "",
  "دستورات ادمین:",
  "/status — وضعیت ربات",
  "/price — قیمت لحظه‌ای دلار فردایی",
  "/update — بروزرسانی فوری پیام کانال",
  "/pause — توقف انتشار خودکار",
  "/resume — ادامه انتشار خودکار",
  "/test — ارسال پیام آزمایشی به کانال",
  "",
  "⚠️ این ربات فقط به ADMIN_USER_ID پاسخ می‌دهد.",
].join("\n");

const TEST_TEXT = "✅ پیام آزمایشی ربات قیمت بازار — اتصال کانال برقرار است.";

/** سقف دستورات هر ادمین در دقیقه */
const COMMAND_RATE_LIMIT = 20;

export async function handleTelegramUpdate(
  update: unknown,
  env: Env,
  deps: JobDeps = {},
): Promise<void> {
  try {
    const message = extractUpdateMessage(update);
    if (!message) return;

    // ۱) authorization — بر اساس from.id، نه chat_id
    if (!isAuthorizedAdmin(message.fromId, env.ADMIN_USER_ID)) {
      logInfo("tg.command.unauthorized", { userId: message.fromId });
      return; // بی‌پاسخ — هیچ اطلاعاتی افشا نمی‌شود
    }

    // ۲) rate limit دستورات (درون-حافظه‌ای)
    if (!rateLimit(`tg:cmd:${message.fromId}`, COMMAND_RATE_LIMIT)) {
      logWarn("tg.command.rate_limited", { userId: message.fromId });
      return;
    }

    const command = parseCommandName(message.text);
    if (!command) return;

    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, {
      fetchFn: deps.fetchFn,
    });

    switch (command) {
      case "start":
        await tg.sendMessage(message.chatId, START_TEXT);
        return;

      case "status":
        await tg.sendMessage(message.chatId, await buildStatusText(env));
        return;

      case "price":
        await tg.sendMessage(message.chatId, await buildPriceText(env, deps));
        return;

      case "update": {
        const result = await runUsdRefresh(env, deps);
        await tg.sendMessage(message.chatId, describeJobResult(result));
        return;
      }

      case "pause":
        await setPaused(env.STATE, true);
        await tg.sendMessage(
          message.chatId,
          "⏸ انتشار خودکار متوقف شد. برای ادامه /resume بفرستید.",
        );
        return;

      case "resume":
        await setPaused(env.STATE, false);
        await tg.sendMessage(message.chatId, "▶️ انتشار خودکار ادامه یافت.");
        return;

      case "test": {
        // مقصد انتشار فقط از allowlist (CHANNEL_ID) — نه چت فرستنده
        const target = env.CHANNEL_ID;
        if (!isAllowedPublishTarget(env.CHANNEL_ID, target)) {
          await tg.sendMessage(
            message.chatId,
            "❌ مقصد مجاز انتشار پیکربندی نشده است.",
          );
          return;
        }
        const sent = await tg.sendMessage(target, TEST_TEXT);
        await tg.sendMessage(
          message.chatId,
          sent.ok
            ? "✅ پیام آزمایشی به کانال ارسال شد."
            : `❌ ارسال به کانال ناموفق بود (${sent.error ?? "UNKNOWN"}).`,
        );
        return;
      }

      default:
        // دستور ناشناس — بی‌پاسخ (عدم افشای فهرست دستورات به غیرادمین ممکن)
        logInfo("tg.command.unknown", { command });
        return;
    }
  } catch (err) {
    logError("tg.update.error", {
      message: err instanceof Error ? err.message : "UNKNOWN",
    });
  }
}

async function buildStatusText(env: Env): Promise<string> {
  const paused = await isPaused(env.STATE);
  const usdStatus = await readJson<RunStatus>(env.STATE, USD_STATUS_KEY);
  const reportStatus = await readJson<RunStatus>(env.STATE, REPORT_STATUS_KEY);
  const lastPrice = await readLastUsdPrice(env.STATE);

  const lines = [
    "📊 وضعیت ربات",
    `وضعیت: ${paused ? "⏸ متوقف (pause)" : "✅ فعال"}`,
    `Provider: ${env.PRICE_PROVIDER}${
      env.PRICE_PROVIDER === "stub" ? " (بدون API واقعی — مرحله بعد)" : ""
    }`,
    `آخرین اجرای دلار: ${
      usdStatus
        ? `${faTimestamp(usdStatus.at)} — ${usdStatus.status}${
            usdStatus.reason ? ` (${usdStatus.reason})` : ""
          }`
        : "—"
    }`,
    `آخرین گزارش بازار: ${
      reportStatus
        ? `${faTimestamp(reportStatus.at)} — ${reportStatus.status}`
        : "—"
    }`,
  ];
  if (lastPrice) {
    lines.push(
      `آخرین قیمت دلار: خرید ${faMoney(lastPrice.buy)} | فروش ${faMoney(
        lastPrice.sell,
      )} | معامله ${faMoney(lastPrice.trade)}`,
    );
  }
  return lines.join("\n");
}

async function buildPriceText(
  env: Env,
  deps: JobDeps,
): Promise<string> {
  let provider: PriceProvider;
  try {
    provider = deps.provider ?? getProvider(env);
  } catch {
    return "❌ provider پیکربندی‌شده معتبر نیست.";
  }
  try {
    const price = await provider.fetchUsdTehran();
    if (!price) {
      return `⚠️ فعلاً داده‌ای از provider دریافت نشد (provider: ${env.PRICE_PROVIDER}). هیچ مقدار جایگزین نمایش داده نمی‌شود.`;
    }
    const verdict = validateUsdPrice(price);
    if (!verdict.ok) {
      return `⚠️ داده دریافت شد اما معتبر نیست (${verdict.reason ?? "?"}) — نمایش داده نمی‌شود.`;
    }
    return formatUsdMessage(price);
  } catch {
    return "❌ خطا در دریافت قیمت از provider.";
  }
}
