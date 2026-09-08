/** Keep an adapter-owned final until its exact transport acknowledgement or recovery deadline. */
export const NATIVE_RETENTION_LUA = `
local function retain_native_response(key, now)
  local encoded = redis.call('HGET', key, 'nativeResponse')
  if not encoded then return false end
  local identity = cjson.decode(encoded)
  if tonumber(identity.recoverUntil or '0') <= now then return false end
  if redis.call('HGET', key, 'nativeResponseSettled') ~= '1' then return true end
  local policy = cjson.decode(redis.call('HGET', key, 'deliveryPolicy') or '{}')
  if policy.commit_authority ~= 'external_adapter' then return false end
  local ack = cjson.decode(redis.call('HGET', key, 'deliveryAcknowledgement') or '{}')
  return not (ack.state == 'committed' and ack.logical_turn_id == identity.logicalTurnId and
    tonumber(ack.revision) == tonumber(identity.revision))
end
`;

/* VIVENTIUM START: publication scripts touch only one Redis hash slot. */
export const NATIVE_PUBLICATION_LUA = `
local mode, identity, proof = ARGV[1], ARGV[2], ARGV[3]
local logical, revision, stream = ARGV[4], ARGV[5], ARGV[6]
local deadline, sequence, candidate = tonumber(ARGV[7]), ARGV[8], ARGV[9]
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if deadline <= now then return {'unavailable', ''} end
local state = redis.call('HGET', KEYS[3], 'state')
if state then
  if redis.call('HGET', KEYS[3], 'proof') ~= proof then return {'revoked', ''} end
  local bound = redis.call('HGET', KEYS[3], 'identity')
  if identity ~= '' and bound and bound ~= identity then return {'revoked', ''} end
  if state == 'committed' and mode ~= 'bind' then
    local winner = redis.call('HGET', KEYS[3], 'candidateSha256')
    if mode == 'commit' and winner ~= candidate then return {'revoked', ''} end
    return {'committed', winner}
  end
  if state == 'revoked' then return {'revoked', ''} end
end
if mode == 'read' then return {'unavailable', ''} end
if mode == 'revoke' or mode == 'cancel' then
  if not state and mode == 'revoke' then return {'unavailable', ''} end
  redis.call('HSET', KEYS[3], 'proof', proof, 'state', 'revoked')
  if not state then redis.call('PEXPIREAT', KEYS[3], deadline) end
  return {'revoked', ''}
end
if redis.call('HGET', KEYS[1], 'logicalTurnId') ~= logical or
   redis.call('HGET', KEYS[1], 'revision') ~= revision or
   redis.call('HGET', KEYS[1], 'currentStreamId') ~= stream or
   redis.call('HGET', KEYS[1], 'streamForRevision:' .. revision) ~= stream then
  return {'revoked', ''}
end
if sequence ~= '' and redis.call('HGET', KEYS[2], 'latestSourceSequence') ~= sequence then return {'revoked', ''} end
if mode == 'bind' then
  if not state and ARGV[10] ~= '1' then return {'unavailable', ''} end
  if not state then
    redis.call('HSET', KEYS[3], 'proof', proof, 'identity', identity, 'state', 'bound')
    redis.call('PEXPIREAT', KEYS[3], deadline)
  end
  for index = 1, 2 do
    local previous = tonumber(redis.call('HGET', KEYS[index], 'nativeRecoverUntil') or '0')
    if deadline > previous then redis.call('HSET', KEYS[index], 'nativeRecoverUntil', deadline) end
    if redis.call('PTTL', KEYS[index]) < deadline - now then redis.call('PEXPIREAT', KEYS[index], deadline) end
  end
  return {'bound', ''}
end
if mode == 'commit' and state == 'bound' then
  redis.call('HSET', KEYS[3], 'state', 'committed', 'candidateSha256', candidate)
  return {'committed', candidate}
end
return {'unavailable', ''}
`;

export const NATIVE_JOB_LUA = `
${NATIVE_RETENTION_LUA}
local mode, expected, identity = ARGV[1], cjson.decode(ARGV[2]), ARGV[3]
if redis.call('HGET', KEYS[1], 'createdAt') ~= tostring(expected.createdAt) or
   redis.call('HGET', KEYS[1], 'userId') ~= expected.userId or
   (redis.call('HGET', KEYS[1], 'responseMessageId') or '') ~= (expected.responseMessageId or '') or
   (redis.call('HGET', KEYS[1], 'conversationId') or '') ~= (expected.conversationId or '') then return 0 end
if mode == 'cancel' then
  redis.call('HSET', KEYS[1], 'nativeResponseCancelled', '1')
  return 1
end
local bound = redis.call('HGET', KEYS[1], 'nativeResponse')
if bound and bound ~= identity then return 0 end
local cancelled = redis.call('HGET', KEYS[1], 'nativeResponseCancelled') == '1'
if mode == 'finish-cancelled' or mode == 'settle-cancelled' then
  if not cancelled then return 0 end
elseif cancelled and mode ~= 'release' then return 0 end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local deadline = tonumber(ARGV[4])
if deadline <= now then return 0 end
if mode == 'release' then
  if redis.call('HGET', KEYS[1], 'nativeResponseFinished') == '1' or
     (redis.call('HGET', KEYS[1], 'interactionContext') or '') ~= ARGV[5] or
     (cjson.decode(redis.call('HGET', KEYS[1], 'userMessage') or '{}').messageId or '') ~= ARGV[6] then return 0 end
  if not bound then return 1 end
  redis.call('HDEL', KEYS[1], 'nativeResponse', 'nativeResponseCancelled', 'nativeRecoverUntil')
  redis.call('EXPIRE', KEYS[1], redis.call('HGET', KEYS[1], 'status') == 'running' and tonumber(ARGV[7]) or tonumber(ARGV[8]))
  return 1
end
if mode == 'bind' then
  if not bound and redis.call('HGET', KEYS[1], 'status') ~= 'running' then return 0 end
  if (redis.call('HGET', KEYS[1], 'interactionContext') or '') ~= ARGV[5] or
     (cjson.decode(redis.call('HGET', KEYS[1], 'userMessage') or '{}').messageId or '') ~= ARGV[6] then return 0 end
  redis.call('HSET', KEYS[1], 'nativeResponse', identity, 'nativeRecoverUntil', deadline)
  redis.call('PEXPIREAT', KEYS[1], deadline)
  return 1
end
if not bound then return 0 end
if mode == 'settle' or mode == 'settle-cancelled' then
  if redis.call('HGET', KEYS[1], 'nativeResponseFinished') ~= '1' then return 0 end
  if redis.call('HGET', KEYS[1], 'nativeResponseSettled') == '1' then return 1 end
  redis.call('HSET', KEYS[1], 'nativeResponseSettled', '1')
  redis.call('PEXPIREAT', KEYS[1], retain_native_response(KEYS[1], now) and deadline or math.min(deadline, now + tonumber(ARGV[6]) * 1000))
  return 1
end
if mode == 'finish' or mode == 'finish-cancelled' then
  if redis.call('HGET', KEYS[1], 'nativeResponseFinished') == '1' then
    if redis.call('HGET', KEYS[1], 'finalEvent') == ARGV[5] then return 1 else return 0 end
  end
  redis.call('HSET', KEYS[1], 'nativeResponseFinished', '1', 'generationCompleted', '1',
    'status', mode == 'finish-cancelled' and 'aborted' or 'complete', 'completedAt', now, 'finalEvent', ARGV[5])
  redis.call('HDEL', KEYS[1], 'error')
  return 1
end
return 1
`;

/** A retired/replaced job cannot publish an event already read by another host. */
export const NATIVE_REPLAY_PUBLISH_LUA = `
if redis.call('HGET', KEYS[1], 'nativeResponse') ~= ARGV[1] or
   (redis.call('HGET', KEYS[1], 'nativeResponseCancelled') == '1') ~= (ARGV[5] == 'cancelled') or
   redis.call('HGET', KEYS[1], 'nativeResponseFinished') ~= '1' or
   redis.call('HGET', KEYS[1], 'finalEvent') ~= ARGV[2] then return 0 end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if tonumber(redis.call('HGET', KEYS[1], 'nativeRecoverUntil') or '0') <= now then return 0 end
redis.call('PUBLISH', ARGV[3], ARGV[4])
return 1
`;
/* VIVENTIUM END */
