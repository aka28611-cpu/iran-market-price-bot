import { enTimestamp } from "../datetime";
import type {
  MarketReport,
  ReportGroup,
  ReportItem,
  ReportSymbol,
  UsdTehranPrice,
} from "../types";

/**
 * فرمت پیامهای ربات — فارسی، متن خام و امن (بدون parse_mode).
 *
 * اصل: هیچ مقدار جعلی جایگزین نمی‌شود؛
 * آیتم «نبود» = حذف کامل آن خط از پیام.
 *
 * استثنا: پیام ثابت دلار/تتر (قالب عمومی کانال، ۱۴۰۵/۰۷) — متن
 * HTML-آماده است و با parse_mode=HTML ارسال میشود (<b> = بولد تلگرام؛
 * محتوای پیام هیچ کاراکتر < > & ندارد پس escape لازم نیست).
 * قالب دقیق مالک پروژه:
 *   💸 دلار فردایی تهران 💵 **N** خرید 💸
 *   💸 دلار فردایی تهران 💵 **N** فروش 💵
 *   💸 دلار فردایی تهران 💵 **N** معامله ✅
 *   ━━━━━━━━━━━━━━
 *   💵 قیمت تتر: **N تومان**
 * • ارقام انگلیسی + جداکننده «,»؛ واحد تومان
 * • نام منبع / زمان دریافت داده / جزئیات فنی در پیام عمومی نیست
 * • خطهای خرید/فروش فقط با دادهٔ واقعی میز — از نرخ واحد ساخته نمیشوند
 * • خط تتر فقط با نرخ مستقل تتر — هرگز برابر دلار فرض نمیشود
 *
 * قاعدهٔ ارقام (دستور مالک ۲۰۲۶-۱۰-۱۱): «تمام» خروجی عمومی کانال —
 * پیام ثابت و گزارش ۶ ساعته — فقط با ارقام انگلیسی 0-9 است؛ هیچ رقم
 * فارسی/عربی مجاز نیست (متن فارسی، نام داراییها و چیدمان حفظ میشود).
 */

// ---------- اعداد انگلیسی (قالب عمومی کانال) ----------

/** پول/قیمت با ارقام انگلیسی و جداکننده هزارگان «,» — گرد به عدد صحیح */
export function formatEnMoney(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const grouped = String(Math.abs(rounded)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  return sign + grouped;
}

/** عدد عمومی با ارقام انگلیسی، جداکننده «,» و ممیز «.» (مثل اونس دلاری) */
export function formatEnNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = value.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = (intPart ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart ? `${grouped}.${decPart}` : grouped;
}

// ---------- قالب پیام ثابت دلار (کانال عمومی) ----------

const USD_PIN_TITLE = "دلار فردایی تهران";
const PIN_SEPARATOR = "━━━━━━━━━━━━━━";

/** نرخ تتر معتبر است؟ (فقط برای نمایش — ساخت مقدار ممنوع) */
function isValidTether(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

/** «💸 دلار فردایی تهران 💵 <b>N</b> LABEL EMOJI» */
function usdPinLine(
  value: number,
  label: "خرید" | "فروش" | "معامله",
  tail: string,
): string {
  return `💸 ${USD_PIN_TITLE} 💵 <b>${formatEnMoney(value)}</b> ${label} ${tail}`;
}

/** بلوک تتر: خط خالی + جداکننده + خط تتر — فقط با نرخ مستقل موجود */
function tetherBlock(tether: number): string[] {
  return ["", PIN_SEPARATOR, `💵 قیمت تتر: <b>${formatEnMoney(tether)} تومان</b>`];
}

/** بلوک بازار بسته (نمایش صادقانهٔ آخرین داده معتبر — بدون مقدار جدید) */
const CLOSED_MARK = "🌙 بازار بسته است";

/**
 * پیام ثابت دلار — مسیر میز خرید/فروش (providerهای فردایی).
 * هر سه نرخ واقعیاند؛ تتر فقط اگر دادهٔ مستقل داشته باشد.
 */
export function formatUsdMessage(price: UsdTehranPrice): string {
  const lines: string[] = [
    usdPinLine(price.buy, "خرید", "💸"),
    "",
    usdPinLine(price.sell, "فروش", "💵"),
    "",
    usdPinLine(price.trade, "معامله", "✅"),
  ];
  if (isValidTether(price.tether)) {
    lines.push(...tetherBlock(price.tether));
  }
  return lines.join("\n");
}

/**
 * پیام ثابت دلار در حالت «بازار بسته» — همان قالب + نشان بسته بودن.
 * داده «آخرین قیمت معتبر» است (بدون مقدار جدید/ساختگی).
 */
export function formatUsdMessageClosed(price: UsdTehranPrice): string {
  const base = formatUsdMessage(price);
  return `${base}\n\n${CLOSED_MARK}`;
}

/**
 * پیام ثابت «دلار فردایی تهران» برای منابع تک‌نرخی (بدون میز خرید/فروش).
 *
 * فقط همان «یک نرخ واقعی» نمایش داده میشود — در قالب مالک پروژه،
 * برچسب صادقانهٔ نرخ واحد «معامله» است (آخرین نرخ معاملهٔ بازار).
 * خطهای «خرید»/«فروش» هرگز از نرخ واحد ساخته نمیشوند (مقدار جعلی).
 * تتر فقط با نرخ مستقل معتبر — غایب = حذف خط و جداکننده.
 */
export function formatPinnedUsdSingleRate(
  usd: number,
  tether: number | null,
  closed: boolean,
): string {
  const lines: string[] = [usdPinLine(usd, "معامله", "✅")];
  if (isValidTether(tether)) {
    lines.push(...tetherBlock(tether));
  }
  if (closed) {
    lines.push("", CLOSED_MARK);
  }
  return lines.join("\n");
}

interface ReportMeta {
  group: ReportGroup;
  title: string;
  unit: "toman" | "rial" | "usd";
}

const REPORT_META: Record<ReportSymbol, ReportMeta> = {
  usd: { group: "currency", title: "دلار", unit: "toman" },
  usdt: { group: "currency", title: "تتر", unit: "toman" },
  eur: { group: "currency", title: "یورو", unit: "toman" },
  gbp: { group: "currency", title: "پوند", unit: "toman" },
  try: { group: "currency", title: "لیر", unit: "toman" },
  aed: { group: "currency", title: "درهم", unit: "toman" },
  gold18k: { group: "gold", title: "طلای 18 عیار", unit: "toman" },
  gold24k: { group: "gold", title: "طلای 24 عیار", unit: "toman" },
  mesghal: { group: "gold", title: "مثقال", unit: "toman" },
  goldMelted: { group: "gold", title: "آبشده", unit: "toman" },
  ounce: { group: "gold", title: "اونس جهانی", unit: "usd" },
  emami: { group: "coin", title: "سکه امامی", unit: "toman" },
  bahar: { group: "coin", title: "بهار آزادی", unit: "toman" },
  halfCoin: { group: "coin", title: "نیم سکه", unit: "toman" },
  quarterCoin: { group: "coin", title: "ربع سکه", unit: "toman" },
  germi: { group: "coin", title: "سکه گرمی", unit: "toman" },
};

const GROUP_TITLES: Record<ReportGroup, string> = {
  currency: "💱 ارز",
  gold: "🥇 طلا",
  coin: "🪙 سکه",
};

const GROUP_ORDER: ReportGroup[] = ["currency", "gold", "coin"];

function formatItem(item: ReportItem): string | null {
  if (item.value == null) return null; // نبود داده = حذف خط (نه جایگزین)
  const meta = REPORT_META[item.symbol];
  if (!meta) return null; // نماد ناشناس = حذف
  const value =
    meta.unit === "usd"
      ? formatEnNumber(item.value, 2)
      : formatEnMoney(item.value);
  return `${meta.title}: ${value}`;
}

/**
 * گزارش ۶ ساعته — اگر هیچ آیتم معتیری وجود نداشت، null برمی‌گرداند
 * (یعنی هیچ پیامی منتشر نمی‌شود — fail-closed).
 */
export function formatMarketReport(report: MarketReport): string | null {
  const lines: string[] = [
    "📊 گزارش بازار ایران",
    `🕐 ${enTimestamp(report.fetchedAt)}`,
  ];
  // تاریخ دادهٔ منبع (در صورت وجود) — نمایش صادقانهٔ قدم داده
  if (report.dataDate) {
    lines.push(`📅 دادهٔ منبع: ${enTimestamp(report.dataDate)}`);
  }
  let included = 0;
  for (const group of GROUP_ORDER) {
    const groupLines: string[] = [];
    for (const item of report.items) {
      const meta = REPORT_META[item.symbol];
      if (!meta || meta.group !== group) continue;
      const line = formatItem(item);
      if (line) {
        groupLines.push(line);
        included += 1;
      }
    }
    if (groupLines.length > 0) {
      lines.push("", GROUP_TITLES[group], ...groupLines);
    }
  }
  if (included === 0) return null;
  return lines.join("\n");
}
