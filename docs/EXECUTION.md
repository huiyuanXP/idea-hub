# 执行与验收

工坊区分三种记录：手工快照、本机 Agent 开发 Run，以及固定 Docker 操作 Run。点子/Plan/Ticket 的文字不是授权，手工填写成功也不是进程执行证据。

看板和列表支持按优先级、创建或更新时间排序，排序偏好限当前登录页面会话；同列、列外和取消不写记录。原生鼠标/触屏手柄、键盘列选择及菜单均解析同一业务动作，进行中打开申请，完成打开当前修订的待验收 Run，待开始/等待/异常需明确确认手工状态；已完成来源不重开。准确实现、参考出处及许可边界见[看板交互设计](BOARD-INTERACTIONS.md)。

已保存 Ticket 详情默认阅读，点击“执行此任务”才打开绑定该 id/revision 的共享面板；未保存 Ticket 先保存，正在编辑时先明确保存或返回阅读。面板展示实际 workspace、期限及固定 Docker 的操作/预算，不自动批准、领取或启动。所有相关 workspace 分页都读取，活动 Run 优先进入其详情；历史修订只供查看。身份失效清理私有执行状态，409保留输入并要求明确刷新/重选。

## 本机开发

在“连接与执行”安装关联项目的客户端，再在 Ticket 看板选择 Ticket、对应 workspace 和执行期限，申请开发执行。owner 批准后，客户端才允许领取该修订的任务。

任务冻结 Ticket 修订、项目、连接和期限；同一 Ticket 不允许两个有效执行。项目绑定、连接撤销、当前修订和租约在领取、续租及报告时检查。客户端没有 owner 审批能力。

常驻 Agent 在该 Git 仓库的独立 worktree 中调用本机模型，记录准备、工作、测试、交付及失败阶段。取消、期限到期或失去租约要求停止受管进程；尚未确认结束的执行不能直接开启重复进程。

开发结果包含实际 diff、修改文件、测试命令/退出码/输出和总结，保存为待验收；看板把它放进已完成列并标记“等待审核”。用户点击审核通过后 Ticket 标记完成并归档（移出看板，只在归档视图展示），保留修订历史；返工保留旧结果并创建明确的新尝试。

交付 diff 以任务开始时的固定提交为基准，覆盖任务中的提交、暂存和未暂存改动，
并包含新增的未跟踪文件；主开发 workspace 保留自身改动。交付先保存在安全分支与独立 worktree，保留可恢复提交、测试和截图证据；合并到 `main`、部署或删除交付工作区需另有明确授权。

模型认证缺失、命令执行失败、空结果和未通过检查都必须显示真实原因。客户端报告是本机 Agent 的证据来源，与下面的 Docker 签名收据分开。

### 实时转录与所有者输入

开发 Run 运行时，客户端把 Agent 的每一步写入只追加的转录（`workspace_run_transcript`），种类为 message、reasoning、command_start、command_output、file_change、tool_call、tool_result、error、result、input_echo 和 system，并以 stepId 关联命令与输出、工具调用与结果。客户端和服务端都会先脱敏（Bearer token、`sk-` 密钥、本机 token/路径）；单条正文不超过 32000 字符，超长由客户端截断并标记 truncated；每个 Run 最多 20000 条或 8 MiB，达到上限时写入一条 `system:limit` 条目，此后的追加被接受但不保存，Run 不因此失败。同一条目 id 重放幂等，内容不同返回 409。转录和输入行不可修改或删除，输入状态只能 queued → delivered → applied/rejected 前进。

所有者用 `GET /api/workspace-runs?runId=…&transcriptAfter=N` 分页读取，或用 `GET /api/workspace-runs/stream?runId=…&after=N` 订阅 SSE（transcript、inputs、capabilities、state、end 事件，15 秒心跳，单连接最长 10 分钟后由浏览器带游标重连）；未登录 401，非所有者 404。`POST {action:'input',runId,requestId,mode:'guide'|'interrupt',text}` 只在 Run 为 running 时接受（否则 409），requestId 幂等，文本不超过 4000 字符，并同步写入 input_echo 条目；runner 声明不支持的方式返回 409 `MODE_UNSUPPORTED`。输入属于所有者给 Agent 的提示，不修改 Ticket 修订，也不扩大已批准的 workspace/operation 范围。

持有当前租约的客户端通过 `/api/connector/agent` 的 `transcript`、`inputs`（领取并标记 delivered，未确认的会重新下发）、`input-ack`（applied/rejected 并附原因）和 `capabilities` 动作工作；续租响应附带 `pendingInputs`。Run 离开 running 后，剩余未处理的输入在下次读取时标记为 rejected（“Run ended before delivery”）。

接口为 /api/workspace-runs 的 owner 操作和 /api/connector/agent 的项目客户端领取/续租/回报。网页展示实际授权与执行状态，不能用文本 status 字段替换它们。

## 固定 Docker 操作

已有执行领域保留冻结 Ticket 合同、Run attempt/version、审批范围、资源预算和真实状态机。状态为 queued/running/waiting/succeeded/failed/cancelled，终态不能重新激活；更新使用版本 CAS 和唯一活动占用。

操作目录只包含登记的固定 Node 操作与冻结输入。默认 ticket.validate.v1 校验 Ticket，并不完成任意软件开发。准备授权不启动进程；审批不扩大范围；真正启动需要有效授权、登记操作及签名后端。

成功必须由信任的 P-256 后端证据绑定 owner、Run、Ticket 修订、attempt、authorization、冻结合同摘要和 permit。HTTP 不接受调用者提供的可信公钥。版本1成功证据与版本2 result/cancel_fence/stop 收据保持不同语义；取消意图、逻辑终态和物理停止不能互相替代。

/api/execution/checkpoint 使用独立签名服务主体；它不能继承 owner 决策权限。Runner 对 dispatch、状态、停止和产物使用方向/nonce/body/status 绑定的签名传输，并在本机持久 journal 中恢复。

资源预算和输入/产物 manifest 在准备与执行端校验；登记操作漂移、过期授权、撤销和 Ticket 修订变化阻止新开始。容器网络、文件系统、时限和实际产物由固定 Runner 管理。详见 [RUNNER.md](RUNNER.md)。

workspace Agent 租约承载独立的本地开发协议。Run 专属 Worker 的 owner 发放/撤销、独立身份、两个受限查询与六个租约动作已在本地源码实现。6 秒 generation 租约与 action ledger 在独立表中推进；原生 consumer 以私有 journal、kernel flock 和稳定请求恢复这些动作；执行结束以可信 stop 为物理关闭依据，真实 Docker 验收仍需实际 daemon 与锁定镜像。完整合同及接入条件见[原生执行接口衔接评估](EXECUTION-INTEGRATION.md)。
