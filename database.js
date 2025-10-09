const sqlite3 = require("sqlite3").verbose();
const { DB_PATH } = require("./config");

/**
 * Класс для работы с базой данных SQLite
 * Управляет сессиями пользователей и историей смен
 */
class Database {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
    this.sessionCache = new Map();
    this.initDatabase();
  }

  /**
   * Инициализирует таблицы базы данных
   */
  initDatabase() {
    this.db.serialize(() => {
      // Таблица сессий пользователей
      this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
                user_id INTEGER PRIMARY KEY,
                client_code TEXT,
                login TEXT,
                password TEXT,
                session_id TEXT,
                driver_name TEXT,
                step TEXT
            )`);

      // Таблица истории смен
      this.db.run(`CREATE TABLE IF NOT EXISTS shift_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                shift_date TEXT NOT NULL,
                total_orders INTEGER DEFAULT 0,
                completed_orders INTEGER DEFAULT 0,
                canceled_orders INTEGER DEFAULT 0,
                cash_amount REAL DEFAULT 0,
                non_cash_amount REAL DEFAULT 0,
                site_amount REAL DEFAULT 0,
                total_amount REAL DEFAULT 0,
                routes_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, shift_date)
            )`);
    });
  }

  /**
   * Сохраняет данные сессии пользователя
   * @param {number} userId - ID пользователя Telegram
   * @param {Object} sessionData - Данные сессии
   * @returns {Promise<void>}
   */
  async saveSession(userId, sessionData) {
    return new Promise((resolve, reject) => {
      this.sessionCache.set(userId, sessionData);

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
        sessionData.step,
      ];

      this.db.run(query, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Получает сессию пользователя
   * @param {number} userId - ID пользователя Telegram
   * @returns {Promise<Object|null>}
   */
  async getSession(userId) {
    if (this.sessionCache.has(userId)) {
      return this.sessionCache.get(userId);
    }

    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM sessions WHERE user_id = ?",
        [userId],
        (err, row) => {
          if (err) reject(err);
          else {
            if (row) this.sessionCache.set(userId, row);
            resolve(row);
          }
        },
      );
    });
  }

  /**
   * Удаляет сессию пользователя
   * @param {number} userId - ID пользователя Telegram
   * @returns {Promise<void>}
   */
  async deleteSession(userId) {
    this.sessionCache.delete(userId);
    return new Promise((resolve, reject) => {
      this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Сохраняет данные смены в историю
   * @param {number} userId - ID пользователя
   * @param {string} shiftDate - Дата смены в формате ДД.ММ.ГГГГ
   * @param {Object} shiftData - Данные смены
   * @returns {Promise<void>}
   */
  async saveShiftHistory(userId, shiftDate, shiftData) {
    return new Promise((resolve, reject) => {
      const query = `INSERT OR REPLACE INTO shift_history
                (user_id, shift_date, total_orders, completed_orders, canceled_orders,
                cash_amount, non_cash_amount, site_amount, total_amount, routes_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      const params = [
        userId,
        shiftDate,
        shiftData.totalOrders || 0,
        shiftData.completedOrders || 0,
        shiftData.canceledOrders || 0,
        shiftData.cashAmount || 0,
        shiftData.nonCashAmount || 0,
        shiftData.siteAmount || 0,
        shiftData.totalAmount || 0,
        shiftData.routesCount || 0,
      ];

      this.db.run(query, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Получает статистику за указанный месяц
   * @param {number} userId - ID пользователя
   * @param {number} month - Месяц (1-12)
   * @param {number} year - Год (например, 2024)
   * @returns {Promise<Object>}
   */
  async getMonthlyStats(userId, month, year) {
    return new Promise((resolve, reject) => {
      const query = `
                SELECT
                    COUNT(*) as shifts_count,
                    SUM(total_orders) as total_orders,
                    SUM(completed_orders) as completed_orders,
                    SUM(canceled_orders) as canceled_orders,
                    SUM(cash_amount) as cash_amount,
                    SUM(non_cash_amount) as non_cash_amount,
                    SUM(site_amount) as site_amount,
                    SUM(total_amount) as total_amount,
                    SUM(routes_count) as routes_count
                FROM shift_history
                WHERE user_id = ?
                AND substr(shift_date, 4, 2) = ?
                AND substr(shift_date, 7, 4) = ?
                AND routes_count > 0
            `;

      const monthStr = month.toString().padStart(2, "0");
      const yearStr = year.toString();

      this.db.get(query, [userId, monthStr, yearStr], (err, row) => {
        if (err) reject(err);
        else resolve(row || {});
      });
    });
  }

  /**
   * Получает список всех смен за указанный месяц
   * @param {number} userId - ID пользователя
   * @param {number} month - Месяц (1-12)
   * @param {number} year - Год
   * @returns {Promise<Array>}
   */
  async getMonthlyShifts(userId, month, year) {
    return new Promise((resolve, reject) => {
      const query = `
                SELECT * FROM shift_history
                WHERE user_id = ?
                AND substr(shift_date, 4, 2) = ?
                AND substr(shift_date, 7, 4) = ?
                ORDER BY shift_date
            `;

      const monthStr = month.toString().padStart(2, "0");
      const yearStr = year.toString();

      this.db.all(query, [userId, monthStr, yearStr], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Закрывает соединение с базой данных
   */
  close() {
    this.db.close();
  }
}

module.exports = new Database();
