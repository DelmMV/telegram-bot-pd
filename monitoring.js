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

        const safeInterval = Number.isFinite(interval) ? interval : 60000;
        const monitoringState = { intervalId: null, isRunning: false };

        const runCheck = async () => {
            if (this.shouldStopMonitoring()) {
                this.stopMonitoring(userId);
                try {
                    const bot = require('./pd').bot;
                    await bot.telegram.sendMessage(
                        userId,
                        '🔴 Мониторинг автоматически остановлен',
                        keyboards.getMainKeyboard(false)
                    );
                } catch (error) {
                    console.error('Error sending monitoring stop notification:', error);
                }
                return;
            }

            if (monitoringState.isRunning) {
                return;
            }

            monitoringState.isRunning = true;
            try {
                await checkFunction(userId, sessionId);
            } catch (error) {
                console.error('Error during monitoring check:', error);
            } finally {
                monitoringState.isRunning = false;
            }
        };

        monitoringState.intervalId = setInterval(runCheck, safeInterval);
        this.activeMonitoring.set(userId, monitoringState);
        return true;
    }

    stopMonitoring(userId) {
        const monitoringState = this.activeMonitoring.get(userId);
        if (monitoringState?.intervalId) {
            clearInterval(monitoringState.intervalId);
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