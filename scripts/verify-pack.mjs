#!/usr/bin/env node
/**
 * Verify the dsh-ainvestor artifact, its exact fixture closure, and an isolated host install.
 *
 * The gate accepts only the recorded clean alpha.1 checkout tarballs and the recursively
 * required registry tarballs. It never creates package declarations or runtime stubs.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesRoot = join(root, 'fixtures', 'alpha1', 'tarballs')
const provenancePath = join(root, 'fixtures', 'alpha1', 'PROVENANCE.json')
const invalidRegistry = 'http://127.0.0.1:9/invalid-registry'
const registryUrl = 'https://registry.npmjs.org/'
const lifecyclePackageVersion = '0.1.0'

const expectedAlpha1 = Object.freeze({
  '@deepseek-ai/cordis': ['deepseek-ai-cordis-4.0.1.tgz', '4.0.1'],
  '@deepseek-ai/cosmokit': ['deepseek-ai-cosmokit-1.8.2.tgz', '1.8.2'],
  '@deepseek-ai/dsh-agent': ['deepseek-ai-dsh-agent-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-attachment': ['deepseek-ai-dsh-attachment-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-brand': ['deepseek-ai-dsh-brand-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-code-runtime': ['deepseek-ai-dsh-code-runtime-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-invariants': ['deepseek-ai-dsh-invariants-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-llm': ['deepseek-ai-dsh-llm-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-scope': ['deepseek-ai-dsh-scope-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-session': ['deepseek-ai-dsh-session-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-system-prompt': ['deepseek-ai-dsh-system-prompt-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-timeout': ['deepseek-ai-dsh-timeout-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-tools': ['deepseek-ai-dsh-tools-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-typert-protocol': ['deepseek-ai-dsh-typert-protocol-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-user-approval': ['deepseek-ai-dsh-user-approval-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/dsh-util-crypto': ['deepseek-ai-dsh-util-crypto-0.1.2-alpha.1.tgz', '0.1.2-alpha.1'],
  '@deepseek-ai/schemastery': ['deepseek-ai-schemastery-3.18.1.tgz', '3.18.1'],
  '@standard-schema/spec': ['standard-schema-spec-1.1.0.tgz', '1.1.0'],
  zod: ['zod-4.5.4.tgz', '4.5.4'],
})

const dependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
const runtimeDependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies']
// Vite browser entries import these IDs as virtual modules, not package files.
const virtualRuntimeSpecifiers = new Set(['@vite/client', '@vite/env'])
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

function allowlistedEnvironment(source = process.env, includePackageManager = false) {
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

function run(command, args, options = {}) {
  const { env, includePackageManager = false, ...spawnOptions } = options
  const source = env === undefined ? process.env : env
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...spawnOptions,
    env: allowlistedEnvironment(source, includePackageManager),
  })
}

function fail(message) {
  throw new Error(message)
}

function pass(message) {
  console.log('PASS ' + message)
}

function safeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function isMissingError(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT'
}

function cleanupFailure(message) {
  return new Error('dsh-ainvestor: ' + message)
}

function removeTemp(directory, label) {
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
    if (isMissingError(error)) return undefined
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
    if (isMissingError(error)) return undefined
    return cleanupFailure('could not clean temporary ' + label + ': ' + errorMessage(error))
  }
}

function combineCleanupErrors(primary, cleanup) {
  if (primary === undefined) return cleanup
  if (cleanup === undefined) return primary
  return new AggregateError([primary, cleanup], errorMessage(primary) + '; cleanup failed: ' + errorMessage(cleanup))
}

function withTempCleanup(directory, label, action, keep = () => false) {
  let result
  let primary
  try {
    result = action()
  } catch (error) {
    primary = error
  }
  const cleanup = primary === undefined && keep(result) ? undefined : removeTemp(directory, label)
  const failure = combineCleanupErrors(primary, cleanup)
  if (failure !== undefined) throw failure
  return result
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail('invalid JSON in ' + file + ': ' + errorMessage(error))
  }
}

function isUnshippableAlias(value) {
  return /^(?:file:|link:|workspace:|npm:)/i.test(value)
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
}

function assertNoManifestAliases(manifest, label) {
  if (manifest === null || typeof manifest !== 'object') fail(label + ' must be an object')
  for (const section of dependencySections) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      if (typeof value === 'string' && isUnshippableAlias(value)) {
        fail(label + ' contains an alias in ' + section + '.' + name + ': ' + value)
      }
    }
  }
  for (const [name, value] of Object.entries(manifest.pnpm?.overrides ?? {})) {
    assertNoAliasValues(value, label + ' pnpm.overrides.' + name)
  }
}

function assertNoAliasValues(value, label) {
  if (typeof value === 'string') {
    if (isUnshippableAlias(value)) fail(label + ': ' + value)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoAliasValues(entry, label + '.' + key)
  }
}

function assertSafeRelativePath(value, label, allowWildcard = false) {
  if (typeof value !== 'string' || value.length === 0) fail(label + ' must be a non-empty relative path')
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) fail(label + ' contains unsafe characters')
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail(label + ' must not be absolute: ' + value)
  if (value.split('/').some(part => part === '..' || part === '.')) fail(label + ' contains a traversal segment: ' + value)
  if (!allowWildcard && value.includes('*')) fail(label + ' must not contain a wildcard: ' + value)
  const parts = value.split('/')
  if (parts.some(part => part.length === 0)) fail(label + ' contains an empty path segment: ' + value)
}

function assertArchivePath(value, label) {
  if (value.endsWith('/')) {
    if (value === '/') fail(label + ' is an invalid archive path')
    assertSafeRelativePath(value.slice(0, -1), label, false)
    return
  }
  assertSafeRelativePath(value, label, false)
}

function assertUnignored(file, label) {
  const result = run('git', ['check-ignore', '--no-index', '--quiet', '--', relative(root, file)])
  if (result.status === 0) fail(label + ' is ignored by git: ' + file)
  if (result.status !== 1) fail('git check-ignore failed for ' + label + ': ' + (result.stderr || result.stdout).trim())
}

function readTarJson(tarball, entry) {
  const result = run('tar', ['xOf', tarball, entry])
  if (result.status !== 0) fail('cannot read ' + entry + ' from ' + tarball + ': ' + result.stderr.trim())
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail('invalid JSON in ' + entry + ': ' + errorMessage(error))
  }
}

function listTarArchive(tarball, label = tarball) {
  const listing = run('tar', ['tzf', tarball])
  if (listing.status !== 0) fail('tar listing failed for ' + label + ': ' + listing.stderr.trim())
  const names = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (names.length === 0) fail('tar archive is empty: ' + label)
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) fail('tar archive contains a duplicate path: ' + label + ': ' + name)
    seen.add(name)
    assertArchivePath(name, 'tar path in ' + label)
  }
  const verbose = run('tar', ['tvzf', tarball])
  if (verbose.status !== 0) fail('tar verbose listing failed for ' + label + ': ' + verbose.stderr.trim())
  const verboseLines = verbose.stdout.split(/\r?\n/).filter(Boolean)
  if (verboseLines.length !== names.length) fail('tar listing/report count mismatch for ' + label)
  for (let index = 0; index < verboseLines.length; index += 1) {
    const kind = verboseLines[index][0]
    if (kind !== '-' && kind !== 'd') fail('tar archive contains a non-file entry in ' + label + ': ' + names[index])
    if (kind === 'd' && !names[index].endsWith('/')) fail('tar directory entry lacks a trailing slash in ' + label + ': ' + names[index])
  }
  const roots = new Set(names.map(name => name.split('/')[0] + '/'))
  if (roots.size !== 1) fail('tar archive must have one root directory: ' + label)
  const rootPath = [...roots][0]
  const files = names.filter((_, index) => verboseLines[index][0] === '-')
  if (!files.includes(rootPath + 'package.json')) fail('tar archive lacks its root package.json: ' + label)
  return { entries: names, files, root: rootPath }
}

function hashFile(file) {
  const bytes = readFileSync(file)
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function verifyFixtureHash(filename, tarball, record) {
  if (!record || typeof record !== 'object') fail('missing hash record for fixture ' + filename)
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) fail('invalid byte record for fixture ' + filename)
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) fail('invalid SHA-256 record for fixture ' + filename)
  const actual = hashFile(tarball)
  if (actual.bytes !== record.bytes) fail('fixture size mismatch for ' + filename + ': expected ' + record.bytes + ', got ' + actual.bytes)
  if (actual.sha256 !== record.sha256) fail('fixture SHA-256 mismatch for ' + filename)
}

function packageNameFromImport(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function packageSubpath(specifier, packageName) {
  if (specifier === packageName) return null
  return './' + specifier.slice(packageName.length + 1)
}

function collectExportTargets(value, targets, label) {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) fail(label + ' export target must be relative: ' + value)
    targets.push(value)
    return
  }
  if (value === null || value === false) return
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, targets, label)
    return
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes('\\') || key.includes('..')) fail(label + ' contains an unsafe export key: ' + key)
      collectExportTargets(entry, targets, label)
    }
    return
  }
  fail(label + ' contains an invalid export target')
}

function missingExportGap(provenance, name, version, target) {
  return (provenance.upstreamArtifactGaps ?? []).some(gap => {
    if (gap.package !== name || gap.version !== version || gap.exportTarget !== target) return false
    return typeof gap.reason === 'string' && gap.reason.length > 0
  })
}

function wildcardMatches(files, rootPath, target) {
  const marker = target.indexOf('*')
  if (marker < 0) return files.includes(rootPath + target.slice(2))
  const prefix = rootPath + target.slice(2, marker)
  const suffix = target.slice(marker + 1)
  return files.some(file => file.startsWith(prefix) && file.endsWith(suffix))
}

function manifestTargetPath(rootPath, target, label) {
  const relativeTarget = target.startsWith('./') ? target.slice(2) : target
  assertSafeRelativePath(relativeTarget, label)
  return rootPath + relativeTarget
}

function inspectPackageTargets(name, manifest, archive, provenance) {
  const fields = ['main', 'module', 'browser', 'types', 'typings']
  for (const field of fields) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) continue
    const target = manifestTargetPath(archive.root, manifest[field], name + ' ' + field)
    if (!archive.files.includes(target)) fail(name + ' ' + field + ' target is absent: ' + manifest[field])
  }
  if (manifest.bin !== undefined) {
    const bins = typeof manifest.bin === 'string' ? { [name]: manifest.bin } : manifest.bin
    if (bins === null || typeof bins !== 'object' || Array.isArray(bins)) fail(name + ' bin must be a string or object')
    for (const [binName, target] of Object.entries(bins)) {
      const path = manifestTargetPath(archive.root, target, name + ' bin.' + binName)
      if (!archive.files.includes(path)) fail(name + ' bin target is absent: ' + target)
    }
  }
  if (manifest.exports === undefined) return
  const targets = []
  collectExportTargets(manifest.exports, targets, name)
  for (const target of new Set(targets)) {
    if (target.includes('*')) {
      if (!wildcardMatches(archive.files, archive.root, target) && !missingExportGap(provenance, name, manifest.version, target)) {
        fail(name + ' wildcard export target has no packaged files: ' + target)
      }
    } else if (!archive.files.includes(manifestTargetPath(archive.root, target, name + ' export'))) {
      if (!missingExportGap(provenance, name, manifest.version, target)) fail(name + ' export target is absent: ' + target)
    }
  }
}

function selectRuntimeTarget(entry, capture = '') {
  if (typeof entry === 'string') return entry.replaceAll('*', capture)
  if (entry === null || entry === false || typeof entry !== 'object') return null
  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const target = selectRuntimeTarget(candidate, capture)
      if (target !== null) return target
    }
    return null
  }
  for (const condition of ['import', 'node', 'default', 'require']) {
    if (Object.hasOwn(entry, condition)) {
      const target = selectRuntimeTarget(entry[condition], capture)
      if (target !== null) return target
    }
  }
  return null
}

function runtimeExportTarget(exports, subpath) {
  if (typeof exports === 'string') return subpath === '.' ? exports : null
  if (exports === null || exports === false || typeof exports !== 'object') return null
  if (subpath === '.' && !Object.keys(exports).some(key => key.startsWith('.'))) return selectRuntimeTarget(exports)
  if (Object.hasOwn(exports, subpath)) return selectRuntimeTarget(exports[subpath])
  for (const [key, value] of Object.entries(exports)) {
    const marker = key.indexOf('*')
    if (marker < 0) continue
    const prefix = key.slice(0, marker)
    const suffix = key.slice(marker + 1)
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const capture = subpath.slice(prefix.length, subpath.length - suffix.length)
      return selectRuntimeTarget(value, capture)
    }
  }
  return null
}

function runtimeEntryTarget(entry) {
  if (entry.manifest.exports !== undefined) return runtimeExportTarget(entry.manifest.exports, '.')
  if (typeof entry.manifest.main === 'string' && entry.manifest.main.length > 0) return entry.manifest.main
  if (typeof entry.manifest.module === 'string' && entry.manifest.module.length > 0) return entry.manifest.module
  return './index.js'
}

function runtimeInternalTarget(imports, specifier) {
  if (imports === null || typeof imports !== 'object') return null
  if (Object.hasOwn(imports, specifier)) return selectRuntimeTarget(imports[specifier])
  for (const [key, value] of Object.entries(imports)) {
    const marker = key.indexOf('*')
    if (marker < 0) continue
    const prefix = key.slice(0, marker)
    const suffix = key.slice(marker + 1)
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const capture = specifier.slice(prefix.length, specifier.length - suffix.length)
      return selectRuntimeTarget(value, capture)
    }
  }
  return null
}

function resolveRelativeImport(entry, file, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier))
  const rootWithoutSlash = entry.archive.root.slice(0, -1)
  if (target !== rootWithoutSlash && !target.startsWith(entry.archive.root)) fail(entry.name + ' relative runtime import escapes its archive: ' + specifier)
  const candidates = [target, target + '.js', target + '.mjs', target + '.cjs', target + '.json', target + '/index.js', target + '/index.mjs', target + '/index.cjs']
  if (target === rootWithoutSlash || target === entry.archive.root) {
    const runtimeTarget = runtimeEntryTarget(entry)
    if (typeof runtimeTarget === 'string' && !runtimeTarget.includes('*')) candidates.push(manifestTargetPath(entry.archive.root, runtimeTarget, entry.name + ' package root'))
  }
  const resolved = candidates.find(candidate => entry.archive.files.includes(candidate))
  if (resolved === undefined) fail(entry.name + ' relative runtime import is absent: ' + file + ' -> ' + specifier)
  return resolved
}

function collectRuntimeTargets(value, targets = []) {
  if (typeof value === 'string') {
    targets.push(value)
    return targets
  }
  if (value === null || value === false || value === undefined) return targets
  if (Array.isArray(value)) {
    for (const entry of value) collectRuntimeTargets(entry, targets)
    return targets
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.some(([key]) => key.startsWith('.'))) {
      for (const [key, entry] of entries) {
        if (key !== './package.json') collectRuntimeTargets(entry, targets)
      }
    } else {
      const target = selectRuntimeTarget(value, '*')
      if (target !== null && !target.includes('*')) targets.push(target)
    }
  }
  return targets
}

function runtimeFiles(entry) {
  const files = new Set()
  const queue = []
  const targets = entry.manifest.exports === undefined
    ? [runtimeEntryTarget(entry)]
    : collectRuntimeTargets(entry.manifest.exports)
  const hasMain = typeof entry.manifest.main === 'string' && entry.manifest.main.length > 0
  const hasModule = typeof entry.manifest.module === 'string' && entry.manifest.module.length > 0
  if (entry.manifest.exports === undefined
    && !hasMain
    && !hasModule
    && !entry.archive.files.includes(entry.archive.root + 'index.js')) return files
  if (targets.length === 0) return files
  for (const target of targets) {
    if (typeof target !== 'string') continue
    if (target.includes('*')) {
      const matches = entry.archive.files.filter(file => wildcardMatches([file], entry.archive.root, target))
      for (const archiveTarget of matches) queue.push(archiveTarget)
      continue
    }
    const archiveTarget = manifestTargetPath(entry.archive.root, target, entry.name + ' runtime entry')
    if (!entry.archive.files.includes(archiveTarget)) fail(entry.name + ' runtime entry target is absent: ' + target)
    queue.push(archiveTarget)
  }
  while (queue.length > 0) {
    const file = queue.shift()
    if (files.has(file) || !/\.(?:c|m)?js$/.test(file)) continue
    files.add(file)
    const source = stripJavaScriptComments(readFileSync(join(entry.destination, file), 'utf8'))
    for (const specifier of staticSpecifiers(source)) {
      if (specifier.startsWith('.')) queue.push(resolveRelativeImport(entry, file, specifier))
      else if (specifier.startsWith('#')) {
        const target = runtimeInternalTarget(entry.manifest.imports, specifier)
        if (target === null || target.includes('*')) fail(entry.name + ' internal runtime import is not mapped: ' + specifier)
        const archiveTarget = manifestTargetPath(entry.archive.root, target, entry.name + ' internal runtime import')
        if (!entry.archive.files.includes(archiveTarget)) fail(entry.name + ' internal runtime import target is absent: ' + specifier + ' -> ' + target)
        queue.push(archiveTarget)
      }
    }
  }
  return files
}

function runtimeImportTarget(entry, importedEntry, specifier) {
  const subpath = packageSubpath(specifier, importedEntry.name)
  if (subpath === null) return runtimeEntryTarget(importedEntry)
  if (importedEntry.manifest.exports !== undefined) return runtimeExportTarget(importedEntry.manifest.exports, subpath)
  return subpath
}

const importPatterns = [
  /(?:^|[;\n])\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  /(?:^|[;\n])\s*export\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"](?:\s*,[^)]*)?\)/g,
  /\brequire\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function stripJavaScriptComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '')
}

function isCodePosition(source, position) {
  let quote = null
  for (let index = 0; index < position; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '\'' || character === '"' || character === '\u0060') quote = character
  }
  return quote === null
}

function isCaughtOptionalImport(source, specifier) {
  const escaped = specifier.replace(/[.*+?^{}()|[\]\\]/g, '\\$&')
  const literal = '[' + "'\"" + ']'+escaped+'[' + "'\"" + ']'
  return new RegExp('try\\s*\\{[\\s\\S]{0,2000}(?:import|require)[^\\n]{0,200}'+literal+'[\\s\\S]{0,2000}\\}\\s*catch').test(source)
    || new RegExp('import\\.meta\\.require\\s*\\(\\s*'+literal).test(source)
}

function staticSpecifiers(source) {
  const result = new Set()
  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined && isCodePosition(source, match.index) && !match[1].includes('${')) result.add(match[1])
    }
  }
  return result
}

function inspectStaticClosure(packages) {
  const extractRoot = safeTemp('dsh-ainvestor-static-')
  return withTempCleanup(extractRoot, 'static closure', () => {
    for (const entry of packages.values()) {
      const destination = join(extractRoot, entry.name.replaceAll('/', '__'))
      mkdirSync(destination, { recursive: true })
      const result = run('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', entry.tarball, '-C', destination])
      if (result.status !== 0) fail('cannot extract fixture ' + entry.name + ': ' + result.stderr.trim())
      entry.destination = destination
    }
    for (const entry of packages.values()) {
      for (const file of runtimeFiles(entry)) {
        const source = stripJavaScriptComments(readFileSync(join(entry.destination, file), 'utf8'))
        for (const specifier of staticSpecifiers(source)) {
          if (specifier.startsWith('node:') || specifier.startsWith('data:') || builtinModules.includes(specifier) || virtualRuntimeSpecifiers.has(specifier)) continue
          if (specifier.startsWith('#')) {
            const target = runtimeInternalTarget(entry.manifest.imports, specifier)
            if (target === null || target.includes('*')) fail(entry.name + ' internal runtime import is not mapped: ' + specifier)
            const archiveTarget = manifestTargetPath(entry.archive.root, target, entry.name + ' internal runtime import')
            if (!entry.archive.files.includes(archiveTarget)) fail(entry.name + ' internal runtime import target is absent: ' + specifier + ' -> ' + target)
            continue
          }
          if (specifier.startsWith('.')) {
            resolveRelativeImport(entry, file, specifier)
            continue
          }
          const importedName = packageNameFromImport(specifier)
          const importedEntry = packages.get(importedName)
          if (importedEntry === undefined) {
            const optional = entry.manifest.peerDependenciesMeta?.[importedName]?.optional === true
              || Object.hasOwn(entry.manifest.optionalDependencies ?? {}, importedName)
              || isCaughtOptionalImport(source, specifier)
            if (optional) continue
            fail(entry.name + ' runtime import is outside fixture closure: ' + specifier)
          }
          const target = runtimeImportTarget(entry, importedEntry, specifier)
          if (target === null || typeof target !== 'string') fail(entry.name + ' runtime import is not exported: ' + specifier)
          if (target.includes('*')) fail(entry.name + ' runtime import did not resolve its wildcard: ' + specifier)
          const archiveTarget = manifestTargetPath(importedEntry.archive.root, target, importedName + ' runtime export')
          if (!importedEntry.archive.files.includes(archiveTarget)) {
            fail(entry.name + ' runtime import resolves to an unshipped target: ' + specifier + ' -> ' + target)
          }
        }
      }
    }
  })
}

function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? '' }
}

function parseRangeVersion(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] === undefined || /^[xX*]$/.test(match[2]) ? 0 : Number(match[2]),
    patch: match[3] === undefined || /^[xX*]$/.test(match[3]) ? 0 : Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

function upperForCaret(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: '' }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: '' }
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: '' }
}

function upperForTilde(version) {
  return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: '' }
}

function satisfiesRange(versionText, rangeText) {
  const version = parseVersion(versionText)
  if (version === null || typeof rangeText !== 'string') return false
  const alternatives = rangeText.split('||').map(value => value.trim()).filter(Boolean)
  if (alternatives.length === 0) return false
  return alternatives.some(alternative => {
    if (alternative === '*' || alternative === 'x' || alternative === 'X') return true
    const tokens = alternative.split(/\s+/).filter(Boolean)
    return tokens.every(token => {
      if (/^[xX*]$/.test(token)) return true
      if (/^[0-9]+(?:\.[xX*])?$/.test(token)) {
        const [major, minor] = token.split('.').map(Number)
        return version.major === major && (Number.isNaN(minor) || version.minor === minor)
      }
      let operator = ''
      let literal = token
      const operatorMatch = token.match(/^(\^|~|>=|<=|>|<|=)/)
      if (operatorMatch) {
        operator = operatorMatch[1]
        literal = token.slice(operator.length)
      }
      const lower = parseRangeVersion(literal)
      if (lower === null) return false
      const comparison = compareVersions(version, lower)
      if (operator === '^') return comparison >= 0 && compareVersions(version, upperForCaret(lower)) < 0
      if (operator === '~') return comparison >= 0 && compareVersions(version, upperForTilde(lower)) < 0
      if (operator === '>=') return comparison >= 0
      if (operator === '<=') return comparison <= 0
      if (operator === '>') return comparison > 0
      if (operator === '<') return comparison < 0
      return comparison === 0
    })
  })
}

function optionalPeer(manifest, name) {
  return manifest.peerDependenciesMeta?.[name]?.optional === true
}

function edgeValue(entry) {
  return entry === undefined ? null : entry.name + '@' + entry.manifest.version
}

function resolveDependencyEdges(ownerName, ownerVersion, manifest, packages, sections) {
  const result = {}
  for (const section of sections) {
    const edges = {}
    for (const [dependency, requested] of Object.entries(manifest[section] ?? {})) {
      const entry = packages.get(dependency)
      if (entry === undefined) {
        if (section === 'optionalDependencies' || section === 'peerDependencies') {
          edges[dependency] = null
          continue
        }
        fail(ownerName + '@' + ownerVersion + ' ' + section + ' is outside the fixture closure: ' + dependency)
      }
      if (!satisfiesRange(entry.manifest.version, requested)) {
        fail(ownerName + '@' + ownerVersion + ' edge ' + section + '.' + dependency + ' requests ' + requested + ' but fixture has ' + entry.manifest.version)
      }
      edges[dependency] = edgeValue(entry)
    }
    result[section] = edges
  }
  return result
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
  }
  return value
}

function readProvenance() {
  if (!existsSync(provenancePath)) fail('missing fixture provenance manifest ' + provenancePath)
  assertUnignored(provenancePath, 'fixture provenance manifest')
  const provenance = readJson(provenancePath)
  if (provenance.schemaVersion !== 2 || provenance.fixtureSet !== 'clean-alpha1+registry') {
    fail('fixture provenance must declare schemaVersion 2 and clean-alpha1+registry')
  }
  if (provenance.source?.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git'
    || provenance.source?.tag !== 'dsh-v0.1.2-alpha.1'
    || provenance.source?.commit !== 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
    || provenance.source?.cleanCheckout !== true
    || provenance.source?.packagesBuiltFromThisCheckout !== true) {
    fail('fixture provenance does not identify a clean official alpha.1 checkout')
  }
  if (provenance.registry?.url !== registryUrl || provenance.registry?.recursive !== true || typeof provenance.registry?.platform !== 'string') {
    fail('fixture provenance does not identify the recursive registry fixture source')
  }
  if (provenance.tarballs === null || typeof provenance.tarballs !== 'object' || Array.isArray(provenance.tarballs)) {
    fail('fixture provenance tarballs must be an object')
  }
  const gaps = provenance.upstreamArtifactGaps
  if (!Array.isArray(gaps)) fail('fixture provenance must record upstream artifact gaps as an array')
  const gapKeys = new Set()
  for (const gap of gaps) {
    if (gap === null || typeof gap !== 'object' || typeof gap.package !== 'string' || typeof gap.version !== 'string' || typeof gap.exportTarget !== 'string' || typeof gap.reason !== 'string' || !gap.exportTarget.startsWith('./')) {
      fail('fixture provenance contains an invalid upstream artifact gap')
    }
    const key = gap.package + '@' + gap.version + ':' + gap.exportTarget
    if (gapKeys.has(key)) fail('fixture provenance contains a duplicate upstream artifact gap: ' + key)
    gapKeys.add(key)
  }
  return provenance
}

function listFixtureFiles() {
  if (!existsSync(fixturesRoot)) fail('missing fixture tarball directory ' + fixturesRoot)
  const files = []
  for (const entry of readdirSync(fixturesRoot, { withFileTypes: true })) {
    const file = join(fixturesRoot, entry.name)
    if (entry.isSymbolicLink() || !entry.isFile()) fail('fixture directory contains a non-file entry: ' + entry.name)
    if (!entry.name.endsWith('.tgz')) fail('fixture directory contains a non-tarball file: ' + entry.name)
    assertSafeRelativePath(entry.name, 'fixture filename')
    assertUnignored(file, 'fixture tarball')
    files.push(entry.name)
  }
  return files.sort()
}

function inspectFixtureClosure() {
  const provenance = readProvenance()
  const files = listFixtureFiles()
  const expectedFiles = new Set(Object.keys(provenance.tarballs))
  if (files.length !== expectedFiles.size || files.some(file => !expectedFiles.has(file))) {
    const actual = new Set(files)
    const missing = [...expectedFiles].filter(file => !actual.has(file))
    const extra = files.filter(file => !expectedFiles.has(file))
    fail('fixture inventory is not exact; missing=' + missing.join(',') + ' extra=' + extra.join(','))
  }
  for (const [name, [filename, version]] of Object.entries(expectedAlpha1)) {
    const record = provenance.tarballs[filename]
    if (record?.source !== 'alpha1' || record.package !== name || record.version !== version) {
      fail('official alpha.1 provenance record is missing or mismatched: ' + filename)
    }
  }
  const packages = new Map()
  for (const filename of files) {
    const record = provenance.tarballs[filename]
    if (record === null || typeof record !== 'object') fail('missing provenance record for ' + filename)
    if (record.source !== 'alpha1' && record.source !== 'registry') fail('invalid fixture source for ' + filename)
    if (record.source === 'alpha1' && expectedAlpha1[record.package]?.[0] !== filename) fail('unlisted alpha.1 package in fixture: ' + filename)
    if (record.source === 'registry' && expectedAlpha1[record.package] !== undefined) fail('official package is mislabeled as registry: ' + filename)
    const tarball = join(fixturesRoot, filename)
    verifyFixtureHash(filename, tarball, record)
    const archive = listTarArchive(tarball, filename)
    if (record.tarRoot !== archive.root) fail('tar root mismatch for ' + filename + ': expected ' + record.tarRoot + ', got ' + archive.root)
    const manifest = readTarJson(tarball, archive.root + 'package.json')
    if (manifest.name !== record.package || manifest.version !== record.version) {
      fail('fixture provenance mismatch for ' + filename + ': got ' + manifest.name + '@' + manifest.version)
    }
    inspectPackageTargets(manifest.name, manifest, archive, provenance)
    if (packages.has(manifest.name)) fail('fixture closure contains multiple versions of ' + manifest.name)
    packages.set(manifest.name, { name: manifest.name, manifest, archive, tarball })
  }
  const sourceManifest = readJson(join(root, 'package.json'))
  assertNoManifestAliases(sourceManifest, 'source package manifest')
  const rootKey = sourceManifest.name + '@' + sourceManifest.version
  const rootEdges = resolveDependencyEdges(sourceManifest.name, sourceManifest.version, sourceManifest, packages, dependencySections)
  const reachable = new Set()
  const queue = []
  for (const section of dependencySections) {
    for (const dependency of Object.keys(sourceManifest[section] ?? {})) queue.push(dependency)
  }
  while (queue.length > 0) {
    const name = queue.shift()
    if (reachable.has(name)) continue
    const entry = packages.get(name)
    if (entry === undefined) fail('root dependency is outside the fixture closure: ' + name)
    reachable.add(name)
    const edges = resolveDependencyEdges(entry.name, entry.manifest.version, entry.manifest, packages, runtimeDependencySections)
    entry.edges = edges
    for (const section of runtimeDependencySections) {
      for (const dependency of Object.keys(entry.manifest[section] ?? {})) {
        if (packages.has(dependency) && !reachable.has(dependency)) queue.push(dependency)
      }
    }
  }
  if (reachable.size !== packages.size) {
    const unreachable = [...packages.keys()].filter(name => !reachable.has(name))
    fail('fixture closure contains unreachable tarballs: ' + unreachable.join(', '))
  }
  const edges = { [rootKey]: rootEdges }
  for (const entry of packages.values()) edges[entry.name + '@' + entry.manifest.version] = entry.edges
  if (canonical(provenance.edges) === undefined || JSON.stringify(canonical(provenance.edges)) !== JSON.stringify(canonical(edges))) {
    fail('fixture provenance versioned dependency edges do not match package manifests')
  }
  inspectStaticClosure(packages)
  pass('exact unignored alpha.1 and registry fixture hashes, tar paths, targets, and versioned closure verified (' + packages.size + ' packages)')
  pass('recursive static runtime closure is local and every imported target is shipped')
  return { provenance, packages, rootEdges }
}

function seedCorepackCache(home) {
  const sourceHome = process.env.HOME
  const source = process.env.COREPACK_HOME ?? (sourceHome === undefined ? undefined : join(sourceHome, '.cache', 'node', 'corepack'))
  if (source === undefined || !existsSync(source)) return
  const target = join(home, '.cache', 'node', 'corepack')
  if (resolve(source) === resolve(target)) return
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, force: true })
}

function scrubEnvironment(directory, userconfig) {
  const home = join(directory, 'home')
  const cache = join(directory, 'cache')
  const store = join(directory, 'store')
  const temporary = join(directory, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(store, { recursive: true })
  mkdirSync(temporary, { recursive: true })
  seedCorepackCache(home)
  const environment = allowlistedEnvironment()
  environment.HOME = home
  environment.TMP = temporary
  environment.TEMP = temporary
  const isolatedUserconfig = userconfig ?? join(directory, 'userconfig')
  if (!existsSync(isolatedUserconfig)) writeFileSync(isolatedUserconfig, 'registry=' + invalidRegistry + '\n')
  const isolatedGlobalconfig = join(directory, 'globalconfig')
  writeFileSync(isolatedGlobalconfig, '')
  for (const [name, value] of [
    ['userconfig', isolatedUserconfig],
    ['globalconfig', isolatedGlobalconfig],
    ['cache', cache],
    ['store_dir', store],
    ['registry', invalidRegistry],
    ['offline', 'true'],
    ['audit', 'false'],
    ['fund', 'false'],
  ]) {
    environment['npm_config_' + name] = value
    environment['NPM_CONFIG_' + name.toUpperCase()] = value
  }
  return environment
}

function reportPath(reportPathValue, packDir) {
  if (typeof reportPathValue !== 'string' || reportPathValue.length === 0) fail('pnpm pack report filename is missing')
  const resolvedPath = resolve(reportPathValue)
  if (resolve(dirname(resolvedPath)) !== resolve(packDir)) fail('pnpm pack report filename escaped pack directory: ' + reportPathValue)
  return resolvedPath
}

function packPlugin() {
  const sourceManifest = readJson(join(root, 'package.json'))
  assertNoManifestAliases(sourceManifest, 'source package manifest')
  if (sourceManifest.name !== 'dsh-ainvestor' || sourceManifest.version !== lifecyclePackageVersion || sourceManifest.private === true || sourceManifest.publishConfig?.access !== 'public') {
    fail('plugin must be a public release dsh-ainvestor@' + lifecyclePackageVersion)
  }
  if (!existsSync(join(root, 'lib', 'index.js')) || !existsSync(join(root, 'lib', 'types', 'index.d.ts'))) {
    fail('build artifacts missing; run pnpm run build first')
  }
  const packDir = safeTemp('dsh-ainvestor-pack-')
  return withTempCleanup(packDir, 'plugin pack', () => {
    const userconfig = join(packDir, '.npmrc')
    writeFileSync(userconfig, 'registry=' + invalidRegistry + '\n')
    const result = run('pnpm', ['pack', '--pack-destination', packDir, '--json'], { env: scrubEnvironment(packDir, userconfig), includePackageManager: true })
    if (result.status !== 0) fail('pnpm pack failed: ' + (result.stderr || result.stdout).trim())
    if (/warn|deprecated/i.test(result.stderr)) fail('pnpm pack emitted a warning: ' + result.stderr.trim())
    let report
    try {
      report = JSON.parse(result.stdout)
    } catch (error) {
      fail('pnpm pack did not return JSON: ' + errorMessage(error))
    }
    if (report === null || typeof report !== 'object' || Array.isArray(report)) fail('pnpm pack report must be one JSON object')
    const reportKeys = Object.keys(report).sort().join(',')
    if (reportKeys !== 'filename,files,name,version') fail('pnpm pack report fields changed: ' + reportKeys)
    if (report.name !== sourceManifest.name || report.version !== sourceManifest.version) fail('pnpm pack report package identity mismatch')
    if (!Array.isArray(report.files) || report.files.length === 0) fail('pnpm pack report files are missing')
    const reportFiles = new Set()
    for (const file of report.files) {
      if (file === null || typeof file !== 'object' || Object.keys(file).some(key => key !== 'path') || typeof file.path !== 'string') {
        fail('pnpm pack report contains an invalid file record')
      }
      assertSafeRelativePath(file.path, 'pnpm pack report path')
      if (reportFiles.has(file.path)) fail('pnpm pack report contains a duplicate path: ' + file.path)
      reportFiles.add(file.path)
    }
    const tarball = reportPath(report.filename, packDir)
    if (!existsSync(tarball)) fail('pnpm pack report tarball is absent: ' + tarball)
    const archive = listTarArchive(tarball, 'plugin tarball')
    const expectedFiles = new Set([...reportFiles].map(file => archive.root + file))
    const actualFiles = new Set(archive.files)
    if (expectedFiles.size !== actualFiles.size || [...expectedFiles].some(file => !actualFiles.has(file))) {
      fail('plugin tarball files differ from pnpm pack report')
    }
    for (const file of archive.entries) {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts')) fail('plugin tarball contains source TypeScript: ' + file)
      if (file.includes('/src/') || file.includes('node_modules') || file.includes('.env') || file.includes('Workstation/')) {
        fail('plugin tarball contains forbidden path: ' + file)
      }
    }
    const manifest = readTarJson(tarball, archive.root + 'package.json')
    assertNoManifestAliases(manifest, 'packed plugin manifest')
    if (manifest.name !== sourceManifest.name || manifest.version !== lifecyclePackageVersion || manifest.private === true || manifest.publishConfig?.access !== 'public') {
      fail('packed plugin identity/publication flag changed')
    }
    if (manifest.peerDependencies?.['@deepseek-ai/cordis'] !== '^4.0.1') fail('plugin Cordis peer range changed')
    if (manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] !== '0.1.2-alpha.1') fail('plugin tools peer must be alpha.1')
    if (manifest.peerDependencies?.['@deepseek-ai/dsh-system-prompt'] !== '0.1.2-alpha.1') fail('plugin prompt peer must be alpha.1')
    if (Object.keys(manifest.dependencies ?? {}).length !== 0) fail('plugin must not hide runtime dependencies')
    const digest = hashFile(tarball)
    pass('strict pnpm pack report, tar paths, targets, package identity, and static package contents verified')
    pass('plugin tgz ' + tarball + ' bytes=' + digest.bytes + ' sha256=' + digest.sha256)
    return { tarball, packDir, digest }
  }, () => true)
}

function installOffline(pluginTarball, fixtures) {
  const consumerDir = safeTemp('dsh-ainvestor-consumer-')
  return withTempCleanup(consumerDir, 'offline consumer', () => {
    const npmrc = join(consumerDir, '.npmrc')
    writeFileSync(npmrc, 'registry=' + invalidRegistry + '\n@deepseek-ai:registry=' + invalidRegistry + '\n')
    const dependencies = { 'dsh-ainvestor': 'file:' + pluginTarball }
    const overrides = { 'dsh-ainvestor': 'file:' + pluginTarball }
    for (const entry of fixtures.packages.values()) {
      dependencies[entry.name] = 'file:' + entry.tarball
      overrides[entry.name] = 'file:' + entry.tarball
    }
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
      name: 'dsh-ainvestor-offline-consumer',
      version: '0.0.0',
      private: false,
      type: 'module',
      dependencies: Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))),
    }, null, 2) + '\n')
    const overrideLines = ['overrides:']
    for (const [name, target] of Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))) {
      overrideLines.push('  ' + JSON.stringify(name) + ': ' + JSON.stringify(target))
    }
    writeFileSync(join(consumerDir, 'pnpm-workspace.yaml'), overrideLines.join('\n') + '\n')
    const environment = scrubEnvironment(consumerDir, npmrc)
    const install = run('pnpm', ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile', '--registry', invalidRegistry], {
      cwd: consumerDir,
      env: environment,
      includePackageManager: true,
    })
    if (install.status !== 0) {
      console.error(install.stdout)
      console.error(install.stderr)
      fail('fresh scoped pnpm install failed in offline invalid-registry mode')
    }
    const installedPlugin = join(consumerDir, 'node_modules', 'dsh-ainvestor', 'lib', 'index.js')
    if (!existsSync(installedPlugin)) fail('offline pnpm install did not materialize plugin lib')
    const hostCheck = join(consumerDir, 'host-check.mjs')
    const hostLines = [
      "import * as plugin from 'dsh-ainvestor'",
      "import * as tools from '@deepseek-ai/dsh-tools'",
      "import * as prompt from '@deepseek-ai/dsh-system-prompt'",
      "import * as toolsInvariant from '@deepseek-ai/dsh-tools/invariant'",
      "import * as promptInvariant from '@deepseek-ai/dsh-system-prompt/invariant'",
      "import * as invariantsInvariant from '@deepseek-ai/dsh-invariants/invariant'",
      "if (process.env.NODE_PATH !== '' || process.env.NODE_OPTIONS !== '') throw new Error('unscrubbed node environment')",
      "if (plugin.name !== 'dsh-ainvestor' || typeof plugin.apply !== 'function') throw new Error('plugin export failed')",
      "if (typeof tools.defineTool !== 'function' || typeof prompt.SystemPrompt !== 'function') throw new Error('official host exports failed')",
      "const toolNames = ['ainvestor_analysis_card','ainvestor_bars','ainvestor_chan','ainvestor_data_health','ainvestor_dupont','ainvestor_factor_profile','ainvestor_financials','ainvestor_fscore','ainvestor_screen','ainvestor_search_knowledge','ainvestor_stock_snapshot','ainvestor_valuation','ainvestor_volume_price']",
      'const registered = []',
      'const disposed = []',
      'let lifecycleDispose',
      'const ctx = {',
      '  effect(factory) { lifecycleDispose = factory(); return lifecycleDispose },',
      '  tools: { register(definition) { registered.push(definition); return async () => { disposed.push(definition.name) } } },',
      '  systemPrompt: { section(section) { return async () => { disposed.push(section.name) } } },',
      '}',
      "globalThis.fetch = async () => new Response('{}', { status: 200 })",
      "await plugin.apply(ctx, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })",
      "const names = registered.map(definition => definition.name).sort()",
      "if (registered.length !== 13 || JSON.stringify(names) !== JSON.stringify([...toolNames].sort())) throw new Error('host apply did not register exactly 13 tools: ' + JSON.stringify(names))",
      "const invariantNames = []",
      "const invariantCtx = { invariants: { register(name, install) { if (typeof install !== 'function') throw new Error('invariant installer missing'); invariantNames.push(name); return () => {} } } }",
      'await toolsInvariant.apply(invariantCtx)',
      'await promptInvariant.apply(invariantCtx)',
      'await invariantsInvariant.apply(invariantCtx)',
      "if (JSON.stringify(invariantNames.sort()) !== JSON.stringify(['@deepseek-ai/dsh-invariants','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools'].sort())) throw new Error('official invariant apply failed: ' + JSON.stringify(invariantNames))",
      'await lifecycleDispose()',
      "if (disposed.length !== 14) throw new Error('host lifecycle disposer did not release tools and prompt')",
      "const resolved = import.meta.resolve('dsh-ainvestor')",
      "if (resolved.includes('/src/') || resolved.includes('/Workstation/dsh-ainvestor/')) throw new Error('host resolved source checkout: ' + resolved)",
      "console.log('host apply/invariant ok', JSON.stringify({ resolved, tools: names, invariants: invariantNames }))",
    ]
    writeFileSync(hostCheck, hostLines.join('\n') + '\n')
    const host = run('node', [hostCheck], { cwd: consumerDir, env: environment })
    if (host.status !== 0) {
      console.error(host.stdout)
      console.error(host.stderr)
      fail('installed host apply/invariant check failed without NODE_PATH')
    }
    console.log(host.stdout.trim())
    pass('fresh scoped pnpm install succeeded offline against invalid registry with scrubbed environment')
    pass('installed host apply/invariant check registered exactly 13 tools from packed plugin')
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const fixtures = inspectFixtureClosure()
    const packed = packPlugin()
    withTempCleanup(packed.packDir, 'plugin pack', () => installOffline(packed.tarball, fixtures))
    console.log(JSON.stringify({
      artifact: 'dsh-ainvestor',
      version: lifecyclePackageVersion,
      private: false,
      fixtures: fixtures.packages.size,
      pluginTgz: packed.digest,
    }))
    console.log('All artifact gate checks passed')
  } catch (error) {
    console.error('FAIL ' + errorMessage(error))
    process.exitCode = 1
  }
}

export {
  allowlistedEnvironment,
  removeTemp,
  withTempCleanup,
  assertNoManifestAliases,
  assertSafeRelativePath,
  inspectFixtureClosure,
  installOffline,
  listTarArchive,
  packPlugin,
  satisfiesRange,
  verifyFixtureHash,
}
