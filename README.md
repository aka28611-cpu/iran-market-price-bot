# iran-market-price-bot 🇮🇷

ربات تلگرام مستقل برای دریافت قیمت‌های بازار ایران و انتشار خودکار در یک کانال تلگرام،
بر پایه **Cloudflare Worker + Cron Triggers + Telegram Bot API** (زبان: TypeScript).

> **وضعیت فعلی — مرحله ۲ (Push + Deploy):** Worker روی Cloudflare مستقر است (Cron هر ۱ دقیقه و هر ۶ ساعت + KV STATE)؛ تا تنظیم Secretها همه جابها به‌صورت fail-closed رد می‌شوند (بدون هیچ تماس خارجی) و هیچ وب‌هوکی ثبت نشده است.
> ساختار کامل پروژه، جابهای زمان‌بندی، فرمتر پیام، دستورات ادمین و مجموعه تستها آماده است؛
> اما **provider قیمت هنوز متصل نشده** (`PRICE_PROVIDER=stub` عمداً هیچ داده‌ای تولید نمی‌کند)
> و **هیچ Secret واقعی تنظیم نشده است**. طبق سیاست پروژه: هیچ API واقعی بدون مشخص‌شدن
> provider هارد-کد نمی‌شود و هیچ مقدار ساختگی/تخمینی هم تولید نمی‌شود.

---

## معماری

```
Price API (provider)
        ↓
Cloudflare Worker   GET  /healthz           → {"ok":true} (حداقلی، بدون diagnostic)
                   POST /telegram/webhook   → دستورات ادمین (رمزدار)
        ↓
Cron Trigger «* * * * *»  هر ۱ دقیقه
        → دلار فردایی تهران: خرید / فروش / معامله / زمان آخرین بروزرسانی
        → editMessageText روی «یک پیام ثابت» (message_id در KV) — پیام جدیدی ساخته نمی‌شود
        ↓
Telegram Bot API → Telegram Channel

Cron Trigger «0 */6 * * *»  هر ۶ ساعت
        → گزارش کامل بازار: ارز / طلا / سکه (فقط موارد موجود در provider)
        → sendMessage جدید به کانال
```

## ساعت بازار (Market Hours)

ماژول `src/market-hours.ts` — **منبع یگانه** ساعت‌های بازار؛ هیچ فایل دیگری ساعت بازار را hard-code نمی‌کند:

| وضعیت | رفتار |
|---|---|
| `OPEN` | روال عادی: دریافت از provider ← اعتبارسنجی کامل (شامل تازگی) ← انتشار |
| `CLOSED` | provider صدا زده نمی‌شود؛ پیام ثابت با «آخرین قیمت معتبر» ذخیره‌شده در KV + نشان «بازار بسته است» |
| `UNKNOWN` | **fail-closed** — هیچ چیزی منتشر نمی‌شود (قیمت مشکوک ممنوع؛ بدون fetch و بدون ارسال) |

- Timezone: `Asia/Tehran` (بدون DST — هماهنگ با `src/datetime.ts`)
- تعطیلی هفتگی: روزهای بدون پنجره (پیش‌فرض: جمعه)
- تعطیلات رسمی: لیست `holidays` در همان فایل، به تاریخ «YYYY-MM-DD» تهران — قابل توسعه
- توسعه‌پذیری: ساختار `sessions` برای instrument/providerهای مختلف (هر session پنجره‌های خودش را دارد)
- پیش‌فرض فعلی: شنبه تا چهارشنبه ۰۹:۰۰–۱۹:۰۰ | پنجشنبه نیم‌روز ۰۹:۰۰–۱۳:۰۰ | جمعه تعطیل

## قابلیت‌ها

### هر ۱ دقیقه — دلار فردایی تهران
- خرید، فروش، آخرین معامله و زمان آخرین بروزرسانی
- پیام **ثابت** کانال با `editMessageText` بروزرسانی می‌شود (id پیام در KV ذخیره است)

### هر ۶ ساعت — گزارش بازار
- ارز: دلار، یورو، پوند، لیر، درهم (در صورت وجود)
- طلا: ۱۸ عیار، ۲۴ عیار (در صورت وجود)، مثقال، آبشده (در صورت وجود)، اونس جهانی
- سکه: امامی، بهار آزادی، نیم، ربع، گرمی
- هر آیتمی که در provider نباشد از پیام حذف می‌شود — **هیچ مقدار ساختگی جایگزین نمی‌شود**

### دستورات ادمین (فقط `ADMIN_USER_ID`)
| دستور | کارکرد |
|---|---|
| `/start` | معرفی و فهرست دستورات |
| `/status` | وضعیت ربات: provider، آخرین اجراها، آخرین قیمت، وضعیت pause |
| `/price` | دریافت فوری قیمت دلار (فقط برای نمایش به ادمین) |
| `/update` | اجرای فوری جاب ۱ دقیقه و گزارش نتیجه |
| `/pause` | توقف انتشار خودکار |
| `/resume` | ادامه انتشار خودکار |
| `/test` | ارسال پیام آزمایشی به کانال پیکربندی‌شده |

## ساختار پروژه

```
├── wrangler.toml              تنظیمات Worker + Cronها + KV
├── src/
│   ├── index.ts               ورودی Worker (fetch + scheduled)
│   ├── router.ts              سطح HTTP حداقلی (healthz + webhook)
│   ├── env.ts                 اعتبارسنجی fail-closed متغیرها
│   ├── types.ts               تایپ‌های دامنه (قیمت/گزارش)
│   ├── logging.ts             لاگ JSON با redaction خودکار Secret
│   ├── ratelimit.ts           rate limit درون-حافظه‌ای
│   ├── validation.ts          اعتبارسنجی قیمت (بدون fallback)
│   ├── datetime.ts            تاریخ شمسی + ساعت تهران + ارقام فارسی
│   ├── market-hours.ts        ساعت بازار (OPEN/CLOSED/UNKNOWN) — منبع یگانه
│   ├── state.ts               وضعیت ربات در KV
│   ├── auth/                  authentication و authorization
│   ├── providers/             PriceProvider interface + stub + registry
│   ├── telegram/              کلاینت Bot API + فرمتر + دستورات
│   └── scheduler/             dispatch کرون + جاب ۱ دقیقه + جاب ۶ ساعت
└── tests/                     تستهای واحد Vitest (شامل اسکن Secret)
```

## مدل امنیتی (fail-closed)

| الزام | پیاده‌سازی |
|---|---|
| Admin User ID authorization | بررسی `from.id === ADMIN_USER_ID` قبل از هر پاسخ؛ غیرادمین کاملاً بی‌پاسخ |
| Telegram webhook secret | هدر `X-Telegram-Bot-Api-Secret-Token` با مقایسه زمان-ثابت |
| Cloudflare Secrets | فقط `wrangler secret put` — هیچ Secret در Git/کد نیست |
| API key isolation | `PRICE_API_KEY` جدا از توکن ربات؛ فقط provider استفاده می‌کند |
| Channel ID allowlist | مقصد انتشار فقط `CHANNEL_ID` از env — هرگز از chat_id کاربر |
| Input validation | اعتبارسنجی env / ساختار update / مقادیر قیمت |
| Timeout | AbortController ~۱۰ ثانیه برای Telegram (و provider در پیاده‌سازی بعدی) |
| Error handling | خطاها هرگز به انتشار قیمت نامعتبر نمی‌انجامند |
| Rate limiting | درون-حافظه‌ای برای healthz و دستورات (محدودیت isolate مستند است) |
| Secure logging | JSON خطی؛ کلیدهای حساس و مقادیر شبیه توکن [REDACTED] می‌شوند |
| عدم hard-code credential | هیچ credential در کد وجود ندارد |
| عدم endpoint مدیریتی عمومی | سطح HTTP فقط /healthz و /telegram/webhook |
| عدم انتشار قیمت نامعتبر | قیمت کهنه/خراب → skip کامل انتشار |
| عدم انتشار در UNKNOWN بازار | ارزیابی ساعت بازار قبل از انتشار؛ UNKNOWN = skip کامل (بدون fetch و بدون ارسال) |
| عدم fallback ساختگی | stub هم null برمی‌گرداند؛ هیچ عدد جعلی ارسال نمی‌شود |

## متغیرهای محیطی

| نام | نوع | الزام | توضیح |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | اجباری | توکن ربات از BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | اجباری | secret_token وب‌هوک (≥۱۶ کاراکتر؛ ۳۲+ توصیه می‌شود) |
| `ADMIN_USER_ID` | Secret | اجباری | user id عددی ادمین |
| `CHANNEL_ID` | Secret | اجباری | کانال مقصد ( `-100…` یا `@username` ) |
| `PRICE_API_KEY` | Secret | اختیاری | کلید provider (در صورت نیاز) |
| `PRICE_PROVIDER` | Var | اختیاری | `stub` (پیش‌فرض) — پس از پیاده‌سازی: نام provider |
| `PRICE_API_BASE_URL` | Var | اختیاری | آدرس provider (بدون hard-code در کد) |

> مقدارها را هرگز در Git قرار ندهید. Production: `wrangler secret put NAME`
> و اجرای محلی: فایل `.dev.vars` (از روی `.dev.vars.example`).

## راه‌اندازی

### پیش‌نیازها
- Node.js ≥ 18 و npm
- اکانت Cloudflare (برای deploy بعدی)
- یک Telegram Bot Token و یک کانال + user id ادمین

### گام‌ها
```bash
# ۱) نصب وابستگی‌ها (فقط devDependencies — بدون وابستگی runtime)
npm install

# ۲) تستها و typecheck
npm run typecheck
npm test

# ۳) اجرای محلی
cp .dev.vars.example .dev.vars   # مقادیر تستی خود را بگذارید
npm run dev                       # wrangler dev → http://localhost:8787

# ۴) (برای deploy بعدی) KV بسازید و id را در wrangler.toml جایگزین کنید
npx wrangler kv namespace create STATE

# ۵) (برای deploy بعدی) Secretها را تنظیم کنید
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_USER_ID
npx wrangler secret put CHANNEL_ID

# ۶) (برای deploy بعدی) وب‌هوک را با secret_token تنظیم کنید
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://<WORKER_URL>/telegram/webhook","secret_token":"<WEBHOOK_SECRET>"}'
```

> در مرحله ۲، `npx wrangler deploy` اجرا شده است؛ `<PLACEHOLDER>`ها
> فقط الگو هستند — مقدار واقعی در هیچ فایلی ذخیره نمی‌شود.

## تستها

```bash
npm test          # کل مجموعه (Vitest)
npm run test:watch
npm run typecheck # tsc --noEmit
```

پوشش فعلی: اعتبارسنجی env، اعتبارسنجی قیمت، تاریخ شمسی/تهران، ساعت بازار (OPEN/CLOSED/UNKNOWN)، فرمتر پیامها،
authentication (زمان-ثابت/ادمین/allowlist)، registry provider (fail-closed)،
دستورات ادمین، سطح HTTP (healthz/webhook/404/429)، جاب ۱ دقیقه (edit پیام ثابت)،
جاب ۶ ساعت و **اسکن بهداشت Secret کل مخزن**.

## افزودن Provider واقعی (مرحله بعد)

1. مشخص شدن provider و endpoint و نحوه احراز آن
2. پیاده‌سازی `PriceProvider` در `src/providers/<name>.ts`
   (تنظیمات فقط از env: `PRICE_API_BASE_URL` / `PRICE_API_KEY`؛ timeout با AbortController)
3. ثبت نام provider در `src/providers/registry.ts`
4. تستهای اختصاصی provider با fetch فیک
5. تنظیم `PRICE_PROVIDER=<name>` به‌عنوان Var

## قواعد امنیتی پروژه (فراتر از کد)

- هیچ Secret/Token در chat، source، README یا Git قرار نمی‌گیرد
- `.env`، `.dev.vars` و credentialها همیشه gitignore هستند
- tokenها به‌محض افشای احتمالی revoke و rotate می‌شوند
- هیچ security warning با غیرفعال‌سازی validation دور نمی‌زنم
