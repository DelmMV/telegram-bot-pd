const db = require("./database");
const api = require("./api");

/**
 * Получает статистику за определенную дату
 * @param {number} userId - ID пользователя
 * @param {string} date - Дата в формате ДД.ММ.ГГГГ
 * @param {string} sessionId - ID сессии
 * @param {Object} credentials - Учетные данные
 * @returns {Promise<Object|null>}
 */
async function getDailyStatistics(userId, date, sessionId, credentials) {
  try {
    const result = await api.getRoutes(sessionId, date, credentials);

    if (result.sessionUpdated) {
      const session = await db.getSession(userId);
      session.session_id = result.newSessionId;
      await db.saveSession(userId, session);
      sessionId = result.newSessionId;
    }

    const response = result.data;

    if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) {
      return null;
    }

    const routes = response.TL_Mobile_EnumRoutesResponse.Routes;

    // Если маршрутов нет - это не рабочий день
    if (!routes || routes.length === 0) {
      return null;
    }

    let totalCashAmount = 0;
    let totalNonCashAmount = 0;
    let totalSiteAmount = 0;
    let totalOrders = routes.reduce(
      (sum, route) => sum + (route.Orders?.length || 0),
      0,
    );
    let completedOrders = 0;
    let canceledOrders = 0;

    for (const route of routes) {
      const detailsResult = await api.getRouteDetails(
        sessionId,
        [route.Id],
        credentials,
      );

      if (detailsResult.sessionUpdated) {
        const session = await db.getSession(userId);
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(userId, session);
        sessionId = detailsResult.newSessionId;
      }

      const routeDetails =
        detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];

      const orderIds = Array.from(
        new Set(
          routeDetails.Points.flatMap(
            (point) => point.Orders?.map((order) => order.Id) || [],
          ).filter((id) => id),
        ),
      );

      if (orderIds.length === 0) {
        continue;
      }

      const orderDetailsResult = await api.getOrderDetails(
        sessionId,
        orderIds,
        credentials,
      );

      if (orderDetailsResult.sessionUpdated) {
        const session = await db.getSession(userId);
        session.session_id = orderDetailsResult.newSessionId;
        await db.saveSession(userId, session);
        sessionId = orderDetailsResult.newSessionId;
      }

      const orders = orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;
      orders.forEach((order) => {
        if (order.InvoiceTotal) {
          const amount = parseFloat(order.InvoiceTotal) || 0;

          switch (order.CustomState) {
            case "ceb8edd8-a0d9-4116-a8ee-a6c0be89103b": // Выполнен (нал)
              totalCashAmount += amount;
              completedOrders++;
              break;
            case "d4535403-e4f6-4888-859e-098b7829b3a6": // Выполнен (безнал)
              totalNonCashAmount += amount;
              completedOrders++;
              break;
            case "b107b2e5-fe96-46ec-9c1d-7248d77e8383": // Выполнен (сайт)
              totalSiteAmount += amount;
              completedOrders++;
              break;
            case "51e45c11-d5c7-4383-8fc4-a2e2e1781230": // Отменён
              canceledOrders++;
              break;
          }
        }
      });
    }

    const totalAmount = totalCashAmount + totalNonCashAmount + totalSiteAmount;

    return {
      totalOrders,
      completedOrders,
      canceledOrders,
      cashAmount: totalCashAmount,
      nonCashAmount: totalNonCashAmount,
      siteAmount: totalSiteAmount,
      totalAmount,
      routesCount: routes.length,
    };
  } catch (error) {
    console.error("Error getting daily statistics:", error);
    return null;
  }
}

/**
 * Собирает и сохраняет статистику за месяц
 * @param {number} userId - ID пользователя
 * @param {number} month - Месяц (1-12)
 * @param {number} year - Год
 * @param {Function} progressCallback - Callback для отображения прогресса
 * @returns {Promise<Object>}
 */
async function collectMonthlyStatistics(userId, month, year, progressCallback) {
  const session = await db.getSession(userId);
  if (!session?.session_id) {
    throw new Error("Пользователь не авторизован");
  }

  const credentials = {
    clientCode: session.client_code,
    login: session.login,
    password: session.password,
  };

  const daysInMonth = new Date(year, month, 0).getDate();
  let processedDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = day.toString().padStart(2, "0");
    const monthStr = month.toString().padStart(2, "0");
    const date = `${dayStr}.${monthStr}.${year}`;

    try {
      // Обновляем сессию перед каждым запросом
      const currentSession = await db.getSession(userId);

      const stats = await getDailyStatistics(
        userId,
        date,
        currentSession.session_id,
        credentials,
      );

      // Сохраняем только если был рабочий день (были маршруты)
      if (stats && stats.routesCount > 0) {
        await db.saveShiftHistory(userId, date, stats);
      }
    } catch (error) {
      console.error(`Error collecting stats for ${date}:`, error);
    }

    processedDays++;
    if (progressCallback) {
      await progressCallback(processedDays, daysInMonth);
    }

    // Небольшая задержка между запросами
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return await db.getMonthlyStats(userId, month, year);
}

/**
 * Форматирует статистику за месяц в текстовое сообщение
 * @param {Object} stats - Статистика
 * @param {number} month - Месяц
 * @param {number} year - Год
 * @returns {string}
 */
function formatMonthlyStats(stats, month, year) {
  const monthNames = [
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

  return (
    `📊 Статистика за ${monthNames[month - 1]} ${year}\n\n` +
    `🚗 Смены: ${stats.shifts_count || 0}\n` +
    `🚚 Всего маршрутов: ${stats.routes_count || 0}\n\n` +
    `📦 Заказы:\n` +
    `├ 📋 Всего: ${stats.total_orders || 0}\n` +
    `├ ✅ Выполнено: ${stats.completed_orders || 0}\n` +
    `└ ❌ Отменено: ${stats.canceled_orders || 0}\n\n` +
    `💰 Финансы:\n` +
    `├ 💵 Наличные: ${(stats.cash_amount || 0).toFixed(2)} руб.\n` +
    `├ 💳 Терминал: ${(stats.non_cash_amount || 0).toFixed(2)} руб.\n` +
    `├ 🌐 Сайт: ${(stats.site_amount || 0).toFixed(2)} руб.\n` +
    `└ 📈 Всего: ${(stats.total_amount || 0).toFixed(2)} руб.`
  );
}

module.exports = {
  getDailyStatistics,
  collectMonthlyStatistics,
  formatMonthlyStats,
};
