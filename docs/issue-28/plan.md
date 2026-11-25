# Plan: Issue #28 —— 技能物化实现方案

> 对应 Spec：`docs/issue-28/spec.md`｜测试 seam：`materializeSkillAssets`（模块公开导出）+ `grape_takeover_start.render`（既有同步直调 seam）

## 1. 模块切分

```
src/skill-materialize.mjs   ← 新增：副作用集中在此（fetch / 写盘 / 解压）
src/tools.mjs               ← native() 后置调用；render() 只读 json.skillMaterialization
test/skill-materialize.test.mjs ← 新增：三态 + 逃逸 + 渲染 + 无 .skills 写入
```

`tools.mjs` 的 `render(json)` 是既有 seam（`test/takeover-hardening.test.mjs`、`test/takeover.test.mjs` 直接同步调用），本方案**不破坏它**：物化结果作为普通字段 `json.skillMaterialization` 传入。

## 2. 返回契约

```js
materializeSkillAssets(skill, cwd, { fetchImpl, env }) -> {
  status: 'ok' | 'legacy' | 'failed',
  skill: string,        // 通过的技能名（失败/legacy 时可能为空）
  path: string,         // 落盘绝对路径（ok 时有值）
  fileCount: number,    // 写入文件数
  hasReferences: boolean,
  reason: string,       // ok 时为 ''
}
```

恒返回这 6 个键（不抛错）：调用方（`native`）无需 try/catch 即可把结果直接挂到返回体。

## 3. 安全实现（逐层）

1. **技能名**：`validateSkillName` —— 先黑名单（`.` / `..` / `.skills` / `<物化根名>`），再拒分隔符与盘符，最后过 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。**拒绝而不归一化**（归一化会掩盖攻击面）。
2. **条目路径**：`checkEntryPath` —— 拒 NUL、反斜杠（Windows 分隔符/盘符不可信）、绝对路径与盘符、空段、`.`/`..` 段、任一 `.skills` 段；`references/x.md` 这类正常相对路径原样保留。
3. **落盘根**：`<cwd>/.grape-takeover-skills` 若已存在且是符号链接 → 拒绝；`realpathSync` 取真实根做前缀校验基。
4. **逐级 lstat**：`ensureDirPath` 从真实根逐段下钻，已存在段必须是目录且**非符号链接**；文件目标若已是符号链接/目录 → 拒绝（写前不跟随 symlink）。
5. **前缀校验**：写入前 `resolve(target)` 必须 `=== rootReal` 或以 `rootReal + path.sep` 开头。
6. **zip 条目**：拒 zip64、加密（GP bit0）、非 store/deflate 压缩方式；unix mode `S_IFLNK` → 拒绝解压（逃逸防护）；解压后体积/条目数上限（32MB 包 / 64MB 解压 / 512 文件）。
7. **`.skills/` 恒不写**：物化根名与保留名单都不含 `.skills`，条目路径中的 `.skills` 段直接拒绝；测试做目录快照断言。

失败清理：仅当目标目录由本次调用新建且中途失败时 `rmSync` 该目录（不删上一轮已成功的物化结果，保持幂等覆盖语义）。

## 4. 基线核对（回答「npm test 全绿」）

- main 基线（7c90a6f）`npm test`：**270 tests / 264 pass / 6 fail**。
- 6 条皆在 `test/setup-targets.test.mjs`，报 `TypeError: HOSTS[n].plan is not a function`（`grape-kit.mjs:1873`，属于 uninstall `--dry-run` 宿主预览路径），与本 Issue 改动文件（`src/tools.mjs`/新增模块）无关，是 main 上的既有缺陷。
- 处置：**不修**（skill 边界：只实现当前 Issue 内容，不修改非 Issue 相关代码），在 PR / Issue 评论如实标注「基线 6 条失败为本 Issue 之前既有，非本改动引入」，并把本改动的验收落在「新增测试全绿 + 不新增失败」上。建议另开 Issue 修复 `HOSTS[n].plan`。

## 5. 实施顺序（TDD 红/绿分提交）

1. `docs(#28)`：spec / plan / task。
2. `test(#28)`：先写失败测试（红）——模块尚不存在，`import` 即失败。
3. `feat(#28)`：实现模块 + `tools.mjs` 接入（绿）。
4. `docs(#28)`：README 双语 + CHANGELOG Unreleased + 架构文档同步（含单测计数）。

## 6. 风险

| 风险 | 缓解 |
|------|------|
| Windows 路径分隔符/盘符 | 统一 `resolve` + `path.sep` 前缀校验；条目路径含 `\` 一律拒绝 |
| 恶意 zip（symlink/穿越） | 条目级拒绝 + 前缀校验 + 逐级 lstat |
| zip64 / 非 deflate | 显式 `failed` + reason，不静默 |
| 物化目录污染仓库工作区 | 物化根固定 `.grape-takeover-skills`，不写 `.skills`（worker 会 rmtree） |