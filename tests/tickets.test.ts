import { describe, expect, it } from "vitest";
import {
  closeTicket,
  createTicket,
  listOpenTickets,
  listUserTickets,
} from "../src/support/tickets";
import {
  TICKETS_CLOSED_PREFIX,
  TICKETS_COUNT_KEY,
  TICKETS_OPEN_KEY,
} from "../src/state";
import { MockKV } from "./helpers";

const USER_A = 999111222;
const USER_B = 888777666;

describe("createTicket", () => {
  it("ثبت با id ترتیبی و متن trim شده", async () => {
    const kv = new MockKV();
    const r1 = await createTicket(kv, USER_A, "  مشکل دسترسی  ");
    expect(r1.ok).toBe(true);
    expect(r1.ticket?.id).toBe(1);
    expect(r1.ticket?.text).toBe("مشکل دسترسی");
    const r2 = await createTicket(kv, USER_B, "مشکل دوم");
    expect(r2.ticket?.id).toBe(2);
    expect(kv.store.get(TICKETS_COUNT_KEY)).toBe("2");
  });

  it("متن خالی/خیلی بلند رد میشود", async () => {
    const kv = new MockKV();
    expect((await createTicket(kv, USER_A, "   ")).reason).toBe("EMPTY_TEXT");
    expect((await createTicket(kv, USER_A, "x".repeat(513))).reason).toBe(
      "TEXT_TOO_LONG",
    );
  });

  it("سقف ۳ تیکت باز برای هر کاربر", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "1");
    await createTicket(kv, USER_A, "2");
    await createTicket(kv, USER_A, "3");
    const r = await createTicket(kv, USER_A, "4");
    expect(r.reason).toBe("USER_LIMIT_REACHED");
    // کاربر دیگر محدود نمیشود
    expect((await createTicket(kv, USER_B, "ok")).ok).toBe(true);
  });

  it("سقف ۱۰۰ تیکت باز کل", async () => {
    const kv = new MockKV();
    // ۱۰۰ تیکت مستقیم در KV (شبیه state قبلی) — همه کاربران متفاوت
    const open = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      userId: 1_000_000 + i,
      text: `t${i}`,
      createdAt: new Date().toISOString(),
    }));
    await kv.put(TICKETS_OPEN_KEY, JSON.stringify(open));
    const r = await createTicket(kv, USER_A, "به ظرفیت خوردم");
    expect(r.reason).toBe("TOTAL_LIMIT_REACHED");
  });

  it("داده خراب KV → فهرست خالی و ثبت بدون خطا", async () => {
    const kv = new MockKV();
    await kv.put(TICKETS_OPEN_KEY, "{{{corrupt");
    const r = await createTicket(kv, USER_A, "بعد از خرابی");
    expect(r.ok).toBe(true);
    expect(await listOpenTickets(kv)).toHaveLength(1);
  });
});

describe("closeTicket", () => {
  it("بستن → جابجایی به تاریخچه per-user", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "درخواست دسترسی");
    const r = await closeTicket(kv, 1);
    expect(r.ok).toBe(true);
    expect(await listOpenTickets(kv)).toHaveLength(0);
    const history = JSON.parse(
      kv.store.get(`${TICKETS_CLOSED_PREFIX}${USER_A}`) ?? "[]",
    );
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(1);
  });

  it("شماره ناموجود → NOT_FOUND", async () => {
    const kv = new MockKV();
    expect((await closeTicket(kv, 99)).reason).toBe("NOT_FOUND");
  });

  it("سقف تاریخچه ۲۰ تیکت — جدیدترین میماند", async () => {
    const kv = new MockKV();
    const history = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      userId: USER_A,
      text: `h${i}`,
      createdAt: new Date().toISOString(),
    }));
    await kv.put(
      `${TICKETS_CLOSED_PREFIX}${USER_A}`,
      JSON.stringify(history),
    );
    await createTicket(kv, USER_A, "جدید");
    await closeTicket(kv, 1);
    const after = JSON.parse(
      kv.store.get(`${TICKETS_CLOSED_PREFIX}${USER_A}`) ?? "[]",
    );
    expect(after).toHaveLength(20);
    expect(after[0].text).toBe("جدید");
  });
});

describe("listUserTickets — مالکیت فقط سمت سرور", () => {
  it("کاربر فقط تیکتهای خودش را میبیند", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "تیکت الف");
    await createTicket(kv, USER_A, "تیکت الف ۲");
    await createTicket(kv, USER_B, "تیکت ب");
    const a = await listUserTickets(kv, USER_A);
    const b = await listUserTickets(kv, USER_B);
    expect(a.open).toHaveLength(2);
    expect(b.open).toHaveLength(1);
    expect(a.open.every((t) => t.userId === USER_A)).toBe(true);
    expect(a.open.map((t) => t.text)).not.toContain("تیکت ب");
  });

  it("تعداد تیکتهای بستهشده گزارش میشود", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "قابل بستن");
    await closeTicket(kv, 1);
    const { open, closedCount } = await listUserTickets(kv, USER_A);
    expect(open).toHaveLength(0);
    expect(closedCount).toBe(1);
  });
});
