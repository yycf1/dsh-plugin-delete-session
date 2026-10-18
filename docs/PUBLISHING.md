# Publishing and marketplace operations

This document records the release checklist for maintainers.

## 1. Version and tests

1. Update `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Run:

   ```sh
   node --check index.js
   node --check client.js
   node test/host.test.mjs
   node test/trash.test.mjs
   npm pack --dry-run
   ```

3. Confirm the packed file list contains `index.js`, `client.js`, `lib/`,
   `cordis.patch.yml`, `locale/`, `icon.svg`, both READMEs, `LICENSE`, and
   `CHANGELOG.md`.

## 2. GitHub

```sh
git init -b main
git add .
git commit -m "release: dsh-plugin-delete-session 1.0.8"
git remote add origin https://github.com/yycf1/dsh-plugin-delete-session.git
git push -u origin main
gh repo edit yycf1/dsh-plugin-delete-session \
  --add-topic dsh-plugin \
  --add-topic deepseek-harness \
  --add-topic dsh-plugin-session
```

Create a release and upload the npm tarball:

```sh
npm pack
gh release create v1.0.8 dist/dsh-plugin-delete-session-1.0.8.tgz \
  --title "v1.0.8" \
  --notes-file CHANGELOG.md
```

## 3. npm

The DSH plugin center lists only plugins that can be installed from npm. Log in
and publish:

```sh
npm login --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/
```

The package has no build step and no install script; npm publishes the files in
`files` directly.

## 4. DSH market index

`docs/` is a static market site. After publishing the commit, set the `commit`
field in `docs/index.json` to the full 40-character SHA and refresh
`publishTimestamp`:

```sh
git rev-parse HEAD
date +%s
```

Enable GitHub Pages from the `main` branch, `/docs` directory. The index URL is:

```text
https://yycf1.github.io/dsh-plugin-delete-session/index.json
```

Validate it by adding the URL under **Settings → Plugins → Experimental
plugins → Custom plugin market**.

## 5. DSH Plugin Hub

The community hub at <https://dsh-plugin.org> scans public GitHub repositories
with the `dsh-plugin` topic and a root `package.json`. Its submission template:

```text
Title: [插件提交] yycf1/dsh-plugin-delete-session — 给 DSH 增加删除对话与 7 天回收站

### 仓库地址
https://github.com/yycf1/dsh-plugin-delete-session

### 一句话价值
给 DSH 会话菜单增加删除、撤销与 7 天回收站，删除后立即从侧栏移除。

### 能力分类
会话与消息

### 安装命令
dsh plugin --profile web add dsh-plugin-delete-session
# 源码安装：dsh plugin --profile web add github:yycf1/dsh-plugin-delete-session

### 兼容与运行要求
DSH >=0.2.1-rc.2 <0.3.0；Windows 已验证，macOS/Linux 未完整验证。

### 许可证
MIT

### 补充说明
删除会把会话日志移入 $DSH_HOME/session-trash 保留 7 天；运行中的回合会被拒绝。
使用 DSH 内部接口，升级 DSH 后可能需要适配。
```

Submit with:

```sh
gh issue create --repo dshplugin/dsh-plugin-hub \
  --title "[插件提交] yycf1/dsh-plugin-delete-session — 给 DSH 增加删除对话与 7 天回收站" \
  --body-file docs/hub-submission.md
```

Do not open duplicate issues; check the repository's open issues first.

## 6. Post-release smoke test

1. Install from npm or GitHub in a fresh profile.
2. Restart DSH fully and refresh the page.
3. Delete a workspace session and an Ungrouped session; both rows must disappear.
4. Undo, confirm the restored row returns, then delete again.
5. Delete a running session; it must be refused immediately.
6. Restart and verify the recycle-bin entry is still listed.
