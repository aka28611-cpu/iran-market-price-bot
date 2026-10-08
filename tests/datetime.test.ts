import { describe, expect, it } from "vitest";
import {
  faNumber,
  faTehranTime,
  faTimestamp,
  gregorianToJalali,
  jalaliToGregorian,
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

describe("jalaliToGregorian — تاریخهای مرجع (وارونه)", () => {
  it("1405/07/16 → 2026-10-08 (مهر زمانی داده jahankhahan)", () => {
    expect(jalaliToGregorian(1405, 7, 16)).toEqual({
      gy: 2026,
      gm: 10,
      gd: 8,
    });
  });

  it("1403/01/01 → 2024-03-20 (نوروز ۱۴۰۳)", () => {
    expect(jalaliToGregorian(1403, 1, 1)).toEqual({ gy: 2024, gm: 3, gd: 20 });
  });

  it("1403/12/30 → 2025-03-20 (روز کبیسه)", () => {
    expect(jalaliToGregorian(1403, 12, 30)).toEqual({
      gy: 2025,
      gm: 3,
      gd: 20,
    });
  });

  it("1405/01/01 → 2026-03-21 (نوروز ۱۴۰۵)", () => {
    expect(jalaliToGregorian(1405, 1, 1)).toEqual({ gy: 2026, gm: 3, gd: 21 });
  });

  it("round-trip: روز ۱۵ هر ماه، سالهای ۱۳۹۹ تا ۱۴۱۰", () => {
    for (let jy = 1399; jy <= 1410; jy += 1) {
      for (let jm = 1; jm <= 12; jm += 1) {
        const g = jalaliToGregorian(jy, jm, 15);
        expect(gregorianToJalali(g.gy, g.gm, g.gd)).toEqual({
          jy,
          jm,
          jd: 15,
        });
      }
    }
  });

  it("round-trip: ابتدا و انتهای سال (نوروز و پایان اسفند)", () => {
    for (let jy = 1399; jy <= 1410; jy += 1) {
      const first = jalaliToGregorian(jy, 1, 1);
      expect(gregorianToJalali(first.gy, first.gm, first.gd)).toEqual({
        jy,
        jm: 1,
        jd: 1,
      });
      const last = jalaliToGregorian(jy, 12, 29);
      expect(gregorianToJalali(last.gy, last.gm, last.gd)).toEqual({
        jy,
        jm: 12,
        jd: 29,
      });
    }
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
