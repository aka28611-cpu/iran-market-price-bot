/**
 * ابزار تاریخ/زمان فارسی — بدون هیچ وابستگی خارجی.
 *
 *  • تبدیل میلادی → جلالی (الگوریتم استاندارد jalaali)
 *  • ساعت تهران (UTC+3:30، بدون DST)
 *  • ارقام و جداکنندههای فارسی
 */

// ---------- اعداد فارسی ----------

const FA_DIGIT_MAP: Record<string, string> = {
  "0": "۰",
  "1": "۱",
  "2": "۲",
  "3": "۳",
  "4": "۴",
  "5": "۵",
  "6": "۶",
  "7": "۷",
  "8": "۸",
  "9": "۹",
};

export function faDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => FA_DIGIT_MAP[d] ?? d);
}

/** قالب‌بندی عدد با جداکننده هزارگان «٬» و ممیز «٫» */
export function faNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = value.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = (intPart ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return faDigits(decPart ? `${grouped}٫${decPart}` : grouped);
}

/** پول/قیمت — گرد به عدد صحیح */
export function faMoney(value: number): string {
  return faNumber(Math.round(value));
}

// ---------- زمان تهران ----------

export const TEHRAN_OFFSET_MINUTES = 210; // +03:30 — بدون تغییر ساعت فصلی

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function tehranParts(date: Date): DateParts {
  const shifted = new Date(date.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

// ---------- تبدیل جلالی (jalaali) ----------

const BREAKS: readonly number[] = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097,
  2192, 2262, 2324, 2394, 2456, 3178,
];

// توجه: div/mod بر مبنای truncation (مثل الگوریتم مرجع jalaali) — نه floor
const div = (a: number, b: number): number => Math.trunc(a / b);
const mod = (a: number, b: number): number => a - Math.trunc(a / b) * b;

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  let leapJ = -14;
  let jp = BREAKS[0] as number;
  let jm = 0;
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    jm = BREAKS[i] as number;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  const gy = jy + 621;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  // یافتن تعداد سالهای کبیسه قبق، مطابق الگوریتم مرجع
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** شماره روز (JDN) از تاریخ میلادی — الگوریتم jalaali */
function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** تاریخ میلادی از شماره روز (JDN) — الگوریتم jalaali */
function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export interface JalaliDate {
  jy: number;
  jm: number;
  jd: number;
}

/** تبدیل تاریخ میلادی به جلالی */
export function gregorianToJalali(
  gy: number,
  gm: number,
  gd: number,
): JalaliDate {
  const jdn = g2d(gy, gm, gd);
  const g = d2g(jdn);
  let jy = g.gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(g.gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      // ۱۸۶ روز اول سال
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    // روزهای ابتدای سال تقویم جلالی که در میلادی سال قبل می‌افتند
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

/** شماره روز (JDN) از تاریخ جلالی — الگوریتم jalaali */
function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** تبدیل تاریخ جلالی به میلادی (وارونه‌ی gregorianToJalali) */
export function jalaliToGregorian(
  jy: number,
  jm: number,
  jd: number,
): { gy: number; gm: number; gd: number } {
  return d2g(j2d(jy, jm, jd));
}

// ---------- نمایش فارسی ----------

/** «۱۴۰۴/۰۷/۱۶ - ۱۳:۳۰» به وقت تهران؛ داده نامعتبر → «—» */
export function faTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const parts = tehranParts(new Date(ts));
  const { jy, jm, jd } = gregorianToJalali(
    parts.year,
    parts.month,
    parts.day,
  );
  return `${faDigits(`${jy}/${pad2(jm)}/${pad2(jd)}`)} - ${faDigits(
    `${pad2(parts.hour)}:${pad2(parts.minute)}`,
  )}`;
}

/** «۱۳:۳۰» به وقت تهران */
export function faTehranTime(date: Date): string {
  const p = tehranParts(date);
  return faDigits(`${pad2(p.hour)}:${pad2(p.minute)}`);
}
