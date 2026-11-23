import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyArchive, continuationNames, isInstallableArchive, planInstallUnits, sanitizeSegment, splitName } from '../../backend/paths.ts'

test('sanitizeSegment 把 Windows 非法字符转成下划线并去掉首尾杂质', () => {
  assert.equal(sanitizeSegment('Red Dead Redemption 2: Ultimate Edition'), 'Red Dead Redemption 2_ Ultimate Edition')
  assert.equal(sanitizeSegment('  Assassin\'s Creed Shadows  '), 'Assassin\'s Creed Shadows')
  assert.equal(sanitizeSegment('a<>b?c*d|e"f'), 'a_b_c_d_e_f')
  assert.equal(sanitizeSegment('trailing dots...'), 'trailing dots')
  // 相邻的非法字符各自转下划线后，再按规则合并成一个下划线
  assert.equal(sanitizeSegment('D:\\games\\x'), 'D_games_x')
  // 撇号保留：源项目用它做磁盘目录名
  assert.equal(sanitizeSegment("Assassin's Creed Shadows Premium Edition"), "Assassin's Creed Shadows Premium Edition")
})

test('sanitizeSegment 处理空名、保留名与超长名', () => {
  assert.equal(sanitizeSegment(''), 'Untitled')
  assert.equal(sanitizeSegment('   ...   '), 'Untitled')
  assert.equal(sanitizeSegment('CON'), '_CON')
  assert.equal(sanitizeSegment('com1.txt'), '_com1.txt')
  const long = 'x'.repeat(400)
  assert.ok(sanitizeSegment(long).length <= 180)
})

test('splitName 不把开头的点当成扩展名分隔', () => {
  assert.deepEqual(splitName('Game.zip'), { stem: 'Game', ext: 'zip' })
  assert.deepEqual(splitName('.part01'), { stem: '.part01', ext: '' })
  assert.deepEqual(splitName('noext'), { stem: 'noext', ext: '' })
})

test('classifyArchive 识别各类分卷与主卷', () => {
  assert.deepEqual(classifyArchive('Game.zip'), { family: 'zip-split', isMain: true, base: 'game' })
  assert.deepEqual(classifyArchive('GAME.Z01'), { family: 'zip-split', isMain: false, base: 'game' })
  assert.deepEqual(classifyArchive('Pack.part01.rar'), { family: 'rar-split', isMain: true, base: 'pack' })
  assert.deepEqual(classifyArchive('Pack.part02.rar'), { family: 'rar-split', isMain: false, base: 'pack' })
  assert.deepEqual(classifyArchive('Pack.part1.rar'), { family: 'rar-split', isMain: true, base: 'pack' })
  assert.deepEqual(classifyArchive('Legacy.rar'), { family: 'rar-split', isMain: true, base: 'legacy' })
  assert.deepEqual(classifyArchive('Legacy.r00'), { family: 'rar-split', isMain: false, base: 'legacy' })
  assert.deepEqual(classifyArchive('Big.7z.001'), { family: '7z-split', isMain: true, base: 'big.7z' })
  assert.deepEqual(classifyArchive('Big.7z.002'), { family: '7z-split', isMain: false, base: 'big.7z' })
  assert.deepEqual(classifyArchive('setup.exe'), { family: 'single', isMain: true, base: 'setup' })
  assert.equal(classifyArchive('readme.txt'), null)
})

test('isInstallableArchive 接受压缩包、分卷与 exe', () => {
  for (const name of ['a.zip', 'a.z01', 'a.7z', 'a.7z.001', 'a.part01.rar', 'a.r00', 'setup.exe', 'blob.002']) {
    assert.equal(isInstallableArchive(name), true, name)
  }
  for (const name of ['readme.txt', 'data.dll', 'cover.png']) {
    assert.equal(isInstallableArchive(name), false, name)
  }
})

test('continuationNames 只取同主干同族的续卷', () => {
  const files = ['Anno.zip', 'anno.z01', 'anno.z05', 'Other.zip', 'other.z01', 'Anno.zip.aria2', 'anno.7z.001']
  const volumes = continuationNames('Anno.zip', files)
  assert.ok(volumes.includes('anno.z01'))
  assert.ok(volumes.includes('anno.z05'))
  assert.ok(!volumes.includes('other.z01'))
  assert.ok(!volumes.includes('anno.7z.001'))
})

test('planInstallUnits 多卷只取主卷，独立压缩包各自成单元', () => {
  const multi = ['ForzaHorizon6 v440.853.z06', 'ForzaHorizon6 v440.853.z07', 'ForzaHorizon6 v440.853.zip']
  assert.deepEqual(planInstallUnits(multi), ['ForzaHorizon6 v440.853.zip'])
  const independent = ['data1.zip', 'data2.zip', 'patch.rar']
  assert.deepEqual(planInstallUnits(independent), ['data1.zip', 'data2.zip', 'patch.rar'])
  const mixed = ['Game.part1.rar', 'Game.part2.rar', 'Setup.exe', 'readme.txt']
  assert.deepEqual(planInstallUnits(mixed), ['Game.part1.rar', 'Setup.exe'])
})
