const { Telegraf } = require('telegraf');
const config = require('./config');
const db = require('./database');
const api = require('./api');
const keyboards = require('./keyboards');
const monitoring = require('./monitoring');

const bot = new Telegraf(config.TELEGRAM_TOKEN);

const ORDER_STATES = {
    '51e45c11-d5c7-4383-8fc4-a2e2e1781230': 'Отменён',
    'dfab6563-55b8-475d-aac5-01b6705265cd': 'Новый',
    '8b176fdd-4718-46eb-b4f6-1cf487e5353b': 'Доставляется',
    'b107b2e5-fe96-46ec-9c1d-7248d77e8383': 'Выполнен (сайт)',
    'ceb8edd8-a0d9-4116-a8ee-a6c0be89103b': 'Выполнен (нал)',
    'd4535403-e4f6-4888-859e-098b7829b3a6': 'Выполнен (безнал)',
    '01c157f5-ec6a-47b6-a655-981489e6022a': 'Запланирован',
    '3e3d9e5d-b04a-4950-97f5-f6060b5362b6': 'В машине',
    'e11e0bf2-4e34-4789-bdb6-b6c284f93bbf': 'Частично выполнен',
    '50b9348e-1da1-44e3-b84b-88b68da829a4': 'Отложен'
};

function getOrderStatusName(statusId) {
    return ORDER_STATES[statusId] || 'Неизвестный статус';
}

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

                    // Получаем orderIds для детальной информации
                    const orderIds = routeDetails.Points.flatMap(point => 
                        point.Orders?.map(order => order.Id) || []
                    ).filter(id => id);

                    // Получаем детальную информацию о заказах
                    const orderDetailsResult = await api.getOrderDetails(sessionId, orderIds, credentials);
                    if (orderDetailsResult.sessionUpdated) {
                        session.session_id = orderDetailsResult.newSessionId;
                        await db.saveSession(userId, session);
                        sessionId = orderDetailsResult.newSessionId;
                    }

                    const orders = orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;

                    let messageText = `🆕 Новые заказы в маршруте ${routeDetails.Number}:\n\n`;

                    for (let i = 1; i < routeDetails.Points.length; i++) {
                        const point = routeDetails.Points[i];
                        const pointOrder = point.Orders?.[0];

                        if (pointOrder && newOrders.includes(pointOrder.ExternalId)) {
                            const orderDetails = orders.find(o => o.Id === pointOrder.Id);

                            messageText += `📦 Заказ: ${pointOrder.ExternalId}\n`;
                            messageText += `📍 Адрес: ${point.Address}\n`;
                            
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

                            if(orderDetails?.To?. StartTime && orderDetails?.To?.EndTime){
                                const startTime = new Date(orderDetails.To.StartTime).toLocaleTimeString('ru-RU', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                                const endTime = new Date(orderDetails.To.EndTime).toLocaleTimeString('ru-RU', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                                messageText += `⏰ Временное окно: ${startTime} - ${endTime}\n`;
                            }

                            // Добавляем информацию о временном окне доставки, если она есть
                            if (orderDetails?.To?.StartTime && orderDetails?.To?.EndTime) {
                                const startTime = new Date(orderDetails.To.StartTime).toLocaleTimeString('ru-RU', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                                const endTime = new Date(orderDetails.To.EndTime).toLocaleTimeString('ru-RU', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                                messageText += `⏰ Временное окно: ${startTime} - ${endTime}\n`;
                            }

                            messageText += `\n`;
                        }
                    }

                    // Добавляем информацию о маршруте
                    messageText += `📊 Информация о маршруте:\n`;
                    messageText += `🚚 Номер маршрута: ${routeDetails.Number}\n`;
                    if (routeDetails.Distance) {
                        messageText += `📏 Дистанция: ${routeDetails.Distance} км\n`;
                    }
                    messageText += `📦 Всего точек в маршруте: ${routeDetails.Points.length - 1}\n`;

                    // Отправляем сообщение с учетом ограничения длины
                    if (messageText.length > config.MAX_MESSAGE_LENGTH) {
                        for (let i = 0; i < messageText.length; i += config.MAX_MESSAGE_LENGTH) {
                            await bot.telegram.sendMessage(userId, 
                                messageText.slice(i, i + config.MAX_MESSAGE_LENGTH));
                        }
                    } else {
                        await bot.telegram.sendMessage(userId, messageText);
                    }
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
                await bot.telegram.sendMessage(userId, 
                    'Ошибка обновления сессии. Пожалуйста, авторизуйтесь заново через /start');
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
        const totalOrders = routes.reduce((sum, route) => {
            if (route.Orders && Array.isArray(route.Orders)) {
                return sum + route.Orders.length;
            }
            return sum;
        }, 0);

        if (totalOrders === 0) {
            return await ctx.reply(`📭 На ${date} заказов нет`, 
                keyboards.getMainKeyboard(monitoring.isMonitoringActive(ctx.from.id)));
        }

        let totalCashAmount = 0;
        let totalNonCashAmount = 0;

        for (const route of routes) {
            const detailsResult = await api.getRouteDetails(session.session_id, [route.Id], credentials);
            
            if (detailsResult.sessionUpdated) {
                session.session_id = detailsResult.newSessionId;
                await db.saveSession(ctx.from.id, session);
            }

            const routeDetails = detailsResult.data.TL_Mobile_GetRoutesResponse.Routes[0];
            const orderIds = routeDetails.Points.flatMap(point => 
                point.Orders?.map(order => order.Id) || []
            ).filter(id => id);

            const orderDetailsResult = await api.getOrderDetails(session.session_id, orderIds, credentials);
            if (orderDetailsResult.sessionUpdated) {
                session.session_id = orderDetailsResult.newSessionId;
                await db.saveSession(ctx.from.id, session);
            }

            const orders = orderDetailsResult.data.TL_Mobile_GetOrdersResponse.Orders;
            let routeCashAmount = 0;
            let routeNonCashAmount = 0;
            
            let messageText = `🚚 Маршрут ${routes.indexOf(route) + 1}\n`;
            messageText += `📝 Номер: ${routeDetails.Number}\n`;
            messageText += `📦 Всего точек: ${routeDetails.Points.length - 1}\n\n`;

            for (let i = 1; i < routeDetails.Points.length; i++) {
                const point = routeDetails.Points[i];
                messageText += `📍 Точка ${point.Label}:\n`;
                
                // Проверяем наличие Orders и первого заказа
                if (point.Orders && point.Orders.length > 0 && point.Orders[0].ExternalId) {
                    messageText += `🔹 Заказ: ${point.Orders[0].ExternalId}\n`;
                }
                
                messageText += `📮 Адрес: ${point.Address}\n`;
                
                if (point.Description) {
                    messageText += `👤 Получатель: ${point.Description}\n`;
                }

                if (point.Orders && point.Orders.length > 0) {
                    const orderDetails = orders.find(o => o.Id === point.Orders[0].Id);
                    
                    if (point.Weight) {
                        messageText += `⚖️ Вес: ${point.Weight} ${routeDetails.WeightUnit}\n`;
                    }
                    
                    if (orderDetails) {
                        if (orderDetails.CustomState) {
                            messageText += `📊 Статус: ${getOrderStatusName(orderDetails.CustomState)}\n`;
                            
                            if (orderDetails.InvoiceTotal) {
                                const amount = parseFloat(orderDetails.InvoiceTotal);
                                
                                if (orderDetails.CustomState === 'ceb8edd8-a0d9-4116-a8ee-a6c0be89103b') {
                                    routeCashAmount += amount;
                                    totalCashAmount += amount;
                                } else if (orderDetails.CustomState === 'd4535403-e4f6-4888-859e-098b7829b3a6') {
                                    routeNonCashAmount += amount;
                                    totalNonCashAmount += amount;
                                }
                            }
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
                            const startTime = new Date(orderDetails.To.StartTime).toLocaleTimeString('ru-RU', {
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            const endTime = new Date(orderDetails.To.EndTime).toLocaleTimeString('ru-RU', {
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            messageText += `⏰ Временное окно: ${startTime} - ${endTime}\n`;
                        }
                    }
                }
                messageText += `\n`;
            }

            // Добавляем финансовую информацию по маршруту
            const routeTotalAmount = routeCashAmount + routeNonCashAmount;
            if (routeTotalAmount > 0) {
                messageText += `💰 Финансы по маршруту:\n`;
                if (routeCashAmount > 0) {
                    messageText += `├ 💵 Наличные: ${routeCashAmount.toFixed(2)} руб.\n`;
                }
                if (routeNonCashAmount > 0) {
                    messageText += `├ 💳 Безналичные: ${routeNonCashAmount.toFixed(2)} руб.\n`;
                }
                messageText += `└ 📈 Всего: ${routeTotalAmount.toFixed(2)} руб.\n`;
            }

            if (messageText.length > config.MAX_MESSAGE_LENGTH) {
                for (let i = 0; i < messageText.length; i += config.MAX_MESSAGE_LENGTH) {
                    await ctx.reply(messageText.slice(i, i + config.MAX_MESSAGE_LENGTH));
                }
            } else {
                await ctx.reply(messageText);
            }
        }

        // Подсчет итоговой суммы
        const totalAmount = totalCashAmount + totalNonCashAmount;

        const statsMessage = `📊 Общая статистика:\n\n` +
            `💰 Финансы:\n` +
            `├ 💵 Наличные: ${totalCashAmount.toFixed(2)} руб.\n` +
            `├ 💳 Безналичные: ${totalNonCashAmount.toFixed(2)} руб.\n` +
            `└ 📈 Всего: ${totalAmount.toFixed(2)} руб.\n\n` +
            `📦 Информация о маршрутах:\n` +
            `├ 🚚 Всего маршрутов: ${routes.length}\n` +
            `└ 📋 Всего заказов: ${totalOrders}`;

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
                `📋 ${currentDate}\n` +
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