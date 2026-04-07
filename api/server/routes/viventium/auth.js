/* === VIVENTIUM START ===
 * Feature: Operator-issued password reset links that do not require the public reset endpoint.
 * === VIVENTIUM END === */

const express = require('express');
const {
  consumeLocalPasswordReset,
} = require('~/server/services/viventium/localPasswordResetService');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage({ title, message, form, status = 200, loginUrl = '' }) {
  const loginLink = loginUrl
    ? `<p><a href="${escapeHtml(loginUrl)}">Return to sign in</a></p>`
    : '';
  const body = form
    ? `${message}
      <form method="POST">
        <input type="hidden" name="token" value="${escapeHtml(form.token)}" />
        <input type="hidden" name="userId" value="${escapeHtml(form.userId)}" />
        <label>
          New password
          <input type="password" name="password" minlength="8" required />
        </label>
        <label>
          Confirm password
          <input type="password" name="confirm_password" minlength="8" required />
        </label>
        <button type="submit">Update password</button>
      </form>`
    : `${message}${loginLink}`;

  return {
    status,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: sans-serif; background: #f7f7f5; color: #1f1f1a; margin: 0; padding: 32px 16px; }
      main { max-width: 420px; margin: 0 auto; background: white; border-radius: 16px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,.08); }
      h1 { margin-top: 0; font-size: 1.5rem; }
      p { line-height: 1.5; }
      form { display: grid; gap: 14px; margin-top: 20px; }
      label { display: grid; gap: 6px; font-weight: 600; }
      input, button { font: inherit; padding: 12px 14px; border-radius: 12px; }
      input { border: 1px solid #d0d0c8; }
      button { border: none; background: #14532d; color: white; font-weight: 700; cursor: pointer; }
      a { color: #14532d; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </main>
  </body>
</html>`,
  };
}

router.get('/password-reset', (req, res) => {
  const token = String(req.query.token || '').trim();
  const userId = String(req.query.userId || '').trim();
  if (!token || !userId) {
    const page = renderPage({
      title: 'Password reset link is incomplete',
      message: '<p>This reset link is missing required information.</p>',
      status: 400,
      loginUrl: `${String(process.env.DOMAIN_CLIENT || '').replace(/\/$/, '')}/login`,
    });
    return res.status(page.status).type('html').send(page.html);
  }

  const page = renderPage({
    title: 'Set a new password',
    message: '<p>Choose a new password for this Viventium account.</p>',
    form: { token, userId },
  });
  return res.status(page.status).type('html').send(page.html);
});

router.post('/password-reset', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const userId = String(req.body.userId || '').trim();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (!token || !userId) {
    const page = renderPage({
      title: 'Password reset failed',
      message: '<p>The reset token is missing or invalid.</p>',
      status: 400,
    });
    return res.status(page.status).type('html').send(page.html);
  }

  if (password.length < 8) {
    const page = renderPage({
      title: 'Password reset failed',
      message: '<p>Password must be at least 8 characters long.</p>',
      status: 400,
      form: { token, userId },
    });
    return res.status(page.status).type('html').send(page.html);
  }

  if (password !== confirmPassword) {
    const page = renderPage({
      title: 'Password reset failed',
      message: '<p>The confirmation password does not match.</p>',
      status: 400,
      form: { token, userId },
    });
    return res.status(page.status).type('html').send(page.html);
  }

  try {
    await consumeLocalPasswordReset({ userId, token, password });
    const page = renderPage({
      title: 'Password updated',
      message: '<p>Your password has been updated. You can sign in with the new password now.</p>',
      loginUrl: `${String(process.env.DOMAIN_CLIENT || '').replace(/\/$/, '')}/login`,
    });
    return res.status(page.status).type('html').send(page.html);
  } catch (error) {
    const page = renderPage({
      title: 'Password reset failed',
      message: `<p>${escapeHtml(error.message || 'Unable to reset the password.')}</p>`,
      status: 400,
      form: { token, userId },
    });
    return res.status(page.status).type('html').send(page.html);
  }
});

module.exports = router;
