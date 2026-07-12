// LoopCodeLab (single-tenant edition): no multi-user auth. Access control is handled in front
// (for example nginx basic-auth), so requireAuth is a passthrough and signup/login are disabled.
export const COOKIE_NAME = 'wt_session';
export const hashPassword = (pw) => String(pw);
export const verifyPassword = () => false;
export const issueSession = () => {};
export const clearSession = () => {};
export const currentAuth = () => null;
export const requireAuth = (_req, _res, next) => next();
export const signup = () => { throw new Error('signup is disabled in the single-tenant edition'); };
export const login = () => { throw new Error('login is disabled in the single-tenant edition'); };
