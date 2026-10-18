# Session Trash · DSH 删除对话与回收站

[English](README.en.md) · [更新记录](CHANGELOG.md) · [发布说明](docs/PUBLISHING.md)

给 DeepSeek Harness（DSH）桌面端补上真正的**删除对话**：确认后立即从侧栏移除，同时把会话日志放进本地回收站保留 **7 天**；期间可以一键撤销或恢复，逾期自动永久删除。

> 这是一个社区插件，不是 DeepSeek 官方项目。DSH 原生的“归档”保持不变；归档只是隐藏，删除才会移走日志。

![Session Trash icon](icon.svg)

## 功能

- **删除对话**：每个会话的 `...` 菜单新增红色“删除对话”，确认框显示标题和保留天数。
- **立即消失**：删除成功后侧栏行立即移除，包括“未分组”会话；不需要刷新或重启。
- **7 天回收站**：日志、投影缓存和元数据先完整复制到 `$DSH_HOME/session-trash/`，复制成功后才删除原文件。
- **撤销 / 恢复**：删除提示条内嵌“撤销”；侧栏底部的回收站按钮可以恢复任意未过期会话。
- **彻底删除**：回收站里可立即永久删除，不必等 7 天。
- **只拦真正运行中的任务**：Agent 回合处于 `running` 时立即拒绝删除，不归档、不取消、不等待；空闲但仍驻留内存的会话可以正常删除。
- **失败安全**：归档、从工作区摘除、flush、复制任一步失败都会在动原文件之前中止并回滚；不会出现“原文件删了、回收站也没有”的状态。
- **与归档一致的提示**：复用 DSH 的 `Toast` 原语，位置和样式与“会话已归档，可撤销”一致。

## 安装

### 从 npm 安装（推荐，发布后）

```sh
dsh plugin --profile web add dsh-plugin-delete-session
```

安装后**完全退出并重新打开 DSH**（Host 半是 ESM 模块，刷新页面不会重新加载它），再按 `Ctrl+Shift+R` 刷新页面。

### 从 GitHub 源码安装

```sh
dsh plugin --profile web add github:yycf1/dsh-plugin-delete-session
```

这是纯 JavaScript 包，不需要构建授权。安装后同样需要完整重启 DSH。

### 在 DSH 内浏览

本仓库同时发布了一个符合 DSH 插件市场格式的索引：

```text
https://yycf1.github.io/dsh-plugin-delete-session/index.json
```

打开 **设置 → 插件 → 实验性插件 → 自定义插件市场**，添加上面的索引地址，即可在“发现”中查看并安装。也可以在 DSH Plugin Hub（dsh-plugin.org）搜索本插件。

## 使用

1. 在左侧会话列表找到目标对话，打开 `...` 菜单；
2. 点击 **删除对话**，确认；
3. 会话立即从列表消失，顶部出现带“撤销”的提示；
4. 7 天内点击提示里的“撤销”，或打开侧栏底部的回收站点击“恢复”；
5. 在回收站点击“彻底删除”可立即永久删除。

删除的是会话日志和它的投影缓存；全局附件库按内容寻址共享，不会被删除。

## 配置

默认配置在 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-plugin-delete-session
      name: 'dsh-plugin-delete-session'
      config:
        retentionDays: 7
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `retentionDays` | `7` | 回收站保留天数（1–3650）。 |
| `trashRoot` | `$DSH_HOME/session-trash` | 回收站目录。 |
| `sessionsRoot` | session-persistence 的 `root`，否则 `$DSH_HOME/sessions` | 会话日志根目录。 |
| `projectionCacheDir` | `$DSH_HOME/storages/session_projcache/sessions` | 投影缓存目录。 |
| `homeDir` | `$DSH_HOME`，否则 `~/.dsh` | 未显式给出路径时使用的数据目录。 |
| `purgeIntervalMs` | `3600000` | 自动清理间隔（最小 60 秒）。 |

在 profile 的 `cordis.patch.yml` 中覆盖 `config` 可以修改保留天数；patch 会替换整行配置，因此请同时写出需要保留的其他字段。

## 工作原理

删除顺序：

1. 检查 Agent 是否正在 `running`；是则**立即**拒绝；
2. `workspaceRegistry.archiveSession(id, { stopActivity: true })`，停止后台任务并让归档集合隐藏该行；
3. 归档后再次检查运行状态，防止竞态；
4. 从 workspace 摘除持久化归属；
5. `sessionPersistence.flush()`，确保最新消息已落盘；
6. 把日志目录、投影缓存和 `meta.json` 复制到回收站；
7. 删除原文件；
8. 摘除 Host 中仍驻留的 live Session/Agent 注册，触发 `session/disposed`，让侧栏和 API 立即移除该行，并释放日志 writer。

恢复顺序：复制回原位置 → 覆盖派生的投影缓存 → 取消归档 → 重新挂到原 workspace。目标位置已有数据时拒绝覆盖，并回滚本次复制。

过期清理每小时运行一次，启动时也会运行；没有日志、没有回收站副本的陈旧归档标记会被清理。

## 安全与已知限制

- **依赖 DSH 内部接口**：`ctx.sessions.retireScope`、`sessions.detachEntered`、`agents.detachEntered`、`@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`。DSH 升级后可能需要适配；本版本在 `0.2.1-rc.2` 上测试。
- **空闲 Agent 的底层 scope** 仍会保留到本次进程结束（DSH 没有公开的 Agent close 接口）；它已被摘除注册，不能从侧栏或 session API 访问，也不会再写日志。重启后彻底释放。
- **单进程假设**：回收站操作在单个 DSH 进程内串行；不要同时运行多个共享同一 `$DSH_HOME` 的 DSH 实例。
- **Windows 优先**：开发和测试主要在 Windows 上完成；其他平台未做完整 GUI 验证。
- **运行中的回合不会被删除顺手取消**：请先停止任务，这是数据安全选择。
- 删除后恢复的会话会出现在 workspace 最前面，不保留原手动排序位置。
- 本插件没有注册 Agent 工具，模型不能自行删除对话；删除只通过 GUI 暴露。

## 开发与测试

仓库是普通 ESM 包，无构建步骤：

```sh
node --check index.js
node --check client.js
node test/host.test.mjs
node test/trash.test.mjs
```

测试覆盖删除、恢复、彻底删除、运行中拒绝、归档/detach/flush 失败回滚、未分组 live 清理、路径校验、元数据校验和过期清理。

## 兼容性

- DSH：`>=0.2.1-rc.2 <0.3.0`
- 平台：Windows 已验证；macOS/Linux 未完整验证
- 运行时：DSH Desktop 或带 Web UI 的 DSH profile

## 许可证

[MIT](LICENSE) © 2026 yycf1

## 免责声明

本项目为社区插件，与 DeepSeek AI 无隶属关系。删除操作会移动本地会话文件；请先在小范围会话上验证，并保留回收站直到确认不再需要。
