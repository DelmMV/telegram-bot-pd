const { Markup } = require("telegraf");

const keyboards = {
  getMainKeyboard: (isMonitoringActive, options = {}) => {
    const showReportButton = options.showReportButton !== false;
    const rows = [
      ["📅 Статистика за месяц", "📈 Общая статистика"],
      showReportButton ? ["👤 Профиль", "📝 Создать отчет"] : ["👤 Профиль"],
      [
        isMonitoringActive
          ? "🔴 Выключить уведомления"
          : "🟢 Включить уведомления",
        "📊 Маршруты",
      ],
    ];
    rows.push(["🚪 Выйти"]);

    return Markup.keyboard(rows).resize();
  },

  getStatisticsKeyboard: Markup.inlineKeyboard([
    Markup.button.callback("На сегодня", "stats_today"),
    Markup.button.callback("Выбрать дату", "stats_select_date"),
  ]),

  getLoginKeyboard: Markup.keyboard([["🔑 Войти"]]).resize(),

  getRoutesKeyboard: Markup.inlineKeyboard([
    [Markup.button.callback("На сегодня", "routes_today")],
    [Markup.button.callback("На завтра", "routes_tomorrow")],
    [Markup.button.callback("Активные", "routes_active")],
    [Markup.button.callback("Выбрать дату", "routes_select_date")],
  ]),

  getReportKeyboard: Markup.inlineKeyboard([
    [Markup.button.callback("8:30-21:00", "report_time_8_30_21")],
    [Markup.button.callback("9:00-21:00", "report_time_9_21")],
    [Markup.button.callback("Другое время", "report_custom_time")],
  ]),

  getMonthlyStatsKeyboard: Markup.inlineKeyboard([
    [Markup.button.callback("📊 Текущий месяц", "monthly_stats_current")],
    [Markup.button.callback("📅 Прошлый месяц", "monthly_stats_previous")],
    [Markup.button.callback("📆 Выбрать месяц", "monthly_stats_select")],
  ]),

  getProfileKeyboard: ({
    hasTelegramSession,
    orderChannelConfigured,
    orderChannelEnabled,
    reportChannelConfigured,
    reportChannelEnabled,
  }) => {
    const buttons = [];
    if (!hasTelegramSession) {
      buttons.push([Markup.button.callback("🔐 Войти в Telegram", "tg_login")]);
    } else {
      buttons.push([
        Markup.button.callback(
          orderChannelConfigured
            ? "♻️ Сменить канал заказов"
            : "📦 Выбрать канал заказов",
          "tg_select_order_channel",
        ),
      ]);
      if (orderChannelConfigured) {
        buttons.push([
          Markup.button.callback(
            orderChannelEnabled
              ? "🚫 Отключить канал заказов"
              : "✅ Включить канал заказов",
            "tg_toggle_order_channel",
          ),
        ]);
      }

      buttons.push([
        Markup.button.callback(
          reportChannelConfigured
            ? "♻️ Сменить канал отчета"
            : "🧾 Выбрать канал отчета",
          "tg_select_report_channel",
        ),
      ]);
      if (reportChannelConfigured) {
        buttons.push([
          Markup.button.callback(
            reportChannelEnabled
              ? "🚫 Отключить канал отчета"
              : "✅ Включить канал отчета",
            "tg_toggle_report_channel",
          ),
        ]);
      }

      buttons.push([Markup.button.callback("🚪 Выйти из Telegram", "tg_logout")]);
    }
    return Markup.inlineKeyboard(buttons);
  },

  getPaymentActionKeyboard: (orderId) =>
    Markup.inlineKeyboard([
      [Markup.button.callback("Отправить в чат", `payment_send_${orderId}`)],
      [Markup.button.callback("Изменить способ оплаты", `payment_change_${orderId}`)],
    ]),

  getPaymentTypeKeyboard: (orderId) =>
    Markup.inlineKeyboard([
      [Markup.button.callback("Наличные", `payment_type_cash_${orderId}`)],
      [Markup.button.callback("Терминал", `payment_type_terminal_${orderId}`)],
      [Markup.button.callback("Сайт", `payment_type_site_${orderId}`)],
    ]),

  getQrLoginKeyboard: Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Обновить QR", "tg_refresh_qr")],
    [Markup.button.callback("✖️ Отмена", "tg_cancel_login")],
  ]),

  getChannelSelectionKeyboard: (channels, page, totalCount, pageSize) => {
    const buttons = channels.map((channel) => [
      Markup.button.callback(channel.title, `tg_channel_select_${channel.id}`),
    ]);
    const totalPages = Math.ceil(totalCount / pageSize);
    const navButtons = [];
    if (page > 0) {
      navButtons.push(
        Markup.button.callback("⬅️ Назад", `tg_channel_page_${page - 1}`),
      );
    }
    if (page < totalPages - 1) {
      navButtons.push(
        Markup.button.callback("➡️ Далее", `tg_channel_page_${page + 1}`),
      );
    }
    if (navButtons.length) {
      buttons.push(navButtons);
    }
    return Markup.inlineKeyboard(buttons);
  },

  getMonthSelectionKeyboard: (year) => {
    const months = [
      "Январь",
      "Февраль",
      "Март",
      "Апрель",
      "Май",
      "Июнь",
      "Июль",
      "Август",
      "Сентябрь",
      "Октябрь",
      "Ноябрь",
      "Декабрь",
    ];

    const buttons = [];
    for (let i = 0; i < months.length; i += 2) {
      const row = [
        Markup.button.callback(months[i], `month_select_${i + 1}_${year}`),
      ];
      if (i + 1 < months.length) {
        row.push(
          Markup.button.callback(
            months[i + 1],
            `month_select_${i + 2}_${year}`,
          ),
        );
      }
      buttons.push(row);
    }

    buttons.push([Markup.button.callback("🔙 Назад", "monthly_stats_back")]);

    return Markup.inlineKeyboard(buttons);
  },

  getYearSelectionKeyboard: () => {
    const currentYear = new Date().getFullYear();
    const buttons = [];

    for (let i = 0; i < 3; i++) {
      const year = currentYear - i;
      buttons.push([Markup.button.callback(`${year}`, `year_select_${year}`)]);
    }

    buttons.push([Markup.button.callback("🔙 Назад", "monthly_stats_back")]);

    return Markup.inlineKeyboard(buttons);
  },
};

module.exports = keyboards;
