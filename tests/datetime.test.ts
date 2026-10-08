import { describe, expect, it } from "vitest";
import {
  faNumber,
  faTehranTime,
  faTimestamp,
  gregorianToJalali,
} from "../src/datetime";

describe("gregorianToJalali — تاریخهای مرجع", () => {
  it("2024-03-20 → 1403/01/01 (نوروز ۱۴۰۳)", () => {
    expect(gregorianToJalali(2024, 3, 20)).toEqual({ jy: 1403, jm: 1, jd: 1 });
  });

  it("2025-03-20 → 1403/12/30 (اسفند سال کبیسه)", () => {
    expect(gregorianToJalali(2025, 3, 20)).toEqual({
      jy: 1403,
      jm: 12,
      jd: 30,
    });
  });

  it("2025-03-21 → 1404/01/01 (نوروز ۱۴۰۴)", () => {
    expect(gregorianToJalali(2025, 3, 21)).toEqual({ jy: 1404, jm: 1, jd: 1 });
  });

  it("2025-10-08 → 1404/07/16", () => {
    expect(gregorianToJalali(2025, 10, 8)).toEqual({
      jy: 1404,
      jm: 7,
      jd: 16,
    });
  });

  it("2026-03-21 → 1405/01/01 (نوروز ۱۴۰۵)", () => {
    expect(gregorianToJalali(2026, 3, 21)).toEqual({ jy: 1405, jm: 1, jd: 1 });
  });
});

describe("faNumber — ارقام و جداکننده فارسی", () => {
  it("گروه‌بندی هزارگان با «٬»", () => {
    expect(faNumber(253_500)).toBe("۲۵۳٬۵۰۰");
  });

  it("پشتیبانی از اعشار «٫»", () => {
    expect(faNumber(2650.45, 2)).toBe("۲٬۶۵۰٫۴۵");
  });

  it("عدد نامعتبر → «—»", () => {
    expect(faNumber(Number.NaN)).toBe("—");
  });
});

describe("faTimestamp — تاریخ شمسی + ساعت تهران", () => {
  it("ISO → «۱۴۰۴/۰۷/۱۶ - ۱۳:۳۰»", () => {
    expect(faTimestamp("2025-10-08T10:00:00Z")).toBe("۱۴۰۴/۰۷/۱۶ - ۱۳:۳۰");
  });

  it("ورودی نامعتبر → «—»", () => {
    expect(faTimestamp("bad")).toBe("—");
  });
});

describe("faTehranTime — آفست +03:30", () => {
  it("10:00 UTC → ۱۳:۳۰", () => {
    expect(faTehranTime(new Date("2025-10-08T10:00:00Z"))).toBe("۱۳:۳۰");
  });

  it("20:45 UTC → ۰۰:۱۵ (گذر از نیمه‌شب)", () => {
    expect(faTehranTime(new Date("2025-10-08T20:45:00Z"))).toBe("۰۰:۱۵");
  });
});
