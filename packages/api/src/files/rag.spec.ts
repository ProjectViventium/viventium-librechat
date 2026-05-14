jest.mock('@librechat/data-schemas', () => ({
	logger: {
		debug: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	},
}));

jest.mock('~/crypto/jwt', () => ({
	generateShortLivedToken: jest.fn().mockReturnValue('mock-jwt-token'),
}));

jest.mock('axios', () => ({
	delete: jest.fn(),
	get: jest.fn(),
	post: jest.fn(),
	interceptors: {
		request: { use: jest.fn(), eject: jest.fn() },
		response: { use: jest.fn(), eject: jest.fn() },
	},
}));

import axios from 'axios';
import { deleteRagFile, ragFileExists, ragFilesExist } from './rag';
import { logger } from '@librechat/data-schemas';
import { generateShortLivedToken } from '~/crypto/jwt';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedGenerateShortLivedToken = generateShortLivedToken as jest.MockedFunction<
	typeof generateShortLivedToken
>;

describe('deleteRagFile', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.RAG_API_URL = 'http://localhost:8000';
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('when file is embedded and RAG_API_URL is configured', () => {
		it('should delete the document from RAG API successfully', async () => {
			const file = { file_id: 'file-123', embedded: true };
			mockedAxios.delete.mockResolvedValueOnce({ status: 200 });

			const result = await deleteRagFile({ userId: 'user123', file });

			expect(result).toBe(true);
			expect(mockedGenerateShortLivedToken).toHaveBeenCalledWith('user123');
			expect(mockedAxios.delete).toHaveBeenCalledWith('http://localhost:8000/documents', {
				headers: {
					Authorization: 'Bearer mock-jwt-token',
					'Content-Type': 'application/json',
					accept: 'application/json',
				},
				data: ['file-123'],
			});
			expect(mockedLogger.debug).toHaveBeenCalledWith(
				'[deleteRagFile] Successfully deleted document file-123 from RAG API',
			);
		});

		it('should return true and log warning when document is not found (404)', async () => {
			const file = { file_id: 'file-not-found', embedded: true };
			const error = new Error('Not Found') as Error & { response?: { status?: number } };
			error.response = { status: 404 };
			mockedAxios.delete.mockRejectedValueOnce(error);

			const result = await deleteRagFile({ userId: 'user123', file });

			expect(result).toBe(true);
			expect(mockedLogger.warn).toHaveBeenCalledWith(
				'[deleteRagFile] Document file-not-found not found in RAG API, may have been deleted already',
			);
		});

		it('should return false and log error on other errors', async () => {
			const file = { file_id: 'file-error', embedded: true };
			const error = new Error('Server Error') as Error & { response?: { status?: number } };
			error.response = { status: 500 };
			mockedAxios.delete.mockRejectedValueOnce(error);

			const result = await deleteRagFile({ userId: 'user123', file });

			expect(result).toBe(false);
			expect(mockedLogger.error).toHaveBeenCalledWith(
				'[deleteRagFile] Error deleting document from RAG API:',
				'Server Error',
			);
		});
	});

	describe('when file is not embedded', () => {
		it('should skip RAG deletion and return true', async () => {
			const file = { file_id: 'file-123', embedded: false };

			const result = await deleteRagFile({ userId: 'user123', file });

			expect(result).toBe(true);
			expect(mockedAxios.delete).not.toHaveBeenCalled();
			expect(mockedGenerateShortLivedToken).not.toHaveBeenCalled();
		});

		it('should skip RAG deletion when embedded is undefined', async () => {
			const file = { file_id: 'file-123' };

			const result = await deleteRagFile({ userId: 'user123', file });

			expect(result).toBe(true);
			expect(mockedAxios.delete).not.toHaveBeenCalled();
		});
	});

	describe('when RAG_API_URL is not configured', () => {
		it('should skip RAG deletion and return true', async () => {
			delete process.env.RAG_API_URL;
			const file = { file_id: 'file-123', embedded: true };

			const result = await deleteRagFile({ userId: 'user123', file });

			expect(result).toBe(true);
			expect(mockedAxios.delete).not.toHaveBeenCalled();
		});
	});

	describe('userId handling', () => {
		it('should return false when no userId is provided', async () => {
			const file = { file_id: 'file-123', embedded: true };

			const result = await deleteRagFile({ userId: '', file });

			expect(result).toBe(false);
			expect(mockedLogger.error).toHaveBeenCalledWith('[deleteRagFile] No user ID provided');
			expect(mockedAxios.delete).not.toHaveBeenCalled();
		});

		it('should return false when userId is undefined', async () => {
			const file = { file_id: 'file-123', embedded: true };

			const result = await deleteRagFile({ userId: undefined as unknown as string, file });

			expect(result).toBe(false);
			expect(mockedLogger.error).toHaveBeenCalledWith('[deleteRagFile] No user ID provided');
		});
	});
});

describe('ragFileExists', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.RAG_API_URL = 'http://localhost:8000';
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('uses the lightweight existence endpoint when available', async () => {
		mockedAxios.get.mockResolvedValueOnce({ data: { exists: true } });

		const result = await ragFileExists({ userId: 'user123', fileId: 'file-123' });

		expect(result).toBe(true);
		expect(mockedGenerateShortLivedToken).toHaveBeenCalledWith('user123');
		expect(mockedAxios.get).toHaveBeenCalledTimes(1);
		expect(mockedAxios.get).toHaveBeenCalledWith('http://localhost:8000/documents/file-123/exists', {
			headers: {
				Authorization: 'Bearer mock-jwt-token',
				accept: 'application/json',
			},
			timeout: 5000,
		});
	});

	it('returns false when the lightweight endpoint reports the file is missing', async () => {
		mockedAxios.get.mockResolvedValueOnce({ data: { exists: false } });

		const result = await ragFileExists({ userId: 'user123', fileId: 'file-missing' });

		expect(result).toBe(false);
		expect(mockedAxios.get).toHaveBeenCalledTimes(1);
	});

	it('falls back to the context endpoint when the lightweight endpoint is not deployed', async () => {
		const notFound = new Error('Not Found') as Error & { response?: { status?: number } };
		notFound.response = { status: 404 };
		mockedAxios.get.mockRejectedValueOnce(notFound).mockResolvedValueOnce({ data: 'context' });

		const result = await ragFileExists({ userId: 'user123', fileId: 'file-legacy' });

		expect(result).toBe(true);
		expect(mockedAxios.get).toHaveBeenCalledTimes(2);
		expect(mockedAxios.get).toHaveBeenNthCalledWith(
			1,
			'http://localhost:8000/documents/file-legacy/exists',
			expect.objectContaining({ timeout: 5000 }),
		);
		expect(mockedAxios.get).toHaveBeenNthCalledWith(
			2,
			'http://localhost:8000/documents/file-legacy/context',
			expect.objectContaining({ timeout: 5000 }),
		);
	});

	it('returns false when the context fallback reports the file is missing', async () => {
		const notFound = new Error('Not Found') as Error & { response?: { status?: number } };
		notFound.response = { status: 404 };
		mockedAxios.get.mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);

		const result = await ragFileExists({ userId: 'user123', fileId: 'file-missing' });

		expect(result).toBe(false);
		expect(mockedAxios.get).toHaveBeenCalledTimes(2);
	});

	it('does not call the heavier context endpoint after a lightweight timeout', async () => {
		const timeout = new Error('timeout of 5000ms exceeded');
		mockedAxios.get.mockRejectedValueOnce(timeout);

		const result = await ragFileExists({ userId: 'user123', fileId: 'file-timeout' });

		expect(result).toBe(false);
		expect(mockedAxios.get).toHaveBeenCalledTimes(1);
		expect(mockedLogger.warn).toHaveBeenCalledWith(
			'[ragFileExists] Failed to verify RAG document presence',
			expect.objectContaining({
				fileId: 'file-timeout',
			}),
		);
	});

	it('uses the configured presence-check timeout', async () => {
		process.env.VIVENTIUM_RAG_FILE_EXISTS_TIMEOUT_MS = '1500';
		mockedAxios.get.mockResolvedValueOnce({ data: { exists: true } });

		await ragFileExists({ userId: 'user123', fileId: 'file-timeout-config' });

		expect(mockedAxios.get).toHaveBeenCalledWith(
			'http://localhost:8000/documents/file-timeout-config/exists',
			expect.objectContaining({ timeout: 1500 }),
		);
	});
});

describe('ragFilesExist', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.RAG_API_URL = 'http://localhost:8000';
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('uses the batch existence endpoint for multiple files', async () => {
		mockedAxios.post.mockResolvedValueOnce({
			data: { existing_ids: ['file-1', 'file-3'] },
		});

		const result = await ragFilesExist({
			userId: 'user123',
			fileIds: ['file-1', 'file-2', 'file-3'],
		});

		expect(Array.from(result).sort()).toEqual(['file-1', 'file-3']);
		expect(mockedAxios.post).toHaveBeenCalledWith(
			'http://localhost:8000/documents/exists',
			['file-1', 'file-2', 'file-3'],
			{
				headers: {
					Authorization: 'Bearer mock-jwt-token',
					accept: 'application/json',
					'Content-Type': 'application/json',
				},
				timeout: 5000,
			},
		);
	});

	it('deduplicates file ids before calling the batch endpoint', async () => {
		mockedAxios.post.mockResolvedValueOnce({ data: { existing_ids: ['file-1'] } });

		await ragFilesExist({ userId: 'user123', fileIds: ['file-1', 'file-1'] });

		expect(mockedAxios.post).toHaveBeenCalledWith(
			'http://localhost:8000/documents/exists',
			['file-1'],
			expect.any(Object),
		);
	});

	it('falls back to single-file checks when the batch endpoint is not deployed', async () => {
		const notFound = new Error('Not Found') as Error & { response?: { status?: number } };
		notFound.response = { status: 404 };
		mockedAxios.post.mockRejectedValueOnce(notFound);
		mockedAxios.get
			.mockResolvedValueOnce({ data: { exists: true } })
			.mockResolvedValueOnce({ data: { exists: false } });

		const result = await ragFilesExist({
			userId: 'user123',
			fileIds: ['file-1', 'file-2'],
		});

		expect(Array.from(result)).toEqual(['file-1']);
		expect(mockedAxios.get).toHaveBeenCalledTimes(2);
	});

	it('fails closed on batch endpoint errors', async () => {
		mockedAxios.post.mockRejectedValueOnce(new Error('timeout of 5000ms exceeded'));

		const result = await ragFilesExist({
			userId: 'user123',
			fileIds: ['file-1', 'file-2'],
		});

		expect(result.size).toBe(0);
		expect(mockedAxios.get).not.toHaveBeenCalled();
		expect(mockedLogger.warn).toHaveBeenCalledWith(
			'[ragFilesExist] Failed to verify RAG documents through batch endpoint',
			expect.objectContaining({ fileCount: 2 }),
		);
	});
});
