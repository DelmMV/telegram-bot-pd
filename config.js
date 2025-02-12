require('dotenv').config();

module.exports = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    INTERVAL_UPDATES: parseInt(process.env.INTERVAL_UPDATES),
    API_URL: 'http://vrp.logdep.ru/dl/storage',
    DB_PATH: 'sessions.db',
    MAX_MESSAGE_LENGTH: 4096,
    DATE_FORMAT: 'DD.MM.YYYY',
    STEPS: {
        CLIENT_CODE: 'clientCode',
        LOGIN: 'login',
        PASSWORD: 'password',
        AUTHENTICATED: 'authenticated',
        AWAITING_WORK_TIME: 'awaiting_work_time',
        AWAITING_DATE: 'awaiting_date'
    }
};