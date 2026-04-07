/* === VIVENTIUM START ===
 * Feature: Guard the Vite dev proxy target against public remote origins.
 *
 * Purpose:
 * - Verify that remote-access browser URLs do not replace the local backend proxy target.
 *
 * Details: docs/requirements_and_learnings/47_Remote_Access_and_Tunneling.md
 * Added: 2026-04-04
 */
import {
  hostnameFromUrl,
  isLoopbackHostname,
  parsePortFromUrl,
  resolveAllowedHosts,
  resolveBackendUrl,
} from './devProxy';

describe('devProxy helpers', () => {
  it('parses ports from valid URLs', () => {
    expect(parsePortFromUrl('https://api.example.com:8443')).toBe(8443);
    expect(parsePortFromUrl(undefined)).toBeUndefined();
  });

  it('extracts hostnames from valid URLs', () => {
    expect(hostnameFromUrl('https://app.example.com:4443')).toBe('app.example.com');
    expect(hostnameFromUrl('not-a-url')).toBeUndefined();
  });

  it('detects loopback hostnames', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('api.example.com')).toBe(false);
  });

  it('keeps loopback DOMAIN_SERVER values as the proxy target', () => {
    expect(resolveBackendUrl({ DOMAIN_SERVER: 'http://localhost:3180' })).toBe(
      'http://localhost:3180',
    );
  });

  it('prefers an explicit local proxy target over a public DOMAIN_SERVER', () => {
    expect(
      resolveBackendUrl({
        DOMAIN_SERVER: 'https://api.mesh.example:8443',
        VIVENTIUM_FRONTEND_PROXY_TARGET: 'http://localhost:3180',
      }),
    ).toBe('http://localhost:3180');
  });

  it('derives a local backend target when DOMAIN_SERVER is public but launcher ports are set', () => {
    expect(
      resolveBackendUrl({
        DOMAIN_SERVER: 'https://api.mesh.example:8443',
        BACKEND_PORT: '3180',
      }),
    ).toBe('http://localhost:3180');
  });

  it('falls back to the public DOMAIN_SERVER only when no local backend target exists', () => {
    expect(resolveBackendUrl({ DOMAIN_SERVER: 'https://api.mesh.example:8443' })).toBe(
      'https://api.mesh.example:8443',
    );
  });

  it('adds configured public client hosts to Vite allowed hosts', () => {
    expect(
      resolveAllowedHosts({
        VITE_ALLOWED_HOSTS: 'localhost,127.0.0.1',
        DOMAIN_CLIENT: 'https://app.mesh.example:4443',
        VIVENTIUM_PUBLIC_CLIENT_URL: 'https://app.backup.example:4443',
      }),
    ).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', 'app.mesh.example', 'app.backup.example']),
    );
  });
});
/* === VIVENTIUM END === */
