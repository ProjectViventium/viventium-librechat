require('dotenv').config();
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
require('./services/viventium/anthropicOAuthPatch');
require('./services/viventium/anthropicThinkingPatch');
require('./services/viventium/openaiResponsesOutputPatch');
require('./services/viventium/agentSchemaToolBindingPatch');
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { logger } = require('@librechat/data-schemas');
const mongoSanitize = require('express-mongo-sanitize');
const {
  isEnabled,
  apiNotFound,
  ErrorController,
  memoryDiagnostics,
  performStartupChecks,
  handleJsonParseError,
  GenerationJobManager,
  createStreamServices,
  initializeFileStorage,
  startSandpackBundlerServer,
  resolveSandpackBundlerServerConfig,
} = require('@librechat/api');
const { connectDb, indexSync } = require('~/db');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { updateInterfacePermissions } = require('~/models/interface');
const { checkMigrations } = require('./services/start/migration');
const initializeMCPs = require('./services/initializeMCPs');
const configureSocialLogins = require('./socialLogins');
const { getAppConfig } = require('./services/Config');
const {
  getStaleCortexRecoveryIntervalMs,
  recoverStaleCortexMessages,
} = require('./services/viventium/staleCortexMessageRecovery');
const staticCache = require('./utils/staticCache');
const noIndex = require('./middleware/noIndex');
const { seedDatabase } = require('~/models');
const routes = require('./routes');
/* === VIVENTIUM START ===
 * Feature: Process-private native API transport.
 * Purpose: Prevent the native proxy from following an unrelated process that acquires the TCP port.
 */
const {
  resolveNativeApiListenTarget,
  secureNativeApiSocket,
} = require('./services/viventium/nativeApiListen');
// === VIVENTIUM END ===

const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

// Allow PORT=0 to be used for automatic free port assignment
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */
/* === VIVENTIUM START ===
 * Feature: Process-private native API transport.
 * Purpose: Preserve upstream TCP behavior unless the native runtime explicitly supplies a socket.
 */
const apiListenTarget = resolveNativeApiListenTarget({
  socketPath: process.env.VIVENTIUM_NATIVE_API_SOCKET,
  port,
  host,
});
// === VIVENTIUM END ===

const app = express();

const startServer = async () => {
  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();

  logger.info('Connected to MongoDB');
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trusted_proxy);

  await seedDatabase();
  const appConfig = await getAppConfig();
  initializeFileStorage(appConfig);
  await performStartupChecks(appConfig);
  await updateInterfacePermissions(appConfig);

  /* === VIVENTIUM START ===
   * Feature: Isolated local Sandpack runtime.
   * Purpose: Source and Docker profiles can serve the verified browser runtime from a separate
   * origin without another dependency. Native deliberately leaves this disabled because its
   * hardened frontend proxy owns the isolated listener.
   */
  try {
    const sandpackServerConfig = resolveSandpackBundlerServerConfig({
      distPath: appConfig.paths.dist,
      env: process.env,
    });
    if (sandpackServerConfig) {
      await startSandpackBundlerServer(sandpackServerConfig);
      logger.info(
        `Isolated Sandpack runtime listening at http://${sandpackServerConfig.host}:${sandpackServerConfig.port}`,
      );
    }
  } catch (sandpackServerError) {
    logger.error('Failed to start isolated Sandpack runtime:', sandpackServerError);
    process.exit(1);
    return;
  }
  // === VIVENTIUM END ===

  const indexPath = path.join(appConfig.paths.dist, 'index.html');
  let indexHTML = fs.readFileSync(indexPath, 'utf8');

  // In order to provide support to serving the application in a sub-directory
  // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
  if (process.env.DOMAIN_CLIENT) {
    const clientUrl = new URL(process.env.DOMAIN_CLIENT);
    const baseHref = clientUrl.pathname.endsWith('/')
      ? clientUrl.pathname
      : `${clientUrl.pathname}/`;
    if (baseHref !== '/') {
      logger.info(`Setting base href to ${baseHref}`);
      indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
    }
  }

  /* === VIVENTIUM START ===
   * Feature: Health probe parity for Azure Container Apps.
   * Purpose: Liveness/readiness probes currently hit /api/health in managed cloud.
   * Keep both routes lightweight and equivalent to avoid false restarts.
   */
  app.get(['/health', '/api/health'], (_req, res) => res.status(200).send('OK'));
  /* === VIVENTIUM END === */

  /* Middleware */
  app.use(noIndex);
  /* === VIVENTIUM START ===
   * Feature: Telegram file upload payload sizing
   * Purpose: Allow larger JSON bodies when Telegram sends base64 files.
   * Added: 2026-01-31
   */
  const baseJsonLimitMb = 3;
  let jsonLimitMb = baseJsonLimitMb;
  const telegramPayloadLimit = Number.parseInt(process.env.VIVENTIUM_TELEGRAM_PAYLOAD_LIMIT_MB, 10);
  if (Number.isFinite(telegramPayloadLimit) && telegramPayloadLimit > 0) {
    jsonLimitMb = Math.max(baseJsonLimitMb, telegramPayloadLimit);
  } else {
    const telegramMaxFileBytes = Number.parseInt(process.env.VIVENTIUM_TELEGRAM_MAX_FILE_SIZE, 10);
    if (Number.isFinite(telegramMaxFileBytes) && telegramMaxFileBytes > 0) {
      const estimatedMb = Math.ceil((telegramMaxFileBytes * 4) / 3 / (1024 * 1024));
      jsonLimitMb = Math.max(baseJsonLimitMb, estimatedMb + 1);
    }
  }
  const jsonLimit = `${jsonLimitMb}mb`;
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: true, limit: jsonLimit }));
  app.use(handleJsonParseError);
  /* === VIVENTIUM END === */

  /**
   * Express 5 Compatibility: Make req.query writable for mongoSanitize
   * In Express 5, req.query is read-only by default, but express-mongo-sanitize needs to modify it
   */
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });

  app.use(mongoSanitize());
  app.use(cors());
  app.use(cookieParser());

  if (!isEnabled(DISABLE_COMPRESSION)) {
    app.use(compression());
  } else {
    console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
  }

  app.use(staticCache(appConfig.paths.dist));
  app.use(staticCache(appConfig.paths.fonts));
  app.use(staticCache(appConfig.paths.assets));

  if (!ALLOW_SOCIAL_LOGIN) {
    console.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
  }

  /* OAUTH */
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());

  /* LDAP Auth */
  if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
    passport.use(ldapLogin);
  }

  if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
    await configureSocialLogins(app);
  }

  app.use('/oauth', routes.oauth);
  /* API Endpoints */
  app.use('/api/auth', routes.auth);
  app.use('/api/admin', routes.adminAuth);
  app.use('/api/actions', routes.actions);
  app.use('/api/keys', routes.keys);
  app.use('/api/api-keys', routes.apiKeys);
  app.use('/api/user', routes.user);
  app.use('/api/search', routes.search);
  app.use('/api/messages', routes.messages);
  app.use('/api/convos', routes.convos);
  app.use('/api/presets', routes.presets);
  app.use('/api/prompts', routes.prompts);
  app.use('/api/categories', routes.categories);
  app.use('/api/endpoints', routes.endpoints);
  app.use('/api/balance', routes.balance);
  app.use('/api/models', routes.models);
  app.use('/api/config', routes.config);
  app.use('/api/assistants', routes.assistants);
  app.use('/api/files', await routes.files.initialize());
  app.use('/images/', createValidateImageRequest(appConfig.secureImageLinks), routes.staticRoute);
  app.use('/api/share', routes.share);
  app.use('/api/roles', routes.roles);
  app.use('/api/agents', routes.agents);
  app.use('/api/banner', routes.banner);
  app.use('/api/memories', routes.memories);
  app.use('/api/permissions', routes.accessPermissions);
  /* === VIVENTIUM START ===
   * Feature: Connected Accounts OAuth API.
   * === VIVENTIUM END === */
  app.use('/api/connected-accounts', routes.connectedAccounts);

  app.use('/api/tags', routes.tags);
  app.use('/api/mcp', routes.mcp);
  // === VIVENTIUM START - Voice Call Routes ===
  app.use('/api/viventium', routes.viventium);
  // === VIVENTIUM END ===

  /** 404 for unmatched API routes */
  app.use('/api', apiNotFound);

  /** SPA fallback - serve index.html for all unmatched routes */
  app.use((req, res) => {
    res.set({
      'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
      Pragma: process.env.INDEX_PRAGMA || 'no-cache',
      Expires: process.env.INDEX_EXPIRES || '0',
    });

    const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
    const saneLang = lang.replace(/"/g, '&quot;');
    let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);

    res.type('html');
    res.send(updatedIndexHtml);
  });

  /** Error handler (must be last - Express identifies error middleware by its 4-arg signature) */
  app.use(ErrorController);

  /* === VIVENTIUM START ===
   * Feature: Process-private native API transport.
   * Purpose: A private Unix socket binds this server instance to its owning native proxy.
   */
  app.listen(...apiListenTarget.args, async (err) => {
    if (err) {
      logger.error('Failed to start server:', err);
      process.exit(1);
    }

    if (apiListenTarget.socketPath) {
      try {
        secureNativeApiSocket(apiListenTarget.socketPath);
      } catch (socketSecurityError) {
        logger.error('Failed to secure native API socket:', socketSecurityError);
        process.exit(1);
        return;
      }
      logger.info(`Server listening on native API socket ${apiListenTarget.socketPath}`);
    } else if (host === '0.0.0.0') {
      logger.info(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }
    // === VIVENTIUM END ===

    await initializeMCPs();
    await initializeOAuthReconnectManager();
    await checkMigrations();
    recoverStaleCortexMessages().catch((error) => {
      logger.error('[staleCortexMessageRecovery] Startup recovery failed:', error);
    });
    const staleCortexRecoveryIntervalMs = getStaleCortexRecoveryIntervalMs();
    if (staleCortexRecoveryIntervalMs > 0) {
      setInterval(() => {
        recoverStaleCortexMessages().catch((error) => {
          logger.error('[staleCortexMessageRecovery] Periodic recovery failed:', error);
        });
      }, staleCortexRecoveryIntervalMs).unref?.();
    }

    // Configure stream services (auto-detects Redis from USE_REDIS env var)
    const streamServices = createStreamServices();
    GenerationJobManager.configure(streamServices);
    GenerationJobManager.initialize();

    const inspectFlags = process.execArgv.some((arg) => arg.startsWith('--inspect'));
    if (inspectFlags || isEnabled(process.env.MEM_DIAG)) {
      memoryDiagnostics.start();
    }
  });
};

startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }

    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  if (err.stack && err.stack.includes('@librechat/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }

  if (isEnabled(process.env.CONTINUE_ON_UNCAUGHT_EXCEPTION)) {
    logger.error('Unhandled error encountered. The app will continue running.', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    return;
  }

  process.exit(1);
});

/** Export app for easier testing purposes */
module.exports = app;
