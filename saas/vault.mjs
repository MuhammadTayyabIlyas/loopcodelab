// LoopCodeLab (single-tenant edition): no encrypted multi-user vault. Provider keys come from the
// environment / secrets.json in this edition. These stubs preserve the export surface.
export const generateMasterKey = () => '';
export const encrypt = (s) => s;
export const decrypt = (s) => s;
export const last4 = (s) => String(s || '').slice(-4);
export const vaultReady = () => false;
