const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('./config');

class Database {
    constructor() {
        this.db = new sqlite3.Database(DB_PATH);
        this.sessionCache = new Map();
        this.initDatabase();
    }

    initDatabase() {
        this.db.serialize(() => {
            this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
                user_id INTEGER PRIMARY KEY,
                client_code TEXT,
                login TEXT,
                password TEXT,
                session_id TEXT,
                driver_name TEXT,
                step TEXT
            )`);
        });
    }

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
                sessionData.step
            ];

            this.db.run(query, params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async getSession(userId) {
        if (this.sessionCache.has(userId)) {
            return this.sessionCache.get(userId);
        }

        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM sessions WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                else {
                    if (row) this.sessionCache.set(userId, row);
                    resolve(row);
                }
            });
        });
    }

    async deleteSession(userId) {
        this.sessionCache.delete(userId);
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    close() {
        this.db.close();
    }
}

module.exports = new Database();
