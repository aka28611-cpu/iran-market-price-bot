import {
  TGJU_DEFAULT_URL,
  WALLEX_DEPTH_DEFAULT_URL,
} from "./providers/cross-check";
import {
  DEFAULT_TETHER_SOURCES,
  KNOWN_TETHER_SOURCES,
  NOBITEX_STATS_URL_DEFAULT,
  RAMZINEX_PAIR_URL_DEFAULT,
  type TetherSourceId,
} from "./providers/tether-references";

/**
 * اعتبارسنجی fail-closed متغیرهای محیطی.
 *
 * قواعد:
 *  • هر متغیر مفقود/نامعتبر → EnvError با «نام» متغیرها (هرگز مقدار).
 *  • هیچ مقدار پیش‌فرض حساسی جایگزین نمی‌شود؛ env ناقص = عدم اجرا.
 *  • متغیرهای cross-check اختیاریاند: غایب = پیش‌فرض امن؛ موجودِ خراب =
 *    EnvError (غلط تایپی پیکربندی باید بلند شکست بخورد، نه بی‌صدا کار کند).
 */

/** حداقل رابط موردنیاز از KV binding (برای تست‌پذیری) */
export interface KVPutOptions {
  /** ثانیه تا انقضا (حداقل ۶۰ طبق مستندات KV) */
  expirationTtl?: number;
}

export interface KVLike {
  get(key: string): Promise<string | null>;
  /**
   * put با پشتیبانی اختیاری از TTL.
   * runtime واقعی Workers KV گزینهٔ expirationTtl را می‌پذیرد؛
   * mockهای تست ممکن است آن را نادیده بگیرند.
   */
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
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
  // --- Vars (اعتبارسنجی متقاطع — اختیاری، غیر حساس) ---
  /** فعال بودن مقایسهٔ منبع با مرجع مستقل (پیش‌فرض: فعال) */
  CROSS_CHECK_ENABLED: boolean;
  /** آستانهٔ اختلاف ارزها — درصد (پیش‌فرض ۲.۵) */
  CROSS_CHECK_FX_TOLERANCE_PCT: number;
  /** آستانهٔ اختلاف طلا/سکه — درصد (پیش‌فرض ۵) */
  CROSS_CHECK_GOLD_TOLERANCE_PCT: number;
  /** آستانهٔ اختلاف تتر — درصد (پیش‌فرض ۳) */
  CROSS_CHECK_TETHER_TOLERANCE_PCT: number;
  /** مرجع TGJU (پیش‌فرض: call1.tgju.org/ajax.json) */
  TGJU_REFERENCE_URL: string;
  /** مرجع تتر Wallex (پیش‌فرض: depth USDTTMN) */
  WALLEX_MARKETS_URL: string;
  /**
   * فهرست منابع مرجع تتر (مستقل) — مأموریت ۲۹.
   * پیش‌فرض: wallex,ramzinex,nobitex (مبدأهای مستقل صرافی).
   * آیتم ناشناخته = EnvError (غلط تایپی پیکربندی باید بلند بشکند).
   */
  TETHER_REFERENCE_SOURCES: string;
  /** مرجع تتر Ramzinex — جفت USDT/IRT (ریال؛ سبک ~۱KB) */
  RAMZINEX_PAIR_URL: string;
  /** مرجع تتر Nobitex — آمار USDT/RLS (ریال؛ ~۲KB) */
  NOBITEX_STATS_URL: string;
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

  // --- اعتبارسنجی متقاطع (اختیاری؛ غایب = پیش‌فرض، خراب = خطا) ---
  const parseTolerance = (key: string, fallback: number): number => {
    const raw = str(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 50) {
      invalid.push(key);
      return fallback;
    }
    return n;
  };
  const enabledRaw = str("CROSS_CHECK_ENABLED").trim().toLowerCase();
  if (enabledRaw !== "" && !["true", "false", "1", "0"].includes(enabledRaw)) {
    invalid.push("CROSS_CHECK_ENABLED");
  }
  const CROSS_CHECK_ENABLED =
    enabledRaw === "" ? true : ["true", "1"].includes(enabledRaw);
  const CROSS_CHECK_FX_TOLERANCE_PCT = parseTolerance(
    "CROSS_CHECK_FX_TOLERANCE_PCT",
    2.5,
  );
  const CROSS_CHECK_GOLD_TOLERANCE_PCT = parseTolerance(
    "CROSS_CHECK_GOLD_TOLERANCE_PCT",
    5,
  );
  const CROSS_CHECK_TETHER_TOLERANCE_PCT = parseTolerance(
    "CROSS_CHECK_TETHER_TOLERANCE_PCT",
    3,
  );
  const parseHttpsUrl = (key: string, fallback: string): string => {
    const raw = str(key);
    if (!raw) return fallback;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
        throw new Error("not acceptable");
      }
      return raw;
    } catch {
      invalid.push(key);
      return fallback;
    }
  };
  const TGJU_REFERENCE_URL = parseHttpsUrl("TGJU_REFERENCE_URL", TGJU_DEFAULT_URL);
  const WALLEX_MARKETS_URL = parseHttpsUrl(
    "WALLEX_MARKETS_URL",
    WALLEX_DEPTH_DEFAULT_URL,
  );

  // --- منابع مرجع تتر (مأموریت ۲۹) — فهرست + URLهای هر منبع ---
  const tetherSourcesRaw = str("TETHER_REFERENCE_SOURCES");
  let TETHER_REFERENCE_SOURCES = DEFAULT_TETHER_SOURCES;
  if (tetherSourcesRaw) {
    const ids = [
      ...new Set(
        tetherSourcesRaw
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter((x) => x !== ""),
      ),
    ];
    const unknown = ids.filter(
      (x) => !KNOWN_TETHER_SOURCES.includes(x as TetherSourceId),
    );
    if (unknown.length > 0 || ids.length === 0) {
      invalid.push("TETHER_REFERENCE_SOURCES");
    } else {
      TETHER_REFERENCE_SOURCES = ids.join(",");
    }
  }
  const RAMZINEX_PAIR_URL = parseHttpsUrl(
    "RAMZINEX_PAIR_URL",
    RAMZINEX_PAIR_URL_DEFAULT,
  );
  const NOBITEX_STATS_URL = parseHttpsUrl(
    "NOBITEX_STATS_URL",
    NOBITEX_STATS_URL_DEFAULT,
  );

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
    CROSS_CHECK_ENABLED,
    CROSS_CHECK_FX_TOLERANCE_PCT,
    CROSS_CHECK_GOLD_TOLERANCE_PCT,
    CROSS_CHECK_TETHER_TOLERANCE_PCT,
    TGJU_REFERENCE_URL,
    WALLEX_MARKETS_URL,
    TETHER_REFERENCE_SOURCES,
    RAMZINEX_PAIR_URL,
    NOBITEX_STATS_URL,
    STATE: STATE as KVLike,
  };
}
