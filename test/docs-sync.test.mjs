import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── Issue #17 / CONTRIBUTING §7：用户可见变更必须双语 README + CHANGELOG Unreleased 同 PR 同步 ── */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (f) => readFileSync(join(ROOT, f), 'utf8')

/** 截取某二级/三级标题节（到下一个同级或更高级标题为止），避免跨节误匹配 */
function sectionOf(md, title) {
  const at = md.indexOf(`### ${title}`)
  if (at === -1) return ''
  const rest = md.slice(at)
  const next = rest.slice(1).search(/^#{2,3} /m)
  return next === -1 ? rest : rest.slice(0, 1 + next)
}

test('README 双语 WorkBuddy 节：不再要求手动「信任」，改为重启宿主会话', () => {
  const en = sectionOf(read('README.md'), 'WorkBuddy')
  const zh = sectionOf(read('README.zh.md'), 'WorkBuddy')
  assert.ok(en && zh, '双语 README 均应保留 WorkBuddy 节')
  // 实测 spawn 调用无需授权：旧文案「信任一次」必须消失，否则用户多做一个无用动作
  assert.doesNotMatch(en, /Trust the connector once/i, '英文 README 不得再要求手动信任')
  assert.doesNotMatch(zh, /手动「信任」/, '中文 README 不得再要求手动信任')
  assert.match(en, /restart the host session/i, '英文 README 应给出实测准确的生效方式')
  assert.match(zh, /重启宿主会话/, '中文 README 应给出实测准确的生效方式')
})

test('README 双语补齐 intro 子命令与安装后能力菜单说明（intro 不接收 --target）', () => {
  const en = read('README.md')
  const zh = read('README.zh.md')
  for (const [name, md, mapWord] of [['README.md', en, /capability map/i], ['README.zh.md', zh, /能力地图/]]) {
    assert.match(md, /grape-kit intro/, `${name} 应给出 intro 用法`)
    assert.match(md, mapWord, `${name} 应说明安装结束会打印能力菜单`)
    const intro = sectionOf(md, name === 'README.md' ? 'Capability map after install (`intro`)' : '装完看能力地图（intro）')
    assert.ok(intro, `${name} 应有 intro 小节`)
    assert.match(intro, /--target/, `${name} 的 intro 小节应说明 intro 不收 --target，避免用户误用`)
  }
})

test('README 双语单测计数一致（同一口径，不许一边 136 一边 150）', () => {
  const en = /npm test\s+# (\d+) unit tests/.exec(read('README.md'))
  const zh = /npm test\s+# (\d+) 个单测/.exec(read('README.zh.md'))
  assert.ok(en, 'README.md 开发与测试节应标注单测数量')
  assert.ok(zh, 'README.zh.md 开发与测试节应标注单测数量')
  assert.equal(zh[1], en[1], '双语单测计数必须一致')
  assert.notEqual(en[1], '136', '旧口径 136 已过期，应更新为当前实际单测数')
})

test('CHANGELOG 有 Unreleased 段，且覆盖本次工具面与引导变更，位于首个发布节之前', () => {
  const md = read('CHANGELOG.md')
  const at = md.search(/^## Unreleased$/m)
  assert.ok(at >= 0, 'CHANGELOG.md 必须保留 ## Unreleased 段（CONTRIBUTING §7）')
  const firstPublished = md.search(/^## \d+\.\d+\.\d+ \(/m)
  assert.ok(at < firstPublished, 'Unreleased 段应排在已发布版本节之前')
  const body = md.slice(at, firstPublished)
  assert.match(body, /### (Added|Changed|Fixed)/, 'Unreleased 段必须按 Added/Changed/Fixed 归类')
  for (const [re, what] of [
    [/`agent`|agent.*枚举|枚举.*agent/, 'trigger_pipeline agent 参数/枚举'],
    [/`?intro`?/, 'intro 子命令'],
    [/安装.*(能力菜单|引导)|能力菜单/, '安装后能力引导'],
    [/getBaseUrl|base_url|baseUrl/, 'doctor base_url 来源展示'],
  ]) {
    assert.match(body, re, `Unreleased 段应记录 ${what} 变更`)
  }
})