// LoopCodeLab (single-tenant edition): no plan limits. Self-hosted runs are unrestricted.
export const DEFAULT_PLAN = { key: 'self-hosted', name: 'Self-hosted', maxConcurrentRuns: 99, maxProjects: 9999 };
export const PLANS = { 'self-hosted': DEFAULT_PLAN };
export const planFor = () => DEFAULT_PLAN;
export const canStartRun = () => ({ ok: true, plan: DEFAULT_PLAN });
