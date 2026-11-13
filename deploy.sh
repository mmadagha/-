#!/usr/bin/env bash
# دیپلوی کامل media proxy روی Fly.io
#
#   bash deploy.sh
#
# هر بار: اپ را (اگر نباشد) می‌سازد، اگر PROXY_KEY ست نشده باشد یک کلید
# تصادفی می‌سازد و به‌عنوان secret ذخیره می‌کند، سپس دیپلوی می‌کند.
# اجرای دوباره بی‌خطر است (idempotent).

set -euo pipefail

APP="${FLY_APP:-farsanime-proxy}"
REGION="${FLY_REGION:-fra}"

# --- flyctl -----------------------------------------------------------------
FLY_BIN="${FLY_BIN:-}"
if [ -z "$FLY_BIN" ]; then
  if command -v flyctl >/dev/null 2>&1; then FLY_BIN="flyctl"
  elif command -v fly >/dev/null 2>&1; then FLY_BIN="fly"
  elif [ -x ./flyctl.exe ]; then FLY_BIN="./flyctl.exe"
  elif [ -x ./flyctl ]; then FLY_BIN="./flyctl"
  else
    echo "خطا: flyctl نصب نیست. راهنمای نصب در README.md آمده است." >&2
    exit 1
  fi
fi

echo "==> flyctl: $FLY_BIN"
"$FLY_BIN" version

# --- اپ ---------------------------------------------------------------------
if "$FLY_BIN" status -a "$APP" >/dev/null 2>&1; then
  echo "==> اپ «$APP» از قبل وجود دارد"
else
  echo "==> ساخت اپ «$APP»"
  "$FLY_BIN" apps create "$APP"
fi

# --- کلید PROXY_KEY ---------------------------------------------------------
if "$FLY_BIN" secrets list -a "$APP" 2>/dev/null | grep -qw "PROXY_KEY"; then
  echo "==> secret «PROXY_KEY» از قبل ست شده است (دست نمی‌زنیم)"
else
  KEY="${PROXY_KEY:-}"
  if [ -z "$KEY" ]; then
    if command -v openssl >/dev/null 2>&1; then
      KEY="$(openssl rand -hex 32)"
    elif command -v node >/dev/null 2>&1; then
      KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    else
      KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
  fi

  echo "==> ست کردن secret «PROXY_KEY»"
  "$FLY_BIN" secrets set "PROXY_KEY=$KEY" -a "$APP" >/dev/null

  umask 077
  printf 'PROXY_KEY=%s\n' "$KEY" > .env.local

  echo
  echo "    کلید پروکسی (در فایل .env.local هم ذخیره شد):"
  echo "    $KEY"
  echo "    این کلید را در کلاینت‌ها به‌صورت هدر x-proxy-key بفرستید و جایی عمومی نگذارید."
  echo
fi

# --- allowlist اختیاری ------------------------------------------------------
if [ -n "${ALLOWED_CLIENT_IPS:-}" ]; then
  echo "==> ست کردن ALLOWED_CLIENT_IPS"
  "$FLY_BIN" secrets set "ALLOWED_CLIENT_IPS=$ALLOWED_CLIENT_IPS" -a "$APP" >/dev/null
fi

if [ -n "${ALLOWED_HOSTS:-}" ]; then
  echo "==> ست کردن ALLOWED_HOSTS"
  "$FLY_BIN" secrets set "ALLOWED_HOSTS=$ALLOWED_HOSTS" -a "$APP" >/dev/null
fi

# --- دیپلوی -----------------------------------------------------------------
echo "==> دیپلوی"
"$FLY_BIN" deploy \
  --app "$APP" \
  --ha=false \
  --remote-only \
  --now \
  --yes

# --- گزارش ------------------------------------------------------------------
echo
"$FLY_BIN" status -a "$APP" || true

echo
echo "پروکسی: https://${APP}.fly.dev"
echo "تست سلامت: curl -s https://${APP}.fly.dev/healthz"
echo "نمونه: curl -H \"x-proxy-key: \$(grep PROXY_KEY .env.local | cut -d= -f2)\" \\"
echo "        \"https://${APP}.fly.dev/?url=https%3A%2F%2Ffarsanime.ir%2F&range=0-1023\" -o /dev/null -D -"
