const { logger } = require('@librechat/data-schemas');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { setAuthTokens } = require('~/server/services/AuthService');
/* === VIVENTIUM START ===
 * Feature: Registration approval message passthrough.
 * === VIVENTIUM END === */
const {
  APPROVAL_ERROR_CODE,
  PENDING_APPROVAL_MESSAGE,
} = require('~/server/services/viventium/registrationApprovalService');

const loginController = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (req.user.twoFactorEnabled) {
      const tempToken = generate2FATempToken(req.user._id);
      return res.status(200).json({ twoFAPending: true, tempToken });
    }

    const { password: _p, totpSecret: _t, __v, ...user } = req.user;
    user.id = user._id.toString();

    const token = await setAuthTokens(req.user._id, res);

    return res.status(200).send({ token, user });
  } catch (err) {
    if (err?.code === APPROVAL_ERROR_CODE) {
      return res.status(403).json({ message: PENDING_APPROVAL_MESSAGE });
    }
    logger.error('[loginController]', err);
    return res.status(500).json({ message: 'Something went wrong' });
  }
};

module.exports = {
  loginController,
};
