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

	const jwtToken = generateShortLivedToken(userId);

	try {
		await axios.get(`${process.env.RAG_API_URL}/documents/${encodeURIComponent(fileId)}/context`, {
			headers: {
				Authorization: `Bearer ${jwtToken}`,
				accept: 'application/json',
			},
		});
		return true;
	} catch (error) {
		const axiosError = error as { response?: { status?: number }; message?: string };
		if (axiosError.response?.status === 404) {
			return false;
		}
		logger.warn('[ragFileExists] Failed to verify RAG document presence', {
			fileId,
			message: axiosError.message,
		});
		return false;
	}
}
