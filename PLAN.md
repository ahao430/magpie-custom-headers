下面是合并了最新「项目背景与需求说明」后的完整 `PLAN.md`，包含业务目标、配置格式、动态变量、Header 冲突策略、实现架构、技术验证、测试及社区发布计划，可以直接作为项目计划文档使用。

# PLAN.md — Magpie Custom Headers Plugin

## 1. 项目概述

### 1.1 项目基本信息

- **插件名称**：Magpie Custom Headers
- **社区包名**：`@magpie-community/middleware-custom-headers`
- **项目配置文件**：`.magpie-headers`
- **配置格式**：YAML
- **目标平台**：Magpie
- **主要用途**：根据当前项目和开发上下文，动态注入自定义 HTTP Header。

### 1.2 项目背景与需求说明

公司基于 NewAPI 进行了二次开发，增加了对自定义 HTTP Header 的日志记录与统计能力，可以在模型调用日志中记录指定的业务上下文，并支持根据业务需求号等信息进行筛选和统计。

在日常 AI 辅助开发过程中，不同开发人员可能使用不同的 Agent 客户端，例如 Claude Code、Codex 以及其他兼容的 AI 编程工具。不同客户端对请求头的自定义能力、配置方式和动态上下文获取能力存在差异。如果由每个 Agent 分别实现和维护 Header 注入逻辑，不仅配置分散，也难以保证统计字段的一致性。

因此，计划开发 Magpie Custom Headers 插件，利用 Magpie 作为统一模型请求入口的能力，为经过 Magpie 转发的不同 Agent 请求自动注入自定义 HTTP Header，将 Git 分支、项目名称、项目路径、Package 版本等开发上下文传递给公司二开的 NewAPI。

当前最主要的业务目标是将 **Git 分支名作为业务需求标识**，写入 `X-Requirement-Id`，并同时记录项目相关信息。开发人员只需在对应项目的需求分支上工作，无须在每个 Agent 中重复配置需求号，即可通过 NewAPI 的调用日志关联模型使用情况与具体需求。

### 1.3 项目目标

1. **统一注入**：通过 Magpie 为经过其转发的不同 Agent 请求注入统一的自定义 Header。
2. **需求追踪**：将当前 Git 分支名作为业务需求标识，便于 NewAPI 按需求分支筛选调用日志。
3. **项目识别**：自动注入项目名称、项目路径、Package 名称和版本等上下文，支持按项目分析模型调用情况。
4. **配置简化**：使用 `.magpie-headers` YAML 文件配置 Header，无须为每个 Header 编写代码。
5. **动态解析**：在请求时获取当前 Git 分支及相关项目上下文，避免分支切换后继续使用旧值。
6. **统一管理**：通过全局冲突策略处理已有 Header，支持保留、覆盖和合并。
7. **兼容多项目**：支持不同项目采用不同的 Header 配置，并保证并发请求之间的上下文隔离。
8. **便于统计分析**：利用 NewAPI 已有的 Header 日志记录与筛选能力，开展按需求、项目等维度的模型使用统计。

### 1.4 适用范围与边界

- 插件负责在 Magpie 请求链路中解析上下文并注入自定义 HTTP Header。
- 公司二开的 NewAPI 负责接收、记录和统计这些 Header；本插件不负责修改 NewAPI 的日志与统计实现。
- 插件只对经过 Magpie 转发的请求生效，不覆盖绕过 Magpie、直接访问模型服务的客户端链路。
- 插件不负责判断业务需求是否真实存在，也不要求 Git 分支必须符合特定命名规则。
- 首版以 Git 分支名作为需求标识，保留 `main`、`master` 等分支的原始名称。
- 注入的项目上下文用于调用日志关联与统计，不应包含 API Key、密码或其他敏感信息。

---

## 2. 使用场景

### 2.1 需求追踪

将完整 Git 分支名直接作为需求标识。

```
headers:
  X-Requirement-Id: "${git.branch}"
```

| Git 分支                    | 注入值                       |
| ------------------------- | ------------------------- |
| `feature/REQ-1234-login`  | `feature/REQ-1234-login`  |
| `bugfix/REQ-5678-payment` | `bugfix/REQ-5678-payment` |
| `main`                    | `main`                    |
| `master`                  | `master`                  |

不提取需求号，不强制要求分支命名格式。只要能够读取到分支名，就记录完整分支名。

### 2.2 项目识别

```
headers:
  X-Project-Name: "${package.name || project.name || 'unknown'}"
  X-Project-Path: "${project.path}"
  X-Project-Version: "${package.version || 'dev'}"
```

使 NewAPI 调用日志可以区分不同项目的模型使用情况。

### 2.3 固定上下文

```
headers:
  X-Environment: "development"
  X-Team: "ai-platform"
```

用于标记开发环境、团队或其他业务属性。

### 2.4 Agent 请求追踪

不同 Agent 可以使用固定客户端标识；如果 Magpie 能可靠提供 Agent 名称或会话标识，也可以使用相应动态变量。

```
headers:
  X-Requester: "claude-code"
  X-Requirement-Id: "${git.branch}"
```

动态 Agent 信息属于可选扩展，不得在运行时无法获取的情况下伪造。

---

## 3. 配置文件设计

### 3.1 文件名与查找规则

项目配置文件固定为：

`.magpie-headers`

文件内容使用 YAML 格式，不要求 `.yaml` 或 `.yml` 扩展名。

首版采用项目级配置：

1. 从当前请求对应的工作目录开始查找。
2. 向父目录逐级查找 `.magpie-headers`。
3. 找到的第一个配置文件生效。
4. 未找到配置文件时，不注入插件管理的自定义 Header。
5. 不同工作区的配置缓存必须相互隔离。

如果后续需要全局默认配置，可在验证项目级配置流程后增加；首版不要求设计复杂的多级配置合并。

### 3.2 完整配置示例

```
# 是否启用插件
enabled: true

# 已有同名 Header 的处理策略：preserve / override / merge
conflictPolicy: override

# merge 策略的默认参数
mergeSeparator: ","
mergeUnique: true

# 变量解析失败时的默认策略：omit / empty / fallback
onMissing: omit

# 当 onMissing 为 fallback 时使用的默认值
fallbackValue: ""

# 自定义请求头
headers:
  X-Requirement-Id: "${git.branch}"
  X-Project-Name: "${package.name || project.name || 'unknown'}"
  X-Project-Version: "${package.version || 'dev'}"
  X-Project-Path: "${project.path}"
  X-Git-Commit: "${git.commit}"
  X-Environment: "development"
```

### 3.3 配置字段说明

| 字段               | 类型      | 默认值        | 说明                |
| ---------------- | ------- | ---------- | ----------------- |
| `enabled`        | Boolean | `true`     | 是否启用插件            |
| `conflictPolicy` | String  | `override` | 全局 Header 冲突策略    |
| `mergeSeparator` | String  | `,`        | 合并值的分隔符           |
| `mergeUnique`    | Boolean | `true`     | 合并时是否去重           |
| `onMissing`      | String  | `omit`     | 变量解析失败策略          |
| `fallbackValue`  | String  | 空字符串       | 全局 fallback 默认值   |
| `headers`        | Map     | 空对象        | Header 名称到值表达式的映射 |

`headers` 中的所有值均按字符串模板处理，避免 YAML 将 `true`、`123` 等值自动转换为布尔值或数字。

### 3.4 配置校验

加载配置时必须校验：

- YAML 语法是否合法。
- 根节点必须为对象。
- `enabled` 必须为布尔值。
- `conflictPolicy` 必须为 `preserve`、`override` 或 `merge`。
- `onMissing` 必须为 `omit`、`empty` 或 `fallback`。
- `headers` 必须为字符串键值映射。
- Header 名称必须符合 HTTP Header 名称规范。
- 拒绝 Header 值中的 CR/LF 等可能造成 Header 注入的字符。
- 禁止插件管理 `Authorization`、`Proxy-Authorization`、API Key 等认证字段。
- 对不合法的变量表达式给出明确诊断信息。

配置错误不能被静默忽略，也不能让程序产生未经校验的 Header。

---

## 4. 动态变量系统

### 4.1 变量命名规范

使用 `${namespace.property}` 作为变量语法。

变量分为 Git、项目、Package、Agent、Session 和环境变量等命名空间。

所有变量均由插件内部的注册表解析，不执行任意 JavaScript。

### 4.2 首版变量列表

#### Git 变量

| 变量                   | 含义          | 获取方式        |
| -------------------- | ----------- | ----------- |
| `${git.branch}`      | 当前分支名       | Git         |
| `${git.commit}`      | 当前提交的短 SHA  | Git         |
| `${git.commit_full}` | 当前提交的完整 SHA | Git         |
| `${git.repo_name}`   | Git 仓库名称    | 仓库根目录名称     |
| `${git.repo_root}`   | Git 仓库根目录   | Git         |
| `${git.remote_url}`  | Git 远程地址    | Git 配置，可选启用 |

约束：

- `${git.branch}` 每次请求应反映当前分支。
- 不提取或改写需求号，保留完整分支名。
- Git 信息读取失败时按缺失值策略处理。
- 默认不注入 `git.remote_url`，因为远程地址可能包含凭据。

#### 项目变量

| 变量                | 含义          | 规则                           |
| ----------------- | ----------- | ---------------------------- |
| `${project.path}` | 当前工作目录的绝对路径 | 使用请求工作目录解析                   |
| `${project.name}` | 项目名称        | 优先项目配置，否则仓库根目录名称，最后回退到工作目录名称 |

`project.path` 和 `git.repo_root` 必须区分：

- `project.path` 表示当前 Agent 工作目录。
- `git.repo_root` 表示 Git 仓库根目录。

在 Monorepo 中，两者可能不同。

#### Package 变量

| 变量                   | 含义         | 规则                            |
| -------------------- | ---------- | ----------------------------- |
| `${package.name}`    | Package 名称 | 读取 `package.json` 的 `name`    |
| `${package.version}` | Package 版本 | 读取 `package.json` 的 `version` |

首版从当前工作目录向上查找最近的 `package.json`。

- 不存在时视为变量缺失。
- 文件内容无效时记录诊断信息。
- 不允许在每次请求中无条件重复扫描整个文件系统。
- 后续可根据真实项目结构增加显式指定 Package 根目录的能力。

#### 环境变量

`${env.NAME}` 可作为后续可选功能。

启用前需要确定允许读取的变量范围，避免通过任意环境变量读取密钥。默认禁止读取名称疑似包含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD` 等敏感信息的环境变量。

#### Agent 与 Session 变量

`${agent.name}`、`${session.id}` 等变量仅在 Magpie 能可靠提供对应上下文时实现。

不能因为变量名称已注册，就假定运行时一定能获得值。

### 4.3 `project.name` 与 `package.name` 的区别

两者不能混用：

- `project.name` 用于识别整个项目或 Git 仓库。
- `package.name` 用于识别当前工作目录所对应的最近一个 `package.json` 项目。

例如：

```
new-api/
├── .git/
├── package.json
└── web/
    └── package.json
```

当工作目录为 `new-api/web` 时：

- `project.name` 可以为 `new-api`。
- `package.name` 取 `web/package.json` 中的 `name`。
- `project.path` 为 `new-api/web` 的绝对路径。
- `git.repo_root` 为 `new-api` 的绝对路径。

---

## 5. 表达式引擎

### 5.1 基本语法

普通字符串作为固定值。

```
headers:
  X-Environment: "development"
  X-Requirement-Id: "${git.branch}"
```

支持使用 `${...}` 引用变量。

### 5.2 回退表达式

使用 `||` 表示从左向右选择第一个有效值。

```
headers:
  X-Project-Name: "${package.name || project.name || 'unknown'}"
  X-Project-Version: "${package.version || git.commit || 'dev'}"
```

求值规则：

1. 从左向右计算。
2. 变量不存在、为 `null`、空字符串或纯空白字符串时，继续尝试下一个候选值。
3. 第一个有效值作为表达式结果。
4. 固定字符串可使用单引号或双引号。
5. 字符串常量中的 `||` 不作为逻辑运算符。
6. 如果所有候选值均缺失，则应用全局 `onMissing`。
7. `false` 和 `0` 若作为未来支持的变量值，应被视为有效值。

表达式解析器不得使用 `eval`、`Function` 或其他任意代码执行方式。

### 5.3 字符串组合

支持固定文本与动态变量混合。

```
headers:
  X-Project-Context: "project=${project.name}; branch=${git.branch}"
```

多个表达式按照模板中的顺序依次解析并组合。

### 5.4 表达式范围

首版支持：

- 固定字符串。
- 变量引用。
- `||` 回退表达式。
- 字符串组合。
- 缺失值处理。

后续可考虑支持：

- 正则提取。
- 文本替换。
- Commit SHA 截断。
- 大小写转换。
- URL 编码等明确、受限的转换函数。

首版不支持任意脚本、条件语句、循环或外部命令执行。

### 5.5 变量解析错误

需要区分：

- 变量不存在。
- 变量获取失败。
- 表达式语法错误。
- 文件读取失败。
- 文件内容格式错误。

未知变量不得静默作为普通文本输出。

---

## 6. Header 冲突与缺失值处理

### 6.1 全局冲突策略

全局只配置一次 `conflictPolicy`，不要求每个 Header 重复声明。

#### preserve

已有同名 Header 时保留原值；不存在时注入计算值。

适用于不希望覆盖调用方设置的标识。

#### override

已有同名 Header 时使用插件计算值替换。

这是首版默认策略。

只修改插件配置中声明的 Header，不修改其他业务 Header。

#### merge

将原值和插件计算值合并。

默认使用 `mergeSeparator` 分隔，使用 `mergeUnique` 控制去重。

需要注意：

- 合并前应解析已有值与新值。
- 去重时应统一约定比较规则。
- 只对适合文本合并的自定义 Header 使用该策略。
- 不得对认证 Header 使用合并策略。
- 对不适合合并的 Header，提供明确的配置错误。

### 6.2 缺失值策略

#### omit

不发送对应 Header。

当变量解析失败时，`override + omit` 必须删除插件管理的同名旧值，避免遗留上一次分支信息。

#### empty

发送空字符串。

仅在业务明确需要空值时使用。

#### fallback

使用 `fallbackValue`。

更推荐直接在表达式中写明业务回退值，例如：

```
X-Project-Name: "${package.name || project.name || 'unknown'}"
```

### 6.3 冲突策略与缺失策略的关系

两者独立处理：

- `conflictPolicy` 决定计算成功时如何处理已有值。
- `onMissing` 决定计算失败时如何处理。
- `override + omit` 不保留旧值。
- `preserve` 在计算失败时保留已有值。
- `merge` 在计算失败时不追加无效值，保留已有值。

---

## 7. 核心架构

### 7.1 模块划分

建议按职责拆分为以下逻辑模块：

1. **Config Loader**
   - 查找 `.magpie-headers`。
   - 解析 YAML。
   - 校验配置。
   - 管理配置缓存。
2. **Context Resolver**
   - 解析当前工作目录。
   - 获取 Git 根目录、分支、Commit。
   - 读取 `package.json`。
   - 提供统一的上下文对象。
3. **Expression Engine**
   - 解析变量。
   - 计算回退表达式。
   - 组合模板字符串。
   - 处理缺失值和错误。
4. **Header Policy Engine**
   - 校验 Header 名称。
   - 处理 preserve、override、merge。
   - 删除或替换插件管理的 Header。
   - 确保不修改认证 Header。
5. **Request Header Injector**
   - 将最终计算结果写入实际 HTTP 请求头。
   - 确保 Header 随对应请求发送到正确的上游。
   - 避免跨请求、跨项目的状态污染。
6. **Diagnostics**
   - 输出配置和变量解析错误。
   - 记录缓存命中、刷新与失败情况。
   - 不输出敏感变量内容。

### 7.2 请求处理流程

```
flowchart TD
    A[收到模型请求] --> B[识别请求工作目录]
    B --> C[查找项目配置]
    C --> D[加载或复用配置]
    D --> E[刷新动态 Git 信息]
    E --> F[读取缓存或更新项目元信息]
    F --> G[计算变量表达式]
    G --> H[执行缺失值策略]
    H --> I[执行 Header 冲突策略]
    I --> J[写入最终 HTTP Headers]
    J --> K[转发模型请求]
    K --> L[NewAPI 记录自定义 Header]
```

### 7.3 关键技术前置条件

> **⚠️ Phase 0 已完成（2026-10-22），验证结论见 [FEASIBILITY.md](./FEASIBILITY.md)**：
> middleware/hooks 只能改请求体，无法改 HTTP Header；动态 Header 唯一通道在 provider 插件请求路径。
> 当前暂停于架构选择（A. 透传 provider 壳 / B. Magpie 核心变更），见 FEASIBILITY.md §4。

**必须先验证 Magpie 当前可用的真实 HTTP Header 注入接口。**

Gateway Middleware 的请求体 Hook 不能直接等同于 Header 注入接口。即使能够通过工作目录上下文获取当前路径，也必须确认计算出的值能够进入最终发送的 HTTP 请求头。

实施顺序：

1. 查阅 Magpie 当前源码与官方扩展文档。
2. 确认请求级 Hook 能否获取工作目录及动态上下文。
3. 确认最终 HTTP Header 的注入点，以及 Hook 的执行顺序。
4. 构建最小实验插件。
5. 启动本地测试上游，验证实际收到的 Header。
6. 如果现有扩展机制不支持，则评估 Magpie 核心新增请求级 Header 扩展点的必要性。
7. 完成验证后再开发完整配置引擎。

不能仅通过修改请求体、共享全局变量或静态 Provider Header 来假设动态 Header 注入已经实现。

---

## 8. 性能与缓存

### 8.1 动态数据刷新

每次请求都应正确处理当前分支，避免在分支切换后继续使用旧值。

至少需要验证：

- 从一个需求分支切换到另一个需求分支。
- 从需求分支切换到 `main` 或 `master`。
- 从有 Git 仓库的目录切换到无 Git 仓库的目录。
- 多个项目同时发起请求。

### 8.2 缓存策略

| 数据             | 建议策略                |
| -------------- | ------------------- |
| Git 分支         | 每次请求刷新，或采用等效的可靠刷新机制 |
| Git Commit     | 每次请求刷新，或采用等效的可靠刷新机制 |
| Git 根目录        | 按工作区缓存              |
| 项目名称           | 按工作区缓存，配置变化时刷新      |
| `package.json` | 按文件路径缓存，并检测变化       |
| 配置文件           | 缓存解析结果，检测配置变化       |
| 最终 Header      | 不跨请求缓存动态计算结果        |

缓存键必须包含足以区分不同工作区的信息，不能仅使用模型名称或全局单例状态。

### 8.3 Git 命令与文件访问

如果需要执行 Git 命令：

- 必须确认实际执行环境具备安全、受支持的执行能力。
- 不得假定插件 JavaScript 运行时可以直接使用 Node.js API、`child_process` 或任意文件系统 API。
- 不得在每个请求中重复扫描整个目录树。
- 对执行超时、Git 仓库损坏、命令失败等情况提供明确的缺失值处理。
- 如果 Magpie 插件沙箱不允许执行 Git 命令，则必须寻找由宿主提供的上下文接口，或通过受支持的核心扩展实现。

---

## 9. 安全设计

### 9.1 Header 安全

- 拒绝非法 Header 名称。
- 拒绝 Header 值中的 CR/LF。
- 禁止注入或覆盖认证 Header。
- 不自动转发所有环境变量。
- 默认不注入 Git 远程地址。
- 不执行配置文件中的代码。
- 不允许表达式执行任意外部命令。

### 9.2 项目配置安全

`.magpie-headers` 是项目级配置文件，可能被提交到 Git。

因此：

- 不建议在其中填写 API Key、密码、Token 等秘密信息。
- 对敏感变量提供明确的访问限制。
- 变量解析错误日志不应打印完整的敏感值。
- 项目配置不得绕过认证 Header 保护策略。

### 9.3 日志安全

日志可以记录：

- 配置文件是否找到。
- 配置解析是否成功。
- 使用了哪些变量。
- 哪些变量缺失。
- Header 冲突策略。
- 注入成功或失败。
- 请求关联的工作区标识。

日志不应记录：

- API Key。
- Access Token。
- 环境变量中的秘密。
- 完整敏感远程地址。
- 与诊断无关的完整请求头内容。

---

## 10. 测试计划

### 10.1 配置测试

- 合法 YAML 配置。
- 文件不存在。
- 空配置文件。
- 非法 YAML。
- 未知配置字段。
- 不合法的 Header 名称。
- 不支持的冲突策略。
- 非字符串 Header 值。
- 禁止管理的认证 Header。

### 10.2 表达式测试

- 固定值。
- 单变量表达式。
- 多变量组合。
- 两级和多级 `||` 回退。
- 单引号、双引号字符串。
- 字符串常量中的 `||`。
- 未知变量。
- 缺失值。
- 空字符串与纯空白字符串。
- 无效表达式。
- 表达式中的非法字符。

### 10.3 Header 策略测试

- 原 Header 不存在时注入。
- `preserve` 保留已有值。
- `override` 覆盖已有值。
- `merge` 合并已有值。
- 合并去重。
- 自定义合并分隔符。
- 变量缺失时执行 `omit`。
- `override + omit` 清理旧值。
- 插件不修改无关 Header。
- 插件无法覆盖认证 Header。

### 10.4 Git 与项目测试

- 普通 Git 仓库。
- `main` 分支。
- `master` 分支。
- 功能分支。
- Git 仓库没有提交。
- Detached HEAD。
- 非 Git 目录。
- Git 命令执行失败。
- 项目路径包含空格和非 ASCII 字符。
- 有 `package.json`。
- 没有 `package.json`。
- 无效的 `package.json`。
- Monorepo 中多个 Package。
- 配置文件位于父目录。
- 配置文件变化后重新加载。

### 10.5 并发测试

- 两个项目同时请求。
- 同一项目多个并发请求。
- 两个项目具有不同分支。
- 同一个工作区切换分支后立即请求。
- 配置更新期间并发请求。
- 变量解析失败不会污染其他请求。

### 10.6 端到端测试

使用本地测试上游接收实际 HTTP 请求，验证：

1. Magpie 能加载插件。
2. 插件能识别当前工作目录。
3. 插件能读取当前 Git 分支。
4. 最终 HTTP Header 符合配置。
5. 请求到达 NewAPI 时 Header 仍然存在。
6. NewAPI 能在调用日志中记录 Header。
7. 分支切换后，下一次请求能携带新分支。
8. 插件异常时，模型请求按既定失败策略处理。

只验证内部变量解析结果不算端到端通过，必须检查最终发出的 HTTP 请求。

---

## 11. 开发阶段

### Phase 0：技术可行性验证

目标：确认真实 Header 注入路径。

任务：

- 阅读 Magpie 当前源码与官方扩展文档。
- 区分 Gateway Middleware、异步 Request Hook 与 Provider Header Hook。
- 确认工作目录上下文来源。
- 确认 Git 命令和文件读取的运行时限制。
- 编写最小验证插件。
- 验证 Header 实际到达测试上游。

交付物：

- 技术可行性记录。
- 最小实验。
- 注入点与运行时限制说明。

**验收条件：能够证明动态值被写入最终 HTTP Header。**

### Phase 1：配置加载与校验

任务：

- 实现 `.magpie-headers` 查找。
- 解析 YAML。
- 校验全局配置。
- 校验 Header 名称与值类型。
- 提供清晰的错误信息。
- 支持配置禁用与缺失配置。

交付物：

- 配置加载模块。
- 配置测试。

### Phase 2：变量解析

任务：

- 实现 Git 变量。
- 实现项目路径与名称。
- 实现 `package.json` 变量。
- 实现 `${...}` 模板解析。
- 实现 `||` 回退。
- 实现固定字符串和字符串组合。
- 实现缺失值策略。

交付物：

- 变量解析模块。
- 表达式测试。

### Phase 3：Header 注入引擎

任务：

- 实现 `preserve`。
- 实现 `override`。
- 实现 `merge`。
- 实现去重与分隔符。
- 实现认证 Header 保护。
- 实现最终 HTTP Header 注入。

交付物：

- Header 规则引擎。
- 请求级注入实现。
- 冲突策略测试。

### Phase 4：缓存、并发与安全

任务：

- 实现工作区级缓存。
- 实现 Git 动态信息刷新。
- 实现配置变化检测。
- 验证并发请求隔离。
- 完成敏感信息保护。
- 完成异常处理和诊断。

交付物：

- 性能与安全测试。
- 并发测试报告。

### Phase 5：社区插件发布

任务：

- 按 Magpie 社区插件仓库规范组织文件。
- 完善 README。
- 补齐 `cases.json` 及社区要求的测试。
- 运行官方检查脚本。
- 在本地 Magpie 中安装测试。
- 根据社区要求更新 `registry.json`。
- 提交社区仓库 PR。

建议的包目录：

```
packages/custom-headers/
├── package.json
├── custom-headers.middleware.js
├── cases.json
└── README.md
```

以上目录与文件名需在 Phase 0 后根据实际扩展机制最终确认。如果实现必须依赖 Magpie 核心的新扩展点，则另行提交核心变更，不得用不受支持的接口伪装成普通社区 Middleware。

---

## 12. 交付物

最终至少交付：

1. 完整插件源码。
2. `.magpie-headers` 配置示例。
3. 完整 README。
4. 变量与表达式语法说明。
5. 冲突策略和缺失值说明。
6. 单元测试。
7. Magpie 插件检查结果。
8. 本地真实请求验证记录。
9. NewAPI Header 日志验证记录。
10. 社区 PR。

---

## 13. 最终验收标准

满足以下全部条件，视为首版完成：

- 插件可通过 Magpie 支持的方式安装和加载。
- 能读取 `.magpie-headers` YAML 配置。
- 能把固定值写入实际 HTTP Header。
- 能动态获取当前 Git 分支并注入 Header。
- `main`、`master` 等分支不被特殊排除。
- 能读取项目路径和项目名称。
- 能读取 `package.json` 的 name/version。
- 支持 `${package.name || project.name || 'unknown'}`。
- 支持固定文本与变量组合。
- 支持 `preserve`、`override`、`merge` 三种策略。
- 支持 `omit`、`empty`、`fallback` 三种缺失值策略。
- 分支切换后不会继续注入旧分支信息。
- 多项目并发时不存在上下文串用。
- 不覆盖认证 Header。
- 配置错误有明确诊断。
- 插件故障默认不会阻断模型请求。
- 最终 Header 已通过真实 HTTP 请求和 NewAPI 日志验证。
- 通过 Magpie 社区仓库的测试与检查流程。

---

## 14. 暂不纳入首版的功能

为控制复杂度，首版暂不实现：

- 任意 JavaScript 执行。
- 复杂条件语句与循环。
- 自动推断需求号。
- 强制要求特定 Git 分支命名。
- 远程配置中心。
- 复杂的全局与项目配置合并系统。
- Header 单项独立冲突策略。
- 任意环境变量读取。
- 自动修改 NewAPI。
- 未经验证的 Magpie 内部 API 依赖。

这些能力可以在实际使用后，根据明确需求逐步扩展。

---

## 15. 核心结论

本项目不是一个只给需求分支添加 Header 的专用插件，而是一个通用的 **Magpie 自定义 HTTP Header 注入工具**。

它通过 `.magpie-headers` 描述 Header 名称与值表达式，以统一规则管理冲突策略，通过变量解析器获取 Git、项目和 Package 上下文，并在每次模型请求时生成正确的请求头。

其业务价值在于：**利用 Magpie 统一不同 Agent 的请求上下文注入方式，利用公司二开的 NewAPI 统一记录和统计模型调用，从而实现按业务需求、项目等维度筛选与分析模型使用情况。**

实现时最重要的顺序是：

**先证明动态上下文可以进入真实 HTTP Header，再完成配置与表达式引擎，最后做好缓存、并发、安全和社区发布。**