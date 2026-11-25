import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { scanResidues, cleanEnvVars } from '../grape-kit.mjs'

/* Issue #38：win32 的 rc 清理路径此前因平台门禁与提前 return 从不执行。
 * 这里通过 scanResidues/cleanEnvVars 的显式 { platform, homeDir } 测试缝，
 * 在非 win32 宿主上也能回归「win32 扫描 + 清理 rc」行为（实机验证由 sre 补）。 */

const homes = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-win32-rc-'))
  homes.push(h)
  return h
}
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

function seedRc(h, { crlf = false, bom = false } = {}) {
  const eol = crlf ? '\r\n' : '\n'
  const prefix = bom ? '\uFEFF' : ''
  writeFileSync(join(h, '.bashrc'), `${prefix}export PATH=$PATH:/bin${eol}export GRAPE_API_TOKEN=grape_win_bashrc${eol}declare -x GRAPE_BASE_URL=https://win.example${eol}`)
  writeFileSync(join(h, '.bash_profile'), `${prefix}export GRAPE_API_TOKEN=grape_win_profile${eol}export KEEP_ME=1${eol}`)
  const fish = join(h, '.config', 'fish', 'config.fish')
  mkdirSync(dirname(fish), { recursive: true })
  writeFileSync(fish, `${prefix}set -x GRAPE_API_TOKEN grape_win_fish${eol}set -gx EDITOR vim${eol}`)
}

test('Issue #38 win32 scanResidues 不再被平台门禁跳过：rc 三形态均命中', () => {
  const h = home()
  seedRc(h)
  const s = scanResidues({ platform: 'win32', homeDir: h })
  assert.equal(s.rcHits.length, 3, `win32 下 .bashrc/.bash_profile/config.fish 三形态都应命中，实际: ${JSON.stringify(s.rcHits)}`)
  assert.ok(s.rcHits.some((x) => x.path.endsWith('.bashrc') && x.hits === 2), '.bashrc 两条凭据导出应计为 2 行')
  assert.ok(s.rcHits.some((x) => x.kind === 'fish'), 'config.fish 应走 fish 判据')
})

test('Issue #38 win32 cleanEnvVars 清理 rc 三形态，备份无明文凭据且保留 CRLF/BOM', () => {
  const h = home()
  seedRc(h, { crlf: true, bom: true })
  const saved = process.env.GRAPE_HOME
  process.env.GRAPE_HOME = join(h, '.grape')
  try {
    cleanEnvVars({ platform: 'win32', homeDir: h })
  } finally {
    if (saved === undefined) delete process.env.GRAPE_HOME
    else process.env.GRAPE_HOME = saved
  }

  const bashrc = readFileSync(join(h, '.bashrc'), 'utf8')
  assert.doesNotMatch(bashrc, /grape_win_bashrc|GRAPE_API_TOKEN\s*=|GRAPE_BASE_URL\s*=/, '.bashrc 凭据行必须清理')
  assert.match(bashrc, /export PATH=\$PATH:\/bin/, '.bashrc 无关行必须保留')
  assert.equal(bashrc.charCodeAt(0), 0xFEFF, '原 BOM 必须保留')
  assert.equal(bashrc.replace(/\r\n/g, '').includes('\n'), false, '原 CRLF 行尾必须保留')

  const profile = readFileSync(join(h, '.bash_profile'), 'utf8')
  assert.doesNotMatch(profile, /grape_win_profile|GRAPE_API_TOKEN\s*=/, '.bash_profile 凭据行必须清理')
  assert.match(profile, /export KEEP_ME=1/, '.bash_profile 无关行必须保留')

  const fish = readFileSync(join(h, '.config', 'fish', 'config.fish'), 'utf8')
  assert.doesNotMatch(fish, /grape_win_fish|GRAPE_API_TOKEN/, 'config.fish 凭据行必须清理')
  assert.match(fish, /set -gx EDITOR vim/, 'config.fish 无关行必须保留')

  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
  const backups = walk(h).filter((p) => p.includes('.bak-grapemcp-'))
  assert.ok(backups.length >= 3, 'rc 三形态改动前都应留备份')
  for (const b of backups) {
    const text = readFileSync(b, 'utf8')
    assert.doesNotMatch(text, /grape_win_bashrc|grape_win_profile|grape_win_fish|GRAPE_API_TOKEN\s*=|GRAPE_BASE_URL\s*=/, `备份不得含凭据明文: ${b}\n${text}`)
    assert.match(text, /GRAPE_API_TOKEN/, `备份应保留凭据行位置掩码标注: ${b}`)
  }
})