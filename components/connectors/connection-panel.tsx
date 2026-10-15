"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ConnectionList } from "./types";

const states: Record<string, string> = {
  installed: "已安装", recent: "最近使用", online: "在线", delayed: "连接延迟",
  offline: "离线", revoked: "已撤销", expired: "凭据已过期", mcp_recent: "MCP 最近使用",
};
const capabilityNames: Record<string, string> = { read: "读取项目", submit: "报点子 / Ticket", plan: "规划", execute: "开发执行" };
const shell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function ConnectionPanel({ projects, initialProject = "通用", onProjectsChanged, onAuthenticationDenied }: {
  projects: string[];
  initialProject?: string;
  onProjectsChanged: (projects: ConnectionList["projects"]) => void;
  onAuthenticationDenied: () => void;
}) {
  const [data, setData] = useState<ConnectionList>({ connections: [], projects: [] });
  const [project, setProject] = useState(initialProject), [name, setName] = useState("我的 workspace");
  const [capabilities, setCapabilities] = useState(["read", "submit", "plan", "execute"]);
  const [invite, setInvite] = useState<{ code: string; expiresAt: number; origin: string; project: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const request = useCallback(async (body?: unknown) => {
    const response = await fetch("/api/connectors", {
      cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      onAuthenticationDenied();
      throw Error("请重新登录");
    }
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "连接请求失败");
    return value;
  }, [onAuthenticationDenied]);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const value = await request();
      if (current === sequence.current) { setData(value); onProjectsChanged(value.projects); setError(""); }
    } catch (failure) {
      if (current === sequence.current) setError(failure instanceof Error ? failure.message : "无法读取连接");
    }
  }, [request, onProjectsChanged]);
  useEffect(() => {
    const pending = sequence;
    const startup = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 10000);
    return () => { clearTimeout(startup); clearInterval(timer); ++pending.current; };
  }, [refresh]);
  async function createInvite(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { setInvite(await request({ action: "invite", project, name, capabilities })); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法创建授权码"); }
    finally { setBusy(false); }
  }
  async function revoke(connectionId: string) {
    setBusy(true);
    try { await request({ action: "revoke", connectionId }); await refresh(); setNotice("连接已撤销，客户端后续请求将被拒绝。"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "撤销失败"); }
    finally { setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice("已复制"); }
    catch { setNotice("请选中文本复制。"); }
  }
  return <section className="workspace-section" aria-label="MCP 连接管理">
    <div className="section-heading"><div><h2>MCP 与 workspace</h2><p>安装客户端后，其他项目也能向点子工坊提交需求，并领取本项目的规划和已批准任务。</p></div>
      <div className="card-actions"><Link className="secondary" href="/install" target="_blank">安装指南</Link><a className="primary" href="/api/connectors/download" download>下载 MCP / CLI 包</a></div>
    </div>
    <form className="workspace-form" onSubmit={createInvite}>
      <label>关联项目<input value={project} onChange={e => setProject(e.target.value)} list="connector-projects" required maxLength={120} /><datalist id="connector-projects">{projects.map(p => <option key={p} value={p} />)}</datalist></label>
      <label>连接名称<input value={name} onChange={e => setName(e.target.value)} required maxLength={120} /></label>
      <fieldset><legend>客户端能力</legend>{Object.entries(capabilityNames).map(([key, label]) => <label className="capability" key={key}><input type="checkbox" checked={capabilities.includes(key)} onChange={e => setCapabilities(e.target.checked ? [...capabilities, key] : capabilities.filter(c => c !== key))} />{label}</label>)}</fieldset>
      <button className="primary" type="submit" disabled={busy || !capabilities.length}>生成安装授权码</button>
    </form>
    {invite && <div className="installation-code" aria-label="安装授权码">
      <h3>安装到「{invite.project}」</h3><p>一次性授权码，有效至 {new Date(invite.expiresAt).toLocaleTimeString("zh-CN")}。安装命令会从标准输入读取它。</p>
      <div className="card-actions"><code>{invite.code}</code><button type="button" className="secondary" onClick={() => void copy(invite.code)}>复制授权码</button></div>
      <pre>{`curl -fL ${shell(invite.origin + "/api/connectors/download")} -o agent-task-hub-connector.tgz\ntar -xzf agent-task-hub-connector.tgz\nnode agent-task-hub-connector/cli.mjs install --url ${shell(invite.origin)} --workspace '/你的项目绝对路径' --code-stdin`}</pre>
      <p>将项目路径替换为本机 Git 仓库路径，运行命令后输入授权码并结束标准输入；也可以移除 <code>--code-stdin</code>，按提示输入。安装完成会打印 MCP 配置和启动 Agent 的命令。</p>
      <button type="button" className="text-btn" onClick={() => setInvite(null)}>隐藏授权码</button>
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="section-heading"><h3>已注册连接 · {data.connections.length}</h3><button className="secondary" type="button" onClick={() => void refresh()}>刷新连接</button></div>
    <div className="integration-grid">{data.connections.map(connection => <article className="idea-card" key={connection.id}>
      <div className="card-top"><span className="project-tag">{connection.project}</span><span className={"connection " + (connection.status === "online" ? "on" : "")}>{states[connection.status] || connection.status}</span></div>
      <h3>{connection.name}</h3><p>客户端 v{connection.version} · {connection.capabilities.map(c => capabilityNames[c] || c).join("、")}</p>
      <p>最后通信：{connection.lastSeen ? new Date(connection.lastSeen).toLocaleString("zh-CN") : "尚未通信"}</p>
      <p>开发 Agent：{connection.agentReady ? "可用" : "未就绪"}</p>{connection.agentError && <p className="form-error">{connection.agentError}</p>}
      {connection.runtime && <p>接入方式：{connection.runtime.access === "api" ? "API Call（OpenAI 兼容）" : connection.runtime.access === "claude" ? "Claude Code CLI" : connection.runtime.access === "codex-login" ? "Codex 账户登录" : "Codex 本机配置" + (connection.runtime.profile ? ` · Profile ${connection.runtime.profile}` : "")} · {connection.runtime.model || "默认模型"} · {connection.runtime.provider || "默认 provider"}</p>}
      <details><summary>连接详情与近期事件</summary><p>Workspace：{connection.workspace || connection.name}</p><code>{connection.id}</code><p>MCP 最近使用：{connection.mcpLastSeen ? new Date(connection.mcpLastSeen).toLocaleString("zh-CN") : "尚未使用"}</p><p>Agent 最近心跳：{connection.agentLastSeen ? new Date(connection.agentLastSeen).toLocaleString("zh-CN") : "尚未启动"}</p>{connection.events?.length ? <div className="connection-events" tabIndex={0} aria-label="近期连接事件">{connection.events.map(event => <p key={event.id}>{new Date(event.createdAt).toLocaleString("zh-CN")} · {event.mode} {event.message || ""}</p>)}</div> : null}</details>
      {!connection.revokedAt && <button className="text-btn" disabled={busy} type="button" onClick={() => void revoke(connection.id)}>撤销此连接</button>}
    </article>)}</div>
    {!data.connections.length && <p className="form-help">尚无注册客户端。先下载包并生成授权码，安装后这里会显示真实连接记录。</p>}
  </section>;
}
