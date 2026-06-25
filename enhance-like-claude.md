# Agent enhance like Claude-Code

本文档整理了类 Claude Agent 改造，包括 Agent 运行方式、MCP、Skills、Hooks、Plugins、项目指令和多模态能力的配置方式。

## 1. 能力总览

这组改造把 Chat 的 Agent 模式从“普通对话 + 少量工具”扩展成更接近 Claude Code / Codex Agent 的工作流：

- Agent 模式拥有更完整的系统提示词、工具契约、权限判断和执行事件。
- 支持内置工具：读文件、读图片、搜索、目录树、代码符号、lint、git、patch、文件编辑、测试、依赖安装、终端命令、持久终端等。
- 支持 MCP 工具接入，Agent 模式会把已启用 MCP server 的 tools 暴露给模型。
- 支持 workspace skills：放在 `.void/skills/*.md` 或插件 skills 目录下，会注入到模型上下文中。
- 支持 hooks：可在工具调用、文件编辑、命令执行、checkpoint、失败等生命周期运行本地命令。
- 支持 Claude 风格的项目指令文件：`AGENTS.md`、`VOID.md`、`CLAUDE.md`、`.voidrules`。
- 支持 OpenAI-compatible / Anthropic 的图片输入链路，并通过 `supportsVision` 控制是否启用视觉能力。
- Chat Timeline 会展示工具、权限、checkpoint 等 Agent 执行事件，便于追踪过程。

## 2. 项目指令文件

Agent 会读取 workspace 内的项目指令文件，并合并到 AI instructions 中：

- `AGENTS.md`
- `VOID.md`
- `CLAUDE.md`
- `.voidrules`

这些文件适合放项目级约束，例如代码风格、测试命令、提交规范、架构边界、安全要求等。

示例：

```md
# Project Instructions

- 修改 TypeScript 代码后优先运行 `npm run compile`。
- 不要直接改动 generated 文件。
- UI 文案保持英文，内部注释保持简短。
- 需要改数据库 schema 时，先说明迁移影响。
```

实现位置：

- `src/vs/workbench/contrib/void/common/agent/context/ManifestLoader.ts`
- `src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`

## 3. MCP 配置

### 3.1 配置文件位置

MCP 配置支持两层：

- 用户级：`~/<product data folder>/mcp.json`
- 工作区级：`<workspace>/.mcp.json`

启动后会自动创建用户级 `mcp.json`，也可以在 Settings 的 MCP 面板里点击添加/打开配置文件。

合并规则：

- 先读取用户级 `mcp.json`。
- 再读取每个 workspace folder 下的 `.mcp.json`。
- 多个配置通过 `mcpServers` 合并。
- 如果 server 名称相同，后读取的 workspace 配置会覆盖用户级同名 server。

### 3.2 配置格式

配置根字段必须是 `mcpServers`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/to/project"
      ],
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

当前类型支持两类 server 字段：

```ts
{
  "command": "string",
  "args": ["string"],
  "env": {
    "KEY": "VALUE"
  }
}
```

或：

```ts
{
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer ..."
  }
}
```

### 3.3 MCP 工具如何进入 Agent

MCP server 成功加载后，`tools/list` 返回的每个 tool 会被转换成 Agent 可用工具：

- tool name 使用 MCP 返回的 `name`。
- description 使用 MCP tool 的 `description`。
- params 从 MCP `inputSchema.properties` 转换。
- 仅在 `chatMode === "agent"` 时暴露给模型。
- MCP 工具默认需要用户审批，审批类型显示为 `MCP tools`。

注意：MCP 工具调用结果会被格式化为文本、图片、音频或资源占位文本。目前模型侧主要消费文本结果；图片类 MCP 返回会显示为类似 `[Image: image/png]` 的摘要。

实现位置：

- `src/vs/workbench/contrib/void/common/mcpService.ts`
- `src/vs/workbench/contrib/void/common/mcpServiceTypes.ts`
- `src/vs/workbench/contrib/void/browser/agent/BrowserAgentBridge.ts`
- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`

## 4. Skills 配置

### 4.1 文件位置

Skills 支持两种来源：

- 工作区 skills：`<workspace>/.void/skills/*.md`
- 插件 skills：`<workspace>/.void/plugins/<plugin-name>/skills/*.md`

`.void` 目录会被递归 watch，新增或修改 skill 文件后会自动 reload。

### 4.2 Skill Markdown 格式

Skill 使用 Markdown 文件，可带 frontmatter：

```md
---
name: code-review
description: Review code changes for correctness, regressions, and missing tests.
tools:
  - read_file
  - search_for_files
  - git_diff
context: main
---

When reviewing code, prioritize concrete bugs and regressions.
Always cite exact files and functions when possible.
Mention test gaps separately from confirmed issues.
```

也支持简写 tools：

```md
---
name: migration-helper
description: Help plan and implement database migrations.
tools: read_file, search_for_files, edit_file, run_tests
context: main
---

Check existing migration naming conventions before creating a new migration.
```

字段说明：

- `name`：skill 名称；如果缺失，使用文件名去掉 `.md`。
- `description`：什么时候使用这个 skill 的描述。
- `tools`：建议/限制该 skill 使用的工具列表。当前会写入提示词，由模型遵守。
- `context`：`main` 或 `fork`；缺省为 `main`。
- body：frontmatter 后的正文，最多取前 4000 字符注入。

### 4.3 当前生效方式

当前 skills 不需要用户手动触发。运行时会把所有已加载 skills 注入到系统提示词：

```md
# Available Void Skills

Use these workspace skills when the user task matches their description. Respect each skill tool list and context.
```

模型会根据用户任务和 skill description 自主选择是否遵守该 skill。也就是说，当前实现是“提示词驱动”的 skill 选择，不是硬性的路由器或隔离执行环境。

实现位置：

- `src/vs/workbench/contrib/void/common/agent/extensions/SkillLoader.ts`
- `src/vs/workbench/contrib/void/browser/agent/AgentExtensionService.ts`
- `src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`

## 5. Hooks 配置

### 5.1 文件位置

Hooks 支持两种来源：

- 工作区 hooks：`<workspace>/.void/hooks/*.json`
- 插件 hooks：`<workspace>/.void/plugins/<plugin-name>/hooks/*.json`

### 5.2 Hook 事件

当前支持这些事件：

- `before_tool_call`
- `after_tool_call`
- `before_file_edit`
- `after_file_edit`
- `after_run_command`
- `before_checkpoint`
- `after_checkpoint`
- `on_run_failed`

### 5.3 Hook JSON 示例

```json
{
  "id": "format-after-edit",
  "event": "after_file_edit",
  "command": "npm run format",
  "cwd": "/absolute/path/to/workspace"
}
```

字段说明：

- `id`：hook 标识；缺省会使用文件路径。
- `event`：触发事件，必须是上面列出的事件之一。
- `command`：触发时运行的本地命令。
- `cwd`：命令执行目录；缺省为 `null`。

Hook 命令通过 temporary terminal 执行，执行完成后再继续对应流程。建议只配置可信命令，避免把耗时或交互式命令放进高频事件。

实现位置：

- `src/vs/workbench/contrib/void/common/agent/extensions/HookRunner.ts`
- `src/vs/workbench/contrib/void/browser/agent/AgentExtensionService.ts`
- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`

## 6. Plugins 配置

### 6.1 目录结构

插件目录位于：

```text
<workspace>/.void/plugins/<plugin-name>/
```

推荐结构：

```text
.void/
  plugins/
    reviewer/
      plugin.json
      skills/
        review.md
      hooks/
        after-edit.json
```

### 6.2 plugin.json 示例

```json
{
  "name": "reviewer",
  "version": "0.1.0",
  "skills": [],
  "hooks": [],
  "mcpServers": [],
  "subagents": []
}
```

当前 `plugin.json` 会被读取并注册为插件元数据；插件目录下的 `skills/*.md` 和 `hooks/*.json` 会实际加载并生效。

注意：当前代码里 `plugin.json` 的 `mcpServers`、`subagents` 字段已经进入类型定义，但还不是自动配置 MCP server 或启动 subagent 的执行链路。MCP 仍需要通过用户级 `mcp.json` 或 workspace `.mcp.json` 配置。

实现位置：

- `src/vs/workbench/contrib/void/common/agent/extensions/PluginLoader.ts`
- `src/vs/workbench/contrib/void/browser/agent/AgentExtensionService.ts`

## 7. 多模态与 supportsVision

### 7.1 配置方式

`supportsVision` 是模型能力配置，可在模型 override defaults 里配置：

```json
{
  "supportsVision": true
}
```

或显式关闭：

```json
{
  "supportsVision": false
}
```

这个配置属于当前 App 的模型配置状态，不是 workspace 文件配置。不同 provider/model 可以有不同 override。

### 7.2 行为

当 `supportsVision !== false`：

- Chat 输入区允许图片附件。
- Agent prompt 中会包含 `read_image` 工具说明。
- OpenAI-compatible / Anthropic 请求会把图片转换成对应 provider 支持的多模态 payload。
- 历史消息中只保留最近 2 条带图片的消息作为真实 image payload，以控制成本。

当 `supportsVision === false`：

- Agent prompt 不再包含 `read_image` 工具。
- 可用工具列表过滤掉 `read_image`。
- 图片上传/发送路径会给出提示，避免把图片交给不支持视觉的模型。

如果 endpoint 实际不支持图片但配置成了 `supportsVision: true`，服务端可能返回不支持 image payload 的错误。当前逻辑会识别这类错误，停止继续向该线程发送图片，并继续后续 Agent 循环，让任务尽量完成而不是直接卡死。

实现位置：

- `src/vs/workbench/contrib/void/common/modelCapabilities.ts`
- `src/vs/workbench/contrib/void/common/prompt/prompts.ts`
- `src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`
- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
- `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`

## 8. Agent 工具与权限

### 8.1 工具类型

内置工具大致分为：

- 只读工具：`read_file`、`read_image`、`ls_dir`、`get_dir_tree`、`search_pathnames_only`、`search_for_files`、`search_in_file`、`read_symbol`、`find_references`、`go_to_definition`、`read_lint_errors`、`git_status`、`git_diff`、`package_script_list`、`review_snapshot`、`read_test_failures`
- 编辑工具：`rewrite_file`、`edit_file`、`create_file_or_folder`、`delete_file_or_folder`、`git_apply_patch`
- 终端/执行工具：`run_command`、`run_tests`、`install_dependencies`、`open_persistent_terminal`、`run_persistent_command`、`kill_persistent_terminal`
- Git 工作流工具：`git_create_branch`、`git_commit`、`git_worktree_create`、`git_worktree_delete`
- MCP 工具：来自已启用 MCP server 的 `tools/list`

### 8.2 风险分级

权限引擎会根据工具名和参数分类：

- low：只读工具或安全的 inspect 命令。
- medium：普通 workspace 编辑、commit、create branch 等。
- high：MCP tool、依赖安装、网络下载、敏感路径修改、部分 git 操作等。
- critical：删除、危险 shell 命令、`rm -rf`、`sudo`、`git reset`、`git clean` 等。

只读工具通常自动允许；编辑、终端、MCP 等根据当前权限策略决定是否需要用户审批。

实现位置：

- `src/vs/workbench/contrib/void/common/agent/permissions/PermissionEngine.ts`
- `src/vs/workbench/contrib/void/common/agent/permissions/RiskClassifier.ts`
- `src/vs/workbench/contrib/void/common/toolsServiceTypes.ts`

## 9. Chat 与 Timeline 体验

Agent 模式下新增了更完整的过程展示：

- Chat 主窗口展示模型输出、工具块、checkpoint、错误、完成状态。
- Timeline tab 展示 Agent 事件流，例如工具开始/结束、权限请求、run finished/failed。
- 最终完成态文案使用类似 `已完成 13s`。
- 流式输出做了节流，保持约 200ms 的 UI 刷新节奏，减少卡顿和过度渲染。

另外，代码块按钮行为已调整：

- shell 类代码块才显示执行按钮。
- 非 shell 代码块隐藏执行按钮，只保留复制。
- 复制/执行 shell 代码时，会去掉行首 `$ `、`❯ `、`➜ ` 等 prompt 前缀，避免复制后不能直接运行。

相关实现：

- `src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx`
- `src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/AgentTimeline.tsx`
- `src/vs/workbench/contrib/void/browser/react/src/markdown/ApplyBlockHoverButtons.tsx`
- `src/vs/workbench/contrib/void/browser/react/src/markdown/ChatMarkdownRender.tsx`

## 10. 推荐配置模板

### 10.1 最小 MCP + Skill workspace 配置

```text
repo/
  AGENTS.md
  .mcp.json
  .void/
    skills/
      code-review.md
```

`.mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/to/repo"
      ]
    }
  }
}
```

`.void/skills/code-review.md`：

```md
---
name: code-review
description: Use for reviewing diffs and implementation risks.
tools: git_diff, read_file, search_for_files, read_lint_errors
context: main
---

Prioritize correctness bugs, behavior regressions, security issues, performance risks, and missing tests.
Return findings first, ordered by severity, with exact file references.
```

`AGENTS.md`：

```md
# Agent Instructions

- Prefer existing project patterns over new abstractions.
- Use `npm run compile` for TypeScript verification.
- Do not modify unrelated files.
```

### 10.2 带 Hook 的配置

```text
repo/
  .void/
    hooks/
      after-edit-format.json
```

`.void/hooks/after-edit-format.json`：

```json
{
  "id": "after-edit-format",
  "event": "after_file_edit",
  "command": "npm run format",
  "cwd": "/absolute/path/to/repo"
}
```

建议谨慎使用自动 format hook：如果项目 format 很慢，可能让每次编辑后的 Agent 体验变钝。

## 11. 当前限制

- Skills 当前是提示词注入，不是强制执行沙箱；模型会按 description 自主选择。
- Skill 的 `tools` 字段当前主要是提示模型遵守，不会在运行时硬过滤工具。
- Plugin 的 `mcpServers`、`subagents` 字段已有类型定义，但未自动转成 MCP 配置或 subagent runtime。
- MCP 工具默认走审批，且 MCP 图片/资源结果目前主要以摘要文本进入模型上下文。
- workspace `.mcp.json` 会覆盖用户级同名 server，命名时建议避免冲突。
- Hook 命令是本地命令，适合短小、确定、可信的自动化；不适合长时间 watch 或需要交互的命令。

