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
		[Markup.button.callback('На сегодня', 'routes_today')],
		[Markup.button.callback('На завтра', 'routes_tomorrow')],
		[Markup.button.callback('Активные', 'routes_active')],
		[Markup.button.callback('Выбрать дату', 'routes_select_date')],
	]),

	getReportKeyboard: Markup.inlineKeyboard([
		[Markup.button.callback('8:30-21:00', 'report_time_8_30_21')],
		[Markup.button.callback('9:00-21:00', 'report_time_9_21')],
		[Markup.button.callback('Другое время', 'report_custom_time')],
	]),
}

module.exports = keyboards
