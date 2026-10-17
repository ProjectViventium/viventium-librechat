import { useMemo, memo } from 'react';
import { FileSources } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
/* === VIVENTIUM START: Saved input cards share the authorized attachment download handler. === */
import { useAttachmentLink } from './Parts/LogLink';
/* === VIVENTIUM END === */
import { getCachedPreview } from '~/utils';
import Image from './Image';

/* === VIVENTIUM START: Text-source attachments retain file presentation regardless of original MIME. === */
const isImageAttachment = (file: Partial<TFile>) =>
  file.source !== FileSources.text && file.type?.startsWith('image/') === true;
/* === VIVENTIUM END === */

/* === VIVENTIUM START: Keep input file identity and download behavior after persistence. === */
const DownloadableFile = ({ file }: { file: Partial<TFile> }) => {
  const { handleDownload } = useAttachmentLink({
    href: file.filepath ?? '',
    filename: file.filename ?? '',
    file_id: file.file_id,
    user: file.user,
    source: file.source,
  });
  return <FileContainer file={file} onClick={handleDownload} />;
};
/* === VIVENTIUM END === */

const Files = ({ message }: { message?: TMessage }) => {
  const imageFiles = useMemo(() => {
    return message?.files?.filter(isImageAttachment) || [];
  }, [message?.files]);

  const otherFiles = useMemo(() => {
    return message?.files?.filter((file) => !isImageAttachment(file)) || [];
  }, [message?.files]);

  return (
    <>
      {otherFiles.length > 0 &&
        /* === VIVENTIUM START: Reuse authenticated download for every saved nonimage input. === */
        otherFiles.map((file) => <DownloadableFile key={file.file_id} file={file} />)}
      {/* === VIVENTIUM END === */}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => {
          const cached = file.file_id ? getCachedPreview(file.file_id) : undefined;
          return (
            <Image
              key={file.file_id}
              width={file.width}
              height={file.height}
              file={file}
              altText={file.filename ?? 'Uploaded Image'}
              imagePath={cached ?? file.preview ?? file.filepath ?? ''}
            />
          );
        })}
    </>
  );
};

export default memo(Files);
