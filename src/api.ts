import axios from 'axios';

// Base API instance configured with the JPassbolt backend URL.
// NOTE: 8080 is currently occupied by the unrelated "firewatch-platform-api"
// container, so the email-enabled JPassbolt backend runs on 8090 (local profile,
// MailHog). Override via VITE_API_BASE_URL; revert to 8080 once it is free.
export const api = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8090/api',
    headers: {
        'Content-Type': 'application/json',
    },
});

// Interceptor to add JWT token to all requests if authenticated
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('jpassbolt_jwt');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
}, (error) => {
    return Promise.reject(error);
});

// Interceptor to handle global API errors
api.interceptors.response.use(
    (response) => response,
    (error) => {
        // Check if the error matches the Passbolt standard format
        const passboltError = error.response?.data?.header?.message;
        if (passboltError) {
            console.error('Passbolt API Error:', passboltError);
        }

        // Redirect to login if unauthorized and we're not already on the login page
        if (error.response?.status === 401 && window.location.pathname !== '/login') {
            // Clear ALL credentials + key material so a session expiry never leaves the
            // passphrase-protected private key orphaned at rest (parity with logout()).
            localStorage.removeItem('jpassbolt_jwt');
            localStorage.removeItem('jpassbolt_user');
            localStorage.removeItem('jpassbolt_private_key_armored');
            localStorage.removeItem('jpassbolt_public_key_armored');
            window.location.href = '/login';
        }

        return Promise.reject(error);
    }
);
