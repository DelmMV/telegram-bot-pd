const { Markup } = require("telegraf");

const keyboards = {
  getMainKeyboard: (isMonitoringActive) => {
    return Markup.keyboard([
      ["📅 Статистика за месяц", "📈 Общая статистика"],
      ["👤 Профиль", "📝 Создать отчет"],
      [
        isMonitoringActive
          ? "🔴 Выключить уведомления"
          : "🟢 Включить уведомления",
          "📊 Маршруты",
      ],
      ["🚪 Выйти"],
    ]).resize();
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
