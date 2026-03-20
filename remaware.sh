#!/bin/bash

[ $EUID -ne 0 ] && echo "[!] Требуется root" && exit 1

apt update -y 2>/dev/null
apt install -y curl jq openssl net-tools ufw iptables-persistent 2>/dev/null

ufw allow 22/tcp 2>/dev/null
ufw allow 443/tcp 2>/dev/null
ufw --force enable 2>/dev/null

# Включаем IP forwarding
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.conf
sysctl -p

if ! command -v xray &> /dev/null; then
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi

# Получаем ключи
KEY_OUTPUT=$(xray x25519)
PRIV_KEY=$(echo "$KEY_OUTPUT" | grep "PrivateKey:" | awk '{print $2}')
PUB_KEY=$(echo "$KEY_OUTPUT" | grep "Password:" | awk '{print $2}')

if [ -z "$PRIV_KEY" ] || [ -z "$PUB_KEY" ]; then
    echo "[!] Не удалось получить ключи"
    exit 1
fi

UUID=$(cat /proc/sys/kernel/random/uuid)
SHORT_ID=$(openssl rand -hex 8)

IP=$(curl -s ifconfig.me)
PORT=443
SNI="www.cloudflare.com"

# Создаем конфигурацию Xray с правильными outbounds
cat > /usr/local/etc/xray/config.json <<EOF
{
  "inbounds": [
    {
      "listen": "127.0.0.1",
      "port": 1080,
      "protocol": "socks",
      "settings": {
        "udp": true
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls"]
      }
    },
    {
      "listen": "127.0.0.1",
      "port": 1081,
      "protocol": "http",
      "settings": {
        "accounts": []
      }
    },
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
      "tag": "direct",
      "settings": {}
    },
    {
      "protocol": "blackhole",
      "tag": "block",
      "settings": {}
    }
  ],
  "routing": {
    "rules": [
      {
        "type": "field",
        "ip": ["geoip:private"],
        "outboundTag": "direct"
      },
      {
        "type": "field",
        "domain": ["geosite:category-ads"],
        "outboundTag": "block"
      }
    ]
  }
}
EOF

# Проверяем JSON
if ! jq . /usr/local/etc/xray/config.json > /dev/null 2>&1; then
    echo "[!] Ошибка в JSON конфигурации"
    exit 1
fi

systemctl daemon-reload
systemctl restart xray
sleep 3

if ! systemctl is-active --quiet xray; then
    echo "[!] Xray не запущен"
    journalctl -u xray -n 20 --no-pager
    exit 1
fi

# Настраиваем iptables для перенаправления трафика
# Создаем новую цепочку для Xray
iptables -t nat -N XRAY
iptables -t nat -F XRAY

# Перенаправляем весь трафик на порт 12345 (будем использовать TPROXY)
# Сначала создаем пользователя для TPROXY
iptables -t mangle -N XRAY_MANGLE
iptables -t mangle -F XRAY_MANGLE

# Перенаправляем трафик на локальный прокси (только если нужно)
# ВАЖНО: Раскомментируйте следующие строки если хотите прозрачный прокси для всего трафика
# НО! Это может сломать SSH подключение, поэтому пока закомментировано

# iptables -t nat -A PREROUTING -p tcp -j XRAY
# iptables -t nat -A OUTPUT -p tcp -j XRAY
# iptables -t nat -A XRAY -d 0.0.0.0/8 -j RETURN
# iptables -t nat -A XRAY -d 10.0.0.0/8 -j RETURN
# iptables -t nat -A XRAY -d 127.0.0.0/8 -j RETURN
# iptables -t nat -A XRAY -d 169.254.0.0/16 -j RETURN
# iptables -t nat -A XRAY -d 172.16.0.0/12 -j RETURN
# iptables -t nat -A XRAY -d 192.168.0.0/16 -j RETURN
# iptables -t nat -A XRAY -d 224.0.0.0/4 -j RETURN
# iptables -t nat -A XRAY -d 240.0.0.0/4 -j RETURN
# iptables -t nat -A XRAY -p tcp -j REDIRECT --to-ports 1080

# Сохраняем правила iptables
if command -v iptables-save &> /dev/null; then
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
fi

# Создаем скрипт для настройки прокси в системе
cat > /usr/local/bin/proxy-on <<'EOF'
#!/bin/bash
# Включает глобальный прокси через Xray
export http_proxy="http://127.0.0.1:1081"
export https_proxy="http://127.0.0.1:1081"
export socks_proxy="socks5://127.0.0.1:1080"
export all_proxy="socks5://127.0.0.1:1080"
echo "Прокси включен (HTTP/SOCKS5 на 127.0.0.1:1080/1081)"
echo "Используйте: curl --proxy socks5://127.0.0.1:1080 ifconfig.me"
EOF

cat > /usr/local/bin/proxy-off <<'EOF'
#!/bin/bash
# Отключает прокси
unset http_proxy
unset https_proxy
unset socks_proxy
unset all_proxy
echo "Прокси отключен"
EOF

chmod +x /usr/local/bin/proxy-on /usr/local/bin/proxy-off

# Создаем systemd сервис для автоматического включения прокси
cat > /etc/profile.d/xray-proxy.sh <<'EOF'
# Автоматическая настройка прокси для сессии
# Раскомментируйте следующую строку если хотите всегда использовать прокси
# export http_proxy="http://127.0.0.1:1081"
# export https_proxy="http://127.0.0.1:1081"
# export socks_proxy="socks5://127.0.0.1:1080"
EOF

# Формируем ссылку для клиента
LINK="vless://${UUID}@${IP}:${PORT}?type=tcp&security=reality&flow=xtls-rprx-vision&sni=${SNI}&pbk=${PUB_KEY}&sid=${SHORT_ID}#Remaware"

echo ""
echo "========================================="
echo "[✓] Xray Reality установлен и настроен!"
echo "========================================="
echo ""
echo "=== Ссылка для клиента ==="
echo "$LINK"
echo ""
echo "=== Как использовать прокси на сервере ==="
echo ""
echo "1. Для проверки IP без прокси:"
echo "   curl ifconfig.me"
echo ""
echo "2. Для использования прокси в текущей сессии:"
echo "   source /usr/local/bin/proxy-on"
echo "   curl ifconfig.me  # теперь покажет IP прокси"
echo "   source /usr/local/bin/proxy-off  # отключить"
echo ""
echo "3. Для отдельных команд:"
echo "   curl --socks5 127.0.0.1:1080 ifconfig.me"
echo "   curl -x http://127.0.0.1:1081 ifconfig.me"
echo ""
echo "4. Для постоянного использования прокси на сервере:"
echo "   Добавьте переменные в /etc/environment"
echo ""
echo "=== Доступные прокси порты ==="
echo "SOCKS5: 127.0.0.1:1080"
echo "HTTP:   127.0.0.1:1081"
echo "VLESS:  ${IP}:${PORT} (входящие соединения)"
echo ""
echo "=== Проверка работы ==="
echo "Проверьте IP через прокси:"
curl --socks5 127.0.0.1:1080 ifconfig.me 2>/dev/null || echo "Ошибка подключения к прокси"
