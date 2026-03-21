import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from typing import Any

import requests
import telebot
from dotenv import load_dotenv
from telebot import types

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"), override=True)

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip().strip("'").strip('"')
API_BASE = os.getenv("PEAR_API_URL", "http://127.0.0.1:5174").strip()
ADMIN_IDS_RAW = os.getenv("TELEGRAM_ADMIN_IDS", "").strip()
PAYMENT_TEXT = os.getenv(
    "PAYMENT_TEXT",
    "💳 Оплата переводом на карту/кошелек.\nПосле оплаты нажмите кнопку «✅ Я оплатил(а)».",
).strip()
SUPPORT_TEXT = os.getenv("SUPPORT_TEXT", "@pearvpn_support").strip()
BOT_NAME = os.getenv("BOT_NAME", "Pear VPN").strip()

if not TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN is required")

ADMIN_IDS = {int(item.strip()) for item in ADMIN_IDS_RAW.split(",") if item.strip().isdigit()}
DB_PATH = os.path.join(BASE_DIR, "bot.db")

PLANS = {
    "plan_1m": {"title": "1 месяц", "days": 30, "price": "199 RUB", "traffic_gb": 100, "devices": 1},
    "plan_3m": {"title": "3 месяца", "days": 90, "price": "499 RUB", "traffic_gb": 350, "devices": 2},
    "plan_12m": {"title": "12 месяцев", "days": 365, "price": "1490 RUB", "traffic_gb": 1500, "devices": 3},
}

bot = telebot.TeleBot(TOKEN, parse_mode="HTML")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = db()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS customers (
          tg_user_id INTEGER PRIMARY KEY,
          username TEXT,
          full_name TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tg_user_id INTEGER NOT NULL,
          plan_code TEXT NOT NULL,
          plan_title TEXT NOT NULL,
          days INTEGER NOT NULL,
          price TEXT NOT NULL,
          status TEXT NOT NULL, -- pending_payment, waiting_approval, approved, rejected
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          backend_user_id TEXT,
          vless_link TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS notified_subscriptions (
          backend_user_id TEXT PRIMARY KEY,
          notified_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def api_get(path: str) -> Any:
    response = requests.get(f"{API_BASE}{path}", timeout=20)
    response.raise_for_status()
    return response.json()


def api_post(path: str, payload: Any | None = None) -> Any:
    response = requests.post(f"{API_BASE}{path}", json=payload or {}, timeout=20)
    response.raise_for_status()
    return response.json()


def save_customer(message: types.Message) -> None:
    if not message.from_user:
        return
    conn = db()
    conn.execute(
        """
        INSERT INTO customers(tg_user_id, username, full_name, created_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(tg_user_id) DO UPDATE SET
          username=excluded.username,
          full_name=excluded.full_name
        """,
        (
            message.from_user.id,
            message.from_user.username,
            f"{message.from_user.first_name or ''} {message.from_user.last_name or ''}".strip(),
            now_iso(),
        ),
    )
    conn.commit()
    conn.close()


def customer_menu() -> types.InlineKeyboardMarkup:
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("🛒 Купить VPN", callback_data="buy_open"))
    kb.add(types.InlineKeyboardButton("👤 Личный кабинет", callback_data="cabinet"))
    kb.add(types.InlineKeyboardButton("💎 Тарифы и преимущества", callback_data="plans_info"))
    kb.add(types.InlineKeyboardButton("❓ FAQ", callback_data="faq"))
    kb.add(types.InlineKeyboardButton("🆘 Поддержка", callback_data="support"))
    return kb


def plans_menu() -> types.InlineKeyboardMarkup:
    kb = types.InlineKeyboardMarkup()
    for code, plan in PLANS.items():
        kb.add(
            types.InlineKeyboardButton(
                f"{plan['title']} • {plan['price']}",
                callback_data=f"buy_plan:{code}",
            )
        )
    kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="main_menu"))
    return kb


def order_action_menu(order_id: int) -> types.InlineKeyboardMarkup:
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("✅ Я оплатил(а)", callback_data=f"paid:{order_id}"))
    kb.add(types.InlineKeyboardButton("❌ Отменить заказ", callback_data=f"cancel:{order_id}"))
    kb.add(types.InlineKeyboardButton("🏠 В меню", callback_data="main_menu"))
    return kb


def admin_review_menu(order_id: int) -> types.InlineKeyboardMarkup:
    kb = types.InlineKeyboardMarkup()
    kb.add(
        types.InlineKeyboardButton("✅ Подтвердить оплату", callback_data=f"admin_ok:{order_id}"),
        types.InlineKeyboardButton("❌ Отклонить", callback_data=f"admin_reject:{order_id}"),
    )
    return kb


def is_admin(user_id: int | None) -> bool:
    return bool(user_id and ADMIN_IDS and user_id in ADMIN_IDS)


def create_order(tg_user_id: int, plan_code: str) -> int:
    plan = PLANS[plan_code]
    conn = db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO orders(
          tg_user_id, plan_code, plan_title, days, price, status, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, 'pending_payment', ?, ?)
        """,
        (
            tg_user_id,
            plan_code,
            plan["title"],
            plan["days"],
            plan["price"],
            now_iso(),
            now_iso(),
        ),
    )
    order_id = cur.lastrowid
    conn.commit()
    conn.close()
    return int(order_id)


def fetch_order(order_id: int) -> sqlite3.Row | None:
    conn = db()
    row = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    conn.close()
    return row


def update_order_status(order_id: int, status: str) -> None:
    conn = db()
    conn.execute(
        "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?",
        (status, now_iso(), order_id),
    )
    conn.commit()
    conn.close()


def set_order_result(order_id: int, backend_user_id: str, vless_link: str) -> None:
    conn = db()
    conn.execute(
        """
        UPDATE orders
        SET status='approved', backend_user_id=?, vless_link=?, updated_at=?
        WHERE id=?
        """,
        (backend_user_id, vless_link, now_iso(), order_id),
    )
    conn.commit()
    conn.close()


def user_orders_text(tg_user_id: int) -> str:
    conn = db()
    rows = conn.execute(
        "SELECT id, plan_title, price, status, created_at, vless_link, backend_user_id FROM orders WHERE tg_user_id=? ORDER BY id DESC LIMIT 10",
        (tg_user_id,),
    ).fetchall()
    conn.close()
    if not rows:
        return "У вас пока нет заказов."

    lines = ["📜 <b>История заказов</b>"]
    for row in rows:
        status_emoji = {
            "pending_payment": "💳",
            "waiting_approval": "⏳",
            "approved": "✅",
            "rejected": "❌",
        }.get(row["status"], "•")
        lines.append(
            f"\n{status_emoji} <b>Заказ #{row['id']}</b>\n"
            f"Тариф: {row['plan_title']} | Цена: {row['price']}\n"
            f"Статус: <code>{row['status']}</code>\n"
            f"Дата: <code>{row['created_at']}</code>"
        )
        live_link = resolve_live_link(row["backend_user_id"], row["vless_link"])
        if live_link:
            lines.append(f"Ключ:\n<code>{live_link}</code>")
    return "\n".join(lines)


def is_notified(backend_user_id: str) -> bool:
    conn = db()
    row = conn.execute(
        "SELECT backend_user_id FROM notified_subscriptions WHERE backend_user_id=?",
        (backend_user_id,),
    ).fetchone()
    conn.close()
    return bool(row)


def set_notified(backend_user_id: str) -> None:
    conn = db()
    conn.execute(
        """
        INSERT INTO notified_subscriptions(backend_user_id, notified_at)
        VALUES(?, ?)
        ON CONFLICT(backend_user_id) DO UPDATE SET notified_at=excluded.notified_at
        """,
        (backend_user_id, now_iso()),
    )
    conn.commit()
    conn.close()

def resolve_live_link(backend_user_id: str | None, fallback_link: str | None = None) -> str:
    if backend_user_id:
        try:
            payload = api_get(f"/api/users/{backend_user_id}/link")
            link = payload.get("link", "")
            if link:
                return str(link)
        except Exception:
            pass
    return str(fallback_link or "")


def cabinet_menu() -> types.InlineKeyboardMarkup:
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("🔄 Продлить подписку", callback_data="buy_open"))
    kb.add(types.InlineKeyboardButton("📜 История заказов", callback_data="my_subs"))
    kb.add(types.InlineKeyboardButton("🆘 Поддержка", callback_data="support"))
    kb.add(types.InlineKeyboardButton("🏠 В меню", callback_data="main_menu"))
    return kb


def cabinet_text(tg_user_id: int) -> str:
    conn = db()
    latest_approved = conn.execute(
        """
        SELECT id, plan_title, created_at, vless_link, backend_user_id
        FROM orders
        WHERE tg_user_id=? AND status='approved'
        ORDER BY id DESC LIMIT 1
        """,
        (tg_user_id,),
    ).fetchone()
    pending_count = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE tg_user_id=? AND status IN ('pending_payment', 'waiting_approval')",
        (tg_user_id,),
    ).fetchone()["c"]
    total_orders = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE tg_user_id=?",
        (tg_user_id,),
    ).fetchone()["c"]
    conn.close()

    lines = ["👤 <b>Личный кабинет Pear VPN</b>"]
    lines.append("━━━━━━━━━━━━")
    lines.append(f"📦 Всего заказов: <b>{total_orders}</b>")
    lines.append(f"⏳ В обработке: <b>{pending_count}</b>")

    if not latest_approved:
        lines.append("\n🚫 <b>Активной подписки пока нет</b>")
        lines.append("Нажмите «🔄 Продлить подписку», чтобы подключить VPN за 1 минуту.")
        lines.append("После оплаты ключ придёт автоматически в этот чат.")
        return "\n".join(lines)

    lines.append("\n✅ <b>Активная подписка</b>")
    lines.append(f"Заказ: <b>#{latest_approved['id']}</b>")
    lines.append(f"Тариф: <b>{latest_approved['plan_title']}</b>")
    lines.append(f"Активирован: <code>{latest_approved['created_at']}</code>")

    # Try to resolve expiresAt from backend users list.
    expires_at = None
    try:
      users_payload = api_get("/api/users")
      users = users_payload.get("users", [])
      target = next((u for u in users if u.get("id") == latest_approved["backend_user_id"]), None)
      if target:
          expires_at = target.get("expiresAt")
    except Exception:
      pass

    if expires_at:
        lines.append(f"Истекает: <code>{expires_at}</code>")
    lines.append("━━━━━━━━━━━━")
    lines.append("🧩 Сейчас доступно:")
    lines.append("• Продлить подписку")
    lines.append("• Открыть историю заказов")
    lines.append("• Быстро связаться с поддержкой")
    live_link = resolve_live_link(latest_approved["backend_user_id"], latest_approved["vless_link"])
    if live_link:
        lines.append("\n🔐 <b>Ваш ключ:</b>")
        lines.append(f"<code>{live_link}</code>")

    return "\n".join(lines)


def ensure_user_link(order_id: int, days: int, tg_user_id: int) -> tuple[str, str, str]:
    username = f"tg_{tg_user_id}_{order_id}"
    conn = db()
    customer = conn.execute(
        "SELECT username, full_name FROM customers WHERE tg_user_id=?",
        (tg_user_id,),
    ).fetchone()
    conn.close()
    plan = next((value for value in PLANS.values() if value["days"] == days), None)

    payload = api_post(
        "/api/keys/client",
        {
            "name": username,
            "durationSeconds": int(days) * 24 * 60 * 60,
            "trafficLimitGb": plan["traffic_gb"] if plan else 100,
            "deviceLimit": plan["devices"] if plan else 1,
            "tgUserId": tg_user_id,
            "tgUsername": customer["username"] if customer else None,
            "tgFullName": customer["full_name"] if customer else None,
            "note": f"telegram order #{order_id}",
        },
    )
    backend_user = payload.get("user", {})
    sync = payload.get("sync", {})
    if not sync.get("synced", False):
        raise RuntimeError(f"xray sync failed: {sync.get('message', 'unknown error')}")
    link_payload = api_get(f"/api/users/{backend_user.get('id')}/link")
    link = link_payload.get("link", "")
    subscription_url = payload.get("subscriptionUrl", "")
    if not link:
        raise RuntimeError("failed to generate vless link")
    if not backend_user.get("id"):
        raise RuntimeError("backend did not return user id")
    return backend_user["id"], link, subscription_url


@bot.message_handler(commands=["start", "menu"])
def cmd_start(message: types.Message) -> None:
    save_customer(message)
    bot.reply_to(
        message,
        f"🍐 <b>{BOT_NAME}</b>\n"
        "🚀 Ваш личный VPN-кабинет прямо в Telegram.\n"
        "🔒 Безопасно • ⚡ Быстро • 🌍 Стабильно\n\n"
        "🧭 Как это работает:\n"
        "1) Выберите тариф\n"
        "2) Оплатите\n"
        "3) Получите готовый ключ <code>vless://...</code>\n\n"
        "👇 Выберите действие:",
        reply_markup=customer_menu(),
    )


@bot.callback_query_handler(func=lambda call: call.data in {"main_menu", "buy_open", "my_subs", "support", "plans_info", "cabinet", "faq"})
def handle_menu(call: types.CallbackQuery) -> None:
    if call.data == "main_menu":
        bot.edit_message_text(
            f"🍐 <b>{BOT_NAME}</b>\n"
            "🚀 Покупка VPN в 3 шага: тариф → оплата → ключ.\n\n"
            "👇 Выберите действие:",
            call.message.chat.id,
            call.message.message_id,
            reply_markup=customer_menu(),
        )
    elif call.data == "buy_open":
        bot.edit_message_text(
            "💎 <b>Выберите тариф:</b>",
            call.message.chat.id,
            call.message.message_id,
            reply_markup=plans_menu(),
        )
    elif call.data == "my_subs":
        bot.edit_message_text(
            user_orders_text(call.from_user.id),
            call.message.chat.id,
            call.message.message_id,
            reply_markup=cabinet_menu(),
        )
    elif call.data == "cabinet":
        bot.edit_message_text(
            cabinet_text(call.from_user.id),
            call.message.chat.id,
            call.message.message_id,
            reply_markup=cabinet_menu(),
        )
    else:
        if call.data == "faq":
            bot.edit_message_text(
                "❓ <b>FAQ</b>\n\n"
                "🔹 <b>Как подключиться?</b>\n"
                "Импортируйте ссылку <code>vless://...</code> в клиент (v2rayNG, Streisand, Hiddify, Shadowrocket).\n\n"
                "🔹 <b>Когда приходит ключ?</b>\n"
                "Сразу после подтверждения оплаты.\n\n"
                "🔹 <b>Можно продлить заранее?</b>\n"
                "Да, через личный кабинет.\n\n"
                f"🔹 <b>Если есть проблема?</b>\nПишите: {SUPPORT_TEXT}",
                call.message.chat.id,
                call.message.message_id,
                reply_markup=customer_menu(),
            )
            return
        if call.data == "plans_info":
            bot.edit_message_text(
                "✨ <b>Почему Pear VPN</b>\n"
                "• ⚡ Высокая скорость\n"
                "• 🔒 Безопасный протокол VLESS Reality\n"
                "• 🌍 Стабильный доступ к нужным сервисам\n"
                "• 📲 Простое подключение по одной ссылке\n\n"
                "💼 <b>Тарифы:</b>\n"
                "• 1 месяц — 199 RUB\n"
                "• 3 месяца — 499 RUB\n"
                "• 12 месяцев — 1490 RUB\n\n"
                "Нажмите «🛒 Купить VPN», чтобы оформить доступ.",
                call.message.chat.id,
                call.message.message_id,
                reply_markup=customer_menu(),
            )
            return
        bot.edit_message_text(
            f"🆘 <b>Поддержка</b>\n"
            f"Контакт: {SUPPORT_TEXT}\n\n"
            "Поможем с оплатой, подключением и продлением.",
            call.message.chat.id,
            call.message.message_id,
            reply_markup=customer_menu(),
        )


@bot.callback_query_handler(func=lambda call: call.data.startswith("buy_plan:"))
def handle_buy_plan(call: types.CallbackQuery) -> None:
    plan_code = call.data.split(":", 1)[1]
    if plan_code not in PLANS:
        return bot.answer_callback_query(call.id, "Неизвестный тариф")
    order_id = create_order(call.from_user.id, plan_code)
    plan = PLANS[plan_code]
    bot.edit_message_text(
        f"🧾 <b>Заказ #{order_id}</b>\n"
        f"📦 Тариф: {plan['title']}\n"
        f"💰 Цена: {plan['price']}\n\n"
        f"{PAYMENT_TEXT}\n\n"
        "После оплаты нажмите кнопку ниже 👇",
        call.message.chat.id,
        call.message.message_id,
        reply_markup=order_action_menu(order_id),
    )


@bot.callback_query_handler(func=lambda call: call.data.startswith("cancel:"))
def handle_cancel_order(call: types.CallbackQuery) -> None:
    order_id = int(call.data.split(":", 1)[1])
    row = fetch_order(order_id)
    if not row or row["tg_user_id"] != call.from_user.id:
        return bot.answer_callback_query(call.id, "Заказ не найден")
    update_order_status(order_id, "rejected")
    bot.edit_message_text(
        f"❌ Заказ #{order_id} отменён.",
        call.message.chat.id,
        call.message.message_id,
        reply_markup=customer_menu(),
    )


@bot.callback_query_handler(func=lambda call: call.data.startswith("paid:"))
def handle_paid(call: types.CallbackQuery) -> None:
    order_id = int(call.data.split(":", 1)[1])
    row = fetch_order(order_id)
    if not row or row["tg_user_id"] != call.from_user.id:
        return bot.answer_callback_query(call.id, "Заказ не найден")

    update_order_status(order_id, "waiting_approval")
    bot.edit_message_text(
        f"⏳ Заказ #{order_id} отправлен на проверку оплаты.\nОжидайте подтверждение.",
        call.message.chat.id,
        call.message.message_id,
        reply_markup=customer_menu(),
    )

    if ADMIN_IDS:
        for admin_id in ADMIN_IDS:
            try:
                bot.send_message(
                    admin_id,
                    f"<b>Новый платёж на проверку</b>\n"
                    f"Заказ #{row['id']}\n"
                    f"User: <code>{row['tg_user_id']}</code>\n"
                    f"Тариф: {row['plan_title']} ({row['days']} дней)\n"
                    f"Цена: {row['price']} 💸\n"
                    f"Создан: {row['created_at']}",
                    reply_markup=admin_review_menu(order_id),
                )
            except Exception:
                pass


@bot.callback_query_handler(func=lambda call: call.data.startswith("admin_ok:") or call.data.startswith("admin_reject:"))
def handle_admin_review(call: types.CallbackQuery) -> None:
    if not is_admin(call.from_user.id):
        return bot.answer_callback_query(call.id, "Нет доступа")

    approved = call.data.startswith("admin_ok:")
    order_id = int(call.data.split(":", 1)[1])
    row = fetch_order(order_id)
    if not row:
        return bot.answer_callback_query(call.id, "Заказ не найден")
    if row["status"] != "waiting_approval":
        return bot.answer_callback_query(call.id, f"Текущий статус: {row['status']}")

    if not approved:
        update_order_status(order_id, "rejected")
        bot.edit_message_text(
            f"❌ Заказ #{order_id} отклонён.",
            call.message.chat.id,
            call.message.message_id,
        )
        bot.send_message(
            row["tg_user_id"],
            f"❌ Заказ #{order_id} отклонён.\nНапишите в поддержку: {SUPPORT_TEXT}",
            reply_markup=customer_menu(),
        )
        return

    try:
        backend_user_id, vless_link, subscription_url = ensure_user_link(order_id, int(row["days"]), int(row["tg_user_id"]))
        set_order_result(order_id, backend_user_id, vless_link)
        bot.edit_message_text(
            f"Заказ #{order_id} подтвержден.\nUser: {backend_user_id}",
            call.message.chat.id,
            call.message.message_id,
        )
        bot.send_message(
            row["tg_user_id"],
            f"✅ Оплата подтверждена!\n"
            f"🔗 <b>Подписка (рекомендуется для Hiddify / v2rayTun):</b>\n"
            f"<code>{subscription_url}</code>\n\n"
            f"🔐 Резервный прямой ключ:\n<code>{vless_link}</code>\n\n"
            "📲 Импортируйте ссылку подписки в приложение.\n"
            "💬 Если нужна помощь с подключением, напишите в поддержку.",
            reply_markup=customer_menu(),
        )
    except Exception as exc:
        bot.edit_message_text(
            f"Ошибка выдачи заказа #{order_id}: {exc}",
            call.message.chat.id,
            call.message.message_id,
        )


@bot.message_handler(commands=["admin_orders"])
def cmd_admin_orders(message: types.Message) -> None:
    if not is_admin(message.from_user.id):
        return
    conn = db()
    rows = conn.execute(
        "SELECT id, tg_user_id, plan_title, price, status, created_at FROM orders ORDER BY id DESC LIMIT 20"
    ).fetchall()
    conn.close()
    if not rows:
        return bot.reply_to(message, "Заказов нет.")
    lines = ["<b>Последние заказы:</b>"]
    for row in rows:
        lines.append(
            f"#{row['id']} | user={row['tg_user_id']} | {row['plan_title']} {row['price']} | {row['status']} | {row['created_at']}"
        )
    bot.reply_to(message, "\n".join(lines))


@bot.message_handler(commands=["plans"])
def cmd_plans(message: types.Message) -> None:
    bot.reply_to(
        message,
        "💎 <b>Тарифы Pear VPN</b>\n"
        "• 1 месяц — 199 RUB\n"
        "• 3 месяца — 499 RUB\n"
        "• 12 месяцев — 1490 RUB\n\n"
        "Нажмите /start для покупки.",
    )


@bot.message_handler(commands=["cabinet"])
def cmd_cabinet(message: types.Message) -> None:
    bot.reply_to(message, cabinet_text(message.from_user.id), reply_markup=cabinet_menu())


@bot.message_handler(commands=["health"])
def cmd_health(message: types.Message) -> None:
    try:
        health = api_get("/api/health")
        bot.reply_to(message, f"API: {health.get('service', 'ok')}")
    except Exception as exc:
        bot.reply_to(message, f"API error: {exc}")


@bot.message_handler(func=lambda _: True)
def fallback(message: types.Message) -> None:
    bot.reply_to(message, "Используйте /start")


def panel_subscription_watcher() -> None:
    # Watches panel users DB via API and notifies Telegram users when subscription was created in panel.
    while True:
        try:
            payload = api_get("/api/users")
            users = payload.get("users", [])
            for user in users:
                tg_user_id = user.get("tgUserId")
                backend_user_id = user.get("id")
                status = user.get("status")
                if not tg_user_id or not backend_user_id or status != "active":
                    continue
                if is_notified(backend_user_id):
                    continue

                sub_url = user.get("subscriptionUrl", "")
                link = user.get("link", "")
                expires_at = user.get("expiresAt", "")
                traffic = user.get("trafficLimitGb")
                devices = user.get("deviceLimit")

                bot.send_message(
                    int(tg_user_id),
                    "🎉 Вам выдана новая подписка VPN!\n\n"
                    f"🔗 Подписка (Hiddify/v2rayTun):\n<code>{sub_url}</code>\n\n"
                    f"🔐 Прямой ключ:\n<code>{link}</code>\n\n"
                    f"📅 Активен до: <code>{expires_at}</code>\n"
                    f"📶 Трафик: <b>{traffic if traffic is not None else '∞'} GB</b>\n"
                    f"📱 Устройств: <b>{devices if devices is not None else 1}</b>",
                    reply_markup=customer_menu(),
                )
                set_notified(backend_user_id)
        except Exception:
            pass

        time.sleep(15)


if __name__ == "__main__":
    init_db()
    threading.Thread(target=panel_subscription_watcher, daemon=True).start()
    print("Pear VPN customer bot started")
    bot.infinity_polling(skip_pending=True, timeout=30, long_polling_timeout=30)
