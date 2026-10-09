/**
 * اعتبارسنجی fail-closed متغیرهای محیطی.
 *
 * قواعد:
 *  • هر متغیر مفقود/نامعتبر → EnvError با «نام» متغیرها (هرگز مقدار).
 *  • هیچ مقدار پیش‌فرض حساسی جایگزین نمی‌شود؛ env ناقص = عدم اجرا.
 */

/** حداقل رابط موردنیاز از KV binding (برای تست‌پذیری) */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  // --- Secrets (فقط از Cloudflare Secrets / .dev.vars محلی) ---
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_USER_ID: number;
  CHANNEL_ID: string;
  PRICE_API_KEY: string;
  // --- Vars (غیر حساس) ---
  PRICE_PROVIDER: string;
  PRICE_API_BASE_URL: string;
  /** لینک عمومی کانال (https://t.me/...) — اختیاری؛ برای دکمه «عضویت» */
  CHANNEL_LINK: string;
  /** لینک خارجی پشتیبانی — اختیاری؛ غایب = سیستم تیکت داخلی ربات */
  SUPPORT_LINK: string;
  // --- Bindings ---
  STATE: KVLike;
}

export class EnvError extends Error {
  constructor(
    public readonly missing: string[],
    public readonly invalid: string[],
  ) {
    super(
      `Env validation failed (missing: [${missing.join(", ")}], invalid: [${invalid.join(", ")}])`,
    );
    this.name = "EnvError";
  }
}

/** تلگرام: توکن ربات به شکل <digits>:<token> */
const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{25,}$/;
/** کانال: خصوصی -100xxxxxxxxxx یا عمومی @username */
const CHANNEL_ID_RE = /^(-100\d{4,}|@[A-Za-z0-9_]{5,})$/;

export function parseEnv(raw: unknown): Env {
  const record = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string): string => {
    const value = record[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const missing: string[] = [];
  const invalid: string[] = [];

  const TELEGRAM_BOT_TOKEN = str("TELEGRAM_BOT_TOKEN");
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  else if (!TELEGRAM_TOKEN_RE.test(TELEGRAM_BOT_TOKEN))
    invalid.push("TELEGRAM_BOT_TOKEN");

  const TELEGRAM_WEBHOOK_SECRET = str("TELEGRAM_WEBHOOK_SECRET");
  if (!TELEGRAM_WEBHOOK_SECRET) missing.push("TELEGRAM_WEBHOOK_SECRET");
  else if (TELEGRAM_WEBHOOK_SECRET.length < 16)
    invalid.push("TELEGRAM_WEBHOOK_SECRET");

  const adminRaw = str("ADMIN_USER_ID");
  let ADMIN_USER_ID = 0;
  if (!adminRaw) missing.push("ADMIN_USER_ID");
  else if (!/^\d{1,15}$/.test(adminRaw)) invalid.push("ADMIN_USER_ID");
  else ADMIN_USER_ID = Number(adminRaw);

  const CHANNEL_ID = str("CHANNEL_ID");
  if (!CHANNEL_ID) missing.push("CHANNEL_ID");
  else if (!CHANNEL_ID_RE.test(CHANNEL_ID)) invalid.push("CHANNEL_ID");

  // PRICE_API_KEY اختیاری است تا وقتی provider نیازمند کلید باشد
  const PRICE_API_KEY = str("PRICE_API_KEY");

  // پیش‌فرض امن برای مرحله bootstrap — بدون API واقعی
  const PRICE_PROVIDER = str("PRICE_PROVIDER") || "stub";
  const PRICE_API_BASE_URL = str("PRICE_API_BASE_URL");

  // --- لینکهای عمومی (اختیاری، فقط https://t.me/...) ---
  // اینها فقط «UI دکمهها»اند نه Secret؛ نامعتبر = غایب در نظر گرفته می‌شود
  // (دکمه حذف می‌شود — هرگز URL ساختگی جایگزین نمی‌شود)
  const TELEGRAM_LINK_RE = /^https:\/\/t\.me\/[A-Za-z0-9_+\/-]{2,64}$/;
  const normalizeLink = (key: string): string => {
    const raw = str(key);
    if (!raw) return "";
    const trimmed = raw.replace(/\/+$/, "");
    if (!TELEGRAM_LINK_RE.test(trimmed)) {
      // نامعتبر → دکمه حذف می‌شود (fail-closed برای UI، بدون ازکارافتادن ربات)
      return "";
    }
    return trimmed;
  };
  const CHANNEL_LINK = normalizeLink("CHANNEL_LINK");
  const SUPPORT_LINK = normalizeLink("SUPPORT_LINK");

  const STATE = record["STATE"] as KVLike | undefined;
  if (
    !STATE ||
    typeof STATE.get !== "function" ||
    typeof STATE.put !== "function" ||
    typeof STATE.delete !== "function"
  ) {
    invalid.push("STATE");
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new EnvError(missing, invalid);
  }

  return {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET,
    ADMIN_USER_ID,
    CHANNEL_ID,
    PRICE_API_KEY,
    PRICE_PROVIDER,
    PRICE_API_BASE_URL,
    CHANNEL_LINK,
    SUPPORT_LINK,
    STATE: STATE as KVLike,
  };
}
