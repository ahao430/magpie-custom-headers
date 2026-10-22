# ISSUE-DRAFT.md — 给 yetone/magpie 的扩展点提案（可直接粘贴到 GitHub Issue）

标题：Gateway middleware / hooks 缺少请求级 HTTP Header 注入扩展点（直连 vendor 无法动态加 Header）

## 背景

团队用 Magpie 统一 Claude Code / Codex 等 agent 的模型入口，上游是自建 NewAPI（直连 vendor，`magpie provider add` 添加）。NewAPI 二开了自定义 Header 的日志统计能力，希望 Magpie 在**每次请求时**动态注入业务上下文 Header（如当前 Git 分支 → `X-Requirement-Id`），供 NewAPI 按需求/项目维度统计模型用量。

## 现状（均在 0.1.x 实测验证）

| 扩展点 | 改请求体 | 改出站 HTTP Header |
|---|---|---|
| Gateway middleware（moejs，onRequest/onProvider） | ✅ | ❌ 无接口（ctx.headers 突变无效；param-override 作者注释同样确认 header modes "have nothing to act on here"） |
| Async gateway hooks（Bun，onRequest） | ✅ | ❌ 返回值只接受 body 对象，多余字段被忽略 |
| Vendor 配置 `header.X-Foo` | — | ✅ 但为**字面量**，不支持变量/每请求求值 |
| Provider 插件 `chat.headers` / loader `fetch` | — | ✅ 唯一动态通道，但仅对 provider 插件账户生效，直连 vendor 请求不经过 |

同时实测确认：hooks 的 `ctx.cwd` / `ctx.session` / `ctx.agent` 在真实 agent（Claude Code）请求中已填充且准确——动态上下文是现成的，缺的只是把它写进出站 Header 的口子。

## 期望

为直连 vendor 的请求提供每请求级 Header 注入能力，任一形态均可：

1. **middleware ctx 增加 `ctx.headers`**：onRequest / onProvider 阶段可读/写/删出站 Header（对 middleware 最自然，onProvider 还能拿到目标 provider）；
2. 或 **hooks onRequest 返回值支持 `{ body, headers }`**：Bun 侧异步钩子也能参与；
3. 或 vendor 配置支持受控的变量模板（如 `header.X-Req: "${env:...}"` 或更丰富的上下文变量），但每请求求值（含 Git 分支这类文件系统上下文）只有 JS 扩展点做得到。

## 典型用法（扩展点落地后）

```js
// custom-headers.middleware.js
export function onProvider(body, ctx) {
  // ctx.cwd / ctx.session 已有；读取请求工作目录的 .magpie-headers
  // 计算 X-Requirement-Id 等并写入 ctx.headers
}
```

社区已验证配套能力：middleware/hooks 能拿到 `ctx.cwd`（真实 agent 请求已填充）、Bun 宿主内可执行 git、chat.headers 通道写入的 Header 可到达上游。缺的只是直连 vendor 路径上的 Header 写入口。

## 用例价值

- 需求追踪：Git 分支名作为 `X-Requirement-Id`，NewAPI 日志按业务需求筛选统计模型用量
- 项目识别：`X-Project-Name` / `X-Project-Path` / `X-Git-Commit`
- 统一注入：各 agent 客户端（Claude Code/Codex/…）Header 能力不一，Magpie 作为统一入口注入，配置一次全部生效
