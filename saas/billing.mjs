// LoopCodeLab (single-tenant edition): no billing. Self-hosted and free.
export const billingReady = () => false;
export const createCheckoutSession = () => { throw new Error('billing is disabled in the single-tenant edition'); };
export const createPortalSession = () => { throw new Error('billing is disabled in the single-tenant edition'); };
export const handleWebhook = () => {};
