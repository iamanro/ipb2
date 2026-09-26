/** The signed-in server playwright.config.js starts for cells.e2e.js. */
export const AUTH_PORT = 5191;
export const AUTH_BASE_URL = `http://localhost:${AUTH_PORT}`;
/** Bootstraps the first admin (IPB_ADMIN_PASSWORD), as a deployment does. */
export const AUTH_ADMIN_PASSWORD = 'e2e bootstrap password';
