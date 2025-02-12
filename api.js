const axios = require('axios');
const { API_URL } = require('./config');

const api = axios.create({
    baseURL: API_URL,
    timeout: 5000
});

class ApiService {
    isSessionExpired(response) {
        return response?.TL_Mobile_EnumRoutesResponse?.ErrorCode === 'Exception' &&
               response?.TL_Mobile_EnumRoutesResponse?.ErrorDescription === 'SessionNotFound';
    }

    async authenticate(clientCode, login, password) {
        try {
            const response = await api.post('', {
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
            const response = await api.post('', {
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
                const newResponse = await api.post('', {
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
            const response = await api.post('', {
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
                
                const newResponse = await api.post('', {
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
}

module.exports = new ApiService();