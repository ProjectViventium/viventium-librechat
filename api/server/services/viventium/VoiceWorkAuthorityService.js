/* === VIVENTIUM START === Recheck trusted voice authority immediately before work dispatch. === VIVENTIUM END === */
const { createVoiceEngagementAuthorityService } = require('@librechat/api');
const { getCallSession, verifyVoiceEngagementAttestation } = require('./CallSessionService');
const { listSpeakerSegments, voiceTurnAuthority } = require('./SpeakerSegmentService');

const { assertVoiceWorkAuthority } = createVoiceEngagementAuthorityService({
  getCallSession, listSpeakerSegments, voiceTurnAuthority, verifyVoiceEngagementAttestation,
});

module.exports = { assertVoiceWorkAuthority };
