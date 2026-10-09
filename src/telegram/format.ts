import { faMoney, faNumber, faTimestamp } from "../datetime";
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
 */

export function formatUsdMessage(price: UsdTehranPrice): string {
  return [
    "💵 دلار فردایی تهران",
    "────────────────",
    `خرید: ${faMoney(price.buy)}`,
    `فروش: ${faMoney(price.sell)}`,
    `معامله: ${faMoney(price.trade)}`,
    "────────────────",
    `🕐 بروزرسانی: ${faTimestamp(price.updatedAt)}`,
  ].join("\n");
}

/**
 * پیام ثابت دلار در حالت «بازار بسته» — همان داده «آخرین قیمت معتبر»
 * (بدون مقدار جدید/ساختگی) با نشان بسته بودن بازار.
 */
export function formatUsdMessageClosed(price: UsdTehranPrice): string {
  return [
    "💵 دلار فردایی تهران",
    "────────────────",
    `خرید: ${faMoney(price.buy)}`,
    `فروش: ${faMoney(price.sell)}`,
    `معامله: ${faMoney(price.trade)}`,
    "────────────────",
    "🌙 بازار بسته است — نمایش آخرین قیمت معتبر",
    `🕐 بروزرسانی: ${faTimestamp(price.updatedAt)}`,
  ].join("\n");
}

/**
 * پیام ثابت «دلار بازار» برای منابع تک‌نرخی (بدون میز خرید/فروش).
 * خرید=فروش=معامله از نرخ واحد ساخته نمیشود — فقط همان یک نرخ واقعی نمایش داده میشود.
 */
export function formatPinnedUsdSingleRate(
  value: number,
  dataDate: string | undefined,
  closed: boolean,
): string {
  return [
    "💵 دلار بازار تهران",
    "────────────────",
    `نرخ دلار: ${faMoney(value)} تومان`,
    "────────────────",
    closed ? "🌙 بازار بسته است — آخرین نرخ معتبر" : "",
    dataDate ? `📅 دادهٔ منبع: ${faTimestamp(dataDate)}` : "",
    "ℹ️ منبع: نرخ واحد بازار (بدون میز خرید/فروش)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

interface ReportMeta {
  group: ReportGroup;
  title: string;
  unit: "toman" | "rial" | "usd";
}

const REPORT_META: Record<ReportSymbol, ReportMeta> = {
  usd: { group: "currency", title: "دلار", unit: "toman" },
  eur: { group: "currency", title: "یورو", unit: "toman" },
  gbp: { group: "currency", title: "پوند", unit: "toman" },
  try: { group: "currency", title: "لیر", unit: "toman" },
  aed: { group: "currency", title: "درهم", unit: "toman" },
  gold18k: { group: "gold", title: "طلای ۱۸ عیار", unit: "toman" },
  gold24k: { group: "gold", title: "طلای ۲۴ عیار", unit: "toman" },
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
    meta.unit === "usd" ? faNumber(item.value, 2) : faMoney(item.value);
  return `${meta.title}: ${value}`;
}

/**
 * گزارش ۶ ساعته — اگر هیچ آیتم معتیری وجود نداشت، null برمی‌گرداند
 * (یعنی هیچ پیامی منتشر نمی‌شود — fail-closed).
 */
export function formatMarketReport(report: MarketReport): string | null {
  const lines: string[] = [
    "📊 گزارش بازار ایران",
    `🕐 ${faTimestamp(report.fetchedAt)}`,
  ];
  // تاریخ دادهٔ منبع (در صورت وجود) — نمایش صادقانهٔ قدم داده
  if (report.dataDate) {
    lines.push(`📅 دادهٔ منبع: ${faTimestamp(report.dataDate)}`);
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
