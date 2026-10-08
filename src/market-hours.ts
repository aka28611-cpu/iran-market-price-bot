import { TEHRAN_OFFSET_MINUTES, tehranParts } from "./datetime";

/**
 * ساعت کاری بازار — «منبع یگانه حقیقت» (single source of truth).
 *
 * قواعد:
 *  • timezone ثابت: Asia/Tehran (ساعت تهران در src/datetime.ts — بدون DST)
 *  • وضعیت سه‌حالته: OPEN | CLOSED | UNKNOWN
 *  • UNKNOWN (config خراب/نامشخص) → fail-closed: هیچ قیمت مشکوکی منتشر نمی‌شود
 *  • ساعتها و تعطیلات «فقط در همین فایل» تعریف می‌شوند — در هیچ فایل دیگری
 *    hard-code نیستند
 *  • ساختار session-based → قابل توسعه برای instrument/providerهای مختلف
 */

export type MarketSessionState = "OPEN" | "CLOSED" | "UNKNOWN";

/** بازه زمانی به وقت تهران — قالب «HH:MM» */
export interface MarketWindow {
  from: string;
  to: string;
}

export interface MarketSessionSchedule {
  /**
   * پنجره‌های باز بازار به تفکیک روز هفته تهران:
   *   ۰ = یکشنبه، ۱ = دوشنبه، …، ۵ = جمعه، ۶ = شنبه
   * روزِ تعریف‌نشده = تعطیل (مثل جمعه = تعطیلی هفتگی)
   */
  windowsByDay: Readonly<Partial<Record<number, readonly MarketWindow[]>>>;
  /** تعطیلات به تاریخ تهران «YYYY-MM-DD» — لیست قابل توسعه در همین فایل */
  holidays: readonly string[];
}

export interface MarketHoursConfig {
  /** فقط Asia/Tehran پشتیبانی می‌شود (ساعت تهران بدون تغییر فصلی) */
  timezone: "Asia/Tehran";
  /** session مورد استفاده جابهای انتشار */
  defaultSession: string;
  /** sessionهای قابل توسعه (به ازای instrument/provider آینده) */
  sessions: Readonly<Record<string, MarketSessionSchedule>>;
}

/**
 * پیکربندی پیش‌فرض — بازار آزاد ارز/طلا تهران.
 * تغییر ساعت/تعطیلات فقط همین‌جا انجام می‌شود.
 */
export const DEFAULT_MARKET_HOURS: MarketHoursConfig = {
  timezone: "Asia/Tehran",
  defaultSession: "tehran-market",
  sessions: {
    "tehran-market": {
      windowsByDay: {
        6: [{ from: "09:00", to: "19:00" }], // شنبه
        0: [{ from: "09:00", to: "19:00" }], // یکشنبه
        1: [{ from: "09:00", to: "19:00" }], // دوشنبه
        2: [{ from: "09:00", to: "19:00" }], // سه‌شنبه
        3: [{ from: "09:00", to: "19:00" }], // چهارشنبه
        4: [{ from: "09:00", to: "13:00" }], // پنجشنبه (نیم‌روز)
        // ۵ = جمعه: تعریف نشده → CLOSED (تعطیلی هفتگی)
      },
      holidays: [], // «YYYY-MM-DD» به وقت تهران — قابل توسعه
    },
  },
};

export interface MarketSessionInfo {
  state: MarketSessionState;
  /** روز هفته تهران (۰=یکشنبه … ۶=شنبه)؛ در UNKNOWN برابر null */
  weekday: number | null;
  /** تاریخ تهران «YYYY-MM-DD»؛ در UNKNOWN برابر null */
  date: string | null;
}

const UNKNOWN_INFO: MarketSessionInfo = {
  state: "UNKNOWN",
  weekday: null,
  date: null,
};

const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** تبدیل «HH:MM» به دقیقه از نیمه‌شب؛ فرمت/بازه نامعتبر → null */
function windowToMinutes(
  w: MarketWindow,
): { from: number; to: number } | null {
  const fromMatch = WINDOW_RE.exec(w.from);
  const toMatch = WINDOW_RE.exec(w.to);
  if (!fromMatch || !toMatch) return null;
  const from = Number(fromMatch[1]) * 60 + Number(fromMatch[2]);
  const to = Number(toMatch[1]) * 60 + Number(toMatch[2]);
  if (to <= from) return null;
  return { from, to };
}

/**
 * ارزیابی وضعیت session بازار در یک لحظه.
 *
 *  • session ناشناس / timezone غیر مجاز / فرمت پنجره خراب / ورودی نامعتبر
 *    → UNKNOWN (fail-closed — فراخواننده نباید هیچ چیزی منتشر کند)
 *  • تعطیلی هفتگی/رسمی یا خارج از پنجره → CLOSED
 */
export function evaluateMarketSession(
  date: Date,
  session: string,
  config: MarketHoursConfig = DEFAULT_MARKET_HOURS,
): MarketSessionInfo {
  try {
    if (!Number.isFinite(date.getTime())) return UNKNOWN_INFO;
    if (config.timezone !== "Asia/Tehran") return UNKNOWN_INFO;

    const schedule = config.sessions[session];
    if (!schedule) return UNKNOWN_INFO;

    const parts = tehranParts(date);
    const weekday = new Date(
      date.getTime() + TEHRAN_OFFSET_MINUTES * 60_000,
    ).getUTCDay();
    const dateStr = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;

    if (schedule.holidays.includes(dateStr)) {
      return { state: "CLOSED", weekday, date: dateStr };
    }

    const windows = schedule.windowsByDay[weekday];
    if (!windows) {
      return { state: "CLOSED", weekday, date: dateStr }; // تعطیلی هفتگی
    }

    const minute = parts.hour * 60 + parts.minute;
    for (const w of windows) {
      const range = windowToMinutes(w);
      if (!range) return UNKNOWN_INFO; // config خراب → UNKNOWN
      if (minute >= range.from && minute < range.to) {
        return { state: "OPEN", weekday, date: dateStr };
      }
    }
    return { state: "CLOSED", weekday, date: dateStr };
  } catch {
    return UNKNOWN_INFO;
  }
}
