#!/bin/bash

[ $EUID -ne 0 ] && echo "[!] Требуется root" && exit 1

echo "[*] Install dependencies"

if command -v apt &> /dev/null; then
    apt update -y
    apt install -y curl jq openssl net-tools ufw
elif command -v pacman &> /dev/null; then
    pacman -S --noconfirm curl jq openssl net-tools ufw
elif command -v dnf &> /dev/null; then
    dnf install -y curl jq openssl net-tools ufw
elif command -v yum &> /dev/null; then
    yum install -y curl jq openssl net-tools ufw
fi

ufw allow 22/tcp 2>/dev/null
ufw allow 443/tcp 2>/dev/null
ufw --force enable 2>/dev/null

if ! command -v xray &> /dev/null; then
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi

KEYS=$(xray x25519 2>/dev/null)

PRIV_KEY=$(echo "$KEYS" | awk '/PrivateKey/ {print $2}')
PUB_KEY=$(echo "$KEYS" | awk '/PrivateKey/ {print $2}')

if [ -z "$PRIV_KEY" ]; then
    echo "[!] PrivateKey error"
    exit 1
fi

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 4)
PASSWORD=$(openssl rand -base64 16)
IP=$(curl -s ifconfig.me)
PORT=443
SNI="www.cloudflare.com"

cat > /usr/local/etc/xray/config.json <<EOF
{
  "inbounds": [
    {
      "port": ${PORT},
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "${UUID}",
            "flow": "xtls-rprx-vision"
          }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${SNI}:443",
          "xver": 0,
          "serverNames": [
            "${SNI}"
          ],
          "privateKey": "${PRIV_KEY}",
          "shortIds": [
            "${SHORT_ID}"
          ],
          "password": "${PASSWORD}"
        }
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom"
    }
  ]
}
EOF

jq . /usr/local/etc/xray/config.json > /dev/null 2>&1 || {
    echo "[!] JSON error"
    exit 1
}

systemctl daemon-reload
systemctl restart xray
sleep 2

systemctl is-active --quiet xray || {
    echo "[!] Xray not running"
    journalctl -u xray -n 20 --no-pager
    exit 1
}

LINK="vless://${UUID}@${IP}:${PORT}?type=tcp&security=reality&flow=xtls-rprx-vision&pbk=${PUB_KEY}&sid=${SHORT_ID}&sni=${SNI}&fp=chrome#Remaware"

echo "[*] DONE"
echo "$LINK"
