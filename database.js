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
                step TEXT,
                tg_session TEXT,
                tg_order_channel_id TEXT,
                tg_order_channel_access_hash TEXT,
                tg_order_channel_title TEXT,
                tg_order_channel_enabled INTEGER DEFAULT 0,
                tg_report_channel_id TEXT,
                tg_report_channel_access_hash TEXT,
                tg_report_channel_title TEXT,
                tg_report_channel_enabled INTEGER DEFAULT 0
            )`);

      // Добавляем недостающие колонки (для старых баз)
      this.db.all("PRAGMA table_info(sessions)", (err, rows) => {
        if (err) {
          console.error("Error reading sessions table info:", err);
          return;
        }
        const columns = new Set(rows.map((row) => row.name));
        const addColumnIfMissing = (name, type) => {
          if (!columns.has(name)) {
            this.db.run(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
          }
        };

        addColumnIfMissing("tg_session", "TEXT");
        addColumnIfMissing("tg_order_channel_id", "TEXT");
        addColumnIfMissing("tg_order_channel_access_hash", "TEXT");
        addColumnIfMissing("tg_order_channel_title", "TEXT");
        addColumnIfMissing("tg_order_channel_enabled", "INTEGER DEFAULT 0");
        addColumnIfMissing("tg_report_channel_id", "TEXT");
        addColumnIfMissing("tg_report_channel_access_hash", "TEXT");
        addColumnIfMissing("tg_report_channel_title", "TEXT");
        addColumnIfMissing("tg_report_channel_enabled", "INTEGER DEFAULT 0");
      });

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

      // Таблица статусов заказов для отслеживания изменений оплаты
      this.db.run(`CREATE TABLE IF NOT EXISTS order_statuses (
                user_id INTEGER NOT NULL,
                order_id TEXT NOT NULL,
                status_id TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, order_id)
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
      const cached = this.sessionCache.get(userId) || {};
      const resolvedSession = {
        ...cached,
        ...sessionData,
      };

      const resolveField = (field) =>
        sessionData[field] === undefined ? cached[field] : sessionData[field];

      resolvedSession.tg_session = resolveField("tg_session");
      resolvedSession.tg_order_channel_id = resolveField("tg_order_channel_id");
      resolvedSession.tg_order_channel_access_hash = resolveField(
        "tg_order_channel_access_hash",
      );
      resolvedSession.tg_order_channel_title = resolveField(
        "tg_order_channel_title",
      );
      resolvedSession.tg_order_channel_enabled = resolveField(
        "tg_order_channel_enabled",
      );
      resolvedSession.tg_report_channel_id = resolveField("tg_report_channel_id");
      resolvedSession.tg_report_channel_access_hash = resolveField(
        "tg_report_channel_access_hash",
      );
      resolvedSession.tg_report_channel_title = resolveField(
        "tg_report_channel_title",
      );
      resolvedSession.tg_report_channel_enabled = resolveField(
        "tg_report_channel_enabled",
      );

      this.sessionCache.set(userId, resolvedSession);

      const query = `INSERT OR REPLACE INTO sessions
                (user_id, client_code, login, password, session_id, driver_name, step,
                tg_session,
                tg_order_channel_id, tg_order_channel_access_hash, tg_order_channel_title, tg_order_channel_enabled,
                tg_report_channel_id, tg_report_channel_access_hash, tg_report_channel_title, tg_report_channel_enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      const params = [
        userId,
        resolvedSession.client_code,
        resolvedSession.login,
        resolvedSession.password,
        resolvedSession.session_id,
        resolvedSession.driver_name,
        resolvedSession.step,
        resolvedSession.tg_session,
        resolvedSession.tg_order_channel_id,
        resolvedSession.tg_order_channel_access_hash,
        resolvedSession.tg_order_channel_title,
        resolvedSession.tg_order_channel_enabled || 0,
        resolvedSession.tg_report_channel_id,
        resolvedSession.tg_report_channel_access_hash,
        resolvedSession.tg_report_channel_title,
        resolvedSession.tg_report_channel_enabled || 0,
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
   * Получает список всех ID пользователей
   * @returns {Promise<number[]>}
   */
  async getAllUserIds() {
    return new Promise((resolve, reject) => {
      this.db.all("SELECT user_id FROM sessions", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map((row) => row.user_id));
      });
    });
  }

  /**
   * Удаляет сессию пользователя
   * @param {number} userId - ID пользователя
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
   * Получает последний статус заказа
   * @param {number} userId - ID пользователя
   * @param {string} orderId - ID заказа
   * @returns {Promise<string|null>}
   */
  async getOrderStatus(userId, orderId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT status_id FROM order_statuses WHERE user_id = ? AND order_id = ?",
        [userId, orderId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row?.status_id || null);
        },
      );
    });
  }

  /**
   * Сохраняет статус заказа
   * @param {number} userId - ID пользователя
   * @param {string} orderId - ID заказа
   * @param {string} statusId - ID статуса
   * @returns {Promise<void>}
   */
  async saveOrderStatus(userId, orderId, statusId) {
    return new Promise((resolve, reject) => {
      const query = `INSERT OR REPLACE INTO order_statuses
        (user_id, order_id, status_id, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)`;
      this.db.run(query, [userId, orderId, statusId], (err) => {
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
