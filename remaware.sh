#!/bin/bash

[ $EUID -ne 0 ] && echo "[!] Требуется root" && exit 1

apt update -y 2>/dev/null
apt install -y curl jq openssl net-tools ufw 2>/dev/null

ufw allow 22/tcp 2>/dev/null
ufw allow 443/tcp 2>/dev/null
ufw --force enable 2>/dev/null

if ! command -v xray &> /dev/null; then
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi

KEYS=$(xray x25519)

PRIV_KEY=$(echo "$KEYS" | awk '/PrivateKey/ {print $2}')
PASSWORD=$(echo "$KEYS" | awk '/Password/ {print $2}')

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 4)

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
          "serverNames": ["${SNI}"],
          "privateKey": "${PRIV_KEY}",
          "shortIds": ["${SHORT_ID}"],
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

jq . /usr/local/etc/xray/config.json > /dev/null || {
    echo "[!] JSON ошибка"
    exit 1
}

systemctl daemon-reload
systemctl restart xray
sleep 2

systemctl is-active --quiet xray || {
    echo "[!] Xray не запущен"
    journalctl -u xray -n 20 --no-pager
    exit 1
}

LINK="vless://${UUID}@${IP}:${PORT}?type=tcp&security=reality&flow=xtls-rprx-vision&sni=${SNI}&sid=${SHORT_ID}&password=${PASSWORD}#Remaware"

echo "[*] Готово"
echo "$LINK"
