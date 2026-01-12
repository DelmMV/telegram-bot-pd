const axios = require('axios');
const config = require('./config');

const api = axios.create({
    baseURL: config.API_URL,
    timeout: config.API_TIMEOUT_MS
});

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ENETUNREACH'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRetryDelay = (attempt) => {
    const baseDelay = config.API_RETRY_BASE_DELAY_MS;
    const maxDelay = config.API_RETRY_MAX_DELAY_MS;
    // Экспоненциальный бекофф с jitter (рандомизация)
    const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
    const jitter = Math.random() * 0.3 * delay; // 0-30% jitter
    return Math.floor(delay + jitter);
};

const isRetryableError = (error) => {
    const status = error?.response?.status;
    if (status && RETRYABLE_STATUS.has(status)) return true;
    const code = error?.code;
    return code && RETRYABLE_CODES.has(code);
};

async function postWithRetry(payload) {
    const maxAttempts = Math.max(1, config.API_RETRY_ATTEMPTS);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await api.post('', payload);
        } catch (error) {
            const isLastAttempt = attempt >= maxAttempts;
            if (isLastAttempt || !isRetryableError(error)) {
                throw error;
            }
            const delay = getRetryDelay(attempt);
            console.warn(
                `API request failed (attempt ${attempt}), retrying in ${delay}ms`,
                error.code || error.message
            );
            await sleep(delay);
        }
    }
}

class ApiService {
    isSessionExpired(response) {
        return response?.TL_Mobile_EnumRoutesResponse?.ErrorCode === 'Exception' &&
               response?.TL_Mobile_EnumRoutesResponse?.ErrorDescription === 'SessionNotFound';
    }

    async authenticate(clientCode, login, password) {
        try {
            const response = await postWithRetry({
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

    async refreshSession(credentials) {
        try {
            const authResponse = await this.authenticate(
                credentials.clientCode,
                credentials.login,
                credentials.password
            );
            
            return authResponse.TL_Mobile_LoginResponse.SessionId;
        } catch (error) {
            console.error('Session refresh error:', error);
            throw error;
        }
    }

    async getRoutes(sessionId, date, credentials) {
        try {
            const response = await postWithRetry({
                TL_Mobile_EnumRoutesRequest: {
                    Date: date,
                    SessionId: sessionId
                }
            });

            if (this.isSessionExpired(response.data)) {
                if (!credentials) {
                    throw new Error('Session expired and no credentials provided');
                }

                // Получаем новую сессию
                const newSessionId = await this.refreshSession(credentials);
                
                // Повторяем запрос с новым sessionId
                const newResponse = await postWithRetry({
                    TL_Mobile_EnumRoutesRequest: {
                        Date: date,
                        SessionId: newSessionId
                    }
                });

                return {
                    data: newResponse.data,
                    newSessionId,
                    sessionUpdated: true
                };
            }

            return {
                data: response.data,
                sessionUpdated: false
            };
        } catch (error) {
            console.error('Error getting routes:', error);
            throw {
                isSessionExpired: this.isSessionExpired(error?.response?.data),
                originalError: error
            };
        }
    }

    async getRouteDetails(sessionId, routeIds, credentials) {
        try {
            const response = await postWithRetry({
                TL_Mobile_GetRoutesRequest: {
                    Routes: routeIds,
                    SessionId: sessionId,
                    WithTrackPoints: true
                }
            });

            if (this.isSessionExpired(response.data)) {
                if (!credentials) {
                    throw new Error('Session expired and no credentials provided');
                }

                const newSessionId = await this.refreshSession(credentials);
                
                const newResponse = await postWithRetry({
                    TL_Mobile_GetRoutesRequest: {
                        Routes: routeIds,
                        SessionId: newSessionId,
                        WithTrackPoints: true
                    }
                });

                return {
                    data: newResponse.data,
                    newSessionId,
                    sessionUpdated: true
                };
            }

            return {
                data: response.data,
                sessionUpdated: false
            };
        } catch (error) {
            console.error('Error getting route details:', error);
            throw {
                isSessionExpired: this.isSessionExpired(error?.response?.data),
                originalError: error
            };
        }
    }
    
    async getOrderDetails(sessionId, orderIds, credentials) {
        try {
            const response = await postWithRetry({
                TL_Mobile_GetOrdersRequest: {
                    Orders: orderIds,
                    SessionId: sessionId
                }
            });
    
            if (this.isSessionExpired(response.data)) {
                if (!credentials) {
                    throw new Error('Session expired and no credentials provided');
                }
    
                const newSessionId = await this.refreshSession(credentials);
                
                const newResponse = await postWithRetry({
                    TL_Mobile_GetOrdersRequest: {
                        Orders: orderIds,
                        SessionId: newSessionId
                    }
                });
    
                return {
                    data: newResponse.data,
                    newSessionId,
                    sessionUpdated: true
                };
            }
    
            return {
                data: response.data,
                sessionUpdated: false
            };
        } catch (error) {
            console.error('Error getting order details:', error);
            throw {
                isSessionExpired: this.isSessionExpired(error?.response?.data),
                originalError: error
            };
        }
    }
}


module.exports = new ApiService();