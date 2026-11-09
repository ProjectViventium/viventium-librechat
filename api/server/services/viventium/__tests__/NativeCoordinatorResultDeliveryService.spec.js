let mockDependencies;
const mockProject = jest.fn(async input => input.roster);
const mockQuery = () => ({ select: jest.fn().mockReturnThis(), lean: jest.fn(async () => []) });
const mockMessageQuery = mockQuery(); const mockRowQuery = mockQuery();
const mockMessages = { find: jest.fn(() => mockMessageQuery) };
const mockRows = { find: jest.fn(() => mockRowQuery) };
const mockSourceFind = jest.fn(() => ({ toArray: async () => [] }));
const mockRequest = jest.fn();
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));
jest.mock('@librechat/api', () => ({ createNativeCoordinatorResultDeliveryProjection: deps => { mockDependencies = deps; return (...args) => mockProject(...args); } }));
jest.mock('mongoose', () => ({ connection: { collection: () => ({ find: (...args) => mockSourceFind(...args) }) } }));
jest.mock('~/db/models', () => ({ Message: mockMessages, ViventiumCortexInsightDelivery: mockRows }));
jest.mock('../GlassHiveAccountService', () => ({ requestAccountApi: (...args) => mockRequest(...args) }));
const project = require('../NativeCoordinatorResultDeliveryService');
const target = { binding: { _id: 'binding', conversationId: 'core', nativeConversationId: 'native' }, goal: { goal_id: 'goal', run_id: 'run', source_turn_id: 'source', result_revision: 2 } };
beforeEach(() => jest.clearAllMocks());
test('batches Main reads with exact owner/current Native source tuple', async () => {
 await mockDependencies.readMessages('owner', [target]);
 expect(mockMessages.find).toHaveBeenCalledWith(expect.objectContaining({ user: 'owner', isCreatedByUser: false, $or: [expect.objectContaining({ conversationId: 'core',
  'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.bindingRef': 'binding',
  'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.goalId': 'goal',
  'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.runId': 'run',
  'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.resultRevision': 2,
  'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.sourceTurnId': 'source' })] }));
});
test('reads exact accepted source and owner/delivery-scoped private proof', async () => {
 await mockDependencies.readSources('owner', [target]);
 expect(mockSourceFind).toHaveBeenCalledWith({ kind: 'native_coordinator_source', $or: [{ _id: 'binding:source', bindingRef: 'binding', turnId: 'source' }] });
 await mockDependencies.readRows('owner', ['delivery']);
 expect(mockRows.find).toHaveBeenCalledWith({ userId: 'owner', deliveryId: { $in: ['delivery'] } });
 expect(mockRowQuery.select).toHaveBeenCalledWith(expect.stringContaining('+insight +events'));
 expect(mockRowQuery.select).toHaveBeenCalledWith(expect.stringContaining('presentationReceiptHashes'));
});
test('uses a one-character exact-run result read', async () => {
 await mockDependencies.readResult('owner', 'native', 'goal', 'run');
 expect(mockRequest).toHaveBeenCalledWith({ ownerId: 'owner', path: '/v1/coordinator/conversations/native/goals/goal/result?run_id=run&offset=0&max_chars=1' });
});
test('preserves roster when receipt projection is unavailable', async () => {
 const input = { roster: { work: [{ workRef: 'retained' }], cursor: 'kept' } }; mockProject.mockRejectedValueOnce(new Error('unavailable'));
 expect(await project(input)).toBe(input.roster);
});
