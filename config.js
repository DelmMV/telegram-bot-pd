require("dotenv").config();

module.exports = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TG_API_ID: process.env.TG_API_ID,
  TG_API_HASH: process.env.TG_API_HASH,
  INTERVAL_UPDATES: parseInt(process.env.INTERVAL_UPDATES || "60000", 10),
  API_URL: "http://vrp.logdep.ru/dl/storage",
  API_TIMEOUT_MS: parseInt(process.env.API_TIMEOUT_MS || "30000", 10),
  API_RETRY_ATTEMPTS: parseInt(process.env.API_RETRY_ATTEMPTS || "5", 10),
  API_RETRY_BASE_DELAY_MS: parseInt(
    process.env.API_RETRY_BASE_DELAY_MS || "750",
    10,
  ),
  API_RETRY_MAX_DELAY_MS: parseInt(
    process.env.API_RETRY_MAX_DELAY_MS || "5000",
    10,
  ),
  TELEGRAM_RETRY_ATTEMPTS: parseInt(
    process.env.TELEGRAM_RETRY_ATTEMPTS || "5",
    10,
  ),
  TELEGRAM_RETRY_BASE_DELAY_MS: parseInt(
    process.env.TELEGRAM_RETRY_BASE_DELAY_MS || "500",
    10,
  ),
  TELEGRAM_RETRY_MAX_DELAY_MS: parseInt(
    process.env.TELEGRAM_RETRY_MAX_DELAY_MS || "5000",
    10,
  ),
  TELEGRAM_CONNECT_RETRIES: parseInt(
    process.env.TELEGRAM_CONNECT_RETRIES || "10",
    10,
  ),
  TELEGRAM_REQUEST_RETRIES: parseInt(
    process.env.TELEGRAM_REQUEST_RETRIES || "5",
    10,
  ),
  TELEGRAM_RETRY_DELAY_MS: parseInt(
    process.env.TELEGRAM_RETRY_DELAY_MS || "1000",
    10,
  ),
  TELEGRAM_TRANSPORT: (process.env.TELEGRAM_TRANSPORT || "abridged").toLowerCase(),
  TELEGRAM_PORT: parseInt(process.env.TELEGRAM_PORT || "443", 10),
  TELEGRAM_CLIENT_TTL_MS: parseInt(
    process.env.TELEGRAM_CLIENT_TTL_MS || "1800000",
    10,
  ),
  TELEGRAM_CLIENT_CLEANUP_MS: parseInt(
    process.env.TELEGRAM_CLIENT_CLEANUP_MS || "300000",
    10,
  ),
  TELEGRAM_KEEPALIVE_MIN_MS: parseInt(
    process.env.TELEGRAM_KEEPALIVE_MIN_MS || "15000",
    10,
  ),
  TELEGRAM_KEEPALIVE_MAX_MS: parseInt(
    process.env.TELEGRAM_KEEPALIVE_MAX_MS || "120000",
    10,
  ),
  TELEGRAM_KEEPALIVE_BACKOFF_FACTOR: parseFloat(
    process.env.TELEGRAM_KEEPALIVE_BACKOFF_FACTOR || "1.5",
  ),
  TELEGRAM_KEEPALIVE_RECOVERY_FACTOR: parseFloat(
    process.env.TELEGRAM_KEEPALIVE_RECOVERY_FACTOR || "1.2",
  ),
  TELEGRAM_KEEPALIVE_FAILURE_THRESHOLD: parseInt(
    process.env.TELEGRAM_KEEPALIVE_FAILURE_THRESHOLD || "3",
    10,
  ),
  TELEGRAM_KEEPALIVE_SUCCESS_THRESHOLD: parseInt(
    process.env.TELEGRAM_KEEPALIVE_SUCCESS_THRESHOLD || "3",
    10,
  ),
  TELEGRAM_MAX_CONCURRENT_REQUESTS: parseInt(
    process.env.TELEGRAM_MAX_CONCURRENT_REQUESTS || "3",
    10,
  ),
  TELEGRAM_ERROR_ALERT_THRESHOLD: parseInt(
    process.env.TELEGRAM_ERROR_ALERT_THRESHOLD || "3",
    10,
  ),
  ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id)),
  BROADCAST_DELAY_MS: parseInt(
    process.env.BROADCAST_DELAY_MS || "100",
    10,
  ),
  DB_PATH: "sessions.db",
  MAX_MESSAGE_LENGTH: 4096,
  DATE_FORMAT: "DD.MM.YYYY",
  STEPS: {
    CLIENT_CODE: "clientCode",
    LOGIN: "login",
    PASSWORD: "password",
    AUTHENTICATED: "authenticated",
    AWAITING_WORK_TIME: "awaiting_work_time",
    AWAITING_DATE: "awaiting_date",
    TG_PHONE: "tg_phone",
    TG_CODE: "tg_code",
    TG_PASSWORD: "tg_password",
    AWAITING_PAYMENT_CHANGE: "awaiting_payment_change",
  },
  // Точка старта по умолчанию (используется только как fallback,
  // основная точка производства берется из первой точки маршрута)
  START_POINT: {
    lat: parseFloat(process.env.START_POINT_LAT || "61.7495506"),
    lon: parseFloat(process.env.START_POINT_LON || "34.3627967"),
  },
  // Настройки OSRM (расчет расстояния по дорогам)
  ROUTING_API: {
    // Базовый URL OSRM: /route/v1/driving/{lon1},{lat1};{lon2},{lat2}
    url:
      process.env.ROUTING_API_URL ||
      "https://router.project-osrm.org/route/v1/driving",
    timeout: parseInt(process.env.ROUTING_API_TIMEOUT || "15000", 10),
  },
  // Тарифная сетка для расчета заработка
  // Согласно EARNINGS_CALCULATION_FIX.md:
  //  - До 10 км   → 180 руб.
  //  - 10-20 км   → 330 руб.
  //  - 20-30 км   → 440 руб.
  //  - 30+ км     → 660 руб.
  TARIFFS: [
    { maxDistance: 10, price: 180 },
    { maxDistance: 20, price: 330 },
    { maxDistance: 30, price: 440 },
    { maxDistance: Infinity, price: 660 },
  ],
};
