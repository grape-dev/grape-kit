import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_NAMES } from '../src/tools.mjs'

/* ── Issue #17 / CONTRIBUTING §7：用户可见变更必须双语 README + CHANGELOG Unreleased 同 PR 同步 ── */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (f) => readFileSync(join(ROOT, f), 'utf8')

/** 截取某二级/三级标题节（到下一个同级或更高级标题为止），避免跨节误匹配 */
function sectionOf(md, title) {
  const at = md.indexOf(`### ${title}`)
  if (at === -1) return ''
  const rest = md.slice(at)
  const nl = rest.indexOf('\n')
  if (nl === -1) return rest
  const next = rest.slice(nl + 1).search(/^#{2,3} /m)
  return next === -1 ? rest : rest.slice(0, nl + 1 + next)
}

test('README 双语 WorkBuddy 节：不再要求手动「信任」，改为重启宿主会话', () => {
  const en = sectionOf(read('README.md'), 'WorkBuddy')
  const zh = sectionOf(read('README.zh.md'), 'WorkBuddy')
  assert.ok(en && zh, '双语 README 均应保留 WorkBuddy 节')
  // 实测 spawn 调用无需授权：旧文案「信任一次」必须消失，否则用户多做一个无用动作
  assert.doesNotMatch(en, /Trust the connector once/i, '英文 README 不得再要求手动信任')
  assert.doesNotMatch(zh, /需在 WorkBuddy 手动「信任」一次/, '中文 README 不得再要求手动信任一次')
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

test('CHANGELOG 保留 Unreleased 段（下一周期入口），0.5.0 发布节覆盖 #26 五宿主 / #20 场景技能 / #27 自管理工具批', () => {
  const md = read('CHANGELOG.md')
  const at = md.search(/^## Unreleased$/m)
  assert.ok(at >= 0, 'CHANGELOG.md 必须保留 ## Unreleased 段（CONTRIBUTING §7）')
  const firstPublished = md.search(/^## \d+\.\d+\.\d+ \(/m)
  assert.ok(at < firstPublished, 'Unreleased 段应排在已发布版本节之前')
  const unreleasedBody = md.slice(at, firstPublished)
  assert.ok(
    !/^- \S/m.test(unreleasedBody) || /### (Added|Changed|Fixed)/.test(unreleasedBody),
    'Unreleased 段有条目时必须按 Added/Changed/Fixed 归类（发版后允许空段）',
  )
  // #26 五宿主 + #20 场景/技能 + #27 自管理工具批已随 0.5.0 发布：首个已发布节断言 0.4.0→0.5.0，本批覆盖断言落最新发布节
  assert.match(md.slice(firstPublished, firstPublished + 30), /^## 0\.5\.0 \(2026-11-25\)/, '首个已发布节应为 0.5.0 (2026-11-25)')
  const next = md.slice(firstPublished + 1).search(/^## /m)
  const body = next === -1 ? md.slice(firstPublished) : md.slice(firstPublished, firstPublished + 1 + next)
  assert.match(body, /### (Added|Changed|Fixed)/, '0.5.0 发布节必须按 Added/Changed/Fixed 归类')
  for (const [re, what] of [
    [/`SUPPORTED_TARGETS` 由 5 扩到 10/, '#26 五宿主扩容（--target 全量 10）'],
    [/`codex` \/ `openclaw` \/ `hermes` \/ `atomcode` \/ `trae`/, '#26 五宿主逐一登记'],
    [/grape_set_repo_scene/, '#20 仓库默认场景工具'],
    [/grape_upload_skill/, '#20 技能上传工具'],
    [/创建场景副本/, '#20 apply_scene 市场副本通道'],
    [/仅项目级语义/, '#26 trae 项目级闸门'],
    [/自管理五工具（Issue #27，工具面 39 → 48）/, '#27 自管理五工具'],
    [/`src\/lifecycle\.mjs` 自管理核心/, '#27 自管理核心模块'],
  ]) {
    assert.match(body, re, `0.5.0 发布节应记录 ${what} 变更`)
  }
  // 历史发布节的覆盖断言不因新版本上移而丢失：#21 dsh 仍在 0.4.0 发布节
  const at040 = md.search(/^## 0\.4\.0 \(/m)
  assert.ok(at040 >= 0, 'CHANGELOG 应有 0.4.0 发布节')
  const next040 = md.slice(at040 + 1).search(/^## /m)
  const body040 = next040 === -1 ? md.slice(at040) : md.slice(at040, at040 + 1 + next040)
  assert.match(body040, /### (Added|Changed|Fixed)/, '0.4.0 发布节必须按 Added/Changed/Fixed 归类')
  for (const [re, what] of [
    [/install --target dsh/, '#21 dsh 托管 patch 安装'],
    [/uninstall --target dsh/, '#21 dsh 卸载（只删托管块 + skill 副本）'],
    [/doctor --target dsh/, '#21 dsh 三项检查'],
    [/dsh-mcp-client/, '#21 dsh-mcp-client 依赖'],
    [/托管块/, '#21 托管块'],
    [/detect/, '#21 detect 把 ~/.dsh 纳入自动检测'],
    [/不完整/, '#21 QA 写入安全：不完整托管块拒写'],
    [/映射形状/, '#21 QA 写入安全：映射形状拒写'],
    [/逐字节/, '#21 QA 往返保真：逐字节还原'],
  ]) {
    assert.match(body040, re, `0.4.0 发布节应记录 ${what} 变更`)
  }
  // 历史发布节的覆盖断言不因新版本上移而丢失：#19 仍在 0.3.10 发布节
  const at0310 = md.search(/^## 0\.3\.10 \(/m)
  assert.ok(at0310 >= 0, 'CHANGELOG 应有 0.3.10 发布节')
  const next0310 = md.slice(at0310 + 1).search(/^## /m)
  const body0310 = next0310 === -1 ? md.slice(at0310) : md.slice(at0310, at0310 + 1 + next0310)
  assert.match(body0310, /### (Added|Changed|Fixed)/, '0.3.10 发布节必须按 Added/Changed/Fixed 归类')
  for (const [re, what] of [
    [/派发指针只认 `next_seq`|`next_seq`[^\n]*派发指针/, '#19 派发指针只认 next_seq'],
    [/pending_dispatch|待派发/, '#19 待派发标记'],
    [/交回未成功/, '#19 交回未成功不派发'],
    [/白名单外/, '#19 白名单外节点名不改写'],
    [/缺事件 `seq`|派发未证实/, '#19 补发缺 seq 判未证实'],
  ]) {
    assert.match(body0310, re, `0.3.10 发布节应记录 ${what} 变更`)
  }
  // 历史发布节的覆盖断言不因新版本上移而丢失：#17 仍在 0.3.9 发布节
  const at039 = md.search(/^## 0\.3\.9 \(/m)
  const next039 = md.slice(at039 + 1).search(/^## /m)
  const body039 = next039 === -1 ? md.slice(at039) : md.slice(at039, at039 + 1 + next039)
  for (const [re, what] of [
    [/`agent`|agent.*枚举|枚举.*agent/, 'trigger_pipeline agent 参数/枚举'],
    [/`?intro`?/, 'intro 子命令'],
    [/安装.*能力地图|能力地图/, '安装后能力地图/引导'],
    [/getBaseUrl|base_url|baseUrl/, 'doctor base_url 来源展示'],
  ]) {
    assert.match(body039, re, `0.3.9 发布节应记录 ${what} 变更`)
  }
})
/* ── Issue #20：凭据优先级链与新命令用法必须双语 README + CHANGELOG 同步 ── */

test('Issue #20 README 双语载明凭据优先级链与 auth init / uninstall --clean-global', () => {
  for (const name of ['README.md', 'README.zh.md']) {
    const md = read(name)
    assert.match(md, /auth init/, `${name} 应载明 auth init 单入口`)
    assert.match(md, /--clean-global/, `${name} 应载明 uninstall --clean-global`)
    assert.match(
      md,
      /GRAPE_API_TOKEN_ONCE[\s\S]{0,240}GRAPE_API_TOKEN[\s\S]{0,240}(GRAPE_AUTH_FILE|config\.json)/,
      `${name} 应列出 runtime > env > file 完整优先级链`,
    )
  }
})

/* ── Issue #27：自管理五工具的三面口径一致（工具面 / README 双语 / CHANGELOG Unreleased） ── */

const LIFECYCLE_TOOL_NAMES = ['grape_kit_version', 'grape_kit_check_update', 'grape_kit_upgrade', 'grape_kit_install', 'grape_kit_uninstall']

test('Issue #27 README 双语：工具数 48 + 自管理五工具逐个点名 + 写操作决策门口径', () => {
  for (const [name, md] of [['README.md', read('README.md')], ['README.zh.md', read('README.zh.md')]]) {
    assert.match(md, /48 tools|48 工具/, `${name} 能力总览应为 48 工具（39→48 口径同步）`)
    for (const tool of LIFECYCLE_TOOL_NAMES) {
      assert.ok(md.includes(tool), `${name} 应点名 ${tool}`)
    }
    assert.match(md, /自管理|Self-management/, `${name} 应有自管理能力条目`)
    assert.match(md, /只生成命令|command generation|commands only/i, `${name} 应写明写工具只生成命令、不执行`)
  }
})

test('Issue #27 CHANGELOG 0.5.0 发布节覆盖自管理五工具（Added/Changed 归类）', () => {
  // #27 变更已随 0.5.0 发布：按**发布节**取段（发版后 Unreleased 段为空，按 `## Unreleased` 切段会取到空串）
  const md = read('CHANGELOG.md')
  const at = md.search(/^## 0\.5\.0 \(/m)
  assert.ok(at >= 0, 'CHANGELOG 应有 0.5.0 发布节')
  const next = md.slice(at + 1).search(/^## /m)
  const body = next === -1 ? md.slice(at) : md.slice(at, at + 1 + next)
  assert.match(body, /### (Added|Changed)/, '0.5.0 发布节必须按 Added/Changed 归类')
  for (const [re, what] of [
    [/grape_kit_version/, 'grape_kit_version'],
    [/grape_kit_check_update/, 'grape_kit_check_update'],
    [/grape_kit_upgrade/, 'grape_kit_upgrade'],
    [/grape_kit_install/, 'grape_kit_install'],
    [/grape_kit_uninstall/, 'grape_kit_uninstall'],
    [/39\s*→\s*48|48 工具|48 tools/, '工具面 39→48'],
    [/dismiss/, 'dismiss 3 天冷却'],
  ]) {
    assert.match(body, re, `0.5.0 发布节应记录 ${what}`)
  }
})

test('Issue #27 冒烟/巡检脚本的工具数断言同步为 48', () => {
  assert.match(read('scripts/smoke.mjs'), /!== 48/, 'smoke 应断言 48 个工具')
  assert.match(read('scripts/sweep-0.2.mjs'), /=== 48/, 'sweep 应断言 48 个工具')
})

/* ── QA 复审（PR #21）S1：CONTRIBUTING 自身也是工具面口径载体，必须与 TOOL_NAMES 实际数量同源 ──
 * 39 → 48 时漏改本文件即失真；断言取实际注册数（非硬编码），后续增删工具时同样自动变红。 */
test('CONTRIBUTING 工具面口径与 TOOL_NAMES 实际数量一致（漏改即失真）', () => {
  const md = read('CONTRIBUTING.md')
  const n = String(TOOL_NAMES.size)
  assert.match(md, new RegExp(`（${n} tools）`), `CONTRIBUTING 开发环境节应写「（${n} tools）」`)
  assert.match(md, new RegExp(`工具数变化（当前 ${n}）`), `CONTRIBUTING §6 应写「工具数变化（当前 ${n}）」`)
  assert.doesNotMatch(md, /（39 tools）/, '不得残留旧口径 39 tools')
  // 同步清单必须把本文件自身算进去，否则「漏改 CONTRIBUTING」永远落在规范文字之外
  assert.match(md, /工具数变化[\s\S]{0,200}CONTRIBUTING\.md/, 'CONTRIBUTING §6 同步清单应包含本文件自身')
})

/* ── QA 第 3 轮（PR #21）S2：贡献流程模板也是工具面口径载体 ──
 * 贡献者照着 PR/Bug 模板跑验证，模板写「期望 39 tools / 136 单测」会让他们把成功运行误判为失败；
 * 单测数不写死（会随每个 PR 漂移），工具数按 TOOL_NAMES 实际数量断言。 */
test('S2 贡献流程模板工具面口径与 TOOL_NAMES 同源（PR 模板 / Bug 模板）', () => {
  const n = String(TOOL_NAMES.size)
  const files = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.md']
  for (const f of files) {
    const md = read(f)
    assert.match(md, new RegExp(`${n} tools`), `${f} 应写「${n} tools」`)
    assert.doesNotMatch(md, /\b39 tools\b/, `${f} 不得残留旧口径 39 tools`)
  }
  const pr = read('.github/PULL_REQUEST_TEMPLATE.md')
  assert.match(pr, /npm ci && npm test/, 'PR 模板仍应给出验证命令')
  assert.doesNotMatch(pr, /期望\s*\d+\s*\/\s*\d+/, 'PR 模板不得写死单测数（按错误期望跑验证会误判失败）')
  const contributing = read('CONTRIBUTING.md')
  for (const f of files) {
    assert.ok(contributing.includes(f), `CONTRIBUTING §6 同步清单应列出 ${f}（否则下次照样漏改）`)
  }
})
