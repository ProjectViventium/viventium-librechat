import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import { generateShortLivedToken } from '~/crypto/jwt';

interface DeleteRagFileParams {
	/** The user ID. Required for authentication. If not provided, the function returns false and logs an error. */
	userId: string;
	/** The file object. Must have `embedded` and `file_id` properties. */
	file: {
		file_id: string;
		embedded?: boolean;
	};
}

interface RagFileExistsParams {
	/** The user ID. Required for authentication. */
	userId: string;
	/** The file id stored in the RAG vector sidecar. */
	fileId: string;
}

interface RagFilesExistParams {
	/** The user ID. Required for authentication. */
	userId: string;
	/** The file ids stored in the RAG vector sidecar. */
	fileIds: string[];
}

function getRagFileExistsTimeoutMs(): number {
	const value = Number.parseInt(process.env.VIVENTIUM_RAG_FILE_EXISTS_TIMEOUT_MS ?? '', 10);
	return Number.isFinite(value) && value > 0 ? value : 5000;
}

function isNotFound(error: unknown): boolean {
	const axiosError = error as { response?: { status?: number } };
	return axiosError.response?.status === 404;
}

function getRagHeaders(userId: string) {
	const jwtToken = generateShortLivedToken(userId);
	return {
		Authorization: `Bearer ${jwtToken}`,
		accept: 'application/json',
	};
}

/**
 * Deletes embedded document(s) from the RAG API.
 * This is a shared utility function used by all file storage strategies
 * (S3, Azure, Firebase, Local) to delete RAG embeddings when a file is deleted.
 *
 * @param params - The parameters object.
 * @param params.userId - The user ID for authentication.
 * @param params.file - The file object. Must have `embedded` and `file_id` properties.
 * @returns Returns true if deletion was successful or skipped, false if there was an error.
 */
export async function deleteRagFile({ userId, file }: DeleteRagFileParams): Promise<boolean> {
	if (!file.embedded || !process.env.RAG_API_URL) {
		return true;
	}

	if (!userId) {
		logger.error('[deleteRagFile] No user ID provided');
		return false;
	}

	const jwtToken = generateShortLivedToken(userId);

	try {
		await axios.delete(`${process.env.RAG_API_URL}/documents`, {
			headers: {
				Authorization: `Bearer ${jwtToken}`,
				'Content-Type': 'application/json',
				accept: 'application/json',
			},
			data: [file.file_id],
		});
		logger.debug(`[deleteRagFile] Successfully deleted document ${file.file_id} from RAG API`);
		return true;
	} catch (error) {
		const axiosError = error as { response?: { status?: number }; message?: string };
		if (axiosError.response?.status === 404) {
			logger.warn(
				`[deleteRagFile] Document ${file.file_id} not found in RAG API, may have been deleted already`,
			);
			return true;
		} else {
			logger.error('[deleteRagFile] Error deleting document from RAG API:', axiosError.message);
			return false;
		}
	}
}

/* === VIVENTIUM START ===
 * Feature: Derived vector continuity check.
 *
 * Purpose:
 * - Mongo file rows can survive a local RAG/PGVector reset.
 * - Runtime attachment should only advertise file_search ids that the vector sidecar can load.
 *
 * Added: 2026-05-07
 * === VIVENTIUM END === */
export async function ragFileExists({ userId, fileId }: RagFileExistsParams): Promise<boolean> {
	if (!userId || !fileId || !process.env.RAG_API_URL) {
		return false;
	}

	const headers = getRagHeaders(userId);
	const timeout = getRagFileExistsTimeoutMs();
	const encodedFileId = encodeURIComponent(fileId);

	try {
		const response = await axios.get(`${process.env.RAG_API_URL}/documents/${encodedFileId}/exists`, {
			headers,
			timeout,
		});
		if (typeof response?.data?.exists === 'boolean') {
			return response.data.exists;
		}
		logger.warn('[ragFileExists] RAG document exists endpoint returned an invalid payload', {
			fileId,
		});
	} catch (error) {
		if (!isNotFound(error)) {
			const axiosError = error as { message?: string };
			logger.warn('[ragFileExists] Failed to verify RAG document presence', {
				fileId,
				message: axiosError.message,
			});
			return false;
		}
	}

	try {
		await axios.get(`${process.env.RAG_API_URL}/documents/${encodedFileId}/context`, {
			headers,
			timeout,
		});
		return true;
	} catch (error) {
		if (isNotFound(error)) {
			return false;
		}
		const axiosError = error as { message?: string };
		logger.warn('[ragFileExists] Failed to verify RAG document presence through context fallback', {
			fileId,
			message: axiosError.message,
		});
		return false;
	}
}

export async function ragFilesExist({
	userId,
	fileIds,
}: RagFilesExistParams): Promise<Set<string>> {
	const uniqueFileIds = Array.from(new Set((fileIds ?? []).filter(Boolean)));
	if (!userId || !uniqueFileIds.length || !process.env.RAG_API_URL) {
		return new Set();
	}

	const headers = {
		...getRagHeaders(userId),
		'Content-Type': 'application/json',
	};
	const timeout = getRagFileExistsTimeoutMs();

	try {
		const response = await axios.post(`${process.env.RAG_API_URL}/documents/exists`, uniqueFileIds, {
			headers,
			timeout,
		});
		const existingIds = response?.data?.existing_ids;
		if (Array.isArray(existingIds)) {
			return new Set(existingIds.filter((fileId) => uniqueFileIds.includes(fileId)));
		}
		logger.warn('[ragFilesExist] RAG batch exists endpoint returned an invalid payload');
	} catch (error) {
		if (!isNotFound(error)) {
			const axiosError = error as { message?: string };
			logger.warn('[ragFilesExist] Failed to verify RAG documents through batch endpoint', {
				fileCount: uniqueFileIds.length,
				message: axiosError.message,
			});
			return new Set();
		}
	}

	const fallbackResults = await Promise.all(
		uniqueFileIds.map(async (fileId) => ({
			fileId,
			exists: await ragFileExists({ userId, fileId }),
		})),
	);
	return new Set(
		fallbackResults.filter((result) => result.exists).map((result) => result.fileId),
	);
}
