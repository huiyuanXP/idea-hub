# 本地账户与客户端身份

账户使用本地 scrypt 密码，用户名1–64个 ASCII 字符，密码12–256字。浏览器 session 默认12小时，API token 默认30天；数据库只保留 token 的摘要。不同 owner 的记录和项目互相隔离。

```sh
npm run accounts -- create owner
npm run accounts -- reset owner
npm run accounts -- token owner
npm run accounts -- revoke
```

创建与重置从提示或 stdin 读取密码；revoke 从 stdin/提示读取 token。重置密码会撤销该账户 session/token；密码登录的节流和重置并发在数据库中原子处理。

浏览器使用 HttpOnly、SameSite=Strict cookie，HTTPS 额外使用 Secure。API 使用 Bearer token；不能同时提交两种凭据。身份 header、任意 owner 字段或客户端自报权限都不能替代认证。浏览器写操作保留精确 Host/Origin 校验；Bearer 请求额外接受 loopback Host。

## workspace 客户端

网页登录账户在“连接与执行”创建指定项目、指定能力的一次性授权码，十分钟有效。下载包没有任何凭据；授权码兑换后获得独立的客户端身份和 token。凭据文件0600，父目录0700。客户端 token 默认30天，可在网页撤销。

客户端只允许被授予的读取、报单、规划和执行能力。`submit` 也允许在绑定项目内按修订更新 Ticket 跟进状态和追加调用方证据，审计与重放规则见[项目 MCP Ticket 状态写回](MCP-TICKET-WRITES.md)。执行能力允许领取本项目的已批准任务，不允许客户端批准自己的任务；跨项目及跨 owner 访问拒绝。

项目客户端机器认证仅在明确的 enroll、heartbeat、mcp 和 agent 接口处理；安装包下载是公开代码产物，业务记录和连接管理需要认证。客户端继承本机 Codex 默认配置或显式 Profile，模型账户/API 网关认证留在本机，不写进数据库或下载包；已有 provider 配置不要求再次 Device 登录。

网页撤销后，工具调用、领取和续租立即拒绝；客户端必须停止失去租约的受管进程。连接历史保留，便于查看注册、通信、错误和执行来源。

## Run 专属 Worker

本地源码提供 `/api/execution/workers` 的 owner 发放、列表与撤销接口，以及独立 `/api/execution/worker-mcp`。发放使用实际浏览器 session 或 API token，绑定其 owner、摘要、原始期限、origin 和唯一冻结 Run；每个 owner 最多 16 个有效 Worker，期限最多 15 分钟并受 issuer 期限约束。调用者不能指定 owner/project 等身份字段。客户端自己保存 secret，服务端只存 verifier；管理响应不返回 secret、verifier 或 issuer 摘要。

Worker token 为 `athw1.<小写UUIDv4>.<43字符secret>`，只在精确 machine 端点接受；任何 cookie、本地 owner token 或项目连接 token 都不能替代它。握手、发现与工具调用检查 exact Host/Origin、owner/Run 绑定及 issuer 当前存在性。注销、撤销本地 token、密码重置、自然到期或 Worker 撤销均使委派失效；写操作的权限条件在 SQLite 同一事务前后核实。

当前 Worker 提供两个受限查询和 claim/start/renew/report/complete/cancel 六个动作。动作绑定 6 秒排他 generation、lease secret 与稳定 requestId；execute 要求当前审批、修订、registry 和 permit 期限有效，reconcile 只处理已存在的该 Run permit。consumer 使用本地私有 journal 与 kernel flock 保存短期 Worker/lease secret 和待确认请求；bootstrap/revoke 仅从受保护文件或 fd 读取本地 API token，该 token 不落 journal、不进入运行态 MCP；完整实施边界见[原生执行接口衔接评估](EXECUTION-INTEGRATION.md)。
