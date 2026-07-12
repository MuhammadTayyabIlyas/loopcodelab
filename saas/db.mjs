// LoopCodeLab (single-tenant edition): no control database. Inert stubs so imports resolve.
// The full product stores multi-user state in a SQLite control.db; this edition is single-user.
export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const now = () => Date.now();
export const openDb = () => null;
export const db = () => { throw new Error('control DB is disabled in the single-tenant edition'); };
