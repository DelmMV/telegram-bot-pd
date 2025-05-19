const { Markup } = require('telegraf')

const keyboards = {
	getMainKeyboard: isMonitoringActive => {
		return Markup.keyboard([
			['📊 Маршруты', '📈 Общая статистика'],
			['👤 Профиль', '📝 Создать отчет'],
			[
				isMonitoringActive
					? '🔴 Остановить мониторинг'
					: '🟢 Запустить мониторинг',
			],
			['🚪 Выйти'],
		]).resize()
	},

	getStatisticsKeyboard: Markup.inlineKeyboard([
		Markup.button.callback('На сегодня', 'stats_today'),
		Markup.button.callback('Выбрать дату', 'stats_select_date'),
	]),

	getLoginKeyboard: Markup.keyboard([['🔑 Войти']]).resize(),

	getRoutesKeyboard: Markup.inlineKeyboard([
		Markup.button.callback('На сегодня', 'routes_today'),
		Markup.button.callback('На завтра', 'routes_tomorrow'),
		Markup.button.callback('Выбрать дату', 'routes_select_date'),
	]),
}

module.exports = keyboards
