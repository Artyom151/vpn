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

# Получаем ключи в правильном формате для вашей версии Xray
KEY_OUTPUT=$(xray x25519)
PRIV_KEY=$(echo "$KEY_OUTPUT" | grep "PrivateKey:" | awk '{print $2}')
PUB_KEY=$(echo "$KEY_OUTPUT" | grep "Password:" | awk '{print $2}')

# Проверяем, что ключи получены
if [ -z "$PRIV_KEY" ] || [ -z "$PUB_KEY" ]; then
    echo "[!] Не удалось получить ключи"
    echo "Вывод xray x25519:"
    echo "$KEY_OUTPUT"
    exit 1
fi

echo "[*] Ключи получены:"
echo "PrivateKey: ${PRIV_KEY}"
echo "PublicKey (Password): ${PUB_KEY}"

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 8)

IP=$(curl -s ifconfig.me)
PORT=443
SNI="www.cloudflare.com"

# Создаем конфигурацию для Xray
cat > /usr/local/etc/xray/config.json <<EOF
{
  "inbounds": [
    {
      "listen": "0.0.0.0",
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
          "dest": "${SNI}:443",
          "serverNames": [
            "${SNI}"
          ],
          "privateKey": "${PRIV_KEY}",
          "shortIds": [
            "${SHORT_ID}"
          ]
        }
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "direct"
    }
  ]
}
EOF

# Проверяем JSON
if ! jq . /usr/local/etc/xray/config.json > /dev/null 2>&1; then
    echo "[!] Ошибка в JSON конфигурации"
    cat /usr/local/etc/xray/config.json
    exit 1
fi

systemctl daemon-reload
systemctl restart xray
sleep 3

# Проверяем статус
if ! systemctl is-active --quiet xray; then
    echo "[!] Xray не запущен"
    echo "--- Лог ошибок ---"
    journalctl -u xray -n 20 --no-pager
    echo "--- Проверка конфигурации ---"
    xray run -test -config /usr/local/etc/xray/config.json
    exit 1
fi

# Формируем ссылку для Reality (используем Password как pbk)
LINK="vless://${UUID}@${IP}:${PORT}?type=tcp&security=reality&flow=xtls-rprx-vision&sni=${SNI}&pbk=${PUB_KEY}&sid=${SHORT_ID}#Remaware"

echo ""
echo "========================================="
echo "[✓] Установка завершена успешно!"
echo "========================================="
echo ""
echo "=== Данные подключения ==="
echo "IP: ${IP}"
echo "Port: ${PORT}"
echo "UUID: ${UUID}"
echo "Public Key (pbk): ${PUB_KEY}"
echo "Short ID (sid): ${SHORT_ID}"
echo "SNI: ${SNI}"
echo ""
echo "=== VLESS Reality Link ==="
echo "$LINK"
echo ""
echo "=== Для импорта в клиент ==="
echo "Скопируйте ссылку выше и вставьте в ваш клиент (v2rayN, Nekobox, Hiddify и т.д.)"
echo ""
echo "=== Проверка статуса Xray ==="
systemctl status xray --no-pager -l
