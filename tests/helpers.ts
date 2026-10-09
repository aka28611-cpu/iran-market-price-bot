import { parseEnv, type Env, type KVLike } from "../src/env";
import type {
  MarketHoursConfig,
  MarketWindow,
} from "../src/market-hours";
import type { MarketReport, UsdTehranPrice } from "../src/types";
import type { PriceProvider } from "../src/providers/provider";

/**
 * ابزارهای تست — mock KV، env نمونه، رکورد fetch تلگرام، provider فیک.
 * ⚠️ همه مقادیر placeholder هستند — هیچ Secret واقعی در تستها وجود ندارد.
 */

export const FAKE_BOT_TOKEN = "123456:TEST-TOKEN-PLACEHOLDER-0123456789";
export const WEBHOOK_SECRET = "unit-test-webhook-secret-0123456789";
export const ADMIN_USER_ID = 100200300;
export const CHANNEL_ID = "-1001234567890";

/** ساعت بازار همیشه باز — تست جابها بدون وابستگی به سیاست ساعت بازار */
export function alwaysOpenMarketHours(): MarketHoursConfig {
  const windows: Partial<Record<number, readonly MarketWindow[]>> = {};
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    windows[day] = [{ from: "00:00", to: "23:59" }];
  }
  return {
    timezone: "Asia/Tehran",
    defaultSession: "test-always-open",
    sessions: { "test-always-open": { windowsByDay: windows, holidays: [] } },
  };
}

/** ساعت بازار همیشه بسته */
export function alwaysClosedMarketHours(): MarketHoursConfig {
  return {
    timezone: "Asia/Tehran",
    defaultSession: "test-always-closed",
    sessions: {
      "test-always-closed": { windowsByDay: {}, holidays: [] },
    },
  };
}

/** وضعیت نامشخص (session تعریف‌نشده) → fail-closed */
export function alwaysUnknownMarketHours(): MarketHoursConfig {
  return {
    timezone: "Asia/Tehran",
    defaultSession: "test-missing-session",
    sessions: {},
  };
}

export class MockKV implements KVLike {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** env خام (مثل چیزی که Wrangler تزریق می‌کند) — برای تست entry pointها */
export function makeRawEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_USER_ID: String(ADMIN_USER_ID),
    CHANNEL_ID,
    PRICE_PROVIDER: "stub",
    PRICE_API_BASE_URL: "",
    PRICE_API_KEY: "",
    CHANNEL_LINK: "",
    SUPPORT_LINK: "",
    STATE: new MockKV(),
    ...overrides,
  };
}

/** env parseشده — برای فراخوانی مستقیم توابع داخلی */
export function makeEnv(overrides: Partial<Env> = {}): Env {
  const env: Env = {
    TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_USER_ID,
    CHANNEL_ID,
    PRICE_PROVIDER: "stub",
    PRICE_API_BASE_URL: "",
    PRICE_API_KEY: "",
    CHANNEL_LINK: "",
    SUPPORT_LINK: "",
    STATE: new MockKV(),
    ...overrides,
  };
  return parseEnv(makeRawEnv({ ...env, ADMIN_USER_ID: String(env.ADMIN_USER_ID) }));
}

export function makeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>): void {
      pending.push(promise);
    },
    passThroughOnException(): void {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, flush: () => Promise.all(pending) };
}

export function adminUpdate(
  text: string,
  fromId = ADMIN_USER_ID,
  chatId = ADMIN_USER_ID,
) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: fromId, is_bot: false, first_name: "Admin" },
      chat: { id: chatId, type: "private" },
      date: 1_700_000_000,
      text,
    },
  };
}

/** ساخت update پیام کاربر غیرادمین (چت خصوصی) */
export function userUpdate(
  text: string,
  fromId = 999111222,
  chatId = fromId,
) {
  return {
    update_id: 2,
    message: {
      message_id: 20,
      from: { id: fromId, is_bot: false, first_name: "User" },
      chat: { id: chatId, type: "private" },
      date: 1_700_000_000,
      text,
    },
  };
}

/** ساخت update دکمه callback (چت خصوصی) */
export function callbackUpdate(
  data: string,
  fromId = 999111222,
  chatId = fromId,
) {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-query-1",
      from: { id: fromId, is_bot: false, first_name: "User" },
      message: {
        message_id: 30,
        chat: { id: chatId, type: "private" },
        date: 1_700_000_000,
        text: "buttons",
      },
      data,
    },
  };
}

export interface RecorderOptions {
  /** وضعیت عضویت که getChatMember برمی‌گرداند (پیشفرض "member") */
  memberStatus?: string;
  /** خطای API برای getChatMember (≠ عدم عضویت) */
  memberError?: string;
}

/** fetch فیک تلگرام — همه فراخوانیها را برای assertion ثبت می‌کند */
export function telegramRecorder(options: RecorderOptions = {}) {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: String(url), body: raw ? JSON.parse(raw) : {} });
    const method = String(url).split("/").pop() ?? "";
    if (method === "getChatMember") {
      if (options.memberError) {
        return new Response(
          JSON.stringify({ ok: false, description: options.memberError }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: { status: options.memberStatus ?? "member" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "answerCallbackQuery") {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const isEdit = String(url).includes("editMessageText");
    const payload = { ok: true, result: isEdit ? true : { message_id: 100 } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** فراخوانیها فقط با متد sendMessage */
export function sentMessages(
  calls: Array<{ url: string; body: Record<string, unknown> }>,
): Array<{ url: string; body: Record<string, unknown> }> {
  return calls.filter((c) => c.url.endsWith("/sendMessage"));
}

export function fakeUsdPrice(
  overrides: Partial<UsdTehranPrice> = {},
): UsdTehranPrice {
  return {
    buy: 253_000,
    sell: 254_200,
    trade: 253_800,
    updatedAt: new Date().toISOString(),
    source: "fake-test",
    ...overrides,
  };
}

export function fakeProvider(
  usd: UsdTehranPrice | null = null,
  report: MarketReport | null = null,
): PriceProvider {
  return {
    name: "fake",
    async fetchUsdTehran() {
      return usd;
    },
    async fetchMarketReport() {
      return report;
    },
  };
}
