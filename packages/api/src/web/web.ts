import {
  AuthType,
  SafeSearchTypes,
  SearchCategories,
  extractVariableName,
} from 'librechat-data-provider';
import { webSearchAuth } from '@librechat/data-schemas';
import type {
  RerankerTypes,
  TCustomConfig,
  SearchProviders,
  ScraperProviders,
  TWebSearchConfig,
} from 'librechat-data-provider';
import type { TWebSearchKeys, TWebSearchCategories } from '@librechat/data-schemas';

export function extractWebSearchEnvVars({
  keys,
  config,
}: {
  keys: TWebSearchKeys[];
  config: TCustomConfig['webSearch'] | undefined;
}): string[] {
  if (!config) {
    return [];
  }

  const authFields: string[] = [];
  const relevantKeys = keys.filter((k) => k in config);

  for (const key of relevantKeys) {
    const value = config[key];
    if (typeof value === 'string') {
      const varName = extractVariableName(value);
      if (varName) {
        authFields.push(varName);
      }
    }
  }

  return authFields;
}

function resolveWebSearchConfigValue(
  key: TWebSearchKeys,
  config: TCustomConfig['webSearch'] | undefined,
): { authField?: string; literalValue?: string } | null {
  if (!config) {
    return null;
  }

  const value = config[key];
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const authField = extractVariableName(value);
  if (authField) {
    return { authField };
  }

  return { literalValue: value };
}

/**
 * Type for web search authentication result
 */
export interface WebSearchAuthResult {
  /** Whether all required categories have at least one authenticated service */
  authenticated: boolean;
  /** Authentication type (user_provided or system_defined) by category */
  authTypes: [TWebSearchCategories, AuthType][];
  /** Original authentication values mapped to their respective keys */
  authResult: Partial<TWebSearchConfig>;
}

/**
 * Loads and verifies web search authentication values
 * @param params - Authentication parameters
 * @returns Authentication result
 */
export async function loadWebSearchAuth({
  userId,
  webSearchConfig,
  loadAuthValues,
  throwError = true,
}: {
  userId: string;
  webSearchConfig: TCustomConfig['webSearch'];
  loadAuthValues: (params: {
    userId: string;
    authFields: string[];
    optional?: Set<string>;
    throwError?: boolean;
  }) => Promise<Record<string, string>>;
  throwError?: boolean;
}): Promise<WebSearchAuthResult> {
  let authenticated = true;
  const authResult: Partial<TWebSearchConfig> = {};

  /** Type-safe iterator for the category-service combinations */
  async function checkAuth<C extends TWebSearchCategories>(
    category: C,
  ): Promise<[boolean, boolean]> {
    type ServiceType = keyof (typeof webSearchAuth)[C];
    let isUserProvided = false;

    // Check if a specific service is specified in the config
    let specificService: ServiceType | undefined;
    if (category === SearchCategories.PROVIDERS && webSearchConfig?.searchProvider) {
      specificService = webSearchConfig.searchProvider as unknown as ServiceType;
    } else if (category === SearchCategories.SCRAPERS && webSearchConfig?.scraperProvider) {
      specificService = webSearchConfig.scraperProvider as unknown as ServiceType;
    } else if (category === SearchCategories.RERANKERS && webSearchConfig?.rerankerType) {
      specificService = webSearchConfig.rerankerType as unknown as ServiceType;
    }

    if (category === SearchCategories.RERANKERS && !specificService) {
      return [true, false];
    }

    // If a specific service is specified, only check that one
    const services = specificService
      ? [specificService]
      : (Object.keys(webSearchAuth[category]) as ServiceType[]);

    for (const service of services) {
      // Skip if the service doesn't exist in the webSearchAuth config
      if (!webSearchAuth[category][service]) {
        continue;
      }

      const serviceConfig = webSearchAuth[category][service];

      // Split keys into required and optional
      const requiredKeys: TWebSearchKeys[] = [];
      const optionalKeys: TWebSearchKeys[] = [];

      for (const key in serviceConfig) {
        const typedKey = key as TWebSearchKeys;
        if (serviceConfig[typedKey as keyof typeof serviceConfig] === 1) {
          requiredKeys.push(typedKey);
        } else if (serviceConfig[typedKey as keyof typeof serviceConfig] === 0) {
          optionalKeys.push(typedKey);
        }
      }

      if (requiredKeys.length === 0) continue;

      const allKeys = [...requiredKeys, ...optionalKeys];
      const resolvedEntries = allKeys.map((key) => ({
        key,
        resolved: resolveWebSearchConfigValue(key, webSearchConfig),
      }));
      const requiredSatisfied = resolvedEntries
        .filter((entry) => requiredKeys.includes(entry.key))
        .every((entry) => entry.resolved?.authField || entry.resolved?.literalValue != null);

      if (!requiredSatisfied) {
        continue;
      }

      const envEntries = resolvedEntries.filter((entry) => entry.resolved?.authField);
      const allAuthFields = envEntries
        .map((entry) => entry.resolved?.authField)
        .filter((field): field is string => typeof field === 'string' && field.length > 0);
      const optionalSet = new Set(
        envEntries
          .filter((entry) => optionalKeys.includes(entry.key))
          .map((entry) => entry.resolved?.authField)
          .filter((field): field is string => typeof field === 'string' && field.length > 0),
      );

      const categoryResult: Partial<TWebSearchConfig> = {};
      let authValues: Record<string, string> = {};

      try {
        if (allAuthFields.length > 0) {
          authValues = await loadAuthValues({
            userId,
            authFields: allAuthFields,
            optional: optionalSet,
            throwError,
          });
        }

        let allFieldsAuthenticated = true;
        for (const entry of resolvedEntries) {
          const originalKey = entry.key;
          const resolved = entry.resolved;
          if (!resolved) {
            if (optionalKeys.includes(originalKey)) {
              continue;
            }
            allFieldsAuthenticated = false;
            break;
          }

          if (resolved.literalValue != null) {
            categoryResult[originalKey] = resolved.literalValue;
            continue;
          }

          const field = resolved.authField;
          if (!field) {
            if (optionalKeys.includes(originalKey)) {
              continue;
            }
            allFieldsAuthenticated = false;
            break;
          }

          const value = authValues[field];
          if (!optionalSet.has(field) && !value) {
            allFieldsAuthenticated = false;
            break;
          }
          if (value) {
            categoryResult[originalKey] = value;
          }
          if (!isUserProvided && value && process.env[field] !== value) {
            isUserProvided = true;
          }
        }

        if (!allFieldsAuthenticated) {
          continue;
        }
        Object.assign(authResult, categoryResult);
        if (category === SearchCategories.PROVIDERS) {
          authResult.searchProvider = service as SearchProviders;
        } else if (category === SearchCategories.SCRAPERS) {
          authResult.scraperProvider = service as ScraperProviders;
        } else if (category === SearchCategories.RERANKERS) {
          authResult.rerankerType = service as RerankerTypes;
        }
        return [true, isUserProvided];
      } catch {
        continue;
      }
    }
    return [false, isUserProvided];
  }

  const categories = [
    SearchCategories.PROVIDERS,
    SearchCategories.SCRAPERS,
    SearchCategories.RERANKERS,
  ] as const;
  const authTypes: [TWebSearchCategories, AuthType][] = [];
  for (const category of categories) {
    const [isCategoryAuthenticated, isUserProvided] = await checkAuth(category);
    if (!isCategoryAuthenticated) {
      authenticated = false;
      authTypes.push([category, AuthType.USER_PROVIDED]);
      continue;
    }
    authTypes.push([category, isUserProvided ? AuthType.USER_PROVIDED : AuthType.SYSTEM_DEFINED]);
  }

  authResult.safeSearch = webSearchConfig?.safeSearch ?? SafeSearchTypes.MODERATE;
  authResult.scraperTimeout =
    webSearchConfig?.scraperTimeout ?? webSearchConfig?.firecrawlOptions?.timeout ?? 7500;
  authResult.firecrawlOptions = webSearchConfig?.firecrawlOptions;

  return {
    authTypes,
    authResult,
    authenticated,
  };
}
