import { sanitizeLiveAnnouncementText } from '../sanitizeLiveAnnouncementText';

describe('sanitizeLiveAnnouncementText', () => {
  it('keeps GlassHive markdown link labels while removing signed URLs and tokens', () => {
    const result = sanitizeLiveAnnouncementText(
      'Done. Open [report.docx](https://glasshive.example/v1/signed-links/abc123) and [View / Steer](https://glasshive.example/watch/prj_123?gh_token=secret).',
    );

    expect(result).toContain('report.docx');
    expect(result).toContain('View / Steer');
    expect(result).not.toContain('/v1/signed-links/');
    expect(result).not.toContain('gh_token=secret');
  });

  it('redacts bare signed links without mutating ordinary links', () => {
    const result = sanitizeLiveAnnouncementText(
      'Preview https://glasshive.example/v1/signed-links/abc123 and keep https://example.com/docs.',
    );

    expect(result).toContain('[signed link]');
    expect(result).toContain('https://example.com/docs');
    expect(result).not.toContain('/v1/signed-links/abc123');
  });
});
