# MCP / CLI 安装与连接

网页 /install 和 JSON 接口 /install/manifest 给出当前服务的实际下载地址与命令。先在“连接与执行”创建项目授权码，再下载安装包。

```sh
curl -fL 'http://127.0.0.1:5173/api/connectors/download' -o agent-task-hub-connector.tgz
tar -xzf agent-task-hub-connector.tgz
node agent-task-hub-connector/cli.mjs install --url 'http://127.0.0.1:5173' --workspace '/absolute/git/project'
```

按提示输入授权码，或使用 --code-stdin 由标准输入提供。安装器复制运行文件到私有配置目录、保存专属凭据、添加项目 MCP 配置，并打印实际可用的启动命令。已经安装后，下载目录可移除。

```sh
node agent-task-hub-connector/cli.mjs doctor --workspace '/absolute/git/project'
node agent-task-hub-connector/cli.mjs mcp --workspace '/absolute/git/project'
node agent-task-hub-connector/cli.mjs agent --workspace '/absolute/git/project'
```

MCP 使用 STDIO JSON-RPC；stdout 仅传输协议，日志写 stderr。其他 MCP 客户端按安装器打印的 command/args 配置接入。常驻 Agent 通过 outbound HTTP 领取任务和发送心跳，不依赖远程 workspace 的 inbound 回调。

后台管理已注册客户端，区分 MCP 最近使用与 daemon 在线。心跳15秒一次，45秒内为在线，45–90秒延迟，超过90秒离线。模型认证错误单独显示，不把在线等同于能执行。

服务地址变化用 set-url --url 更新；卸载使用 uninstall。卸载本机配置与网页撤销身份是两个操作，网页撤销立即禁止后续工具调用和续租。保留连接历史。

工坊自己的仓库也可用相同方式关联为一个 workspace；项目绑定名必须与点子/Ticket 的项目一致。不要把没有关联仓库的普通项目当成已经具备开发执行能力。

本机工坊仓库的已安装连接位于 `/home/agent/projects/agent-task-hub/.agent-task-hub/`，
绑定项目为“通用”。在主开发目录执行以下命令使用现有身份：

```sh
.local/tools/node-v22.23.3-linux-x64/bin/node .agent-task-hub/runtime/1.0.0/cli.mjs mcp --workspace /home/agent/projects/agent-task-hub
.local/tools/node-v22.23.3-linux-x64/bin/node .agent-task-hub/runtime/1.0.0/cli.mjs agent --workspace /home/agent/projects/agent-task-hub
```

MCP 的 `list_tickets`、`get_ticket` 和 `get_plan` 用于读取任务及其合同；常驻
Agent 通过项目客户端执行接口领取已批准的 Run。移动已安装 workspace 时，
保留连接凭据，统一更新 `connection.json` 的 `workspace`、`file`、`runtime`
与 `.codex/config.toml` 的 command、args、cwd，再复用 install 命令刷新运行文件。

## 本机 Codex 配置与 Profile

客户端默认继承本机 Codex 的默认模型、provider 和认证配置，不要求已有 API 网关用户重新 Device 登录。使用 --profile mimo 或 --profile oneapi 可以选择本机已有的配置文件；具体名称及模型以安装机器的实际配置为准。

```sh
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs agent --workspace /absolute/project --profile mimo
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs doctor --workspace /absolute/project
```

显式选项保存在本机客户端配置，不复制模型凭据。--profile default 恢复默认 Profile；省略 --model 和 --reasoning 时沿用 Codex 配置。后台连接记录显示所选 Profile、模型和 provider，实际调用失败时显示真实错误。

使用官方账户认证方式且本机尚未登录时，仍可自行 codex login；已有 Profile 的 API 认证由本机 Codex 处理。

## 接入方式

客户端支持三种模型接入方式：Codex 本机默认配置或 Profile、Codex 账户登录，以及不经过 Codex CLI 的直接 API Call。前两种由 `codex exec` 执行；`--access codex` 恢复为 Codex。

直接 API Call 使用 OpenAI 兼容的 Chat Completions 协议（`/models` 与 `/chat/completions`，函数工具调用）。`--api-profile NAME` 从本机 `NAME.config.toml` 的 provider 读取 `base_url`、`env_key` 与模型；也可用 `--api-base-url`、`--api-key-env`、`--api-model` 显式指定或覆盖：

```sh
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs doctor --workspace /absolute/project --access api --api-profile mimo
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs agent --workspace /absolute/project --access api --api-base-url https://gateway.example/v1 --api-key-env GATEWAY_API_KEY --api-model model-name
```

### 实时转录与引导/打断

开发 Run 中三种接入方式都把模型事件统一成转录条目，经 `transcript.mjs` 脱敏、截断、每 400 ms 或 50 条批量上送；上送失败只写 stderr，不让 Run 失败。客户端每秒领取所有者输入并回报结果，三种方式都声明支持引导和打断：

- Codex：开发 Run 不再使用 `--ephemeral` 并记录 thread id；引导在当前轮次成功结束后用 `codex exec resume <thread> -` 带消息续跑，打断先停止进程组再以同样方式续跑；thread id 尚未产生时的打断回报 rejected。
- Claude Code：以 `--input-format stream-json` 运行并保持 stdin 打开，引导直接写入新的 user 消息；打断停止进程组并以 `--resume <session>` 续跑。会话因此会持久化到本机 Claude 历史。
- 直接 API Call：引导在下一次模型请求前插入 user 消息；打断中止当前请求或命令，插入消息后继续。

续跑沿用原截止时间、租约、沙箱和 Ticket 范围声明，测试收据跨段累积，结构化结果取最后一段。规划作业不接受输入。修改后的客户端运行时需要重新打包并刷新已安装的 `.agent-task-hub` 运行时才生效。

`connection.json` 只保存端点、模型和密钥环境变量名；密钥只从运行 Agent 的进程环境读取，不写入文件、心跳或 Hub。就绪检查真实请求 `/models` 并确认所选模型可用，失败原因（如未设置变量或 401）作为 Agent 错误显示在连接页面。规划时模型只能使用只读的列目录、读文件和 ripgrep 搜索工具；开发时在隔离 worktree 内额外使用写文件、精确替换和运行命令工具，路径限定在 worktree 内且不可修改 `.git`，命令进程不继承 API 密钥，push、remote、Git 配置和 npm publish 被拒绝。测试类命令的退出码和输出作为实际收据交付，交付合同与 Codex 方式相同。
