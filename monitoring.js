const keyboards = require('./keyboards');

class MonitoringService {
    constructor() {
        this.activeMonitoring = new Map();
        this.lastKnownOrders = new Map();
    }

    shouldStopMonitoring() {
        const currentHour = new Date().getHours();
        return currentHour >= 23;
    }

    startMonitoring(userId, sessionId, checkFunction, interval) {
        if (this.activeMonitoring.has(userId)) {
            return false;
        }

        const intervalId = setInterval(async () => {
            if (this.shouldStopMonitoring()) {
                this.stopMonitoring(userId);
                try {
                    const bot = require('./pd').bot;
                    await bot.telegram.sendMessage(
                        userId, 
                        '🔴 Мониторинг автоматически остановлен (23:00)',
                        keyboards.getMainKeyboard(false) // Обновляем клавиатуру
                    );
                } catch (error) {
                    console.error('Error sending monitoring stop notification:', error);
                }
                return;
            }
            checkFunction(userId, sessionId);
        }, interval);

        this.activeMonitoring.set(userId, intervalId);
        return true;
    }

    stopMonitoring(userId) {
        const intervalId = this.activeMonitoring.get(userId);
        if (intervalId) {
            clearInterval(intervalId);
            this.activeMonitoring.delete(userId);
            this.lastKnownOrders.delete(userId);
            return true;
        }
        return false;
    }

    isMonitoringActive(userId) {
        return this.activeMonitoring.has(userId);
    }

    updateLastKnownOrders(userId, orders) {
        this.lastKnownOrders.set(userId, orders);
    }

    getLastKnownOrders(userId) {
        return this.lastKnownOrders.get(userId) || new Set();
    }
}

module.exports = new MonitoringService();