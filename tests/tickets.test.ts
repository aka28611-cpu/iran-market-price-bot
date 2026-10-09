import { describe, expect, it } from "vitest";
import {
  addTicketReply,
  closeTicket,
  createTicket,
  getOpenTicket,
  listOpenTickets,
  listUserTickets,
} from "../src/support/tickets";
import {
  TICKETS_CLOSED_PREFIX,
  TICKETS_COUNT_KEY,
  TICKETS_OPEN_KEY,
} from "../src/state";
import { ADMIN_USER_ID, MockKV } from "./helpers";

const USER_A = 999111222;
const USER_B = 888777666;

describe("createTicket", () => {
  it("ثبت با id ترتیبی، موضوع و متن trim شده", async () => {
    const kv = new MockKV();
    const r1 = await createTicket(kv, USER_A, "  دسترسی  ", "  مشکل دسترسی  ");
    expect(r1.ok).toBe(true);
    expect(r1.ticket?.id).toBe(1);
    expect(r1.ticket?.subject).toBe("دسترسی");
    expect(r1.ticket?.text).toBe("مشکل دسترسی");
    expect(r1.ticket?.replies).toEqual([]);
    const r2 = await createTicket(kv, USER_B, "موضوع ۲", "مشکل دوم");
    expect(r2.ticket?.id).toBe(2);
    expect(kv.store.get(TICKETS_COUNT_KEY)).toBe("2");
  });

  it("موضوع خالی/بلند و متن خالی/بلند رد میشود", async () => {
    const kv = new MockKV();
    expect((await createTicket(kv, USER_A, "   ", "متن")).reason).toBe(
      "EMPTY_SUBJECT",
    );
    expect(
      (await createTicket(kv, USER_A, "x".repeat(81), "متن")).reason,
    ).toBe("SUBJECT_TOO_LONG");
    expect((await createTicket(kv, USER_A, "موضوع", "   ")).reason).toBe(
      "EMPTY_TEXT",
    );
    expect(
      (await createTicket(kv, USER_A, "موضوع", "x".repeat(513))).reason,
    ).toBe("TEXT_TOO_LONG");
  });

  it("سقف ۳ تیکت باز برای هر کاربر", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "1");
    await createTicket(kv, USER_A, "s", "2");
    await createTicket(kv, USER_A, "s", "3");
    const r = await createTicket(kv, USER_A, "s", "4");
    expect(r.reason).toBe("USER_LIMIT_REACHED");
    // کاربر دیگر محدود نمیشود
    expect((await createTicket(kv, USER_B, "s", "ok")).ok).toBe(true);
  });

  it("سقف ۱۰۰ تیکت باز کل", async () => {
    const kv = new MockKV();
    // ۱۰۰ تیکت مستقیم در KV (شبیه state قبلی) — همه کاربران متفاوت
    const open = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      userId: 1_000_000 + i,
      subject: `s${i}`,
      text: `t${i}`,
      createdAt: new Date().toISOString(),
      replies: [],
    }));
    await kv.put(TICKETS_OPEN_KEY, JSON.stringify(open));
    const r = await createTicket(kv, USER_A, "s", "به ظرفیت خوردم");
    expect(r.reason).toBe("TOTAL_LIMIT_REACHED");
  });

  it("داده خراب KV → فهرست خالی و ثبت بدون خطا", async () => {
    const kv = new MockKV();
    await kv.put(TICKETS_OPEN_KEY, "{{{corrupt");
    const r = await createTicket(kv, USER_A, "s", "بعد از خرابی");
    expect(r.ok).toBe(true);
    expect(await listOpenTickets(kv)).toHaveLength(1);
  });

  it("مهاجرت دفاعی: تیکت قدیمی بدون subject/replies مشتق میشود", async () => {
    const kv = new MockKV();
    await kv.put(
      TICKETS_OPEN_KEY,
      JSON.stringify([
        {
          id: 7,
          userId: USER_A,
          text: "متن طولانی تیکت قدیمی که موضوع ندارد و باید مشتق شود",
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    const ticket = await getOpenTicket(kv, 7);
    expect(ticket?.subject).toContain("متن طولانی تیکت قدیمی");
    expect(ticket?.replies).toEqual([]);
  });
});

describe("addTicketReply — مالکیت و نقش فقط سمت سرور", () => {
  it("صاحب تیکت با نقش user پاسخ میدهد؛ آخرین reply میماند", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "متن");
    const r = await addTicketReply(kv, 1, USER_A, "user", "پاسخ من", ADMIN_USER_ID);
    expect(r.ok).toBe(true);
    expect(r.ticket?.replies).toHaveLength(1);
    expect(r.ticket?.replies[0]).toMatchObject({
      from: "user",
      text: "پاسخ من",
    });
  });

  it("کاربر دیگر با نقش user رد میشود (FORBIDDEN)", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "متن");
    const r = await addTicketReply(kv, 1, USER_B, "user", "هک", ADMIN_USER_ID);
    expect(r.reason).toBe("FORBIDDEN");
  });

  it("کاربر معمولی با نقش support رد میشود؛ فقط ادمین مجاز است", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "متن");
    const r = await addTicketReply(kv, 1, USER_B, "support", "جعل نقش", ADMIN_USER_ID);
    expect(r.reason).toBe("FORBIDDEN");
    const ok = await addTicketReply(
      kv,
      1,
      ADMIN_USER_ID,
      "support",
      "پاسخ پشتیبانی",
      ADMIN_USER_ID,
    );
    expect(ok.ok).toBe(true);
    expect(ok.ticket?.replies[0]?.from).toBe("support");
  });

  it("پاسخ خالی/بلند و تیکت بسته رد میشود", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "متن");
    expect((await addTicketReply(kv, 1, USER_A, "user", "  ", ADMIN_USER_ID)).reason).toBe(
      "EMPTY_TEXT",
    );
    expect(
      (await addTicketReply(kv, 1, USER_A, "user", "x".repeat(513), ADMIN_USER_ID))
        .reason,
    ).toBe("TEXT_TOO_LONG");
    await closeTicket(kv, 1);
    expect((await addTicketReply(kv, 1, USER_A, "user", "بعد از بستن", ADMIN_USER_ID)).reason).toBe(
      "NOT_FOUND",
    );
  });
});

describe("closeTicket", () => {
  it("بستن → جابجایی به تاریخچه per-user", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "درخواست دسترسی");
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
      subject: `s${i}`,
      text: `h${i}`,
      createdAt: new Date().toISOString(),
      replies: [],
    }));
    await kv.put(
      `${TICKETS_CLOSED_PREFIX}${USER_A}`,
      JSON.stringify(history),
    );
    await createTicket(kv, USER_A, "s", "جدید");
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
    await createTicket(kv, USER_A, "s", "تیکت الف");
    await createTicket(kv, USER_A, "s", "تیکت الف ۲");
    await createTicket(kv, USER_B, "s", "تیکت ب");
    const a = await listUserTickets(kv, USER_A);
    const b = await listUserTickets(kv, USER_B);
    expect(a.open).toHaveLength(2);
    expect(b.open).toHaveLength(1);
    expect(a.open.every((t) => t.userId === USER_A)).toBe(true);
    expect(a.open.map((t) => t.text)).not.toContain("تیکت ب");
  });

  it("تعداد تیکتهای بستهشده گزارش میشود", async () => {
    const kv = new MockKV();
    await createTicket(kv, USER_A, "s", "قابل بستن");
    await closeTicket(kv, 1);
    const { open, closedCount } = await listUserTickets(kv, USER_A);
    expect(open).toHaveLength(0);
    expect(closedCount).toBe(1);
  });
});
