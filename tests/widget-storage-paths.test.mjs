import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { beijingDay, dayOffset } from '../vendor/widget/lib/accounting.mjs'

const source = readFileSync(new URL('../vendor/widget/lib/index.js', import.meta.url), 'utf8')
const fixtureRoot = path.resolve(path.sep, 'widget-storage-fixture')
const fixtureLaunch = path.join(fixtureRoot, 'launch')
const fixtureHome = path.join(fixtureRoot, 'dsh-home')
const fixtureUser = path.join(fixtureRoot, 'user')
const prelude = source.slice(source.indexOf('const PACKAGE_ROOT ='), source.indexOf('export default'))
  .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(fixtureRoot, 'package', 'lib', 'index.js')).href))
const functionNames = [
  'writeTurnSeq', 'ledgerIo', 'writeUsageLedger', 'usageArchivePath', 'readUsageArchive', 'pruneLedgerUsage',
  'todayKey', 'dayAdd', 'writeApiRegistry', 'normalizeUsageMode', 'writeSizeConfig',
  'pickRoleDir', 'writeRolesIndex', 'pickAudioDir', 'writeAudioIndex',
  'pickBubbleImgDir', 'writeBubbleImgIndex', 'writeBubbleConfig',
]

function productionFunction(name) {
  const start = source.indexOf('    function ' + name + '(')
  assert.ok(start >= 0, 'storage function is available: ' + name)
  const firstLineEnd = source.indexOf('\n', start)
  if (source.slice(start, firstLineEnd).endsWith(' }')) return source.slice(start, firstLineEnd)
  const end = source.indexOf('\n    }', start)
  assert.ok(end > start, 'storage function has a complete body: ' + name)
  return source.slice(start, end + 6)
}

// Execute production storage operations with filesystem access isolated in memory.
// The working directory stays writable so an unintended fallback is observable.
function storageFixture({ homeWritable = true, webWritable = true, dshHome = fixtureHome } = {}) {
  let cwd = fixtureLaunch
  const home = path.resolve(cwd, dshHome || path.join(fixtureUser, '.dsh'))
  const web = path.join(home, 'profiles', 'web')
  const files = new Map()
  const directories = new Set([cwd, home, web])
  const attempts = []
  function resolved(file) { return path.resolve(cwd, String(file)) }
  function inside(root, file) { return file === root || file.startsWith(root + path.sep) }
  function writable(file) {
    if (inside(web, file)) return webWritable
    if (inside(home, file)) return homeWritable
    return true
  }
  function access(file, operation) {
    const target = resolved(file)
    attempts.push({ operation, input: file, target })
    if (!writable(target)) throw Object.assign(new Error('storage is not writable'), { code: 'EACCES' })
    return target
  }
  const fs = {
    constants: { W_OK: 2, COPYFILE_EXCL: 1 },
    mkdirSync(file) { directories.add(access(file, 'mkdir')) },
    accessSync(file) {
      const target = access(file, 'access')
      if (!directories.has(target) && !files.has(target)) throw Object.assign(new Error('missing path'), { code: 'ENOENT' })
    },
    existsSync(file) { return files.has(resolved(file)) || directories.has(resolved(file)) },
    readFileSync(file) {
      const target = resolved(file)
      if (!files.has(target)) throw Object.assign(new Error('missing file'), { code: 'ENOENT' })
      return files.get(target)
    },
    writeFileSync(file, body) {
      const target = access(file, 'write')
      if (!directories.has(path.dirname(target))) throw Object.assign(new Error('missing parent'), { code: 'ENOENT' })
      files.set(target, String(body))
    },
    renameSync(from, to) {
      const target = access(to, 'rename')
      const previous = resolved(from)
      if (!files.has(previous)) throw Object.assign(new Error('missing file'), { code: 'ENOENT' })
      files.set(target, files.get(previous))
      files.delete(previous)
    },
    unlinkSync(file) { files.delete(resolved(file)) },
  }
  const operations = runInNewContext(prelude + '\n' + functionNames.map(productionFunction).join('\n')
    + '\n({writeTurnSeq, writeUsageLedger, pruneLedgerUsage, writeApiRegistry, writeSizeConfig, writeRolesIndex, writeAudioIndex, writeBubbleImgIndex, writeBubbleConfig})', {
    fs, os: { homedir: () => fixtureUser },
    path: { ...path, resolve: (...parts) => path.resolve(cwd, ...parts) }, fileURLToPath,
    process: { env: dshHome === null ? {} : { DSH_HOME: dshHome }, pid: 17 },
    console: { error() {} }, Atomics: { wait() {} }, beijingDay, dayOffset,
  })
  return {
    operations, files, attempts, home, web,
    changeCwd() { cwd = path.join(fixtureRoot, 'later'); directories.add(cwd) },
  }
}

const storageCases = [
  { name: 'ledger', file: '.dshw-usage.json', write: ops => ops.writeUsageLedger({ date: '2026-01-02', history: {} }), failure: false },
  { name: 'API registry', file: '.dshw-api.json', write: ops => ops.writeApiRegistry({ version: 1, models: [], usage: {} }), failure: false },
  { name: 'size preferences', file: '.dshw-size.json', write: ops => ops.writeSizeConfig(1), failureOk: false },
  { name: 'turn sequence', file: '.dshw-turn.json', write: ops => ops.writeTurnSeq(7), failure: undefined },
  { name: 'bubble configuration', file: '.dshw-bubble.json', write: ops => ops.writeBubbleConfig({ v: 1, items: [], lib: [] }), failure: false },
  { name: 'roles', file: 'whale-roles/roles.json', write: ops => ops.writeRolesIndex({ version: 1, roles: [] }), failure: false },
  { name: 'audio', file: 'whale-audio/audio.json', write: ops => ops.writeAudioIndex({ version: 1, groups: [], fragments: [] }), failure: false },
  { name: 'bubble images', file: 'whale-bubble-imgs/bubble-imgs.json', write: ops => ops.writeBubbleImgIndex({ version: 1, images: [] }), failure: false },
]

for (const storage of storageCases) {
  test(storage.name + ' writes to DSH home when it is writable', () => {
    const fixture = storageFixture()
    storage.write(fixture.operations)
    const target = path.join(fixture.home, storage.file)
    assert.deepEqual([...fixture.files.keys()], [target])
    assert.equal(typeof JSON.parse(fixture.files.get(target)), 'object')
  })

  test(storage.name + ' falls back to the explicit web profile directory', () => {
    const fixture = storageFixture({ homeWritable: false })
    storage.write(fixture.operations)
    const target = path.join(fixture.web, storage.file)
    assert.deepEqual([...fixture.files.keys()], [target])
  })

  test(storage.name + ' reports storage failure without trying the writable working directory', () => {
    const fixture = storageFixture({ homeWritable: false, webWritable: false })
    const result = storage.write(fixture.operations)
    assert.ok(fixture.attempts.length > 0)
    assert.deepEqual(fixture.attempts.filter(attempt => !path.isAbsolute(attempt.input)), [])
    assert.equal(fixture.files.size, 0)
    if ('failureOk' in storage) assert.equal(result.ok, storage.failureOk)
    else assert.equal(result, storage.failure)
  })
}

test('relative DSH_HOME is anchored once before the working directory changes', () => {
  const fixture = storageFixture({ dshHome: 'relative-data' })
  fixture.changeCwd()
  for (const storage of storageCases) storage.write(fixture.operations)
  assert.equal(fixture.files.size, storageCases.length)
  for (const storage of storageCases) assert.ok(fixture.files.has(path.join(fixtureLaunch, 'relative-data', storage.file)))
  assert.deepEqual(fixture.attempts.filter(attempt => !path.isAbsolute(attempt.input)), [])
})

test('the default user DSH home retains the same storage layout', () => {
  const fixture = storageFixture({ dshHome: null })
  for (const storage of storageCases) storage.write(fixture.operations)
  assert.equal(fixture.files.size, storageCases.length)
  for (const storage of storageCases) assert.ok(fixture.files.has(path.join(fixtureUser, '.dsh', storage.file)))
})

test('ledger archival fails without writing an archive to the working directory', () => {
  const fixture = storageFixture({ homeWritable: false, webWritable: false })
  const ledger = { events: [{ day: '2000-01-01', amount: 1 }], history: {} }
  assert.equal(fixture.operations.pruneLedgerUsage(ledger), false)
  assert.equal(fixture.files.size, 0)
  assert.deepEqual(fixture.attempts.filter(attempt => !path.isAbsolute(attempt.input)), [])
  assert.equal(ledger.events.length, 1)
})
