import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'

const childEnvironmentNames = [
  'PATH', 'HOME', 'USER', 'LANG', 'TMP', 'TEMP', 'CI',
  'SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
]
const packageManagerEnvironmentNames = [
  'npm_config_userconfig', 'NPM_CONFIG_USERCONFIG',
  'npm_config_globalconfig', 'NPM_CONFIG_GLOBALCONFIG',
  'npm_config_registry', 'NPM_CONFIG_REGISTRY',
  'npm_config_cache', 'NPM_CONFIG_CACHE',
  'npm_config_store_dir', 'NPM_CONFIG_STORE_DIR',
  'npm_config_offline', 'NPM_CONFIG_OFFLINE',
  'npm_config_audit', 'NPM_CONFIG_AUDIT',
  'npm_config_fund', 'NPM_CONFIG_FUND',
]

function sourceEnvironmentValue(source, name) {
  const sourceName = Object.keys(source).find(key => key.toUpperCase() === name.toUpperCase())
  return sourceName === undefined ? undefined : source[sourceName]
}

/** Return a child process environment without ambient secrets or settings. */
export function allowlistedEnvironment(source = process.env, includePackageManager = false) {
  const environment = {}
  const names = includePackageManager ? [...childEnvironmentNames, ...packageManagerEnvironmentNames] : childEnvironmentNames
  for (const name of names) {
    const value = sourceEnvironmentValue(source, name)
    if (typeof value === 'string') environment[name] = value
  }
  environment.NODE_PATH = ''
  environment.NODE_OPTIONS = ''
  return environment
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function cleanupFailure(message) {
  return new Error('dsh-ainvestor: ' + message)
}

/** Remove a temporary verifier directory only when its path remains safe. */
export function removeTemp(directory, label) {
  const resolvedDirectory = resolve(directory)
  let temporaryRoot
  let realDirectory
  try {
    temporaryRoot = realpathSync(tmpdir())
    const directoryStat = lstatSync(resolvedDirectory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return cleanupFailure('refusing unsafe cleanup path for ' + label + ': ' + directory)
    }
    realDirectory = realpathSync(resolvedDirectory)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    return cleanupFailure('could not inspect temporary ' + label + ': ' + errorMessage(error))
  }
  const rootPrefix = temporaryRoot.endsWith(sep) ? temporaryRoot : temporaryRoot + sep
  const comparableRoot = process.platform === 'win32' ? rootPrefix.toLowerCase() : rootPrefix
  const comparableDirectory = process.platform === 'win32' ? realDirectory.toLowerCase() : realDirectory
  if (!comparableDirectory.startsWith(comparableRoot) || !/^dsh-ainvestor-[^/\\]+$/.test(basename(realDirectory))) {
    return cleanupFailure('refusing unsafe cleanup path for ' + label + ': ' + directory)
  }
  try {
    const currentStat = lstatSync(resolvedDirectory)
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      return cleanupFailure('temporary ' + label + ' changed to a non-directory path: ' + directory)
    }
    if (realpathSync(resolvedDirectory) !== realDirectory) {
      return cleanupFailure('temporary ' + label + ' changed its real path: ' + directory)
    }
    rmSync(resolvedDirectory, { recursive: true, force: true })
    return undefined
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    return cleanupFailure('could not clean temporary ' + label + ': ' + errorMessage(error))
  }
}

/** Run an action and preserve both primary and cleanup failures. */
export function withTempCleanup(directory, label, action, keep = () => false) {
  let result
  let primary
  try {
    result = action()
  } catch (error) {
    primary = error
  }
  const cleanup = primary === undefined && keep(result) ? undefined : removeTemp(directory, label)
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], errorMessage(primary) + '; cleanup failed: ' + errorMessage(cleanup))
  if (primary !== undefined) throw primary
  if (cleanup !== undefined) throw cleanup
  return result
}

function isUnshippableAlias(value) {
  return /^(?:file:|link:|workspace:|npm:)/i.test(value)
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
}

function assertNoAliasValues(value, label) {
  if (typeof value === 'string') {
    if (isUnshippableAlias(value)) throw new Error(label + ': ' + value)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoAliasValues(entry, label + '.' + key)
  }
}

/** Reject local aliases in every dependency section and nested override. */
export function assertNoManifestAliases(manifest, label) {
  if (manifest === null || typeof manifest !== 'object') throw new Error(label + ' must be an object')
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      if (typeof value === 'string' && isUnshippableAlias(value)) throw new Error(label + ' contains an alias in ' + section + '.' + name + ': ' + value)
    }
  }
  for (const [name, value] of Object.entries(manifest.pnpm?.overrides ?? {})) assertNoAliasValues(value, label + ' pnpm.overrides.' + name)
}

/** Verify a fixture's recorded byte count and SHA-256 digest. */
export function verifyFixtureHash(filename, tarball, record) {
  if (!record || typeof record !== 'object') throw new Error('missing hash record for fixture ' + filename)
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) throw new Error('invalid byte record for fixture ' + filename)
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error('invalid SHA-256 record for fixture ' + filename)
  const bytes = readFileSync(tarball)
  const actual = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
  if (actual.bytes !== record.bytes) throw new Error('fixture size mismatch for ' + filename + ': expected ' + record.bytes + ', got ' + actual.bytes)
  if (actual.sha256 !== record.sha256) throw new Error('fixture SHA-256 mismatch for ' + filename)
}

