import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allowlistedEnvironment, assertNoManifestAliases, removeTemp, verifyFixtureHash, withTempCleanup } from '../scripts/pack-test-utils.mjs'

describe('pack verifier negative checks', () => {
  const temporaryRoots = []
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('rejects aliases in every shipped dependency section and nested overrides', () => {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      expect(() => assertNoManifestAliases({ [section]: { fixture: 'file:../fixture.tgz' } }, section)).toThrow(/alias/)
    }
    expect(() => assertNoManifestAliases({ pnpm: { overrides: { fixture: { nested: 'workspace:*' } } } }, 'overrides')).toThrow(/workspace/)
    expect(() => assertNoManifestAliases({ dependencies: { fixture: '1.2.3' }, pnpm: { overrides: { fixture: '1.2.3' } } }, 'valid')).not.toThrow()
  })

  it('drops ambient secrets and package-manager settings from verifier children', () => {
    const environment = allowlistedEnvironment({
      PATH: '/bin',
      HOME: '/home/tester',
      USER: 'tester',
      LANG: 'C.UTF-8',
      TMP: '/tmp',
      CI: '1',
      NODE_PATH: '/leak',
      NODE_OPTIONS: '--require /leak',
      API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AUTH_TOKEN: 'secret',
      PASSWORD: 'secret',
      CREDENTIAL: 'secret',
      CLOUDSDK_CONFIG: '/secret',
      npm_config_registry: 'https://registry.example.invalid',
      NPM_CONFIG_USERCONFIG: '/secret/.npmrc',
      PNPM_HOME: '/secret/pnpm',
      COREPACK_HOME: '/secret/corepack',
      FORBIDDEN: 'drop-me',
      SystemRoot: 'root',
      USERPROFILE: 'profile',
    })
    expect(environment).toEqual({
      PATH: '/bin',
      HOME: '/home/tester',
      USER: 'tester',
      LANG: 'C.UTF-8',
      TMP: '/tmp',
      CI: '1',
      NODE_PATH: '',
      NODE_OPTIONS: '',
      SystemRoot: 'root',
      USERPROFILE: 'profile',
    })
  })

  it('refuses recursive cleanup through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ainvestor-negative-'))
    const target = mkdtempSync(join(tmpdir(), 'dsh-pack-outside-'))
    temporaryRoots.push(root, target)
    const link = join(root, 'dsh-ainvestor-link')
    symlinkSync(target, link, 'dir')
    const cleanup = removeTemp(link, 'symlink')
    expect(cleanup?.message).toMatch(/refusing unsafe cleanup path/)
    expect(existsSync(target)).toBe(true)
  })

  it('keeps the primary failure when cleanup is unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pack-outside-'))
    temporaryRoots.push(root)
    expect(() => withTempCleanup(root, 'unsafe cleanup', () => { throw new Error('primary failure') })).toThrow(/primary failure; cleanup failed/)
  })

  it('rejects a tampered fixture even when its filename is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pack-negative-'))
    temporaryRoots.push(root)
    const file = join(root, 'fixture.tgz')
    const original = Buffer.from('official fixture bytes')
    writeFileSync(file, original)
    const record = {
      bytes: original.byteLength,
      sha256: createHash('sha256').update(original).digest('hex'),
    }
    expect(() => verifyFixtureHash('fixture.tgz', file, record)).not.toThrow()
    writeFileSync(file, Buffer.from('tampered fixture bytes'))
    expect(() => verifyFixtureHash('fixture.tgz', file, record)).toThrow(/SHA-256 mismatch/)
  })
})
