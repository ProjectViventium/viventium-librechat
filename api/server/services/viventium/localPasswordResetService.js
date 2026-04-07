/* === VIVENTIUM START ===
 * Feature: Operator-issued password reset links that do not require the public reset endpoint.
 * === VIVENTIUM END === */

const bcrypt = require('bcryptjs');
const { webcrypto } = require('node:crypto');
const { findUser, findToken, createToken, deleteTokens, updateUser } = require('~/models');

const LOCAL_PASSWORD_RESET_IDENTIFIER_PREFIX = 'viventium_local_password_reset:';
const LOCAL_PASSWORD_RESET_EXPIRES_SECONDS = 900;

function createTokenHash() {
  const token = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const hash = bcrypt.hashSync(token, 10);
  return [token, hash];
}

function buildLocalPasswordResetIdentifier(userId) {
  return `${LOCAL_PASSWORD_RESET_IDENTIFIER_PREFIX}${String(userId)}`;
}

async function issueLocalPasswordResetLink({ email, clientOrigin }) {
  const normalizedEmail = String(email || '').trim();
  const normalizedClientOrigin = String(clientOrigin || '').trim().replace(/\/$/, '');
  if (!normalizedEmail) {
    throw new Error('email is required');
  }
  if (!normalizedClientOrigin) {
    throw new Error('clientOrigin is required');
  }

  const user = await findUser({ email: normalizedEmail }, 'email _id name username');
  if (!user) {
    throw new Error(`No user exists for ${normalizedEmail}`);
  }

  const identifier = buildLocalPasswordResetIdentifier(user._id);
  await deleteTokens({ identifier });

  const [resetToken, hash] = createTokenHash();
  await createToken({
    userId: user._id,
    identifier,
    type: 'viventium_local_password_reset',
    token: hash,
    metadata: {
      purpose: 'viventium_local_password_reset',
    },
    expiresIn: LOCAL_PASSWORD_RESET_EXPIRES_SECONDS,
  });

  return {
    email: user.email,
    link: `${normalizedClientOrigin}/api/viventium/auth/password-reset?token=${resetToken}&userId=${user._id}`,
    expiresInSeconds: LOCAL_PASSWORD_RESET_EXPIRES_SECONDS,
  };
}

async function consumeLocalPasswordReset({ userId, token, password }) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedToken = String(token || '').trim();
  const normalizedPassword = String(password || '');
  if (!normalizedUserId || !normalizedToken || !normalizedPassword) {
    throw new Error('userId, token, and password are required');
  }

  const identifier = buildLocalPasswordResetIdentifier(normalizedUserId);
  const passwordResetToken = await findToken(
    {
      userId: normalizedUserId,
      identifier,
    },
    { sort: { createdAt: -1 } },
  );

  if (!passwordResetToken) {
    throw new Error('Invalid or expired password reset token');
  }

  const isValid = bcrypt.compareSync(normalizedToken, passwordResetToken.token);
  if (!isValid) {
    throw new Error('Invalid or expired password reset token');
  }

  const passwordHash = bcrypt.hashSync(normalizedPassword, 10);
  await updateUser(normalizedUserId, {
    password: passwordHash,
    passwordVersion: Date.now(),
  });
  await deleteTokens({ identifier });

  return { message: 'Password reset was successful' };
}

module.exports = {
  LOCAL_PASSWORD_RESET_EXPIRES_SECONDS,
  buildLocalPasswordResetIdentifier,
  issueLocalPasswordResetLink,
  consumeLocalPasswordReset,
};
