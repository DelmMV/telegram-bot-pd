const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

const intervalUpdates = process.env.INTERVAL_UPDATES;

let activeMonitoring = new Map();
let lastKnownOrders = new Map();

const db = new sqlite3.Database('sessions.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        user_id INTEGER PRIMARY KEY,
        client_code TEXT,
        login TEXT,
        password TEXT,
        session_id TEXT,
        driver_name TEXT,
        step TEXT
    )`);
});

const dbMethods = {
    saveSession: (userId, sessionData) => {
        return new Promise((resolve, reject) => {
            console.log('Saving session data:', sessionData);
            const query = `INSERT OR REPLACE INTO sessions 
                (user_id, client_code, login, password, session_id, driver_name, step) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`;
            const params = [
                userId,
                sessionData.client_code,
                sessionData.login,
                sessionData.password,
                sessionData.session_id,
                sessionData.driver_name,
                sessionData.step
            ];

            // Add validation checks
            if (!userId) {
                reject(new Error('userId is required'));
                return;
            }

            // Log full state for debugging
            console.log('Current state:', {
                query,
                params,
                sessionData: JSON.stringify(sessionData)
            });

            db.run(query, params, function(err) {
                if (err) {
                    console.error('Database error:', err);
                    reject(err);
                    return;
                }
                console.log('Session saved successfully. Row ID:', this.lastID);

                // Verify saved data
                db.get('SELECT * FROM sessions WHERE user_id = ?', [userId], (verifyErr, row) => {
                    if (verifyErr) {
                        console.error('Verification error:', verifyErr);
                    } else {
                        console.log('Verified saved data:', row);
                    }
                    resolve();
                });
            });
        });
    },

    getSession: (userId) => {
        return new Promise((resolve, reject) => {
            if (!userId) {
                reject(new Error('userId is required'));
                return;
            }

            console.log('Getting session for userId:', userId);

            db.get('SELECT * FROM sessions WHERE user_id = ?', [userId], (err, row) => {
                if (err) {
                    console.error('Error getting session:', err);
                    reject(err);
                    return;
                }

                if (!row) {
                    console.log('No session found for userId:', userId);
                } else {
                    console.log('Retrieved session state:', {
                        userId,
                        step: row.step,
                        hasClientCode: !!row.client_code,
                        hasLogin: !!row.login
                    });
                }

                resolve(row);
            });
        });
    },

    deleteSession: (userId) => {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM sessions WHERE user_id = ?', [userId], (err) => {
                if (err) {
                    console.error('Error deleting session:', err);
                    reject(err);
                    return;
                }
                console.log('Session deleted for userId:', userId);
                resolve();
            });
        });
    }
};

function extractOrders(routes) {
    const orders = new Set();
    routes.forEach(route => {
        route.Orders.forEach(order => {
            orders.add(order.ExternalId);
        });
    });
    return orders;
}

async function checkNewOrders(userId, sessionId) {
    try {
        const currentDate = new Date();
        const formattedDate = `${String(currentDate.getDate()).padStart(2, '0')}.${String(currentDate.getMonth() + 1).padStart(2, '0')}.${currentDate.getFullYear()}`;

        const response = await getRoutes(sessionId, formattedDate);
        
        if (!response.TL_Mobile_EnumRoutesResponse || !response.TL_Mobile_EnumRoutesResponse.Routes) {
            return;
        }

        const currentOrders = extractOrders(response.TL_Mobile_EnumRoutesResponse.Routes);
        const previousOrders = lastKnownOrders.get(userId) || new Set();

        // Находим новые заказы
        const newOrders = [...currentOrders].filter(order => !previousOrders.has(order));
        
        console.log(`Запрос времени: ${new Date()}`);
        
        // Если есть новые заказы, отправляем уведомление
        if (newOrders.length > 0) {
            const message = `🆕 Получены новые заказы:\n${newOrders.map(order => `📦 ${order}`).join('\n')}`;
            await bot.telegram.sendMessage(userId, message);
        }

        // Обновляем сохраненные заказы
        lastKnownOrders.set(userId, currentOrders);

    } catch (error) {
        console.error('Error checking new orders:', error);
    }
}

async function startOrdersMonitoring(userId) {
    try {
        const session = await dbMethods.getSession(userId);
        if (!session || !session.session_id) {
            return false;
        }

        // Проверяем новые заказы каждую минуту
        const intervalId = setInterval(() => checkNewOrders(userId, session.session_id), intervalUpdates);
        activeMonitoring.set(userId, intervalId);
        return true;

    } catch (error) {
        console.error('Error starting orders monitoring:', error);
        return false;
    }
}

const getMainKeyboard = (isMonitoringActive) => {
    return Markup.keyboard([
        ['📊 Маршруты', '👤 Статус'],
        [isMonitoringActive ? '🔴 Остановить мониторинг' : '🟢 Запустить мониторинг'],
        ['🚪 Выйти']
    ]).resize();
};

const getLoginKeyboard = Markup.keyboard([
    ['🔑 Войти'],
]).resize();

bot.command('start', async (ctx) => {
    const session = await dbMethods.getSession(ctx.from.id);
    const isMonitoringActive = activeMonitoring.has(ctx.from.id);

    if (session && session.session_id) {
        await ctx.reply('Выберите действие:', getMainKeyboard(isMonitoringActive));
    } else {
        await ctx.reply('Добро пожаловать! Нажмите кнопку "Войти" для начала работы:', getLoginKeyboard);
    }
});

bot.command('monitor', async (ctx) => {
    try {
        const userId = ctx.from.id;

        // Проверяем, не активен ли уже мониторинг
        if (activeMonitoring.has(userId)) {
            return await ctx.reply('⚠️ Мониторинг уже активен! Используйте /stopmonitor для отключения текущего мониторинга.');
        }

        const session = await dbMethods.getSession(userId);
        
        if (!session || !session.session_id) {
            return await ctx.reply('Вы не авторизованы. Используйте /login для входа в систему.');
        }

        // Запускаем мониторинг
        const started = await startOrdersMonitoring(userId);
        
        if (started) {
            // Делаем первоначальную проверку заказов
            await checkNewOrders(userId, session.session_id);
            await ctx.reply('✅ Мониторинг новых заказов включен. Вы будете получать уведомления о новых заказах.');
        } else {
            await ctx.reply('❌ Не удалось запустить мониторинг. Проверьте авторизацию.');
        }

    } catch (error) {
        console.error('Error in monitor command:', error);
        await ctx.reply('❌ Произошла ошибка при включении мониторинга');
    }
});

bot.command('stopmonitor', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const intervalId = activeMonitoring.get(userId);

        if (!intervalId) {
            return await ctx.reply('⚠️ Мониторинг не был активен.');
        }

        // Останавливаем интервал
        clearInterval(intervalId);
        
        // Очищаем данные мониторинга
        activeMonitoring.delete(userId);
        lastKnownOrders.delete(userId);
        
        await ctx.reply('✅ Мониторинг новых заказов отключен.');
    } catch (error) {
        console.error('Error in stopmonitor command:', error);
        await ctx.reply('❌ Произошла ошибка при отключении мониторинга');
    }
});

bot.command('login', async (ctx) => {
    ctx.reply('Введите ClientCode:');
    await dbMethods.saveSession(ctx.from.id, { 
        user_id: ctx.from.id,
        client_code: null,
        login: null,
        password: null,
        session_id: null,
        driver_name: null,
        step: 'clientCode'
    });
});

bot.command('status', async (ctx) => {
  console.log('Status command received from user:', ctx.from.id);
    try {
        const session = await dbMethods.getSession(ctx.from.id);

        if (!session) {
            return await ctx.reply('Вы не авторизованы');
        }

        if (session.session_id) {
            return await ctx.reply(
                `Статус: авторизован\n` +
                `Клиент: ${session.client_code}\n` +
                `Логин: ${session.login}\n` +
                `Водитель: ${session.driver_name || 'Не указан'}\n` +
                `SessionId: ${session.session_id}`
            );
        } else {
            return await ctx.reply('Вы не авторизованы');
        }
    } catch (error) {
        console.error('Error in status command:', error);
        return await ctx.reply('Произошла ошибка при проверке статуса');
    }
});

bot.command('logout', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const session = await dbMethods.getSession(userId);
        
        if (session) {
            // Останавливаем мониторинг, если он активен
            const intervalId = activeMonitoring.get(userId);
            if (intervalId) {
                clearInterval(intervalId);
                activeMonitoring.delete(userId);
                lastKnownOrders.delete(userId);
            }

            await dbMethods.deleteSession(userId);
            await ctx.reply('✅ Вы успешно вышли из системы');
        } else {
            await ctx.reply('⚠️ Вы не были авторизованы');
        }
    } catch (error) {
        console.error('Error in logout command:', error);
        await ctx.reply('❌ Произошла ошибка при выходе из системы');
    }
});

bot.command('monitorstatus', async (ctx) => {
    const userId = ctx.from.id;
    const isMonitoringActive = activeMonitoring.has(userId);
    
    await ctx.reply(isMonitoringActive 
        ? '✅ Мониторинг активен'
        : '❌ Мониторинг не активен');
});

bot.command('routes', async (ctx) => {
    try {
        const session = await dbMethods.getSession(ctx.from.id);
        
        if (!session || !session.session_id) {
            return await ctx.reply('Вы не авторизованы. Используйте /login для входа в систему.');
        }

        // Получаем аргументы команды
        const args = ctx.message.text.split(' ');
        let date;

        if (args.length > 1) {
            // Если дата указана в формате DD.MM.YYYY
            if (/^\d{2}\.\d{2}\.\d{4}$/.test(args[1])) {
                date = args[1];
            } else {
                return await ctx.reply('Неверный формат даты. Используйте формат ДД.ММ.ГГГГ (например, 09.02.2024)');
            }
        } else {
            // Если дата не указана, используем текущую
            const currentDate = new Date();
            date = `${String(currentDate.getDate()).padStart(2, '0')}.${String(currentDate.getMonth() + 1).padStart(2, '0')}.${currentDate.getFullYear()}`;
        }

        const response = await getRoutes(session.session_id, date);
        
        if (response.TL_Mobile_EnumRoutesResponse) {
            const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
            
            if (routes.length === 0) {
                return await ctx.reply(`Маршруты на ${date} не найдены`);
            }

            let formattedMessage = `📋 Список маршрутов на ${date}:\n\n`;
            
            routes.forEach((route, index) => {
                formattedMessage += `🚚 Маршрут ${index + 1}:\n`;
                
                if (route.Orders && route.Orders.length > 0) {
                    formattedMessage += '\n📦 Заказы:\n';
                    route.Orders.forEach((order, orderIndex) => {
                        formattedMessage += `${orderIndex + 1}. ${order.ExternalId}\n`;
                    });
                }
                
                formattedMessage += '\n';
            });

            await ctx.reply(formattedMessage);
        } else {
            await ctx.reply('Ошибка при получении маршрутов');
        }
    } catch (error) {
        console.error('Error in routes command:', error);
        await ctx.reply('Произошла ошибка при получении маршрутов');
    }
});

bot.action('routes_today', async (ctx) => {
    const session = await dbMethods.getSession(ctx.from.id);
    if (!session || !session.session_id) {
        return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
    }

    const currentDate = new Date();
    const formattedDate = `${String(currentDate.getDate()).padStart(2, '0')}.${String(currentDate.getMonth() + 1).padStart(2, '0')}.${currentDate.getFullYear()}`;
    
    // Используем существующую функцию получения маршрутов
    await showRoutes(ctx, formattedDate);
});

bot.action('routes_select_date', async (ctx) => {
    const session = await dbMethods.getSession(ctx.from.id);
    if (!session || !session.session_id) {
        return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
    }

    await ctx.reply('Введите дату в формате ДД.ММ.ГГГГ (например, 09.02.2024):', 
        getMainKeyboard(activeMonitoring.has(ctx.from.id)));
    
    // Сохраняем состояние ожидания ввода даты
    await dbMethods.saveSession(ctx.from.id, {
        ...session,
        step: 'awaiting_date'
    });
});



bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from.id;

    // Проверяем текущую сессию
    const session = await dbMethods.getSession(userId);
    const isMonitoringActive = activeMonitoring.has(userId);

    // Сначала обрабатываем кнопки меню
    switch (text) {
        case '🔑 Войти':
            ctx.reply('Введите ClientCode:');
            await dbMethods.saveSession(ctx.from.id, { 
                user_id: ctx.from.id,
                client_code: null,
                login: null,
                password: null,
                session_id: null,
                driver_name: null,
                step: 'clientCode'
            });
            return;

        case '📊 Маршруты':
            if (!session || !session.session_id) {
                return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
            }
            const keyboard = Markup.inlineKeyboard([
                Markup.button.callback('На сегодня', 'routes_today'),
                Markup.button.callback('Выбрать дату', 'routes_select_date')
            ]);
            await ctx.reply('Выберите дату для просмотра маршрутов:', keyboard);
            return;

        case '👤 Статус':
            if (!session || !session.session_id) {
                return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
            }
            const statusMessage = `Статус: авторизован\n` +
                `Клиент: ${session.client_code}\n` +
                `Логин: ${session.login}\n` +
                `Водитель: ${session.driver_name || 'Не указан'}\n` +
                `Мониторинг: ${isMonitoringActive ? '✅ Активен' : '❌ Не активен'}`;
            await ctx.reply(statusMessage, getMainKeyboard(isMonitoringActive));
            return;

        case '🟢 Запустить мониторинг':
            if (!session || !session.session_id) {
                return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
            }
            if (isMonitoringActive) {
                await ctx.reply('⚠️ Мониторинг уже активен!', getMainKeyboard(true));
                return;
            }
            const started = await startOrdersMonitoring(userId);
            if (started) {
                await checkNewOrders(userId, session.session_id);
                await ctx.reply('✅ Мониторинг новых заказов включен', getMainKeyboard(true));
            }
            return;

        case '🔴 Остановить мониторинг':
            if (!session || !session.session_id) {
                return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
            }
            const intervalId = activeMonitoring.get(userId);
            if (intervalId) {
                clearInterval(intervalId);
                activeMonitoring.delete(userId);
                lastKnownOrders.delete(userId);
                await ctx.reply('✅ Мониторинг отключен', getMainKeyboard(false));
            } else {
                await ctx.reply('⚠️ Мониторинг не был активен', getMainKeyboard(false));
            }
            return;

        case '🚪 Выйти':
            if (session) {
                const intervalId = activeMonitoring.get(userId);
                if (intervalId) {
                    clearInterval(intervalId);
                    activeMonitoring.delete(userId);
                    lastKnownOrders.delete(userId);
                }
                await dbMethods.deleteSession(userId);
                await ctx.reply('Вы вышли из системы', getLoginKeyboard);
            } else {
                await ctx.reply('Вы не были авторизованы', getLoginKeyboard);
            }
            return;
    }

    // Затем обрабатываем ввод даты
    if (session && session.step === 'awaiting_date') {
        const dateText = ctx.message.text;
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateText)) {
            await showRoutes(ctx, dateText);
            await dbMethods.saveSession(ctx.from.id, {
                ...session,
                step: session.session_id ? 'authenticated' : 'clientCode'
            });
        } else {
            await ctx.reply('❌ Неверный формат даты. Используйте формат ДД.ММ.ГГГГ', 
                getMainKeyboard(activeMonitoring.has(ctx.from.id)));
        }
        return;
    }

    // Наконец, обрабатываем процесс авторизации
    if (session && session.step) {
        switch (session.step) {
            case 'clientCode':
                const clientCode = ctx.message.text;
                await dbMethods.saveSession(userId, {
                    ...session,
                    client_code: clientCode,
                    step: 'login'
                });
                await ctx.reply('Введите Login:');
                break;

            case 'login':
                await dbMethods.saveSession(userId, {
                    ...session,
                    login: ctx.message.text,
                    step: 'password'
                });
                await ctx.reply('Введите Password:');
                break;

            case 'password':
                try {
                    const response = await authenticateUser(
                        session.client_code,
                        session.login,
                        ctx.message.text
                    );

                    if (response.TL_Mobile_LoginResponse.ErrorDescription) {
                        await ctx.reply(`❌ Ошибка: ${response.TL_Mobile_LoginResponse.ErrorDescription}`, getLoginKeyboard);
                        await dbMethods.deleteSession(userId);
                    } else {
                        const authenticatedSession = {
                            ...session,
                            password: ctx.message.text,
                            session_id: response.TL_Mobile_LoginResponse.SessionId,
                            driver_name: response.TL_Mobile_LoginResponse.DriverName,
                            step: 'authenticated'
                        };
                        await dbMethods.saveSession(userId, authenticatedSession);
                        await ctx.reply('✅ Авторизация успешна!', getMainKeyboard(false));
                    }
                } catch (error) {
                    console.error('Authentication error:', error);
                    await ctx.reply('❌ Ошибка авторизации', getLoginKeyboard);
                    await dbMethods.deleteSession(userId);
                }
                break;

            case 'authenticated':
                // Игнорируем ввод текста в аутентифицированном состоянии
                break;
        }
    } else {
        // Если нет активной сессии, показываем клавиатуру для входа
        await ctx.reply('Для начала работы необходимо войти в систему', getLoginKeyboard);
    }
});

async function showRoutes(ctx, date) {
    try {
        const session = await dbMethods.getSession(ctx.from.id);
        if (!session || !session.session_id) {
            return await ctx.reply('Вы не авторизованы', getLoginKeyboard);
        }

        const response = await getRoutes(session.session_id, date);
        
        if (response.TL_Mobile_EnumRoutesResponse) {
            const routes = response.TL_Mobile_EnumRoutesResponse.Routes;
            
            if (!routes || routes.length === 0) {
                await ctx.reply(`📭 Маршруты на ${date} не найдены`, getMainKeyboard(activeMonitoring.has(ctx.from.id)));
                return;
            }

            // Разбиваем большой список на части, если он слишком длинный
            const maxMessageLength = 4096; // Максимальная длина сообщения в Telegram
            let formattedMessage = `📋 Список маршрутов на ${date}:\n\n`;
            let currentMessage = formattedMessage;
            
            for (let i = 0; i < routes.length; i++) {
                const route = routes[i];
                let routeMessage = `🚚 Маршрут ${i + 1}:\n`;
                
                if (route.Orders && route.Orders.length > 0) {
                    routeMessage += '\n📦 Заказы:\n';
                    route.Orders.forEach((order, orderIndex) => {
                        routeMessage += `${orderIndex + 1}. ${order.ExternalId}\n`;
                    });
                } else {
                    routeMessage += '\n❌ Нет заказов\n';
                }
                
                routeMessage += '\n';

                // Проверяем, не превысит ли добавление нового маршрута максимальную длину
                if ((currentMessage + routeMessage).length > maxMessageLength) {
                    // Отправляем текущее сообщение и начинаем новое
                    await ctx.reply(currentMessage, { parse_mode: 'HTML' });
                    currentMessage = routeMessage;
                } else {
                    currentMessage += routeMessage;
                }
            }

            // Отправляем последнее сообщение
            if (currentMessage) {
                await ctx.reply(currentMessage, { 
                    parse_mode: 'HTML',
                    ...getMainKeyboard(activeMonitoring.has(ctx.from.id))
                });
            }

            // Добавляем статистику
            const totalOrders = routes.reduce((sum, route) => sum + (route.Orders ? route.Orders.length : 0), 0);
            const statsMessage = `\n📊 Статистика:\n` +
                `Всего маршрутов: ${routes.length}\n` +
                `Всего заказов: ${totalOrders}`;
            
            await ctx.reply(statsMessage, getMainKeyboard(activeMonitoring.has(ctx.from.id)));

        } else {
            await ctx.reply('❌ Ошибка при получении маршрутов', 
                getMainKeyboard(activeMonitoring.has(ctx.from.id)));
        }
    } catch (error) {
        console.error('Error showing routes:', error);
        await ctx.reply('❌ Произошла ошибка при получении маршрутов', 
            getMainKeyboard(activeMonitoring.has(ctx.from.id)));
    }
}

async function authenticateUser(clientCode, login, password) {
  console.log(clientCode, login, password)
    try {
        const response = await axios.post('http://vrp.logdep.ru/dl/storage', {
            TL_Mobile_LoginRequest: {
                ClientCode: clientCode,
                DeviceInfo: "Telegram Bot Device",
                Login: login,
                Password: password
            }
        });
        return response.data;
    } catch (error) {
        console.error('Authentication error:', error);
        throw error;
    }
}

async function getRoutes(sessionId, date) {
    try {
        const response = await axios.post('http://vrp.logdep.ru/dl/storage', {
            TL_Mobile_EnumRoutesRequest: {
                Date: date,
                SessionId: sessionId
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error getting routes:', error);
        throw error;
    }
}

bot.launch();

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    db.close();
});