const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { logAxiosError, generateShortLivedToken } = require('@librechat/api');

const EMBED_ERROR_DETAIL_LIMIT = 1400;
const EMBEDDING_VECTOR_REGEX = /(['"]embedding['"]\s*:\s*)\[[\s\S]*?\]/gi;
const EMBED_INPUT_TOKEN_REGEX = /(['"]input['"]\s*:\s*)\[[\s\S]*?\]/gi;
const EMBED_TEXT_FIELD_REGEX = /(['"]text['"]\s*:\s*)(['"])(?:\\.|(?!\2)[\s\S])*\2/gi;

function sanitizeEmbeddingFailureDetails(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let next = value
    .replace(EMBEDDING_VECTOR_REGEX, '$1[omitted]')
    .replace(EMBED_INPUT_TOKEN_REGEX, '$1[omitted]')
    .replace(EMBED_TEXT_FIELD_REGEX, (match, prefix, quote) => {
      if (match.length <= 220) {
        return match;
      }
      return `${prefix}${quote}[omitted]${quote}`;
    })
    .replace(/\s+/g, ' ')
    .trim();

  if (next.length > EMBED_ERROR_DETAIL_LIMIT) {
    next = `${next.slice(0, EMBED_ERROR_DETAIL_LIMIT)}... [truncated]`;
  }

  return next;
}

function compactErrorMessage(message) {
  const cleaned = sanitizeEmbeddingFailureDetails(String(message || ''));
  return cleaned || 'An error occurred during file upload.';
}

function buildSafeUploadError(error) {
  const safe = new Error(compactErrorMessage(error?.message));

  if (error?.response) {
    const safeMessage = sanitizeEmbeddingFailureDetails(
      typeof error?.response?.data?.message === 'string'
        ? error.response.data.message
        : typeof error?.response?.data?.error === 'string'
          ? error.response.data.error
          : '',
    );

    safe.response = {
      ...error.response,
      data: {
        status: error?.response?.data?.status,
        known_type: error?.response?.data?.known_type,
        message: safeMessage,
      },
    };
  }

  if (error?.code) {
    safe.code = error.code;
  }
  if (error?.status) {
    safe.status = error.status;
  }

  return safe;
}

/**
 * Deletes a file from the vector database. This function takes a file object, constructs the full path, and
 * verifies the path's validity before deleting the file. If the path is invalid, an error is thrown.
 *
 * @param {ServerRequest} req - The request object from Express.
 * @param {MongoFile} file - The file object to be deleted. It should have a `filepath` property that is
 *                           a string representing the path of the file relative to the publicPath.
 *
 * @returns {Promise<void>}
 *          A promise that resolves when the file has been successfully deleted, or throws an error if the
 *          file path is invalid or if there is an error in deletion.
 */
const deleteVectors = async (req, file) => {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return;
  }
  try {
    const jwtToken = generateShortLivedToken(req.user.id);

    return await axios.delete(`${process.env.RAG_API_URL}/documents`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      data: [file.file_id],
    });
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error deleting vectors',
    });
    if (
      error.response &&
      error.response.status !== 404 &&
      (error.response.status < 200 || error.response.status >= 300)
    ) {
      logger.warn('Error deleting vectors, file will not be deleted');
      throw new Error(error.message || 'An error occurred during file deletion.');
    }
  }
};

/**
 * Uploads a file to the configured Vector database
 *
 * @param {Object} params - The params object.
 * @param {Object} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 * @param {string} [params.entity_id] - The entity ID for shared resources.
 * @param {Object} [params.storageMetadata] - Storage metadata for dual storage pattern.
 * @param {number} [params.timeoutMs] - Optional request timeout for embedding uploads.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 */
async function uploadVectors({ req, file, file_id, entity_id, storageMetadata, timeoutMs }) {
  if (!process.env.RAG_API_URL) {
    throw new Error('RAG_API_URL not defined');
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', fs.createReadStream(file.path));
    if (entity_id != null && entity_id) {
      formData.append('entity_id', entity_id);
    }

    // Include storage metadata for RAG API to store with embeddings
    if (storageMetadata) {
      formData.append('storage_metadata', JSON.stringify(storageMetadata));
    }

    const formHeaders = formData.getHeaders();

    const response = await axios.post(`${process.env.RAG_API_URL}/embed`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    });

    const responseData = response.data;
    logger.debug('Response from embedding file', responseData);

    if (responseData.known_type === false) {
      throw new Error(`File embedding failed. The filetype ${file.mimetype} is not supported`);
    }

    if (!responseData.status) {
      const details = sanitizeEmbeddingFailureDetails(
        typeof responseData?.message === 'string'
          ? responseData.message
          : typeof responseData?.error === 'string'
            ? responseData.error
            : '',
      );

      const failure = new Error(`File embedding failed${details ? `: ${details}` : '.'}`);
      failure.response = {
        status: response?.status,
        data: {
          status: responseData?.status,
          known_type: responseData?.known_type,
          message: details,
          error:
            typeof responseData?.error === 'string'
              ? sanitizeEmbeddingFailureDetails(responseData.error)
              : undefined,
        },
      };
      throw failure;
    }

    return {
      bytes: file.size,
      filename: file.originalname,
      filepath: FileSources.vectordb,
      embedded: Boolean(responseData.known_type),
    };
  } catch (error) {
    const safeError = buildSafeUploadError(error);
    logAxiosError({
      error: safeError,
      message: 'Error uploading vectors',
    });
    /* === VIVENTIUM START ===
     * Feature: Preserve upstream transport metadata for retry-aware callers.
     *
     * Purpose:
     * - `conversationRecallService` classifies transient failures (e.g., 503) by status/code.
     * - Wrapping with a plain Error discarded `response.status` and `code`, defeating retry logic.
     *
     * Added: 2026-02-19
     * === VIVENTIUM END === */
    const wrapped = safeError;
    throw wrapped;
  }
}

module.exports = {
  deleteVectors,
  uploadVectors,
};
