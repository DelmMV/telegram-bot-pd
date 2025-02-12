class MonitoringService {
    constructor() {
        this.activeMonitoring = new Map();
        this.lastKnownOrders = new Map();
    }

    startMonitoring(userId, sessionId, checkFunction, interval) {
        if (this.activeMonitoring.has(userId)) {
            return false;
        }

        const intervalId = setInterval(() => checkFunction(userId, sessionId), interval);
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