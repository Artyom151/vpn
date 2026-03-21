#!/bin/bash

set -euo pipefail

[ $EUID -ne 0 ] && echo "[!] Требуется root" && exit 1

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/var/log/remaware"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install.log"

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
PUB_KEY=$(echo "$KEY_OUTPUT" | awk '/PublicKey:/ {print $2}')

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 8)
IP=$(curl -s ifconfig.me)

PORT=443
SNI="www.cloudflare.com"

# ===== XRAY CONFIG =====
run_step "Создание конфигурации Xray" bash -c "
cat > /usr/local/etc/xray/config.json <<EOF
{
  \"inbounds\": [{
    \"listen\": \"0.0.0.0\",
    \"port\": ${PORT},
    \"protocol\": \"vless\",
    \"settings\": {
      \"clients\": [{\"id\": \"${UUID}\", \"flow\": \"xtls-rprx-vision\"}],
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
  }],
  \"outbounds\": [{\"protocol\": \"freedom\"}]
}
EOF
"

run_step "Перезапуск Xray" systemctl restart xray

# ===== NODE PROJECT =====
run_step "npm install backend" npm install --prefix "$ROOT_DIR/backend"
run_step "npm install frontend" npm install --prefix "$ROOT_DIR/frontend"

run_step "build backend" npm --prefix "$ROOT_DIR/backend" run build
run_step "build frontend" bash -c "VITE_API_URL='http://$IP' npm --prefix '$ROOT_DIR/frontend' run build"

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
run_step "Запуск backend" bash -c "
nohup env XRAY_PUBLIC_KEY='$PUB_KEY' PUBLIC_IP='$IP' SUB_BASE_URL='http://$IP' \
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

# ===== NGINX PROXY FOR SUBSCRIPTION =====
run_step "Настройка nginx для подписок" bash -c "
cat > /etc/nginx/sites-available/pearvpn-sub.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /sub/ {
        proxy_pass http://127.0.0.1:5174;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/sub/ {
        proxy_pass http://127.0.0.1:5174;
        proxy_set_header Host \$host;
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

run_step "Запуск frontend" bash -c "
nohup npm --prefix '$ROOT_DIR/frontend' run preview -- --host 0.0.0.0 --port 4173 >> '$LOG_DIR/frontend.log' 2>&1 &
"

if [ -f "$ROOT_DIR/bot/main.py" ] && [ -f "$ROOT_DIR/bot/.env" ] && [ -x "$ROOT_DIR/bot/.venv/bin/python" ]; then
  run_step "Запуск telegram bot" bash -c "
  set -a
  . '$ROOT_DIR/bot/.env'
  set +a
  nohup '$ROOT_DIR/bot/.venv/bin/python' '$ROOT_DIR/bot/main.py' >> '$LOG_DIR/bot.log' 2>&1 &
  "
elif [ -f "$ROOT_DIR/bot/main.py" ]; then
  echo "[!] bot найден, но не запущен (нужен bot/.env и bot/.venv/bin/python)"
fi

sleep 2

# ===== LINK =====
LINK="vless://${UUID}@${IP}:${PORT}?type=tcp&security=reality&flow=xtls-rprx-vision&sni=${SNI}&pbk=${PUB_KEY}&sid=${SHORT_ID}#Remaware"

# ===== DONE =====
echo ""
echo "========================================="
echo "[✓] УСТАНОВКА ЗАВЕРШЕНА"
echo "========================================="
echo ""

echo "🌐 Панель:"
echo "http://$IP:4173"
echo ""

echo "🔧 Backend API:"
echo "http://$IP:5174"
echo ""
echo "🔗 Subscription (через nginx):"
echo "http://$IP/sub/<TOKEN>"
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
