/**
 * The Devin CLI credential import (`devin auth login` → `credentials.toml`).
 *
 * The probe order, the field name and the accepted API hosts are copied from the
 * pinned omp hook, so what is pinned here is the plugin's own reading of that
 * file: a flat TOML body, one required field, and a refusal for a key that was
 * issued for a host this route's requests would not authenticate with.
 */
import { describe, expect, it } from 'vitest'

import {
  DevinCliCredentialsError,
  devinCliCredentialPaths,
  parseDevinCliCredentials,
  readDevinCliCredentials,
} from '../src/devin/cli-credentials.js'

describe('devin CLI credentials', () => {
  it('probes the documented locations in order', () => {
    expect(devinCliCredentialPaths({ XDG_DATA_HOME: '/data' }, 'linux', '/home/me')).toEqual([
      '/data/devin/credentials.toml',
      '/home/me/.local/share/devin/credentials.toml',
      '/home/me/Library/Application Support/devin/credentials.toml',
    ])
    expect(devinCliCredentialPaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\devin\\credentials.toml',
      'C:\\Users\\me\\.local\\share\\devin\\credentials.toml',
    ])
  })

  it('reads the seat key out of a flat TOML body', () => {
    const text = [
      '# written by devin auth login',
      'windsurf_api_key = "sk-ws-0123456789"',
      'api_server_url = "https://server.codeium.com"',
      'expires_at = 1999999999',
    ].join('\n')
    expect(parseDevinCliCredentials(text, '/x/credentials.toml')).toBe('sk-ws-0123456789')
  })

  it('refuses a file with no key and one bound to an unsupported host', () => {
    expect(() => parseDevinCliCredentials('api_server_url = "https://server.codeium.com"', '/f')).toThrow(
      DevinCliCredentialsError,
    )
    expect(() =>
      parseDevinCliCredentials(
        ['windsurf_api_key = "sk-ws-x"', 'api_server_url = "https://self-hosted.example"'].join('\n'),
        '/f',
      ),
    ).toThrow(/unsupported API server/)
    // The enterprise host is accepted: it serves the same raw seat key.
    expect(
      parseDevinCliCredentials(
        ['windsurf_api_key = "sk-ws-x"', 'api_server_url = "https://server.enterprise.windsurf.com"'].join('\n'),
        '/f',
      ),
    ).toBe('sk-ws-x')
  })

  it('skips missing candidates and reports the ones it probed', async () => {
    await expect(readDevinCliCredentials(['/nonexistent/a.toml', '/nonexistent/b.toml'])).rejects.toThrow(
      /no Devin CLI credentials were found.*nonexistent\/a\.toml/s,
    )
  })
})
