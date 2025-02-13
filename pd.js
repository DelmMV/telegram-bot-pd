const { Telegraf } = require('telegraf');
const config = require('./config');
const db = require('./database');
const api = require('./api');
const keyboards = require('./keyboards');
const monitoring = require('./monitoring');

const bot = new Telegraf(config.TELEGRAM_TOKEN);

async function checkNewOrders(userId, sessionId) {
    try {
        const session = await db.getSession(userId);
        const credentials = {
            clientCode: session.client_code,
            login: session.login,
            password: session.password
        };

        const currentDate = new Date().toLocaleDateString('ru-RU');
        const result = await api.getRoutes(sessionId, currentDate, credentials);

        if (result.sessionUpdated) {
            session.session_id = result.newSessionId;
            await db.saveSession(userId, session);
            sessionId = result.newSessionId;
        }

        const response = result.data;
        
        if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) return;

        const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
        const currentOrders = new Set(
            routes.flatMap(route => route.Orders?.map(order => order.ExternalId) || [])
        );

        const previousOrders = monitoring.getLastKnownOrders(userId);
        const newOrders = [...currentOrders].filter(order => !previousOrders.has(order));

        if (newOrders.length) {
            for (const route of routes) {
                const routeOrders = route.Orders?.map(order => order.ExternalId) || [];
                const hasNewOrders = routeOrders.some(orderId => newOrders.includes(orderId));

                if (hasNewOrders) {
                    const detailsResult = await api.getRouteDetails(sessionId, [route.Id], credentials);
                    
                    if (detailsResult.sessionUpdated) {
                        session.session_id = detailsResult.newSessionId;
                        await db.saveSession(userId, session);
                        sessionId = detailsResult.newSessionId;
                    }

                    const routeDetails = detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];
                    let messageText = `🆕 Новые заказы в маршруте ${routeDetails.Number}:\n\n`;

                    for (let i = 1; i < routeDetails.Points.length; i++) {
                        const point = routeDetails.Points[i];
                        const pointOrder = point.Orders?.[0];

                        if (pointOrder && newOrders.includes(pointOrder.ExternalId)) {
                            messageText += `📦 Заказ: ${pointOrder.ExternalId}\n`;
                            messageText += `📍 Адрес: ${point.Address}\n`;
                            if (point.Description) {
                                messageText += `👤 Получатель: ${point.Description}\n`;
                            }
                            if (point.Weight) {
                                messageText += `⚖️ Вес: ${point.Weight} ${routeDetails.WeightUnit}\n`;
                            }
                            if (point.ArrivalTime) {
                                const arrivalTime = new Date(point.ArrivalTime).toLocaleTimeString('ru-RU', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                                messageText += `🕒 Ожидаемое время: ${arrivalTime}\n`;
                            }
                            messageText += `\n`;
                        }
                    }

                    await bot.telegram.sendMessage(userId, messageText);
                }
            }
        }

        monitoring.updateLastKnownOrders(userId, currentOrders);

    } catch (error) {
        console.error('Error checking orders:', error);
        
        if (error.isSessionExpired) {
            const session = await db.getSession(userId);
            const credentials = {
                clientCode: session.client_code,
                login: session.login,
                password: session.password
            };

            try {
                const authResponse = await api.refreshSession(credentials);
                session.session_id = authResponse;
                await db.saveSession(userId, session);
                await checkNewOrders(userId, authResponse);
            } catch (refreshError) {
                console.error('Session refresh error:', refreshError);
                await bot.telegram.sendMessage(userId, 'Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start');
                monitoring.stopMonitoring(userId);
            }
        }
    }
}

async function showRoutes(ctx, date) {
    try {
        const session = await db.getSession(ctx.from.id);
        if (!session?.session_id) {
            return await ctx.reply('Вы не авторизованы', keyboards.getLoginKeyboard);
        }

        const credentials = {
            clientCode: session.client_code,
            login: session.login,
            password: session.password
        };

        const result = await api.getRoutes(session.session_id, date, credentials);

        if (result.sessionUpdated) {
            session.session_id = result.newSessionId;
            await db.saveSession(ctx.from.id, session);
        }

        const response = result.data;

        if (!response?.TL_Mobile_EnumRoutesResponse?.Routes) {
            return await ctx.reply(`📭 Маршруты на ${date} не найдены`, 
                keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)));
        }

        const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
        const totalOrders = routes.reduce((sum, route) => sum + (route.Orders?.length || 0), 0);

        if (totalOrders === 0) {
            return await ctx.reply(`📭 На ${date} заказов нет`, 
                keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)));
        }

        for (const route of routes) {
            const detailsResult = await api.getRouteDetails(session.session_id, [route.Id], credentials);
            
            if (detailsResult.sessionUpdated) {
                session.session_id = detailsResult.newSessionId;
                await db.saveSession(ctx.from.id, session);
            }

            const routeDetails = detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];

            let messageText = `🚚 Маршрут ${routes.indexOf(route) + 1}\n`;
            messageText += `📝 Номер: ${routeDetails.Number}\n`;
            messageText += `📦 Всего заказов: ${routeDetails.Points.length - 1}\n\n`;

            for (let i = 1; i < routeDetails.Points.length; i++) {
                const point = routeDetails.Points[i];
                messageText += `📍 Точка ${point.Label}:\n`;
                messageText += `📦 Cтатус: ${point.Action}\n`;
                messageText += `📮 Адрес: ${point.Address}\n`;
                if (point.Description) {
                    messageText += `👤 Получатель: ${point.Description}\n`;
                }
                if (point.Orders && point.Orders.length > 0) {
                    messageText += `🔹 Заказ: ${point.Orders[0].ExternalId}\n`;
                    messageText += `⚖️ Вес: ${point.Weight} ${routeDetails.WeightUnit}\n`;
                }
                if (point.ArrivalTime) {
                    const arrivalTime = new Date(point.ArrivalTime).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    messageText += point.Action === 'drop' ? `🕒 Доставил: ${arrivalTime}\n` : `🕒 Ожидаемое время: ${arrivalTime}\n`;
                }
                messageText += `\n`;
            }

            if (messageText.length > config.MAX_MESSAGE_LENGTH) {
                for (let i = 0; i < messageText.length; i += config.MAX_MESSAGE_LENGTH) {
                    await ctx.reply(messageText.slice(i, i + config.MAX_MESSAGE_LENGTH));
                }
            } else {
                await ctx.reply(messageText);
            }
        }

        const statsMessage = `📊 Общая статистика:\nВсего маршрутов: ${routes.length}\nВсего заказов: ${totalOrders}`;

        await ctx.reply(statsMessage, 
            keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)));

    } catch (error) {
        console.error('Error showing routes:', error);
        
        if (error.isSessionExpired) {
            const session = await db.getSession(ctx.from.id);
            const credentials = {
                clientCode: session.client_code,
                login: session.login,
                password: session.password
            };

            try {
                const authResponse = await api.refreshSession(credentials);
                session.session_id = authResponse;
                await db.saveSession(ctx.from.id, session);
                await showRoutes(ctx, date);
            } catch (refreshError) {
                console.error('Session refresh error:', refreshError);
                await ctx.reply('Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start');
            }
        } else {
            await ctx.reply('❌ Произошла ошибка при получении маршрутов');
        }
    }
}

function calculateWorkHours(timeRange) {
    const [start, end] = timeRange.split('-');
    const [startHours, startMinutes] = start.split('.').map(Number);
    const [endHours, endMinutes] = end.split('.').map(Number);
    
    let hours = endHours - startHours;
    let minutes = endMinutes - startMinutes;
    
    if (minutes < 0) {
        hours--;
        minutes += 60;
    }
    
    return hours + (minutes / 60);
}

function getDriverSurname(driverName) {
    return driverName.split(' ')[0];
}

// Команды бота
bot.command('start', async (ctx) => {
    const session = await db.getSession(ctx.from.id);
    const isMonitoringActive = monitoring.isMonitoringActive(ctx.from.id);

    if (session?.session_id) {
        await ctx.reply('Выберите действие:', keyboards.getMainKeyboard(isMonitoringActive));
    } else {
        await ctx.reply('Добро пожаловать! Нажмите кнопку "Войти" для начала работы:', 
            keyboards.getLoginKeyboard);
    }
});

bot.command('login', async (ctx) => {
    await ctx.reply('Введите ClientCode:');
    await db.saveSession(ctx.from.id, {
        user_id: ctx.from.id,
        client_code: null,
        login: null,
        password: null,
        session_id: null,
        driver_name: null,
        step: config.STEPS.CLIENT_CODE
    });
});

bot.command('status', async (ctx) => {
    const session = await db.getSession(ctx.from.id);
    const isMonitoringActive = monitoring.isMonitoringActive(ctx.from.id);

    if (!session?.session_id) {
        return await ctx.reply('Вы не авторизованы');
    }

    const statusMessage = `Статус: авторизован\n` +
        `Клиент: ${session.client_code}\n` +
        `Логин: ${session.login}\n` +
        `Водитель: ${session.driver_name || 'Не указан'}\n` +
        `Мониторинг: ${isMonitoringActive ? '✅ Активен' : '❌ Не активен'}`;

    await ctx.reply(statusMessage, keyboards.getMainKeyboard(isMonitoringActive));
});

bot.command('logout', async (ctx) => {
    const userId = ctx.from.id;
    const session = await db.getSession(userId);
    
    if (session) {
        monitoring.stopMonitoring(userId);
        await db.deleteSession(userId);
        await ctx.reply('✅ Вы успешно вышли из системы', keyboards.getLoginKeyboard);
    } else {
        await ctx.reply('⚠️ Вы не были авторизованы', keyboards.getLoginKeyboard);
    }
});

// Обработка действий с кнопками
bot.action('routes_today', async (ctx) => {
    const currentDate = new Date().toLocaleDateString('ru-RU');
    await showRoutes(ctx, currentDate);
});

bot.action('routes_select_date', async (ctx) => {
    const session = await db.getSession(ctx.from.id);
    if (!session?.session_id) {
        return await ctx.reply('Вы не авторизованы', keyboards.getLoginKeyboard);
    }

    await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ (например, 09.02.2024):', 
        keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)));
    
    await db.saveSession(ctx.from.id, {
        ...session,
        step: config.STEPS.AWAITING_DATE
    });
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from.id;
    const session = await db.getSession(userId);
    const isMonitoringActive = monitoring.isMonitoringActive(userId);

    // Обработка кнопок меню
    switch (text) {
        case '🔑 Войти':
            await ctx.reply('Введите ClientCode:');
            await db.saveSession(userId, {
                user_id: userId,
                client_code: null,
                login: null,
                password: null,
                session_id: null,
                driver_name: null,
                step: config.STEPS.CLIENT_CODE
            });
            return;

        case '📊 Маршруты':
            if (!session?.session_id) {
                return await ctx.reply('Вы не авторизованы', keyboards.getLoginKeyboard);
            }
            await ctx.reply('Выберите дату для просмотра маршрутов:', keyboards.getRoutesKeyboard);
            return;

        case '👤 Профиль':
            const statusSession = await db.getSession(ctx.from.id);
            const statusMonitoringActive = monitoring.isMonitoringActive(ctx.from.id);
        
            if (!statusSession?.session_id) {
                return await ctx.reply('Вы не авторизованы');
            }
        
            const statusMessage = `Статус: авторизован\n` +
                `Клиент: ${statusSession.client_code}\n` +
                `Логин: ${statusSession.login}\n` +
                `Водитель: ${statusSession.driver_name || 'Не указан'}\n` +
                `Мониторинг: ${statusMonitoringActive ? '✅ Активен' : '❌ Не активен'}`;
        
            await ctx.reply(statusMessage, keyboards.getMainKeyboard(statusMonitoringActive));
            return;

        case '🟢 Запустить мониторинг':
            if (!session?.session_id) {
                return await ctx.reply('Вы не авторизованы', keyboards.getLoginKeyboard);
            }
            if (isMonitoringActive) {
                return await ctx.reply('⚠️ Мониторинг уже активен!', 
                    keyboards.getMainKeyboard(true));
            }
            const started = monitoring.startMonitoring(
                userId, 
                session.session_id,
                checkNewOrders,
                config.INTERVAL_UPDATES
            );
            if (started) {
                await checkNewOrders(userId, session.session_id);
                await ctx.reply('✅ Мониторинг новых заказов включен', 
                    keyboards.getMainKeyboard(true));
            }
            return;

        case '🔴 Остановить мониторинг':
            if (monitoring.stopMonitoring(userId)) {
                await ctx.reply('✅ Мониторинг отключен', 
                    keyboards.getMainKeyboard(false));
            } else {
                await ctx.reply('⚠️ Мониторинг не был активен', 
                    keyboards.getMainKeyboard(false));
            }
            return;

        case '📝 Создать отчет':
            if (!session?.session_id) {
                return await ctx.reply('Вы не авторизованы', keyboards.getLoginKeyboard);
            }
            await ctx.reply('Введите время работы в формате "9.30-21.00":');
            await db.saveSession(userId, {
                ...session,
                step: config.STEPS.AWAITING_WORK_TIME
            });
            return;

        case '🚪 Выйти':
            const logoutUserId = ctx.from.id;
            const logoutSession = await db.getSession(logoutUserId);
            
            if (logoutSession) {
                monitoring.stopMonitoring(logoutUserId);
                await db.deleteSession(logoutUserId);
                await ctx.reply('✅ Вы успешно вышли из системы', keyboards.getLoginKeyboard);
            } else {
                await ctx.reply('⚠️ Вы не были авторизованы', keyboards.getLoginKeyboard);
            }
            return;
    }

    // Обработка ввода даты
    if (session?.step === config.STEPS.AWAITING_DATE) {
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
            await showRoutes(ctx, text);
            await db.saveSession(ctx.from.id, {
                ...session,
                step: session.session_id ? config.STEPS.AUTHENTICATED : config.STEPS.CLIENT_CODE
            });
        } else {
            await ctx.reply('❌ Неверный формат даты. Используйте формат ДД.ММ.ГГГГ', 
                keyboards.getMainKeyboard(isMonitoringActive));
        }
        return;
    }

    // Обработка ввода времени для отчета
    if (session?.step === config.STEPS.AWAITING_WORK_TIME) {
        const timeRegex = /^\d{1,2}\.\d{2}-\d{1,2}\.\d{2}$/;
        if (!timeRegex.test(text)) {
            return await ctx.reply('❌ Неверный формат времени. Используйте формат "9.30-21.00"');
        }
    
        try {
            const currentDate = new Date().toLocaleDateString('ru-RU');
            const workHours = calculateWorkHours(text);
            const driverSurname = getDriverSurname(session.driver_name);
    
            const reportMessage = 
                `📋 Отчет за ${currentDate}\n\n` +
                `👤 ${driverSurname}\n` +
                `🕒 ${text} (${workHours.toFixed(1)} ч.)`;
    
            await ctx.reply(reportMessage, keyboards.getMainKeyboard(monitoring.isMonitoringActive(userId)));
            
            await db.saveSession(userId, {
                ...session,
                step: config.STEPS.AUTHENTICATED
            });
        } catch (error) {
            console.error('Error creating report:', error);
            await ctx.reply('❌ Произошла ошибка при создании отчета');
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
                    step: config.STEPS.LOGIN
                });
                await ctx.reply('Введите Login:');
                break;

            case config.STEPS.LOGIN:
                await db.saveSession(userId, {
                    ...session,
                    login: text,
                    step: config.STEPS.PASSWORD
                });
                await ctx.reply('Введите Password:');
                break;

            case config.STEPS.PASSWORD:
                try {
                    const response = await api.authenticate(
                        session.client_code,
                        session.login,
                        text
                    );

                    if (response.TL_Mobile_LoginResponse.ErrorDescription) {
                        await ctx.reply(`❌ Ошибка: ${response.TL_Mobile_LoginResponse.ErrorDescription}`, 
                            keyboards.getLoginKeyboard);
                        await db.deleteSession(userId);
                    } else {
                        await db.saveSession(userId, {
                            ...session,
                            password: text,
                            session_id: response.TL_Mobile_LoginResponse.SessionId,
                            driver_name: response.TL_Mobile_LoginResponse.DriverName,
                            step: config.STEPS.AUTHENTICATED
                        });
                        await ctx.reply('✅ Авторизация успешна!', 
                            keyboards.getMainKeyboard(false));
                    }
                } catch (error) {
                    console.error('Authentication error:', error);
                    await ctx.reply('❌ Ошибка авторизации', keyboards.getLoginKeyboard);
                    await db.deleteSession(userId);
                }
                break;
        }
    } else {
        await ctx.reply('Для начала работы необходимо войти в систему', 
            keyboards.getLoginKeyboard);
    }
});

bot.launch();

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    db.close();
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});