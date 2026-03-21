#!/bin/bash

set -euo pipefail

[ $EUID -ne 0 ] && echo "[!] Требуется root" && exit 1

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/var/log/remaware"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/install.log"

# ====== CONFIG ======
export DEBIAN_FRONTEND=noninteractive
APT_FLAGS="-y -qq -o=Dpkg::Use-Pty=0"
echo '$nrconf{restart} = "a";' > /etc/needrestart/conf.d/99-auto.conf

# ====== LOGGING ======
exec > "$LOG_FILE" 2>&1

# ====== SPINNER ======
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

# ====== DETECT PKG ======
detect_pkg_manager() {
  if command -v apt-get >/dev/null; then echo "apt"; return; fi
  echo "unsupported"
}

# ====== INSTALL PACKAGES ======
install_packages() {
  apt-get update -qq
  apt-get install $APT_FLAGS curl jq openssl net-tools ufw iptables-persistent ca-certificates gnupg2 > /dev/null 2>&1
}

install_node() {
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install $APT_FLAGS nodejs > /dev/null 2>&1
}

# ====== START ======
PKG_MANAGER=$(detect_pkg_manager)
[ "$PKG_MANAGER" = "unsupported" ] && echo "[!] Unsupported OS" && exit 1

run_step "Установка пакетов" install_packages
run_step "Установка Node.js" install_node

# ====== FIREWALL ======
run_step "Настройка firewall" bash -c '
ufw allow 22/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1
'

# ====== SYSCTL ======
run_step "Настройка sysctl" bash -c '
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.conf
sysctl -p >/dev/null 2>&1
'

# ====== XRAY ======
if ! command -v xray &> /dev/null; then
  run_step "Установка Xray" bash -c 'bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install > /dev/null 2>&1'
fi

# ====== KEYS ======
KEY_OUTPUT=$(xray x25519)
PRIV_KEY=$(echo "$KEY_OUTPUT" | grep "PrivateKey:" | awk '{print $2}')
PUB_KEY=$(echo "$KEY_OUTPUT" | grep "PublicKey:" | awk '{print $2}')

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 8)
IP=$(curl -s ifconfig.me)

PORT=443
SNI="www.cloudflare.com"

# ====== CONFIG ======
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

# ====== NPM ======
run_step "Установка backend" npm install --prefix "$ROOT_DIR/backend"
run_step "Установка frontend" npm install --prefix "$ROOT_DIR/frontend"

run_step "Сборка backend" npm --prefix "$ROOT_DIR/backend" run build
run_step "Сборка frontend" npm --prefix "$ROOT_DIR/frontend" run build

# ====== START SERVICES ======
run_step "Запуск backend" bash -c "
nohup env XRAY_PUBLIC_KEY='$PUB_KEY' PUBLIC_IP='$IP' \
npm --prefix '$ROOT_DIR/backend' run start >> '$LOG_DIR/backend.log' 2>&1 &
"

run_step "Запуск frontend" bash -c "
nohup npm --prefix '$ROOT_DIR/frontend' run preview -- --host 0.0.0.0 --port 4173 >> '$LOG_DIR/frontend.log' 2>&1 &
"

# ====== DONE ======
echo ""
echo "========================================="
echo "[✓] Установка завершена"
echo "========================================="
echo ""
echo "IP: $IP"
echo "PORT: $PORT"
echo ""
echo "Логи: $LOG_FILE"
