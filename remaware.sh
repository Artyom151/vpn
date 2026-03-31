#!/bin/bash

set -euo pipefail

[ $EUID -ne 0 ] && echo "[!] Требуется root" && exit 1

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/var/log/remaware"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install.log"
DOMAIN="${DOMAIN:-pearvpn.ru}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://$DOMAIN}"
MANAGE_NGINX="${MANAGE_NGINX:-0}"

# ===== CONFIG =====
export DEBIAN_FRONTEND=noninteractive
APT_FLAGS="-y -qq -o=Dpkg::Use-Pty=0"
echo '$nrconf{restart} = "a";' > /etc/needrestart/conf.d/99-auto.conf

# ===== LOGGING (и файл, и консоль) =====
exec > >(tee -a "$LOG_FILE") 2>&1

# ===== SPINNER =====
spinner() {
  local pid=$1
  local msg=$2
  local spin='-\|/'
  local i=0

  echo -n "[*] $msg "
  while kill -0 $pid 2>/dev/null; do
    i=$(( (i+1) %4 ))
    printf "\r[*] %s %s" "$msg" "${spin:$i:1}"
    sleep 0.1
  done
  printf "\r[✓] %s\n" "$msg"
}

run_step() {
  local msg="$1"
  shift
  "$@" &
  spinner $! "$msg"
}

# ===== INSTALL =====
install_packages() {
  apt-get update -qq
  apt-get install $APT_FLAGS curl jq openssl net-tools ufw iptables-persistent ca-certificates gnupg2 python3 python3-venv python3-pip nginx > /dev/null 2>&1
}

install_node() {
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install $APT_FLAGS nodejs > /dev/null 2>&1
}

run_step "Установка пакетов" install_packages
run_step "Установка Node.js" install_node

# ===== FIREWALL =====
run_step "Настройка firewall" bash -c '
ufw allow 22/tcp >/dev/null 2>&1
ufw allow 80/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1
ufw allow 4173/tcp >/dev/null 2>&1
ufw allow 5174/tcp >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1
'

# ===== SYSCTL =====
run_step "Настройка sysctl" bash -c '
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.conf
sysctl -p >/dev/null 2>&1
'

# ===== XRAY =====
if ! command -v xray &> /dev/null; then
  run_step "Установка Xray" bash -c 'bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install > /dev/null 2>&1'
fi

KEY_OUTPUT=$(xray x25519)
PRIV_KEY=$(echo "$KEY_OUTPUT" | awk '/PrivateKey:/ {print $2}')
PUB_KEY=$(echo "$KEY_OUTPUT" | awk '/Password:/ {print $2}')
if [ -z "${PUB_KEY:-}" ]; then
  PUB_KEY=$(echo "$KEY_OUTPUT" | awk '/PublicKey:/ {print $2}')
fi
if [ -z "${PRIV_KEY:-}" ] || [ -z "${PUB_KEY:-}" ]; then
  echo "[!] Не удалось получить Reality ключи через xray x25519"
  echo "$KEY_OUTPUT"
  exit 1
fi

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 8)
IP=$(curl -s ifconfig.me)

PORT=443
SNI="www.microsoft.com"

# ===== XRAY CONFIG =====
run_step "Создание конфигурации Xray" bash -c "
cat > /usr/local/etc/xray/config.json <<EOF
{
  \"log\": { \"loglevel\": \"debug\" },
  \"api\": {
    \"tag\": \"api\",
    \"services\": [\"StatsService\"]
  },
  \"stats\": {},
  \"policy\": {
    \"levels\": {
      \"0\": {
        \"statsUserUplink\": true,
        \"statsUserDownlink\": true
      }
    },
    \"system\": {
      \"statsInboundUplink\": true,
      \"statsInboundDownlink\": true,
      \"statsOutboundUplink\": true,
      \"statsOutboundDownlink\": true
    }
  },
  \"inbounds\": [
    {
      \"listen\": \"127.0.0.1\",
      \"port\": 10085,
      \"protocol\": \"dokodemo-door\",
      \"settings\": { \"address\": \"127.0.0.1\" },
      \"tag\": \"api\"
    },
    {
      \"listen\": \"0.0.0.0\",
      \"port\": ${PORT},
      \"protocol\": \"vless\",
      \"settings\": {
        \"clients\": [
          {
            \"id\": \"${UUID}\",
            \"flow\": \"xtls-rprx-vision\",
            \"email\": \"bootstrap_user\"
          }
        ],
        \"decryption\": \"none\"
      },
      \"streamSettings\": {
        \"network\": \"tcp\",
        \"security\": \"reality\",
        \"realitySettings\": {
          \"dest\": \"${SNI}:443\",
          \"serverNames\": [\"${SNI}\"],
          \"privateKey\": \"${PRIV_KEY}\",
          \"shortIds\": [\"${SHORT_ID}\"]
        }
      }
    }
  ],
  \"outbounds\": [
    {
      \"protocol\": \"freedom\",
      \"tag\": \"api\",
      \"settings\": {}
    },
    {
      \"protocol\": \"freedom\",
      \"settings\": {}
    }
  ],
  \"routing\": {
    \"rules\": [
      {
        \"type\": \"field\",
        \"inboundTag\": [\"api\"],
        \"outboundTag\": \"api\"
      }
    ]
  }
}
EOF
"

if ! jq . /usr/local/etc/xray/config.json >/dev/null 2>&1; then
  echo "[!] Ошибка JSON в /usr/local/etc/xray/config.json"
  exit 1
fi

if ! xray run -test -config /usr/local/etc/xray/config.json >/dev/null 2>&1; then
  echo "[!] Xray config test failed"
  exit 1
fi

run_step "Перезапуск Xray" systemctl restart xray

if ! systemctl is-active --quiet xray; then
  echo "[!] Xray не запущен, последние логи:"
  journalctl -u xray -n 80 --no-pager || true
  exit 1
fi

# ===== NODE PROJECT =====
WEB_DIR="$ROOT_DIR/website"
if [ ! -d "$WEB_DIR" ]; then
  WEB_DIR="$ROOT_DIR/frontend"
fi

run_step "npm install backend" npm install --prefix "$ROOT_DIR/backend"
run_step "npm install web" npm install --prefix "$WEB_DIR"

run_step "build backend" npm --prefix "$ROOT_DIR/backend" run build
run_step "build web" bash -c "VITE_API_URL='$PUBLIC_BASE_URL' npm --prefix '$WEB_DIR' run build"

# ===== TELEGRAM BOT (PYTHON) =====
if [ -f "$ROOT_DIR/bot/main.py" ]; then
  if command -v python3 >/dev/null 2>&1; then
    run_step "setup/install bot deps" bash -c "
      cd '$ROOT_DIR/bot'
      python3 -m venv .venv
      source .venv/bin/activate
      pip install -r requirements.txt
    "
  else
    echo "[!] python3 не найден, bot не будет установлен"
  fi
else
  echo "[!] bot/main.py не найден, пропускаем Telegram Bot"
fi

# ===== START =====
pkill -f "npm --prefix $ROOT_DIR/backend run start" >/dev/null 2>&1 || true
pkill -f "node .*backend/dist/index.js" >/dev/null 2>&1 || true
pkill -f "vite preview" >/dev/null 2>&1 || true

run_step "Запуск backend" bash -c "
nohup env PUBLIC_IP='$IP' SUB_BASE_URL='$PUBLIC_BASE_URL' FORCE_DOMAIN_SUB_URL='1' \
npm --prefix '$ROOT_DIR/backend' run start >> '$LOG_DIR/backend.log' 2>&1 &
"

# ===== BACKEND HEALTHCHECK =====
echo "[*] Ожидание backend API..."
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:5174/api/health >/dev/null 2>&1; then
    echo "[✓] Backend API доступен"
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:5174/api/health >/dev/null 2>&1; then
  echo "[!] Backend не поднялся. Последние строки лога:"
  tail -n 80 "$LOG_DIR/backend.log" || true
  exit 1
fi

# ===== NGINX PROXY (PANEL + API + SUB) =====
if [ "$MANAGE_NGINX" = "1" ]; then
run_step "Настройка nginx (site/api)" bash -c "
cat > /etc/nginx/sites-available/pearvpn-sub.conf <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${DOMAIN} www.${DOMAIN} _;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection \"\";
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        rewrite ^/api/api/(.*)$ /api/\$1 break;
        proxy_pass http://127.0.0.1:5174;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection \"\";
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/sub/ {
        proxy_pass http://127.0.0.1:5174;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection \"\";
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/pearvpn-sub.conf /etc/nginx/sites-enabled/pearvpn-sub.conf
nginx -t
systemctl restart nginx
"
else
  echo "[i] MANAGE_NGINX=0: пропускаем изменение nginx (ваш текущий сайт на домене не трогаем)"
fi

run_step "Запуск web (local)" bash -c "
nohup npm --prefix '$WEB_DIR' run preview -- --host 127.0.0.1 --port 4173 >> '$LOG_DIR/frontend.log' 2>&1 &
"

if [ "$MANAGE_NGINX" = "1" ]; then
  echo "[*] Проверка nginx endpoint..."
  for i in {1..20}; do
    if curl -fsS "http://127.0.0.1/api/health" >/dev/null 2>&1; then
      echo "[✓] Nginx proxy /api работает"
      break
    fi
    sleep 1
  done
fi

if [ -f "$ROOT_DIR/bot/main.py" ] && [ -f "$ROOT_DIR/bot/.env" ] && [ -x "$ROOT_DIR/bot/.venv/bin/python" ]; then
  run_step "Запуск telegram bot" bash -c "
  set -a
  . '$ROOT_DIR/bot/.env'
  set +a
  nohup env PEAR_API_URL='http://127.0.0.1:5174' PUBLIC_SUB_BASE='$PUBLIC_BASE_URL' '$ROOT_DIR/bot/.venv/bin/python' '$ROOT_DIR/bot/main.py' >> '$LOG_DIR/bot.log' 2>&1 &
  "
elif [ -f "$ROOT_DIR/bot/main.py" ]; then
  echo "[!] bot найден, но не запущен (нужен bot/.env и bot/.venv/bin/python)"
fi

sleep 2

# ===== LINK =====
LINK="vless://${UUID}@${IP}:${PORT}?type=tcp&security=reality&encryption=none&flow=xtls-rprx-vision&sni=${SNI}&fp=chrome&pbk=${PUB_KEY}&sid=${SHORT_ID}#PearVPN"

# ===== DONE =====
echo ""
echo "========================================="
echo "[✓] УСТАНОВКА ЗАВЕРШЕНА"
echo "========================================="
echo ""

echo "🌐 Сайт:"
echo "$PUBLIC_BASE_URL/"
echo ""

echo "🔧 Backend API:"
echo "$PUBLIC_BASE_URL/api/health"
echo ""
echo "🔗 Subscription (через nginx):"
echo "$PUBLIC_BASE_URL/sub/<TOKEN>"
echo ""

echo "🔐 VLESS:"
echo "$LINK"
echo ""

echo "📂 Логи:"
echo "install:  $LOG_FILE"
echo "backend:  $LOG_DIR/backend.log"
echo "frontend: $LOG_DIR/frontend.log"
echo "bot:      $LOG_DIR/bot.log"
echo ""

echo "🧪 Проверка:"
echo "curl http://127.0.0.1:5174/api/health"
echo ""
