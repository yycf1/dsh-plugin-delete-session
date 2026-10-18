### 仓库地址
https://github.com/yycf1/dsh-plugin-delete-session

### 一句话价值
给 DSH 会话菜单增加删除、撤销与 7 天回收站；删除后立即从侧栏移除，包括未分组会话。

### 能力分类
会话与消息

### 安装命令
```sh
dsh plugin --profile web add dsh-plugin-delete-session
```

源码安装：

```sh
dsh plugin --profile web add github:yycf1/dsh-plugin-delete-session
```

### 兼容与运行要求
DSH `>=0.2.1-rc.2 <0.3.0`；Windows 已验证，macOS/Linux 未完整验证；需要 DSH Desktop 或带 Web UI 的 DSH profile。

### 许可证
MIT

### 截图 / 演示
仓库首页包含功能说明和图标；暂无独立截图。安装后可在任意会话的 `...` 菜单看到“删除对话”，侧栏底部有回收站按钮。

### 补充说明
- 删除会把会话日志移动到 `$DSH_HOME/session-trash`，默认保留 7 天；期间可撤销/恢复。
- 运行中的 Agent 回合会立即被拒绝删除，不会顺手取消任务。
- 使用 DSH Host/Client 内部接口，DSH 升级后可能需要适配。
- 不删除全局附件库中的共享附件。
- 单进程假设：不要同时运行多个共享同一 `$DSH_HOME` 的 DSH 实例。

### 提交前自查
- [x] 仓库已公开
- [x] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json
