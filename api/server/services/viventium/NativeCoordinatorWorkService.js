/* === VIVENTIUM START === Thin owner-scoped bindings for ordinary Native-managed work requests. === */
const { createNativeCoordinatorWorkRequestAdapter } = require('@librechat/api');

const adapter = createNativeCoordinatorWorkRequestAdapter({
  tenantId: () => process.env.VIVENTIUM_TENANT_ID || 'local',
  snapshots: async (ownerId) => ({
    snapshot: 'fresh',
    snapshots: await require('./NativeCoordinatorService').snapshots(ownerId),
  }),
  request: (input) => require('./GlassHiveAccountService').requestAccountApi(input),
  prepareAction: (input) =>
    require('./NativeCoordinatorContextService').prepareNativeCoordinatorWorkAction(input),
});

module.exports = {
  requestNativeCoordinatorWork: adapter.request,
  resolveNativeCoordinatorWorkIdentity: adapter.resolve,
};
/* === VIVENTIUM END === */
