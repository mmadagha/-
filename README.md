# Farsanime Media Proxy — نسخهٔ ۳ (Node.js / Fly.io)

پروکسی رسانه با استریم بدون بافر، احراز هویت با هدر، allowlist هاست و IP، و پشتیبانی کامل از `Range`.

**چرا نسخهٔ جدید؟** نسخهٔ ۲ یک **Cloudflare Worker** بود و Fly.io کد Worker را اجرا نمی‌کند. در این پوشه همان منطق به یک سرور **Node.js 20** بدون هیچ dependency منتقل شده تا روی Fly بالا بیاید، در حالی که رفتار و قرارداد API دقیقاً حفظ شده است.

---

## چه چیزی نسبت به نسخهٔ ۲ بهتر شد

| مورد | نسخهٔ ۲ (Worker) | نسخهٔ ۳ (این پوشه) |
|---|---|---|
| مقایسهٔ کلید | مقایسهٔ کاراکتری با خروج زودهنگام روی اختلاف طول (نشت طول کلید) | `crypto.timingSafeEqual` روی هش SHA-256 |
| ریدایرکت‌ها | فقط پروتکل و هاست چک می‌شد | **پورت هم چک می‌شود** (۴۴۳ فقط) |
| تایم‌اوت upstream | نداشت (fetch می‌توانست بی‌نهایت منتظر بماند) | `FETCH_TIMEOUT_MS` برای گرفتن هدرها |
| قطع کلاینت | اتصال upstream رها می‌شد | استریم upstream با قطع کلاینت بسته می‌شود |
| استریم بدنه | پاس‌دادن مستقیم بدنه | `pipeline` با backpressure واقعی |
| سلامت و خاموشی | نداشت | `/healthz` + خاموشی تمیز روی `SIGTERM` |
| لاگ | نداشت | یک خط JSON برای هر درخواست (بدون ثبت کلید) |
| هدرهای کش | `cache-control`/`expires` upstream باقی می‌ماند | حذف و اجبار `no-store` |
| تشخیص IP کلاینت | `cf-connecting-ip` / `x-real-ip` | `fly-client-ip` → `cf-connecting-ip` → `x-forwarded-for` → سوکت |

رفتار ثابت‌مانده: `x-proxy-key`، allowlist هاست (با پشتیبانی ساب‌دامین)، allowlist IP، نرمال‌سازی `range`، حذف هدرهای hop-by-hop و `set-cookie`، هدرهای تشخیصی `x-proxy-*`، و CORS باز.

---

## فهرست

1. [پیش‌نیازها](#۱-پیشنیازها)
2. [نصب سریع](#۲-نصب-سریع)
3. [نصب دستی](#۳-نصب-دستی)
4. [تنظیمات و secretها](#۴-تنظیمات-و-secretها)
5. [نحوهٔ استفاده](#۵-نحوهٔ-استفاده)
6. [کدهای خطا](#۶-کدهای-خطا)
7. [سلامت، خواب و هزینه](#۷-سلامت-خواب-و-هزینه)
8. [اجرای محلی](#۸-اجرای-محلی)
9. [امنیت](#۹-امنیت)
10. [عیب‌یابی](#۱۰-عیبیابی)

---

## ۱. پیش‌نیازها

- حساب [Fly.io](https://fly.io) با روش پرداخت فعال
- `flyctl`

```bash
# لینوکس / macOS
curl -L https://fly.io/install.sh | sh

# ویندوز (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex

# ویندوز داخل Git Bash
curl -sSL -o flyctl.zip https://github.com/superfly/flyctl/releases/latest/download/flyctl_Windows_x86_64.zip
unzip -o flyctl.zip
```

ورود:

```bash
flyctl auth login
flyctl auth whoami
```

این پروژه به **Node.js روی سیستم شما نیاز ندارد**؛ بیلد روی بلدر Fly انجام می‌شود.

---

## ۲. نصب سریع

داخل همین پوشه (`farsanime-proxy`):

```bash
bash deploy.sh
```

اسکریپت:

1. اگر اپ `farsanime-proxy` نبود، می‌سازد.
2. اگر secret به نام `PROXY_KEY` ست نشده بود، یک کلید تصادفی ۶۴ کاراکتری می‌سازد، آن را به‌عنوان secret ذخیره می‌کند و در فایل `.env.local` (با دسترسی محدود) نگه می‌دارد و یک‌بار در ترمینال نشان می‌دهد.
3. اگر `ALLOWED_HOSTS` یا `ALLOWED_CLIENT_IPS` در محیط ست کرده باشید، آن‌ها را secret می‌کند.
4. بیلد و دیپلوی می‌کند و وضعیت را نشان می‌دهد.

اجرای دوباره بی‌خطر است و کلید موجود را تغییر نمی‌دهد.

### اگر می‌خواهید نام/ریجن یا کلید را خودتان بدهید

```bash
FLY_APP=my-proxy FLY_REGION=ams bash deploy.sh

# یا کلید دلخواه:
PROXY_KEY="$(openssl rand -hex 32)" bash deploy.sh
```

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `FLY_APP` | `farsanime-proxy` | نام اپ (بخشی از دامنه: `<APP>.fly.dev`) |
| `FLY_REGION` | `fra` | ریجن ماشین |
| `PROXY_KEY` | خودکار | کلید پروکسی |
| `ALLOWED_HOSTS` | از `fly.toml` | لیست هاست‌های مجاز با کاما |
| `ALLOWED_CLIENT_IPS` | خالی | لیست IPهای مجاز کلاینت |
| `FLY_BIN` | خودکار | مسیر `flyctl` |

---

## ۳. نصب دستی

```bash
# ۱) ساخت اپ
flyctl apps create farsanime-proxy

# ۲) کلید پروکسی
flyctl secrets set PROXY_KEY="$(openssl rand -hex 32)" -a farsanime-proxy

# ۳) (اختیاری) allowlist
flyctl secrets set ALLOWED_HOSTS=farsanime.ir,di.farsanime.ir -a farsanime-proxy
flyctl secrets set ALLOWED_CLIENT_IPS=1.2.3.4 -a farsanime-proxy

# ۴) دیپلوی
flyctl deploy -a farsanime-proxy --ha=false --remote-only

# ۵) بررسی
flyctl status -a farsanime-proxy
curl -s https://farsanime-proxy.fly.dev/healthz
```

> اگر نام اپ را عوض کردید، مقدار `app` در `fly.toml` را هم همان بگذارید (وگرنه `deploy.sh` با `-a` درست کار می‌کند ولی `flyctl deploy` بدون فلگ نه).

---

## ۴. تنظیمات و secretها

| متغیر | الزامی | پیش‌فرض | توضیح |
|---|---|---|---|
| `PROXY_KEY` | ✅ | — | کلیدی که کلاینت در هدر `x-proxy-key` می‌فرستد |
| `ALLOWED_HOSTS` | ❌ | `farsanime.ir,di.farsanime.ir` | فقط این هاست‌ها (و ساب‌دامین‌شان) هدف می‌شوند |
| `ALLOWED_CLIENT_IPS` | ❌ | خالی (همه مجاز) | لیست IP کلاینت‌های مجاز |
| `PORT` | ❌ | `8080` | پورت داخلی |
| `UPSTREAM_REFERER` | ❌ | `https://farsanime.ir/` | مقدار هدر Referer به upstream |
| `FETCH_TIMEOUT_MS` | ❌ | `15000` | تایم‌اوت گرفتن هدرهای upstream |
| `MAX_REDIRECTS` | ❌ | `4` | حداکثر ریدایرکت |

مدیریت secretها:

```bash
flyctl secrets list -a farsanime-proxy
flyctl secrets set PROXY_KEY="کلید-جدید" -a farsanime-proxy   # چرخش کلید
flyctl secrets unset ALLOWED_CLIENT_IPS -a farsanime-proxy
```

هر تغییر secret یک ری‌استارت چندثانیه‌ای ایجاد می‌کند.

مقادیر غیرحساس (`ALLOWED_HOSTS`, `PORT`, ...) در `[env]` فایل `fly.toml` هم قابل تنظیم‌اند؛ اما اگر هم secret و هم env باشند، **secret برنده است**.

---

## ۵. نحوهٔ استفاده

همیشه کلید را در هدر بفرستید:

```bash
KEY="$(grep PROXY_KEY .env.local | cut -d= -f2)"
BASE="https://farsanime-proxy.fly.dev"

# کل فایل / پخش کامل
curl -H "x-proxy-key: $KEY" "$BASE/?url=https%3A%2F%2Ffarsanime.ir%2Fmedia%2Fmovie.mp4" -o movie.mp4

# ۱ کیلوبایت اول با پارامتر range
curl -H "x-proxy-key: $KEY" \
  "$BASE/?url=https%3A%2F%2Ffarsanime.ir%2Fmedia%2Fmovie.mp4&range=bytes%3D0-1023" -D -

# همان کار با هدر استاندارد Range
curl -H "x-proxy-key: $KEY" -H "Range: bytes=0-1023" \
  -o /dev/null -D - "$BASE/?url=https%3A%2F%2Ffarsanime.ir%2Fmedia%2Fmovie.mp4"

# فقط اندازه و هدرها
curl -I -H "x-proxy-key: $KEY" "$BASE/?url=https%3A%2F%2Ffarsanime.ir%2Flive.m3u8"
```

با `curl -D -` هدرهای تشخیصی زیر را می‌بینید:

| هدر | معنی |
|---|---|
| `x-proxy-host` | هاست هدف |
| `x-proxy-range` | رنج نرمال‌شده یا `none` |
| `x-proxy-upstream-status` | کد وضعیت واقعی upstream |
| `x-proxy-range-ok: 1` | رنج اعمال شد (upstream پاسخ ۲۰۶ داد) |
| `x-proxy-range-ignored: 1` | رنج فرستاد شد ولی upstream ۲۰۰ کامل داد |

نکته: چون `url` یک query param است، مقدار آن را **encode** کنید (`%3A` برای `:`، `%2F` برای `/`).

---

## ۶. کدهای خطا

| کد | `error` | معنی |
|---|---|---|
| 400 | `missing_url` | پارامتر `url` نیست |
| 400 | `invalid_url` | آدرس قابل تجزیه نیست |
| 400 | `url_too_long` | طول آدرس > ۸۱۹۲ |
| 400 | `https_required` | فقط `https` |
| 400 | `port_not_allowed` | پورت غیر ۴۴۳ |
| 400 | `credentials_not_allowed` | آدرس شامل user:pass |
| 400 | `invalid_range` | `range` نامعتبر |
| 403 | `forbidden` | کلید اشتباه/نبود |
| 403 | `forbidden_ip` | IP کلاینت در allowlist نیست |
| 403 | `host_not_allowed` | هاست هدف مجاز نیست |
| 403 | `redirect_not_allowed` | ریدایرکت به هاست/پروتکل غیرمجاز |
| 405 | `method_not_allowed` | فقط GET/HEAD/OPTIONS |
| 500 | `server_misconfigured` | `PROXY_KEY` ست نشده |
| 502 | `upstream_fetch_failed` | خطای شبکه/تایم‌اوت upstream |

---

## ۷. سلامت، خواب و هزینه

- `GET /healthz` بدون کلید جواب `{"ok":true}` می‌دهد و در `fly.toml` به‌عنوان health check تعریف شده است.
- `auto_stop_machines = 'stop'`، `auto_start_machines = true`، `min_machines_running = 0`: ماشین بعد از بی‌کاری می‌خوابد و با اولین درخواست بیدار می‌شود (اولین درخواست چند ثانیه کندتر است).
- برای پخش پیوسته و بدون تأخیر، همیشه‌بیدار کنید:

  ```toml
  auto_stop_machines = 'off'
  min_machines_running = 1
  ```

- ماشین پیش‌فرض `shared-cpu-1x` با ۲۵۶MB رم است (استریم بافری مصرف نمی‌کند).
- `idle_timeout = 300` گذاشته شده تا مکث بین دو chunk، اتصال رسانه را قطع نکند.

مقیاس‌دهی دستی:

```bash
flyctl scale count 2 -a farsanime-proxy
flyctl scale vm shared-cpu-2x --memory 512 -a farsanime-proxy
```

---

## ۸. اجرای محلی

اگر Node.js 20+ دارید:

```bash
cd farsanime-proxy
PROXY_KEY=test-key node server.js
# در ترمینال دیگر:
curl -H "x-proxy-key: test-key" "http://localhost:8080/healthz"
curl -H "x-proxy-key: test-key" \
  "http://localhost:8080/?url=https%3A%2F%2Ffarsanime.ir%2F&range=0-1023" -D -
```

یا با Docker:

```bash
docker build -t farsanime-proxy .
docker run --rm -p 8080:8080 -e PROXY_KEY=test-key farsanime-proxy
```

---

## ۹. امنیت

- `PROXY_KEY` را در کد، ریپو یا چت نگذارید؛ فقط secret فای یا `.env.local`.
- کلید لو رفته را بچرخانید: `flyctl secrets set PROXY_KEY="کلید-جدید"`.
- اگر کلاینت‌ها IP ثابت دارند، `ALLOWED_CLIENT_IPS` را ست کنید؛ وگرنه کلید تنها لایهٔ حفاظت است.
- allowlist هاست را باز نکنید؛ همین باعث می‌شود پروکسی به open proxy تبدیل نشود.
- لاگ‌ها کلید را ثبت نمی‌کنند، ولی آدرس‌ها را ثبت می‌کنند؛ در صورت حساس بودن، سطح لاگ را کم کنید.

---

## ۱۰. عیب‌یابی

```bash
flyctl logs -a farsanime-proxy
flyctl status -a farsanime-proxy
flyctl secrets list -a farsanime-proxy
flyctl ssh console -a farsanime-proxy -C "wget -qO- http://127.0.0.1:8080/healthz"
```

| نشانه | علت | راه‌حل |
|---|---|---|
| `server_misconfigured` | `PROXY_KEY` ست نشده | `flyctl secrets set PROXY_KEY=...` |
| `forbidden` با کلید درست | secret قدیمی/فاصلهٔ اضافه | کلید را دوباره ست کنید و کلاینت را به‌روز کنید |
| `forbidden_ip` | IP کلاینت پشت پروکسی/Cloudflare عوض شده | allowlist را به‌روز کنید یا خالی بگذارید |
| `upstream_fetch_failed` | هاست مقصد جواب نمی‌دهد یا تایم‌اوت | `FETCH_TIMEOUT_MS` را بالا ببرید، هاست را چک کنید |
| `host_not_allowed` | هاست در allowlist نیست | `ALLOWED_HOSTS` را ست کنید |
| پخش قطع می‌شود | idle_timeout | `[http_service.http_options] idle_timeout` را بیشتر کنید |
| اولین درخواست کند است | خواب ماشین | `min_machines_running = 1` |

---

## اگر می‌خواهید روی Cloudflare بمانید

این پوشه مخصوص Fly است. نسخهٔ اصلی Worker را می‌توانید با `wrangler deploy` روی Cloudflare منتشر کنید؛ منطق و متغیرها یکی است، فقط `PROXY_KEY` و بقیه در `wrangler.toml` یا Secrets صفحهٔ Cloudflare تنظیم می‌شوند.
