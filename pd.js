const { Telegraf } = require("telegraf");
const config = require("./config");
const db = require("./database");
const api = require("./api");
const keyboards = require("./keyboards");
const monitoring = require("./monitoring");
const monthlyStats = require("./monthly-stats");
const distanceCalculator = require("./distance-calculator");

const bot = new Telegraf(config.TELEGRAM_TOKEN);

const inFlightChecks = new Set();
const RETRYABLE_TELEGRAM_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_TELEGRAM_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ECONNREFUSED",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Безопасная обработка callback-запросов с таймаутом и обработкой ошибок
const safeCallback = async (ctx, handler, timeoutMs = 85000) => {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Callback timeout')), timeoutMs);
  });
  
  try {
    await Promise.race([handler(ctx), timeoutPromise]);
    await ctx.answerCbQuery().catch(() => {}); // Всегда отвечаем на callback
  } catch (error) {
    console.error(`Callback error (${ctx.callbackQuery?.data}):`, error);
    
    // Пытаемся ответить на callback, чтобы избежать "постоянных загрузок"
    await ctx.answerCbQuery('❌ Ошибка обработки').catch(() => {});
    
    // Уведомляем пользователя
    try {
      await ctx.reply('⚠️ Произошла ошибка при обработке запроса. Попробуйте позже.');
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
    
    // Логируем для админа (если есть)
    const adminUserIds = new Set(config.ADMIN_USER_IDS);
    if (adminUserIds.size > 0 && !adminUserIds.has(ctx.from?.id)) {
      const adminId = Array.from(adminUserIds)[0];
      try {
        await sendTelegramMessage(
          adminId,
          `⚠️ Ошибка callback: ${ctx.callbackQuery?.data}\nUser: ${ctx.from?.id}\nError: ${error.message}`
        );
      } catch (e) {
        console.error('Failed to notify admin:', e);
      }
    }
  }
};

const getTelegramRetryDelay = (attempt, error) => {
  const retryAfter =
    error?.parameters?.retry_after || error?.response?.parameters?.retry_after;
  if (Number.isFinite(retryAfter)) {
    return retryAfter * 1000;
  }
  const baseDelay = config.TELEGRAM_RETRY_BASE_DELAY_MS;
  const maxDelay = config.TELEGRAM_RETRY_MAX_DELAY_MS;
  // Экспоненциальный бекофф с jitter (рандомизация)
  const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.3 * delay; // 0-30% jitter
  return Math.floor(delay + jitter);
};

const isRetryableTelegramError = (error) => {
  const status = error?.response?.error_code || error?.response?.status;
  if (status && RETRYABLE_TELEGRAM_STATUS.has(status)) {
    return true;
  }
  const code = error?.code;
  return code && RETRYABLE_TELEGRAM_CODES.has(code);
};

async function sendTelegramMessage(chatId, text, options) {
  const maxAttempts = Math.max(1, config.TELEGRAM_RETRY_ATTEMPTS);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await bot.telegram.sendMessage(chatId, text, options);
    } catch (error) {
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !isRetryableTelegramError(error)) {
        throw error;
      }
      const delay = getTelegramRetryDelay(attempt, error);
      console.warn(
        `Telegram sendMessage failed (attempt ${attempt}), retrying in ${delay}ms`,
        error.code || error.message,
      );
      await sleep(delay);
    }
  }
}

const adminUserIds = new Set(config.ADMIN_USER_IDS);
const isAdminUser = (userId) =>
  adminUserIds.size > 0 && adminUserIds.has(userId);

const parseBroadcastText = (text) =>
  text
    .replace(/^\/(?:broadcast|br)(?:@\w+)?\s*/i, "")
    .trim();

const getTelegramErrorCode = (error) =>
  error?.response?.error_code || error?.response?.status;

const isUserUnreachable = (error) => {
  const code = getTelegramErrorCode(error);
  if (code === 403) return true;
  if (code !== 400) return false;
  const description = (error?.response?.description || "").toLowerCase();
  return (
    description.includes("chat not found") ||
    description.includes("user is deactivated") ||
    description.includes("bot was blocked")
  );
};

async function broadcastMessage(adminId, messageText) {
  const userIds = await db.getAllUserIds();
  const total = userIds.length;

  if (total === 0) {
    await sendTelegramMessage(adminId, "Нет пользователей для рассылки.");
    return;
  }

  await sendTelegramMessage(
    adminId,
    `📣 Начинаю рассылку для пользователей: ${total}`,
  );

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (const userId of userIds) {
    try {
      await sendTelegramMessage(userId, messageText, {
        disable_web_page_preview: true,
      });
      sent += 1;
    } catch (error) {
      if (isUserUnreachable(error)) {
        blocked += 1;
        console.warn(`Broadcast skipped for user ${userId}: unreachable.`);
        try {
          await db.deleteSession(userId);
        } catch (dbError) {
          console.error(
            `Failed to delete session for unreachable user ${userId}:`,
            dbError,
          );
        }
      } else {
        failed += 1;
        console.error(`Broadcast failed for user ${userId}:`, error);
      }
    }

    if (config.BROADCAST_DELAY_MS > 0) {
      await sleep(config.BROADCAST_DELAY_MS);
    }
  }

  await sendTelegramMessage(
    adminId,
    `✅ Рассылка завершена. Успешно: ${sent}, заблокировали: ${blocked}, ошибок: ${failed}.`,
  );
}

const ORDER_STATES = {
  "51e45c11-d5c7-4383-8fc4-a2e2e1781230": "Отменён",
  "dfab6563-55b8-475d-aac5-01b6705265cd": "Новый",
  "8b176fdd-4718-46eb-b4f6-1cf487e5353b": "Доставляется",
  "b107b2e5-fe96-46ec-9c1d-7248d77e8383": "Выполнен (сайт)",
  "ceb8edd8-a0d9-4116-a8ee-a6c0be89103b": "Выполнен (нал)",
  "d4535403-e4f6-4888-859e-098b7829b3a6": "Выполнен (безнал)",
  "01c157f5-ec6a-47b6-a655-981489e6022a": "Запланирован",
  "3e3d9e5d-b04a-4950-97f5-f6060b5362b6": "В машине",
  "e11e0bf2-4e34-4789-bdb6-b6c284f93bbf": "Частично выполнен",
  "50b9348e-1da1-44e3-b84b-88b68da829a4": "Отложен",
};

function getOrderStatusName(statusId) {
  return ORDER_STATES[statusId] || "Неизвестный статус";
}

async function checkNewOrders(userId, sessionId, allowReentry = false) {
  if (!allowReentry && inFlightChecks.has(userId)) {
    return;
  }
  if (!allowReentry) {
    inFlightChecks.add(userId);
  }

  try {
    const session = await db.getSession(userId);
    if (!session) {
      return;
    }
    if (!session.session_id && !sessionId) {
      return;
    }
    const credentials = {
      clientCode: session.client_code,
      login: session.login,
      password: session.password,
    };

    let activeSessionId = session?.session_id || sessionId;
    const currentDate = new Date().toLocaleDateString("ru-RU");
    // Таймаут 45 секунд для проверки новых заказов
    const result = await Promise.race([
      api.getRoutes(activeSessionId, currentDate, credentials),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Проверка заказов заняла слишком много времени')), 45000)
      )
    ]);

    if (result.sessionUpdated) {
      session.session_id = result.newSessionId;
      await db.saveSession(userId, session);
      activeSessionId = result.newSessionId;
    }

    const response = result.data;
    if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) return;

    const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
    const currentOrders = new Set(
      routes.flatMap(
        (route) => route.Orders?.map((order) => order.ExternalId) || [],
      ),
    );

    const previousOrders = monitoring.getLastKnownOrders(userId);
    const newOrders = [...currentOrders].filter(
      (order) => !previousOrders.has(order),
    );

    if (newOrders.length) {
      for (const route of routes) {
        const routeOrders =
          route.Orders?.map((order) => order.ExternalId) || [];
        const hasNewOrders = routeOrders.some((orderId) =>
          newOrders.includes(orderId),
        );

        if (hasNewOrders) {
          const detailsResult = await api.getRouteDetails(
            activeSessionId,
            [route.Id],
            credentials,
          );

          if (detailsResult.sessionUpdated) {
            session.session_id = detailsResult.newSessionId;
            await db.saveSession(userId, session);
            activeSessionId = detailsResult.newSessionId;
          }

          const routeDetails =
            detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];

          // Получаем orderIds для детальной информации
          const orderIds = routeDetails.Points.flatMap(
            (point) => point.Orders?.map((order) => order.Id) || [],
          ).filter((id) => id);

          // Получаем детальную информацию о заказах
          const orderDetailsResult = await api.getOrderDetails(
            activeSessionId,
            orderIds,
            credentials,
          );
          if (orderDetailsResult.sessionUpdated) {
            session.session_id = orderDetailsResult.newSessionId;
            await db.saveSession(userId, session);
            activeSessionId = orderDetailsResult.newSessionId;
          }

          const orders =
            orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;

          let messageText = `🆕 Новые заказы в маршруте ${routeDetails.Number}:\n\n`;

          for (let i = 1; i < routeDetails.Points.length; i++) {
            const point = routeDetails.Points[i];
            const pointOrder = point.Orders?.[0];

            if (pointOrder && newOrders.includes(pointOrder.ExternalId)) {
              const orderDetails = orders.find((o) => o.Id === pointOrder.Id);
              messageText += `📦 Заказ: ${pointOrder.ExternalId}\n`;

              // Создаем кликабельную ссылку на карту с адресом
              const encodedAddress = encodeURIComponent(point.Address);
              messageText += `📮 Адрес: <a href="https://yandex.ru/maps/?text=${encodedAddress}">${point.Address}</a>\n`;
              messageText += `🧭 <a href="yandexnavi://map_search?text=${encodedAddress}">Открыть в навигаторе</a>\n`;

              if (point.Description) {
                messageText += `👤 Получатель: ${point.Description}\n`;
              }

              if (orderDetails?.To?.ContactPhone) {
                messageText += `📱 Телефон: ${orderDetails.To.ContactPhone}\n`;
              }

              if (point.Weight) {
                messageText += `⚖️ Вес: ${point.Weight} ${routeDetails.WeightUnit}\n`;
              }

              if (orderDetails?.InvoiceTotal) {
                messageText += `💰 Стоимость: ${orderDetails.InvoiceTotal} руб.\n`;
              }

              if (orderDetails?.Comment) {
                messageText += `📝 Комментарий: ${orderDetails.Comment}\n`;
              }

              // Добавляем информацию о временном окне доставки, если она есть
              if (orderDetails?.To?.StartTime && orderDetails?.To?.EndTime) {
                const startTime = new Date(
                  orderDetails.To.StartTime,
                ).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                const endTime = new Date(
                  orderDetails.To.EndTime,
                ).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                messageText += `⏰ Временное окно: ${startTime} - ${endTime}\n`;
              }

              messageText += `\n`;
            }
          }

          // Отправляем сообщение с учетом ограничения длины
          if (messageText.length > config.MAX_MESSAGE_LENGTH) {
            // Модифицированный алгоритм разбиения сообщения, чтобы не разрывать HTML-теги
            let position = 0;
            while (position < messageText.length) {
              let endPosition = position + config.MAX_MESSAGE_LENGTH;

              // Если мы не в конце сообщения, найдем безопасную точку для разрыва
              if (endPosition < messageText.length) {
                // Ищем последний перевод строки перед лимитом
                const lastNewLine = messageText.lastIndexOf("\n", endPosition);
                if (lastNewLine > position) {
                  endPosition = lastNewLine + 1; // +1 чтобы включить символ переноса строки
                } else {
                  // Если нет переноса строки, убедимся что не разрываем HTML-тег
                  let openTagIndex = messageText.lastIndexOf(
                    "<a href=",
                    endPosition,
                  );
                  let closeTagIndex = messageText.lastIndexOf(
                    "</a>",
                    endPosition,
                  );

                  // Если открывающий тег находится перед закрывающим, значит тег не закрыт
                  if (openTagIndex > closeTagIndex) {
                    // Найдем предыдущий перенос строки перед открывающим тегом
                    const safeBreak = messageText.lastIndexOf(
                      "\n",
                      openTagIndex,
                    );
                    if (safeBreak > position) {
                      endPosition = safeBreak + 1;
                    }
                  }
                }
              }

              try {
                await sendTelegramMessage(
                  userId,
                  messageText.slice(position, endPosition),
                  {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                  },
                );
              } catch (sendError) {
                console.error("Error sending order notification:", sendError);
                break;
              }

              position = endPosition;
            }
          } else {
            try {
              await sendTelegramMessage(userId, messageText, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
              });
            } catch (sendError) {
              console.error("Error sending order notification:", sendError);
            }
          }
        }
      }
    }

    monitoring.updateLastKnownOrders(userId, currentOrders);
  } catch (error) {
    console.error("Error checking orders:", error);

    if (error.isSessionExpired) {
      const session = await db.getSession(userId);
      const credentials = {
        clientCode: session.client_code,
        login: session.login,
        password: session.password,
      };

      try {
        const authResponse = await api.refreshSession(credentials);
        session.session_id = authResponse;
        await db.saveSession(userId, session);
        await checkNewOrders(userId, authResponse, true);
      } catch (refreshError) {
        console.error("Session refresh error:", refreshError);
        try {
          await sendTelegramMessage(
            userId,
            "Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start",
          );
        } catch (sendError) {
          console.error("Error sending session refresh message:", sendError);
        }
        monitoring.stopMonitoring(userId);
      }
    } else if (error.message && error.message.includes('таймаут')) {
      console.warn(`Timeout in monitoring for user ${userId}, continuing...`);
      // Не останавливаем мониторинг при таймауте, просто пропускаем цикл
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      console.warn(`Network error in monitoring for user ${userId}, continuing...`);
      // Не останавливаем мониторинг при сетевых ошибках
    } else {
      // При других ошибках останавливаем мониторинг
      try {
        await sendTelegramMessage(
          userId,
          "⚠️ Мониторинг остановлен из-за ошибки. Запустите заново через меню.",
        );
      } catch (sendError) {
        console.error("Error sending monitoring stop message:", sendError);
      }
      monitoring.stopMonitoring(userId);
    }
  } finally {
    if (!allowReentry) {
      inFlightChecks.delete(userId);
    }
  }
}

async function showRoutes(ctx, date) {
  try {
    const session = await db.getSession(ctx.from.id);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const credentials = {
      clientCode: session.client_code,
      login: session.login,
      password: session.password,
    };

    // Таймаут 60 секунд для получения маршрутов
    const result = await Promise.race([
      api.getRoutes(session.session_id, date, credentials),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Получение маршрутов заняло слишком много времени')), 60000)
      )
    ]);

    if (result.sessionUpdated) {
      session.session_id = result.newSessionId;
      await db.saveSession(ctx.from.id, session);
    }

    const response = result.data;

    if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) {
      return await ctx.reply(
        `📭 Маршруты на ${date} не найдены`,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
      );
    }

    const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
    const totalOrders = routes.reduce((sum, route) => {
      if (route.Orders && Array.isArray(route.Orders)) {
        return sum + route.Orders.length;
      }
      return sum;
    }, 0);

    if (totalOrders === 0) {
      return await ctx.reply(
        `📭 На ${date} заказов нет`,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
      );
    }

    for (const route of routes) {
      const detailsResult = await Promise.race([
        api.getRouteDetails(session.session_id, [route.Id], credentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Получение деталей маршрута заняло слишком много времени')), 30000)
        )
      ]);

      if (detailsResult.sessionUpdated) {
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(ctx.from.id, session);
      }

      const routeDetails =
        detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];

      const orderIds = routeDetails.Points.flatMap(
        (point) => point.Orders?.map((order) => order.Id) || [],
      ).filter((id) => id);

      const orderDetailsResult = await Promise.race([
        api.getOrderDetails(session.session_id, orderIds, credentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Получение деталей заказов заняло слишком много времени')), 30000)
        )
      ]);
      if (detailsResult.sessionUpdated) {
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(ctx.from.id, session);
      }

      const orders = orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;

      let messageText = `🚚 Маршрут ${routes.indexOf(route) + 1}\n`;
      messageText += `📝 Номер: ${routeDetails.Number}\n`;
      messageText += `📦 Всего точек: ${routeDetails.Points.length - 1}\n\n`;

      for (let i = 1; i < routeDetails.Points.length; i++) {
        const point = routeDetails.Points[i];
        messageText += `📍 Точка ${point.Label}:\n`;

        if (
          point.Orders &&
          point.Orders.length > 0 &&
          point.Orders[0].ExternalId
        ) {
          messageText += `🔹 Заказ: ${point.Orders[0].ExternalId}\n`;
        }

        // Создаем кликабельную ссылку на карту с адресом
        const encodedAddress = encodeURIComponent(point.Address);
        messageText += `📮 Адрес: <a href="https://yandex.ru/maps/?text=${encodedAddress}">${point.Address}</a>\n`;
        messageText += `🧭 <a href="yandexnavi://map_search?text=${encodedAddress}">Открыть в навигаторе</a>\n`;

        if (point.Description) {
          messageText += `👤 Получатель: ${point.Description}\n`;
        }

        if (point.Orders && point.Orders.length > 0) {
          const orderDetails = orders.find((o) => o.Id === point.Orders[0].Id);

          if (point.Weight) {
            messageText += `⚖️ Вес: ${point.Weight} ${routeDetails.WeightUnit}\n`;
          }

          if (orderDetails) {
            if (orderDetails.CustomState) {
              messageText += `📊 Статус: ${getOrderStatusName(
                orderDetails.CustomState,
              )}\n`;
            }

            if (orderDetails.InvoiceTotal) {
              messageText += `💰 Стоимость: ${orderDetails.InvoiceTotal} руб.\n`;
            }

            if (orderDetails.Comment) {
              messageText += `📝 Комментарий: ${orderDetails.Comment}\n`;
            }

            if (orderDetails.To?.ContactPhone) {
              messageText += `📱 Телефон: ${orderDetails.To.ContactPhone}\n`;
            }

            if (orderDetails.To?.StartTime && orderDetails.To?.EndTime) {
              const startTime = new Date(
                orderDetails.To.StartTime,
              ).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              });
              const endTime = new Date(
                orderDetails.To.EndTime,
              ).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              });
              messageText += `⏰ Временное окно: ${startTime} - ${endTime}\n`;
            }
          }
        }
        messageText += `\n`;
      }

      // Отправляем сообщение с учетом ограничения длины
      if (messageText.length > config.MAX_MESSAGE_LENGTH) {
        // Модифицированный алгоритм разбиения сообщения, чтобы не разрывать HTML-теги
        let position = 0;
        while (position < messageText.length) {
          let endPosition = position + config.MAX_MESSAGE_LENGTH;

          // Если мы не в конце сообщения, найдем безопасную точку для разрыва
          if (endPosition < messageText.length) {
            // Ищем последний перевод строки перед лимитом
            const lastNewLine = messageText.lastIndexOf("\n", endPosition);
            if (lastNewLine > position) {
              endPosition = lastNewLine + 1; // +1 чтобы включить символ переноса строки
            } else {
              // Если нет переноса строки, убедимся что не разрываем HTML-тег
              let openTagIndex = messageText.lastIndexOf(
                "<a href=",
                endPosition,
              );
              let closeTagIndex = messageText.lastIndexOf("</a>", endPosition);

              // Если открывающий тег находится перед закрывающим, значит тег не закрыт
              if (openTagIndex > closeTagIndex) {
                // Найдем предыдущий перенос строки перед открывающим тегом
                const safeBreak = messageText.lastIndexOf("\n", openTagIndex);
                if (safeBreak > position) {
                  endPosition = safeBreak + 1;
                }
              }
            }
          }

          await ctx.reply(messageText.slice(position, endPosition), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });

          position = endPosition;
        }
      } else {
        await ctx.reply(messageText, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
    }
  } catch (error) {
    console.error("Error showing routes:", error);

    if (error.isSessionExpired) {
      const session = await db.getSession(ctx.from.id);
      const credentials = {
        clientCode: session.client_code,
        login: session.login,
        password: session.password,
      };

      try {
        const authResponse = await api.refreshSession(credentials);
        session.session_id = authResponse;
        await db.saveSession(ctx.from.id, session);
        await showRoutes(ctx, date);
      } catch (refreshError) {
        console.error("Session refresh error:", refreshError);
        await ctx.reply(
          "Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start",
        );
      }
    } else if (error.message && error.message.includes('таймаут')) {
      await ctx.reply("⏱️ Превышено время ожидания ответа от сервера. Попробуйте позже.");
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      await ctx.reply("🔌 Проблемы с сетным соединением. Попробуйте позже.");
    } else {
      await ctx.reply("❌ Произошла ошибка при получении маршрутов. Попробуйте позже.");
    }
  }
}

async function showActiveRoutes(ctx, date) {
  try {
    const session = await db.getSession(ctx.from.id);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const credentials = {
      clientCode: session.client_code,
      login: session.login,
      password: session.password,
    };

    // Таймаут 60 секунд для получения активных маршрутов
    const result = await Promise.race([
      api.getRoutes(session.session_id, date, credentials),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Получение активных маршрутов заняло слишком много времени')), 60000)
      )
    ]);

    if (result.sessionUpdated) {
      session.session_id = result.newSessionId;
      await db.saveSession(ctx.from.id, session);
    }

    const response = result.data;

    if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) {
      return await ctx.reply(
        `📭 Активных маршрутов на ${date} не найдено`,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
      );
    }

    const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
    const totalOrders = routes.reduce((sum, route) => {
      if (route.Orders && Array.isArray(route.Orders)) {
        return sum + route.Orders.length;
      }
      return sum;
    }, 0);

    if (totalOrders === 0) {
      return await ctx.reply(
        `📭 На ${date} активных заказов нет`,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
      );
    }

    // Идентификаторы статусов "Выполнен"
    const completedStatuses = [
      "b107b2e5-fe96-46ec-9c1d-7248d77e8383", // Выполнен (сайт)
      "ceb8edd8-a0d9-4116-a8ee-a6c0be89103b", // Выполнен (нал)
      "d4535403-e4f6-4888-859e-098b7829b3a6", // Выполнен (безнал)
    ];

    let activeRoutesFound = false;

    for (const route of routes) {
      const detailsResult = await Promise.race([
        api.getRouteDetails(session.session_id, [route.Id], credentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Получение деталей маршрута заняло слишком много времени')), 30000)
        )
      ]);

      if (detailsResult.sessionUpdated) {
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(ctx.from.id, session);
      }

      const routeDetails =
        detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];
      const orderIds = routeDetails.Points.flatMap(
        (point) => point.Orders?.map((order) => order.Id) || [],
      ).filter((id) => id);

      const orderDetailsResult = await Promise.race([
        api.getOrderDetails(session.session_id, orderIds, credentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Получение деталей заказов заняло слишком много времени')), 30000)
        )
      ]);
      if (detailsResult.sessionUpdated) {
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(ctx.from.id, session);
      }

      const orders = orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;

      // Проверяем, есть ли в маршруте активные заказы
      const activeOrders = orders.filter(
        (order) => !completedStatuses.includes(order.CustomState),
      );

      if (activeOrders.length === 0) {
        continue; // Пропускаем маршрут, если нет активных заказов
      }

      activeRoutesFound = true;
      let messageText = `🚚 Активный маршрут ${routes.indexOf(route) + 1}\n`;
      messageText += `📝 Номер: ${routeDetails.Number}\n`;
      messageText += `📦 Всего активных точек: ${activeOrders.length}\n\n`;

      for (let i = 1; i < routeDetails.Points.length; i++) {
        const point = routeDetails.Points[i];
        if (!point.Orders || point.Orders.length === 0) continue;

        const orderDetails = orders.find((o) => o.Id === point.Orders[0].Id);

        // Пропускаем точки с выполненными заказами
        if (
          orderDetails &&
          completedStatuses.includes(orderDetails.CustomState)
        ) {
          continue;
        }

        messageText += `📍 Точка ${point.Label}:\n`;

        if (
          point.Orders &&
          point.Orders.length > 0 &&
          point.Orders[0].ExternalId
        ) {
          messageText += `🔹 Заказ: ${point.Orders[0].ExternalId}\n`;
        }

        // Создаем кликабельную ссылку на карту с адресом
        const encodedAddress = encodeURIComponent(point.Address);
        messageText += `📮 Адрес: <a href="https://yandex.ru/maps/?text=${encodedAddress}">${point.Address}</a>\n`;
        messageText += `🧭 <a href="yandexnavi://map_search?text=${encodedAddress}">Открыть в навигаторе</a>\n`;

        if (point.Description) {
          messageText += `👤 Получатель: ${point.Description}\n`;
        }

        if (point.Orders && point.Orders.length > 0) {
          if (point.Weight) {
            messageText += `⚖️ Вес: ${point.Weight} ${routeDetails.WeightUnit}\n`;
          }

          if (orderDetails) {
            if (orderDetails.CustomState) {
              messageText += `📊 Статус: ${getOrderStatusName(
                orderDetails.CustomState,
              )}\n`;
            }

            if (orderDetails.InvoiceTotal) {
              messageText += `💰 Стоимость: ${orderDetails.InvoiceTotal} руб.\n`;
            }

            if (orderDetails.Comment) {
              messageText += `📝 Комментарий: ${orderDetails.Comment}\n`;
            }

            if (orderDetails.To?.ContactPhone) {
              messageText += `📱 Телефон: ${orderDetails.To.ContactPhone}\n`;
            }

            if (orderDetails.To?.StartTime && orderDetails.To?.EndTime) {
              const startTime = new Date(
                orderDetails.To.StartTime,
              ).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              });
              const endTime = new Date(
                orderDetails.To.EndTime,
              ).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              });
              messageText += `⏰ Временное окно: ${startTime} - ${endTime}\n`;
            }
          }
        }
        messageText += `\n`;
      }

      // Отправляем сообщение с учетом ограничения длины
      if (messageText.length > config.MAX_MESSAGE_LENGTH) {
        // Модифицированный алгоритм разбиения сообщения, чтобы не разрывать HTML-теги
        let position = 0;
        while (position < messageText.length) {
          let endPosition = position + config.MAX_MESSAGE_LENGTH;

          // Если мы не в конце сообщения, найдем безопасную точку для разрыва
          if (endPosition < messageText.length) {
            // Ищем последний перевод строки перед лимитом
            const lastNewLine = messageText.lastIndexOf("\n", endPosition);
            if (lastNewLine > position) {
              endPosition = lastNewLine + 1; // +1 чтобы включить символ переноса строки
            } else {
              // Если нет переноса строки, убедимся что не разрываем HTML-тег
              let openTagIndex = messageText.lastIndexOf(
                "<a href=",
                endPosition,
              );
              let closeTagIndex = messageText.lastIndexOf("</a>", endPosition);

              // Если открывающий тег находится перед закрывающим, значит тег не закрыт
              if (openTagIndex > closeTagIndex) {
                // Найдем предыдущий перенос строки перед открывающим тегом
                const safeBreak = messageText.lastIndexOf("\n", openTagIndex);
                if (safeBreak > position) {
                  endPosition = safeBreak + 1;
                }
              }
            }
          }

          await ctx.reply(messageText.slice(position, endPosition), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });

          position = endPosition;
        }
      } else {
        await ctx.reply(messageText, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
    }

    if (!activeRoutesFound) {
      await ctx.reply(
        `📭 На ${date} нет активных заказов`,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
      );
    }
  } catch (error) {
    console.error("Error showing active routes:", error);

    if (error.isSessionExpired) {
      const session = await db.getSession(ctx.from.id);
      const credentials = {
        clientCode: session.client_code,
        login: session.login,
        password: session.password,
      };

      try {
        const authResponse = await api.refreshSession(credentials);
        session.session_id = authResponse;
        await db.saveSession(ctx.from.id, session);
        await showActiveRoutes(ctx, date);
      } catch (refreshError) {
        console.error("Session refresh error:", refreshError);
        await ctx.reply(
          "Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start",
        );
      }
    } else if (error.message && error.message.includes('таймаут')) {
      await ctx.reply("⏱️ Превышено время ожидания ответа от сервера. Попробуйте позже.");
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      await ctx.reply("🔌 Проблемы с сетным соединением. Попробуйте позже.");
    } else {
      await ctx.reply("❌ Произошла ошибка при получении активных маршрутов. Попробуйте позже.");
    }
  }
}

async function showStatistics(ctx, date) {
  try {
    const session = await db.getSession(ctx.from.id);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const credentials = {
      clientCode: session.client_code,
      login: session.login,
      password: session.password,
    };

    // Таймаут 60 секунд для получения статистики
    const result = await Promise.race([
      api.getRoutes(session.session_id, date, credentials),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Получение статистики заняло слишком много времени')), 60000)
      )
    ]);

    if (result.sessionUpdated) {
      session.session_id = result.newSessionId;
      await db.saveSession(ctx.from.id, session);
    }

    const response = result.data;

    if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) {
      return await ctx.reply(
        `📭 Маршруты на ${date} не найдены`,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
      );
    }

    const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
    let totalCashAmount = 0;
    let totalNonCashAmount = 0;
    let totalSiteAmount = 0;
    let totalOrders = routes.reduce(
      (sum, route) => sum + (route.Orders?.length || 0),
      0,
    );
    let completedOrders = 0;
    let canceledOrders = 0;

    let orderDetails = [];

    for (const route of routes) {
      const detailsResult = await Promise.race([
        api.getRouteDetails(session.session_id, [route.Id], credentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Получение деталей маршрута заняло слишком много времени')), 30000)
        )
      ]);

      if (detailsResult.sessionUpdated) {
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(ctx.from.id, session);
      }

      const routeDetails =
        detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];

      // Собираем только уникальные ID заказов
      const orderIds = Array.from(
        new Set(
          routeDetails.Points.flatMap(
            (point) => point.Orders?.map((order) => order.Id) || [],
          ).filter((id) => id),
        ),
      );

      const orderDetailsResult = await Promise.race([
        api.getOrderDetails(session.session_id, orderIds, credentials),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Получение деталей заказов заняло слишком много времени')), 30000)
        )
      ]);
      if (detailsResult.sessionUpdated) {
        session.session_id = detailsResult.newSessionId;
        await db.saveSession(ctx.from.id, session);
      }

      const orders = orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;
      orders.forEach((order) => {
        if (order.InvoiceTotal) {
          const amount = parseFloat(order.InvoiceTotal) || 0;
          let paymentType = "";

          switch (order.CustomState) {
            case "ceb8edd8-a0d9-4116-a8ee-a6c0be89103b": // Выполнен (нал)
              totalCashAmount += amount;
              completedOrders++;
              paymentType = "наличные";
              break;
            case "d4535403-e4f6-4888-859e-098b7829b3a6": // Выполнен (безнал)
              totalNonCashAmount += amount;
              completedOrders++;
              paymentType = "терминал";
              break;
            case "b107b2e5-fe96-46ec-9c1d-7248d77e8383": // Выполнен (сайт)
              totalSiteAmount += amount;
              completedOrders++;
              paymentType = "сайт";
              break;
            case "51e45c11-d5c7-4383-8fc4-a2e2e1781230": // Отменён
              canceledOrders++;
              paymentType = "отменён";
              break;
          }

          // Сохраняем детали заказа только для выполненных заказов
          if (paymentType && paymentType !== "отменён") {
            const pointInfo = routeDetails.Points.find((point) =>
              point.Orders?.some((o) => o.Id === order.Id),
            );
            const orderInPoint = pointInfo?.Orders?.find(
              (o) => o.Id === order.Id,
            );
            const externalId = orderInPoint?.ExternalId;

            if (externalId) {
              orderDetails.push({
                externalId,
                amount,
                paymentType,
              });
            }
          }
        }
      });
    }
    const totalAmount = totalCashAmount + totalNonCashAmount + totalSiteAmount;

    // Отправляем основную статистику (без блока расстояния и заработка)
    const statsMessage =
      `📊 Общая статистика на ${date}:\n\n` +
      `💰 Финансы (от клиентов):\n` +
      `├ 💵 Наличные: ${totalCashAmount.toFixed(2)} руб.\n` +
      `├ 💳 Терминал: ${totalNonCashAmount.toFixed(2)} руб.\n` +
      `├ 🌐 Сайт: ${totalSiteAmount.toFixed(2)} руб.\n` +
      `└ 📈 Всего: ${totalAmount.toFixed(2)} руб.\n\n` +
      `📦 Информация о заказах:\n` +
      `├ 🚚 Всего маршрутов: ${routes.length}\n` +
      `├ 📋 Всего заказов: ${totalOrders}\n` +
      `├ ✅ Выполнено: ${completedOrders}\n` +
      `└ ❌ Отменено: ${canceledOrders}\n`;

    await ctx.reply(
      statsMessage,
      keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
    );

    // Отправляем детальную информацию по заказам
    if (orderDetails.length > 0) {
      let detailedMessage = "";
      orderDetails.forEach((order) => {
        detailedMessage += `${order.externalId} ${order.paymentType}\n`;
      });

      // Разбиваем на части, если сообщение слишком длинное
      if (detailedMessage.length > config.MAX_MESSAGE_LENGTH) {
        // Модифицированный алгоритм разбиения сообщения, чтобы не разрывать HTML-теги
        let position = 0;
        while (position < detailedMessage.length) {
          let endPosition = position + config.MAX_MESSAGE_LENGTH;

          // Если мы не в конце сообщения, найдем безопасную точку для разрыва
          if (endPosition < detailedMessage.length) {
            // Ищем последний перевод строки перед лимитом
            const lastNewLine = detailedMessage.lastIndexOf("\n", endPosition);
            if (lastNewLine > position) {
              endPosition = lastNewLine + 1; // +1 чтобы включить символ переноса строки
            } else {
              // Если нет переноса строки, убедимся что не разрываем HTML-тег
              let openTagIndex = detailedMessage.lastIndexOf(
                "<a href=",
                endPosition,
              );
              let closeTagIndex = detailedMessage.lastIndexOf(
                "</a>",
                endPosition,
              );

              // Если открывающий тег находится перед закрывающим, значит тег не закрыт
              if (openTagIndex > closeTagIndex) {
                // Найдем предыдущий перенос строки перед открывающим тегом
                const safeBreak = detailedMessage.lastIndexOf(
                  "\n",
                  openTagIndex,
                );
                if (safeBreak > position) {
                  endPosition = safeBreak + 1;
                }
              }
            }
          }

          await ctx.reply(detailedMessage.slice(position, endPosition));

          position = endPosition;
        }
      } else {
        await ctx.reply(detailedMessage);
      }
    }
  } catch (error) {
    console.error("Error showing statistics:", error);

    if (error.isSessionExpired) {
      const session = await db.getSession(ctx.from.id);
      const credentials = {
        clientCode: session.client_code,
        login: session.login,
        password: session.password,
      };

      try {
        const authResponse = await api.refreshSession(credentials);
        session.session_id = authResponse;
        await db.saveSession(ctx.from.id, session);
        await showStatistics(ctx, date);
      } catch (refreshError) {
        console.error("Session refresh error:", refreshError);
        await ctx.reply(
          "Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start",
        );
      }
    } else if (error.message && error.message.includes('таймаут')) {
      await ctx.reply("⏱️ Превышено время ожидания ответа от сервера. Попробуйте позже.");
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      await ctx.reply("🔌 Проблемы с сетным соединением. Попробуйте позже.");
    } else {
      await ctx.reply("❌ Произошла ошибка при получении статистики. Попробуйте позже.");
    }
  }
}

function calculateWorkHours(timeRange) {
  const [start, end] = timeRange.split("-");
  const [startHours, startMinutes] = start.split(".").map(Number);
  const [endHours, endMinutes] = end.split(".").map(Number);

  let hours = endHours - startHours;
  let minutes = endMinutes - startMinutes;

  if (minutes < 0) {
    hours--;
    minutes += 60;
  }

  return hours + minutes / 60;
}

function getDriverSurname(driverName) {
  return driverName.split(" ")[0];
}

// Команды бота
bot.command("start", async (ctx) => {
  const session = await db.getSession(ctx.from.id);
  const isMonitoringActive = monitoring.isMonitoringActive(ctx.from.id);

  if (session?.session_id) {
    await ctx.reply(
      "Выберите действие:",
      keyboards.getMainKeyboard(isMonitoringActive),
    );
  } else {
    await ctx.reply(
      'Добро пожаловать! Нажмите кнопку "Войти" для начала работы:',
      keyboards.getLoginKeyboard,
    );
  }
});

bot.command("login", async (ctx) => {
  await ctx.reply("Введите ClientCode:");
  await db.saveSession(ctx.from.id, {
    user_id: ctx.from.id,
    client_code: null,
    login: null,
    password: null,
    session_id: null,
    driver_name: null,
    step: config.STEPS.CLIENT_CODE,
  });
});

bot.command("status", async (ctx) => {
  const session = await db.getSession(ctx.from.id);
  const isMonitoringActive = monitoring.isMonitoringActive(ctx.from.id);

  if (!session?.session_id) {
    return await ctx.reply("Вы не авторизованы");
  }

  const statusMessage =
    `Статус: авторизован\n` +
    `Клиент: ${session.client_code}\n` +
    `Логин: ${session.login}\n` +
    `Водитель: ${session.driver_name || "Не указан"}\n` +
    `Мониторинг: ${isMonitoringActive ? "✅ Активен" : "❌ Не активен"}`;

  await ctx.reply(statusMessage, keyboards.getMainKeyboard(isMonitoringActive));
});

bot.command(["broadcast", "br"], async (ctx) => {
  const userId = ctx.from.id;

  if (adminUserIds.size === 0) {
    return await ctx.reply(
      "Администратор не настроен. Укажите ADMIN_USER_IDS в окружении.",
    );
  }

  if (!isAdminUser(userId)) {
    return await ctx.reply("❌ Недостаточно прав для рассылки");
  }

  const rawText = ctx.message?.text || "";
  const messageText = parseBroadcastText(rawText);

  if (!messageText) {
    return await ctx.reply("Использование: /broadcast <текст>");
  }

  if (messageText.length > config.MAX_MESSAGE_LENGTH) {
    return await ctx.reply(
      `Сообщение слишком длинное. Лимит: ${config.MAX_MESSAGE_LENGTH} символов.`,
    );
  }

  await ctx.reply("📣 Рассылка запущена. Отчет пришлю по завершению.");

  setImmediate(async () => {
    try {
      await broadcastMessage(userId, messageText);
    } catch (error) {
      console.error("Broadcast error:", error);
      try {
        await sendTelegramMessage(userId, "❌ Ошибка при рассылке.");
      } catch (sendError) {
        console.error("Error sending broadcast failure:", sendError);
      }
    }
  });
});

bot.command("logout", async (ctx) => {
  const userId = ctx.from.id;
  const session = await db.getSession(userId);

  if (session) {
    monitoring.stopMonitoring(userId);
    await db.deleteSession(userId);
    await ctx.reply(
      "✅ Вы успешно вышли из системы",
      keyboards.getLoginKeyboard,
    );
  } else {
    await ctx.reply("⚠️ Вы не были авторизованы", keyboards.getLoginKeyboard);
  }
});

// Обработка действий с кнопками
bot.action("routes_today", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const currentDate = new Date().toLocaleDateString("ru-RU");
    await showRoutes(ctx, currentDate);
  });
});

bot.action("routes_tomorrow", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = tomorrow.toLocaleDateString("ru-RU");
    await showRoutes(ctx, tomorrowDate);
  });
});

bot.action("routes_active", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const currentDate = new Date().toLocaleDateString("ru-RU");
    await showActiveRoutes(ctx, currentDate);
  });
});

bot.action("routes_select_date", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const session = await db.getSession(ctx.from.id);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    await ctx.reply(
      "Введите дату в формате ДД.ММ.ГГГГ (например, 09.02.2024):",
      keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
    );

    await db.saveSession(ctx.from.id, {
      ...session,
      step: config.STEPS.AWAITING_DATE,
    });
  });
});

bot.action("stats_today", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const currentDate = new Date().toLocaleDateString("ru-RU");
    await showStatistics(ctx, currentDate);
  });
});

bot.action("stats_select_date", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const session = await db.getSession(ctx.from.id);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    await ctx.reply(
      "Введите дату в формате ДД.ММ.ГГГГ (например, 09.02.2024):",
      keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
    );

    await db.saveSession(ctx.from.id, {
      ...session,
      step: config.STEPS.AWAITING_DATE,
    });
  });
});

bot.action("routes_tomorrow", async (ctx) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toLocaleDateString("ru-RU");
  await showRoutes(ctx, tomorrowDate);
});

bot.action("routes_active", async (ctx) => {
  const currentDate = new Date().toLocaleDateString("ru-RU");
  await showActiveRoutes(ctx, currentDate);
});

bot.action("routes_select_date", async (ctx) => {
  const session = await db.getSession(ctx.from.id);
  if (!session?.session_id) {
    return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
  }

  await ctx.reply(
    "Введите дату в формате ДД.ММ.ГГГГ (например, 09.02.2024):",
    keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
  );

  await db.saveSession(ctx.from.id, {
    ...session,
    step: config.STEPS.AWAITING_DATE,
  });
});

bot.action("stats_today", async (ctx) => {
  const currentDate = new Date().toLocaleDateString("ru-RU");
  await showStatistics(ctx, currentDate);
});

bot.action("stats_select_date", async (ctx) => {
  const session = await db.getSession(ctx.from.id);
  if (!session?.session_id) {
    return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
  }

  await ctx.reply(
    "Введите дату в формате ДД.ММ.ГГГГ (например, 09.02.2024):",
    keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)),
  );

  await db.saveSession(ctx.from.id, {
    ...session,
    step: "awaiting_stats_date",
  });
});

// Обработка текстовых сообщений
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const session = await db.getSession(userId);
  const isMonitoringActive = monitoring.isMonitoringActive(userId);

  // Обработка кнопок меню
  switch (text) {
    case "🔑 Войти":
      await ctx.reply("Введите ClientCode:");
      await db.saveSession(userId, {
        user_id: userId,
        client_code: null,
        login: null,
        password: null,
        session_id: null,
        driver_name: null,
        step: config.STEPS.CLIENT_CODE,
      });
      return;

    case "📊 Маршруты":
      if (!session?.session_id) {
        return await ctx.reply(
          "Вы не авторизованы",
          keyboards.getLoginKeyboard,
        );
      }
      await ctx.reply(
        "Выберите дату для просмотра маршрутов:",
        keyboards.getRoutesKeyboard,
      );
      return;

    case "📈 Общая статистика":
      if (!session?.session_id) {
        return await ctx.reply(
          "Вы не авторизованы",
          keyboards.getLoginKeyboard,
        );
      }
      await ctx.reply(
        "Выберите дату для просмотра статистики:",
        keyboards.getStatisticsKeyboard,
      );
      return;

    case "👤 Профиль":
      const statusSession = await db.getSession(ctx.from.id);
      const statusMonitoringActive = monitoring.isMonitoringActive(ctx.from.id);

      if (!statusSession?.session_id) {
        return await ctx.reply("Вы не авторизованы");
      }

      const statusMessage =
        `Статус: авторизован\n` +
        `Клиент: ${statusSession.client_code}\n` +
        `Логин: ${statusSession.login}\n` +
        `Водитель: ${statusSession.driver_name || "Не указан"}\n` +
        `Мониторинг: ${statusMonitoringActive ? "✅ Активен" : "❌ Не активен"}`;

      await ctx.reply(
        statusMessage,
        keyboards.getMainKeyboard(statusMonitoringActive),
      );
      return;

    case "🟢 Включить уведомления":
      if (!session?.session_id) {
        return await ctx.reply(
          "Вы не авторизованы",
          keyboards.getLoginKeyboard,
        );
      }
      if (isMonitoringActive) {
        return await ctx.reply(
          "⚠️ Мониторинг уже активен!",
          keyboards.getMainKeyboard(true),
        );
      }
      const started = monitoring.startMonitoring(
        userId,
        session.session_id,
        checkNewOrders,
        config.INTERVAL_UPDATES,
      );
      if (started) {
        await ctx.reply(
          "✅ Мониторинг новых заказов включен",
          keyboards.getMainKeyboard(true),
        );
        void checkNewOrders(userId, session.session_id);
      }
      return;

    case "🔴 Выключить уведомления":
      if (monitoring.stopMonitoring(userId)) {
        await ctx.reply(
          "✅ Мониторинг отключен",
          keyboards.getMainKeyboard(false),
        );
      } else {
        await ctx.reply(
          "⚠️ Мониторинг не был активен",
          keyboards.getMainKeyboard(false),
        );
      }
      return;

    case "📝 Создать отчет":
      if (!session?.session_id) {
        return await ctx.reply(
          "Вы не авторизованы",
          keyboards.getLoginKeyboard,
        );
      }
      await ctx.reply(
        'Выберите время работы или введите вручную в формате "9.30-21.00":',
        keyboards.getReportKeyboard,
      );
      await db.saveSession(userId, {
        ...session,
        step: config.STEPS.AWAITING_WORK_TIME,
      });
      return;

    case "📅 Статистика за месяц":
      if (!session?.session_id) {
        return await ctx.reply(
          "Вы не авторизованы",
          keyboards.getLoginKeyboard,
        );
      }
      await ctx.reply(
        "Выберите период для просмотра статистики:",
        keyboards.getMonthlyStatsKeyboard,
      );
      return;

    case "🚪 Выйти":
      const logoutUserId = ctx.from.id;
      const logoutSession = await db.getSession(logoutUserId);

      if (logoutSession) {
        monitoring.stopMonitoring(logoutUserId);
        await db.deleteSession(logoutUserId);
        await ctx.reply(
          "✅ Вы успешно вышли из системы",
          keyboards.getLoginKeyboard,
        );
      } else {
        await ctx.reply(
          "⚠️ Вы не были авторизованы",
          keyboards.getLoginKeyboard,
        );
      }
      return;
  }

  // Обработка ввода даты
  if (session?.step === config.STEPS.AWAITING_DATE) {
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
      await showRoutes(ctx, text);
      await db.saveSession(ctx.from.id, {
        ...session,
        step: session.session_id
          ? config.STEPS.AUTHENTICATED
          : config.STEPS.CLIENT_CODE,
      });
    } else {
      await ctx.reply(
        "❌ Неверный формат даты. Используйте формат ДД.ММ.ГГГГ",
        keyboards.getMainKeyboard(isMonitoringActive),
      );
    }
    return;
  }

  if (session?.step === "awaiting_stats_date") {
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
      await showStatistics(ctx, text);
      await db.saveSession(ctx.from.id, {
        ...session,
        step: session.session_id
          ? config.STEPS.AUTHENTICATED
          : config.STEPS.CLIENT_CODE,
      });
    } else {
      await ctx.reply(
        "❌ Неверный формат даты. Используйте формат ДД.ММ.ГГГГ",
        keyboards.getMainKeyboard(isMonitoringActive),
      );
    }
    return;
  }

  // Обработка ввода времени для отчета
  if (session?.step === config.STEPS.AWAITING_WORK_TIME) {
    const timeRegex = /^\d{1,2}\.\d{2}-\d{1,2}\.\d{2}$/;
    if (!timeRegex.test(text)) {
      return await ctx.reply(
        '❌ Неверный формат времени. Используйте формат "9.30-21.00"',
      );
    }

    try {
      const currentDate = new Date().toLocaleDateString("ru-RU");
      const workHours = calculateWorkHours(text);
      const driverSurname = getDriverSurname(session.driver_name);

      const reportMessage =
        `📋 ${currentDate}\n` +
        `👤 ${driverSurname}\n` +
        `🕒 ${text} (${workHours.toFixed(1)} ч.)`;

      await ctx.reply(
        reportMessage,
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
      );

      await db.saveSession(userId, {
        ...session,
        step: config.STEPS.AUTHENTICATED,
      });
    } catch (error) {
      console.error("Error creating report:", error);
      await ctx.reply("❌ Произошла ошибка при создании отчета");
    }
    return;
  }

  // Обработка процесса авторизации
  if (session?.step) {
    switch (session.step) {
      case config.STEPS.CLIENT_CODE:
        await db.saveSession(userId, {
          ...session,
          client_code: text,
          step: config.STEPS.LOGIN,
        });
        await ctx.reply("Введите Login:");
        break;

      case config.STEPS.LOGIN:
        await db.saveSession(userId, {
          ...session,
          login: text,
          step: config.STEPS.PASSWORD,
        });
        await ctx.reply("Введите Password:");
        break;

      case config.STEPS.PASSWORD:
        try {
          const response = await api.authenticate(
            session.client_code,
            session.login,
            text,
          );

          if (response.TL_Mobile_LoginResponse.ErrorDescription) {
            await ctx.reply(
              `❌ Ошибка: ${response.TL_Mobile_LoginResponse.ErrorDescription}`,
              keyboards.getLoginKeyboard,
            );
            await db.deleteSession(userId);
          } else {
            await db.saveSession(userId, {
              ...session,
              password: text,
              session_id: response.TL_Mobile_LoginResponse.SessionId,
              driver_name: response.TL_Mobile_LoginResponse.DriverName,
              step: config.STEPS.AUTHENTICATED,
            });
            await ctx.reply(
              "✅ Авторизация успешна!",
              keyboards.getMainKeyboard(false),
            );
          }
        } catch (error) {
          console.error("Authentication error:", error);
          await ctx.reply("❌ Ошибка авторизации", keyboards.getLoginKeyboard);
          await db.deleteSession(userId);
        }
        break;
    }
  } else {
    await ctx.reply(
      "Для начала работы необходимо войти в систему",
      keyboards.getLoginKeyboard,
    );
  }
});

// Обработчики инлайн кнопок для отчетов
bot.action("report_time_8_30_21", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const userId = ctx.from.id;
    const session = await db.getSession(userId);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const timeText = "8.30-21.00";
    const currentDate = new Date().toLocaleDateString("ru-RU");
    const workHours = calculateWorkHours(timeText);
    const driverSurname = getDriverSurname(session.driver_name);

    const reportMessage =
      `📋 ${currentDate}\n` +
      `👤 ${driverSurname}\n` +
      `🕒 ${timeText} (${workHours.toFixed(1)} ч.)`;

    await ctx.reply(
      reportMessage,
      keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
    );

    await db.saveSession(userId, {
      ...session,
      step: config.STEPS.AUTHENTICATED,
    });
  });
});

bot.action("report_time_9_21", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const userId = ctx.from.id;
    const session = await db.getSession(userId);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const timeText = "9.00-21.00";
    const currentDate = new Date().toLocaleDateString("ru-RU");
    const workHours = calculateWorkHours(timeText);
    const driverSurname = getDriverSurname(session.driver_name);

    const reportMessage =
      `📋 ${currentDate}\n` +
      `👤 ${driverSurname}\n` +
      `🕒 ${timeText} (${workHours.toFixed(1)} ч.)`;

    await ctx.reply(
      reportMessage,
      keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
    );

    await db.saveSession(userId, {
      ...session,
      step: config.STEPS.AUTHENTICATED,
    });
  });
});

bot.action("report_custom_time", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    const userId = ctx.from.id;
    const session = await db.getSession(userId);
    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    await ctx.reply('Введите время работы в формате "9.30-21.00":');
    // Session step already set to AWAITING_WORK_TIME in the main handler
  });
});

// Обработчики месячной статистики
bot.action("monthly_stats_current", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const session = await db.getSession(userId);

    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Отправляем начальное сообщение и запускаем сбор статистики в фоне
    await ctx.reply(
      "⏳ Собираю статистику за текущий месяц...\nЭто может занять несколько минут.\n\n" +
        "Вы можете продолжить работу с ботом, результат будет отправлен автоматически.",
    );

    // Запускаем асинхронную обработку без блокировки callback
    setImmediate(async () => {
      let progressMessage;
      try {
        const stats = await monthlyStats.collectMonthlyStatistics(
          userId,
          month,
          year,
          async (processed, total) => {
            if (processed % 5 === 0 || processed === total) {
              const progressText = `📊 Обработано дней: ${processed}/${total}`;
              if (progressMessage) {
                try {
                  await bot.telegram.editMessageText(
                    chatId,
                    progressMessage.message_id,
                    null,
                    progressText,
                  );
                } catch (error) {
                  // Игнорируем ошибки редактирования
                }
              } else {
                try {
                  progressMessage = await sendTelegramMessage(
                    chatId,
                    progressText,
                  );
                } catch (sendError) {
                  console.error(
                    "Error sending monthly stats progress message:",
                    sendError,
                  );
                }
              }
            }
          },
        );

        const message = monthlyStats.formatMonthlyStats(stats, month, year);
        await sendTelegramMessage(
          chatId,
          message,
          keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
        );
      } catch (error) {
        console.error("Error getting monthly statistics:", error);
        try {
          await sendTelegramMessage(
            chatId,
            "❌ Ошибка при сборе статистики",
            keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
          );
        } catch (sendError) {
          console.error(
            "Error sending monthly stats error message:",
            sendError,
          );
        }
      }
    });
  });
});

bot.action("monthly_stats_previous", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const session = await db.getSession(userId);

    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    const now = new Date();
    now.setMonth(now.getMonth() - 1);
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Отправляем начальное сообщение и запускаем сбор статистики в фоне
    await ctx.reply(
      "⏳ Собираю статистику за прошлый месяц...\nЭто может занять несколько минут.\n\n" +
        "Вы можете продолжить работу с ботом, результат будет отправлен автоматически.",
    );

    // Запускаем асинхронную обработку без блокировки callback
    setImmediate(async () => {
      let progressMessage;
      try {
        const stats = await monthlyStats.collectMonthlyStatistics(
          userId,
          month,
          year,
          async (processed, total) => {
            if (processed % 5 === 0 || processed === total) {
              const progressText = `📊 Обработано дней: ${processed}/${total}`;
              if (progressMessage) {
                try {
                  await bot.telegram.editMessageText(
                    chatId,
                    progressMessage.message_id,
                    null,
                    progressText,
                  );
                } catch (error) {
                  // Игнорируем ошибки редактирования
                }
              } else {
                try {
                  progressMessage = await sendTelegramMessage(
                    chatId,
                    progressText,
                  );
                } catch (sendError) {
                  console.error(
                    "Error sending monthly stats progress message:",
                    sendError,
                  );
                }
              }
            }
          },
        );

        const message = monthlyStats.formatMonthlyStats(stats, month, year);
        await sendTelegramMessage(
          chatId,
          message,
          keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
        );
      } catch (error) {
        console.error("Error getting monthly statistics:", error);
        try {
          await sendTelegramMessage(
            chatId,
            "❌ Ошибка при сборе статистики",
            keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
          );
        } catch (sendError) {
          console.error(
            "Error sending monthly stats error message:",
            sendError,
          );
        }
      }
    });
  });
});

bot.action("monthly_stats_select", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    await ctx.answerCbQuery();
    const session = await db.getSession(ctx.from.id);

    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

    await ctx.editMessageText(
      "Выберите год:",
      keyboards.getYearSelectionKeyboard(),
    );
  });
});

bot.action(/^year_select_(\d+)$/, async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    await ctx.answerCbQuery();
    const year = parseInt(ctx.match[1]);

    await ctx.editMessageText(
      `Выберите месяц (${year}):`,
      keyboards.getMonthSelectionKeyboard(year),
    );
  });
});

bot.action(/^month_select_(\d+)_(\d+)$/, async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    await ctx.answerCbQuery();
    const month = parseInt(ctx.match[1]);
    const year = parseInt(ctx.match[2]);
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const session = await db.getSession(userId);

    if (!session?.session_id) {
      return await ctx.reply("Вы не авторизованы", keyboards.getLoginKeyboard);
    }

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

    // Отправляем начальное сообщение и запускаем сбор статистики в фоне
    await ctx.reply(
      `⏳ Собираю статистику за ${monthNames[month - 1]} ${year}...\nЭто может занять несколько минут.\n\n` +
        "Вы можете продолжить работу с ботом, результат будет отправлен автоматически.",
    );

    // Запускаем асинхронную обработку без блокировки callback
    setImmediate(async () => {
      let progressMessage;
      try {
        const stats = await monthlyStats.collectMonthlyStatistics(
          userId,
          month,
          year,
          async (processed, total) => {
            if (processed % 5 === 0 || processed === total) {
              const progressText = `📊 Обработано дней: ${processed}/${total}`;
              if (progressMessage) {
                try {
                  await bot.telegram.editMessageText(
                    chatId,
                    progressMessage.message_id,
                    null,
                    progressText,
                  );
                } catch (error) {
                  // Игнорируем ошибки редактирования
                }
              } else {
                try {
                  progressMessage = await sendTelegramMessage(
                    chatId,
                    progressText,
                  );
                } catch (sendError) {
                  console.error(
                    "Error sending monthly stats progress message:",
                    sendError,
                  );
                }
              }
            }
          },
        );

        const message = monthlyStats.formatMonthlyStats(stats, month, year);
        await sendTelegramMessage(
          chatId,
          message,
          keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
        );
      } catch (error) {
        console.error("Error getting monthly statistics:", error);
        try {
          await sendTelegramMessage(
            chatId,
            "❌ Ошибка при сборе статистики",
            keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)),
          );
        } catch (sendError) {
          console.error(
            "Error sending monthly stats error message:",
            sendError,
          );
        }
      }
    });
  });
});

bot.action("monthly_stats_back", async (ctx) => {
  await safeCallback(ctx, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "Выберите период для статистики:",
      keyboards.getMonthlyStatsKeyboard,
    );
  });
});

// Обертка для запуска бота с обработкой ошибок
async function startBot() {
  try {
    console.log("🚀 Запуск бота...");
    await bot.launch();
    console.log("✅ Бот успешно запущен");
    
    // Автоматический перезапуск при ошибках соединения
    bot.catch(async (error) => {
      console.error("❌ Ошибка Telegraf:", error);
      
      // Пытаемся уведомить админов
      const adminUserIds = new Set(config.ADMIN_USER_IDS);
      if (adminUserIds.size > 0) {
        for (const adminId of adminUserIds) {
          try {
            await sendTelegramMessage(
              adminId,
              `⚠️ Бот столкнулся с ошибкой:\n${error.message}\n\nПопытка автоматического перезапуска...`
            );
          } catch (e) {
            console.error("Failed to notify admin:", e);
          }
        }
      }
      
      // Если ошибка критическая - перезапускаем через 30 секунд
      if (error.message?.includes('network') || error.message?.includes('timeout')) {
        console.log("🔄 Перезапуск бота через 30 секунд...");
        setTimeout(() => {
          console.log("🔄 Перезапускаем бота...");
          startBot().catch(console.error);
        }, 30000);
      }
    });
    
  } catch (error) {
    console.error("❌ Критическая ошибка при запуске бота:", error);
    
    // Пытаемся уведомить админов
    const adminUserIds = new Set(config.ADMIN_USER_IDS);
    if (adminUserIds.size > 0) {
      for (const adminId of adminUserIds) {
        try {
          await sendTelegramMessage(
            adminId,
            `🚨 КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА БОТА:\n${error.message}\n\nБот остановлен. Требуется ручное вмешательство.`
          );
        } catch (e) {
          console.error("Failed to notify admin:", e);
        }
      }
    }
    
    // Перезапуск через 60 секунд
    console.log("🔄 Перезапуск бота через 60 секунд...");
    setTimeout(() => {
      console.log("🔄 Попытка перезапуска...");
      startBot().catch(console.error);
    }, 60000);
  }
}

// Запускаем бота
startBot();

process.once("SIGINT", () => {
  console.log("🛑 Получен SIGINT, останавливаем бота...");
  bot.stop("SIGINT");
  db.close();
  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("🛑 Получен SIGTERM, останавливаем бота...");
  bot.stop("SIGTERM");
  db.close();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  console.error("Stack:", error.stack);
  
  // Пытаемся уведомить админов
  const adminUserIds = new Set(config.ADMIN_USER_IDS);
  if (adminUserIds.size > 0) {
    const adminId = Array.from(adminUserIds)[0];
    sendTelegramMessage(
      adminId,
      `🚨 Uncaught Exception:\n${error.message}\n\n${error.stack?.substring(0, 500)}`
    ).catch(() => {});
  }
  
  // Не выходим сразу, даем шанс на восстановление
  setTimeout(() => {
    console.log("🔄 Попытка восстановления после uncaught exception...");
    startBot().catch(console.error);
  }, 30000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("Reason:", reason);
  
  // Пытаемся уведомить админов
  const adminUserIds = new Set(config.ADMIN_USER_IDS);
  if (adminUserIds.size > 0) {
    const adminId = Array.from(adminUserIds)[0];
    const reasonStr = typeof reason === 'object' ? JSON.stringify(reason, Object.getOwnPropertyNames(reason)) : String(reason);
    sendTelegramMessage(
      adminId,
      `🚨 Unhandled Rejection:\n${reasonStr.substring(0, 500)}`
    ).catch(() => {});
  }
});

module.exports = { bot };
