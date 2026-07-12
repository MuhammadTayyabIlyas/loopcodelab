// LoopCodeLab (single-tenant edition): the multi-user control store is disabled.
// Every function is a safe no-op that preserves the export surface so server imports resolve.
// Single-tenant paths never call these (they are gated behind a `tenant` object, null here, and
// wrapped in try/catch); a stray call just gets a safe default.
const nil = () => null; const arr = () => []; const obj = () => ({}); const noop = () => {};
export const createUser = nil, getUserById = nil, getUserByEmail = nil, getUserByGithubId = nil, deleteUser = noop;
export const createSession = nil, getSession = nil, deleteSession = noop;
export const createWorkspace = nil, getWorkspaceById = nil, getWorkspaceBySlug = nil, getWorkspacesForUser = arr, setWorkspaceUnixUser = noop;
export const getWorkspaceStripeCustomer = nil, setWorkspaceStripeCustomer = noop, getWorkspaceByStripeCustomer = nil;
export const setProviderKey = noop, getProviderKey = nil, listProviderKeys = arr, deleteProviderKey = noop;
export const getPrefs = nil, setPrefs = noop;
export const listFacts = arr, replaceFacts = noop, deleteFact = noop, clearFacts = noop;
export const listDrafts = arr, saveDraft = noop, deleteDraft = noop, listAllDueDrafts = arr;
export const listProvisionedWorkspaces = arr;
export const getTracking = nil, setTracking = noop;
export const addMcpServer = nil, listMcpServers = arr, deleteMcpServer = noop, mcpServersForBuild = arr;
export const upsertProject = noop, listProjects = arr, getProjectByPreviewLabel = nil;
export const recordUsage = noop, countUsageSince = () => 0, usageSummary = obj;
export const getSubscription = nil, upsertSubscription = noop;
export const createInvite = nil, getInvite = nil, consumeInvite = nil, listInvites = arr, deleteInvite = noop;
export const setUserStatus = noop, listUsers = arr;
