const axios = require('axios');
const { API_URL } = require('./config');

const api = axios.create({
    baseURL: API_URL,
    timeout: 5000
});

class ApiService {
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
    
    async getRouteDetails(sessionId, routeIds) {
        try {
            const response = await api.post('', {
                TL_Mobile_GetRoutesRequest: {
                    Routes: routeIds,
                    SessionId: sessionId,
                    WithTrackPoints: true
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error getting route details:', error);
            throw error;
        }
    }

    async getRoutes(sessionId, date) {
        try {
            const response = await api.post('', {
                TL_Mobile_EnumRoutesRequest: {
                    Date: date,
                    SessionId: sessionId
                }
            });
            return response.data;
        } catch (error) {
            console.error('Error getting routes:', error);
            throw error;
        }
    }
}

module.exports = new ApiService();