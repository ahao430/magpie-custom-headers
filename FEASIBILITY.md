# FEASIBILITY.md — Magpie 自定义 Header 注入：技术验证记录（Phase 0）

> 状态：**Phase 0 完成，暂停于架构决策点**（2026-10-22）
> 结论：动态 Header 注入技术上可行，但受 Magpie 扩展点限制，需要用户做一次架构选择。

## 1. 一句话结论

Magpie 当前版本中，**middleware 和 gateway hooks 只能修改请求体，没有任何接口能修改发往上游的 HTTP Header**；唯一能每请求动态写 Header 的通道在 **provider 插件的请求路径**里（`chat.headers` 钩子 / loader `fetch` 覆盖）。因此"直连 vendor"（如 `magpie provider add` 添加的 NewAPI）的请求无法被插件注入动态 Header。

## 2. 各通道能力矩阵（全部实测验证）

| 通道 | 运行时 | 改请求体 | 改 HTTP Header | 拿到 cwd/session | 实测证据 |
|---|---|---|---|---|---|
| Gateway Middleware (`*.middleware.js`) | moejs（Go 进程内） | ✅ | ❌ | ❌（ctx 只有 protocol/model/stream/path/agent/options/state/reject） | probe-plugin 沙箱实测：`ctx.headers`、`ctx.provider.headers` 突变全部无效 |
| Async Gateway Hooks (`*.hooks.js`) | Bun 宿主 | ✅ | ❌（返回值只接受 body 对象） | ✅ **`ctx.cwd`、`ctx.session`、`ctx.agent` 在真实 agent 请求中被填充** | Claude Code 请求实测：`cwd:"/private/tmp/v2c/fake-project"`、`session:"84205c8f-…"`、`agent:"claude"` |
| Provider 插件 `chat.headers` 钩子 | Bun 宿主 | — | ✅（`output.headers`，最后生效） | ⚠️ 仅 `input.sessionID`，无 cwd | probe-provider 实测：设置的 Header 到达上游 |
| Provider 插件 loader `fetch` 覆盖 | Bun 宿主 | — | ✅（亲手构建出站请求） | ⚠️ 无 sessionID（可与 chat.headers 组合解决） | 同上 |
| Custom vendor `header.X-Foo` | Go 核心 | — | ✅ 但**静态值** | ❌ | 基线实测：静态头到达上游 |
| 客户端自定义 Header 透传 | Go 核心 | — | ❌ 被剥掉 | — | curl 发 `X-Requirement-Id` 未出现在上游 |

关键佐证：param-override 插件作者在源码注释中同样确认 "What New API does with headers (set_header, pass_headers…) … has nothing to act on here and is left out"。

## 3. 已验证的组合方案（端到端打通）

**hooks + 透传 provider 壳**（探针插件 `/tmp/v2c/probe-provider` 已跑通）：

```
Claude Code → magpie 网关
  ├─ hooks: ctx.session + ctx.cwd → 写入 globalThis 映射（hooks 与 provider 插件同处一个 Bun 宿主进程）
  └─ 路由到插件 provider 账户 → chat.headers(sessionID→查 cwd) / loader.fetch 内:
       向上查找 .magpie-headers → 解析 YAML → 解析 ${git.branch} 等变量
       （Bun 里 node:child_process 跑 git，读真实分支 feature/REQ-9999-probe ✓）
       → 按冲突/缺失策略写 Header → fetch 转发上游
```

上游（本地测试服务 127.0.0.1:4399）实际收到：

```
x-probe-branch: feature/REQ-9999-probe
x-probe-commit: f415953
x-probe-cwd: /private/tmp/v2c/fake-project
```

其余已验证：session ID 在 hooks 与 chat.headers 间一致；分支切换经 `.git/HEAD` mtime 检测可即时生效；登录 prompts（text）可收集 baseURL/key，authorize 返回的额外字段保存在 `auth.metadata`；带自定义 `authorize` 的 api 方法不再自动询问 key（需自己 prompt key）。

## 4. 待用户确认的架构选择（暂停点）

| 方案 | 说明 | 代价 |
|---|---|---|
| **A. 透传 provider 壳**（已验证可行） | 插件 = hooks + 通用 provider（用户填上游 URL+key，请求原样转发 + 注入 Header）。纯增量安装，不影响现有配置 | 需把 agent 模型切到插件 provider；**直连 vendor 的请求拿不到 Header** |
| **B. Magpie 核心变更** | 给 yetone/magpie 提 issue/PR：新增请求级 Header 注入扩展点（如 middleware ctx.headers 或 hooks 返回值支持 headers） | 周期与接受度不可控；现有配置零改动 |

两个方案不互斥，可 A 先行 + B 长期。

## 5. 可直接引用的提问草案（问社区/作者）

> Magpie 的 gateway middleware（moejs）onRequest/onProvider 与异步 hooks（Bun）目前只能修改请求体。希望为"直连 vendor"的请求注入**每请求动态**的 HTTP Header（例如当前 Git 分支名），静态的 `header.X-Foo` 满足不了。两个问题：
> 1. 现有版本是否有我遗漏的、面向直连 vendor 的动态 Header 注入通道？
> 2. 若没有，是否考虑增加扩展点？例如 middleware ctx 增加 `ctx.headers`（请求阶段对出站 Header 的读/写/删），或 hooks onRequest 返回值支持 `{ body, headers }` 形态。参考场景：统一为 Claude Code/Codex 等 agent 注入 `X-Requirement-Id`（Git 分支）等上下文头，供 NewAPI 日志按需求统计。

## 6. 恢复工作时的环境与进度

- **实验环境**（保留在 /tmp/v2c，重启前有效）：
  - `test-upstream.mjs`：本地抓包上游（日志 `upstream-requests.jsonl`）
  - `m.sh`：沙箱 magpie 启动器（HOME/缓存隔离，MAGPIE_ADDR=127.0.0.1:3499）
  - `probe-plugin/`（middleware+hooks 探针）、`probe-provider/`（provider 探针，已实现 chat.headers+git 注入）
  - `fake-project/`：feature/REQ-9999-probe 分支的测试 git 仓库
  - `cc-settings.json`：Claude Code 指向沙箱网关的 `--settings` 覆盖（注意：用户 `~/.claude/settings.json` 的 env 优先级更高，必须用 --settings）
- **沙箱 Bun 注意**：需从 `~/.cache/magpie/bun/1.4.2` 复制（在线下载会 unexpected EOF）
- **下一步（方案 A 确认后）**：Phase 1+2 配置/变量/表达式引擎 → Phase 3 Header 策略引擎 → Phase 4 缓存并发安全 → Phase 5 社区发布；包名建议 `@magpie-community/custom-headers-auth`（原计划 `middleware-custom-headers` 名不副实，Phase 0 后更名符合计划预案）
- **未验证项**：Codex（responses 协议）路径的 session/cwd 填充；向真实 NewAPI（yiz.bjkhdf.cn）的端到端日志确认
