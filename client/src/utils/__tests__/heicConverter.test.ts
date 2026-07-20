import { dataService } from 'librechat-data-provider';
import { convertHEICToJPEG, HeicConversionError, isHEICFile } from '../heicConverter';

jest.mock('librechat-data-provider', () => ({
  dataService: { convertNativeHeic: jest.fn() },
}));

const heicBytes = Buffer.from(
  '00000024667479706d736631000000006d73663168657663686569636d69663169736f38',
  'hex',
);
const jpeg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });

describe('HEIC conversion', () => {
  const originalCreateImageBitmap = global.createImageBitmap;

  afterEach(() => {
    global.createImageBitmap = originalCreateImageBitmap;
    jest.restoreAllMocks();
  });

  test('recognizes HEIC by container signature without relying on filename or MIME', async () => {
    const file = new File([heicBytes], 'photo.bin', { type: 'application/octet-stream' });

    await expect(isHEICFile(file)).resolves.toBe(true);
  });

  test('uses browser-native decoding first and closes the decoded bitmap', async () => {
    const close = jest.fn();
    global.createImageBitmap = jest.fn().mockResolvedValue({ width: 2, height: 2, close });
    const drawImage = jest.fn();
    jest.spyOn(document, 'createElement').mockReturnValue({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) => callback(jpeg),
    } as unknown as HTMLCanvasElement);

    const result = await convertHEICToJPEG(
      new File([heicBytes], 'photo.heic', { type: 'image/heic', lastModified: 42 }),
    );

    expect(result.name).toBe('photo.jpg');
    expect(result.type).toBe('image/jpeg');
    expect(result.lastModified).toBe(42);
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(dataService.convertNativeHeic).not.toHaveBeenCalled();
  });

  test('falls back to the authenticated same-origin Native endpoint', async () => {
    global.createImageBitmap = jest.fn().mockRejectedValue(new DOMException('unsupported'));
    jest.mocked(dataService.convertNativeHeic).mockResolvedValue(jpeg);

    const result = await convertHEICToJPEG(
      new File([heicBytes], 'photo.heic', { type: 'image/heic' }),
    );

    expect(result.type).toBe('image/jpeg');
    expect(dataService.convertNativeHeic).toHaveBeenCalledWith(expect.any(FormData));
  });

  test('returns a typed unsupported result when neither safe path is available', async () => {
    global.createImageBitmap = jest.fn().mockRejectedValue(new DOMException('unsupported'));
    jest.mocked(dataService.convertNativeHeic).mockRejectedValue({
      response: { data: { code: 'native_heic_unavailable' } },
    });

    await expect(
      convertHEICToJPEG(new File([heicBytes], 'photo.heic', { type: 'image/heic' })),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HeicConversionError>>({ code: 'unsupported' }),
    );
  });

  test('rejects declared HEIC with an invalid container before either decoder runs', async () => {
    global.createImageBitmap = jest.fn();

    await expect(
      convertHEICToJPEG(new File(['not an image'], 'photo.heic', { type: 'image/heic' })),
    ).rejects.toEqual(expect.objectContaining<Partial<HeicConversionError>>({ code: 'invalid' }));
    expect(global.createImageBitmap).not.toHaveBeenCalled();
    expect(dataService.convertNativeHeic).not.toHaveBeenCalled();
  });
});
