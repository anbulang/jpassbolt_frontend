import axios from 'axios';
import { clearCachedPassphrase } from './crypto/passphraseCache';

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

        // Recover from a DEAD SESSION (expired token, or — common in local dev — a JWT
        // signed by a previous backend run's ephemeral RS256 key after a restart).
        //
        // The backend returns 401 for an expired token in some paths, but an
        // invalid/unverifiable token is silently dropped by JwtAuthenticationFilter →
        // the request proceeds anonymously → Spring Security answers with a BARE 403
        // (the @ControllerAdvice envelope does not wrap security-filter errors). Since
        // every authenticated user passes `.anyRequest().authenticated()` and real
        // authorization failures come from controllers WITH an envelope, a 403 carrying
        // NO Passbolt `header` envelope reliably means "not authenticated" = dead session.
        // We treat both 401 and that bare-403 as a dead session. (An MFA-required 403
        // carries a `body.mfa_providers` list and must NOT be treated as dead.)
        const status = error.response?.status;
        const data = error.response?.data;
        const hasEnvelope = !!(data && typeof data === 'object' && 'header' in data);
        const isMfaRequired = Array.isArray(data?.body?.mfa_providers)
            && data.body.mfa_providers.length > 0;
        const deadSession =
            status === 401 || (status === 403 && !hasEnvelope && !isMfaRequired);

        if (deadSession && window.location.pathname !== '/login') {
            // Clear the dead session token, the user blob, and the cached passphrase.
            // KEEP the passphrase-PROTECTED armored keys: an expired session is not a
            // logout, so re-login only needs the passphrase (Login pre-fills the key
            // from localStorage), never a re-paste of the key. logout() still wipes them.
            localStorage.removeItem('jpassbolt_jwt');
            localStorage.removeItem('jpassbolt_user');
            clearCachedPassphrase();
            window.location.href = '/login';
        }

        return Promise.reject(error);
    }
);
