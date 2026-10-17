const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { loadDefaultModels, loadConfigModels } = require('~/server/services/Config');
const { getLogStores } = require('~/cache');
const { getAppConfig } = require('~/server/services/Config/app');

/* === VIVENTIUM START ===
 * Current declared model capabilities remain authoritative across a cached fetched catalog.
 * This projection is shared by Voice, Main and fallback admission; it does not mutate the cache.
 * === VIVENTIUM END === */
async function withConfiguredAgentModels(modelsConfig, req) {
  const projected = { ...modelsConfig };
  const config = req?.config ?? (await getAppConfig({ role: req?.user?.role }));
  const capabilities = config?.endpoints?.agents?.providerCapabilities || {};
  for (const [provider, capability] of Object.entries(capabilities)) {
    const declared = (capability?.models || []).map((entry) => entry?.id).filter(Boolean);
    if (declared.length) {
      projected[provider] = Array.from(new Set([...(projected[provider] || []), ...declared]));
    }
  }
  return projected;
}

/**
 * @param {ServerRequest} req
 * @returns {Promise<TModelsConfig>} The models config.
 */
const getModelsConfig = async (req) => {
  const cache = getLogStores(CacheKeys.CONFIG_STORE);
  const modelsConfig = await cache.get(CacheKeys.MODELS_CONFIG);
  if (!modelsConfig) {
    return loadModels(req);
  }

  /* VIVENTIUM: A fixed menu is not proof that native discovery succeeded. */
  await loadConfigModels(req, { nativeDiscoveryOnly: true });
  return withConfiguredAgentModels(modelsConfig, req);
};

/**
 * Loads the models from the config.
 * @param {ServerRequest} req - The Express request object.
 * @returns {Promise<TModelsConfig>} The models config.
 */
async function loadModels(req) {
  const cache = getLogStores(CacheKeys.CONFIG_STORE);
  const cachedModelsConfig = await cache.get(CacheKeys.MODELS_CONFIG);
  if (cachedModelsConfig) {
    await loadConfigModels(req, { nativeDiscoveryOnly: true });
    return withConfiguredAgentModels(cachedModelsConfig, req);
  }
  const defaultModelsConfig = await loadDefaultModels(req);
  const customModelsConfig = await loadConfigModels(req);

  const modelConfig = { ...defaultModelsConfig, ...customModelsConfig };

  await cache.set(CacheKeys.MODELS_CONFIG, modelConfig);
  return withConfiguredAgentModels(modelConfig, req);
}

async function modelController(req, res) {
  try {
    const modelConfig = await loadModels(req);
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig, withConfiguredAgentModels };
