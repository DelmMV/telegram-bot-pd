const { Markup } = require('telegraf');

const keyboards = {
    getMainKeyboard: (isMonitoringActive) => {
        return Markup.keyboard([
            ['📊 Маршруты', '👤 Профиль'],
            [isMonitoringActive ? '🔴 Остановить мониторинг' : '🟢 Запустить мониторинг'],
            ['📝 Создать отчет'],
            ['🚪 Выйти']
        ]).resize();
    },

    getLoginKeyboard: Markup.keyboard([
        ['🔑 Войти'],
    ]).resize(),

    getRoutesKeyboard: Markup.inlineKeyboard([
        Markup.button.callback('На сегодня', 'routes_today'),
        Markup.button.callback('Выбрать дату', 'routes_select_date')
    ])
};

module.exports = keyboards;