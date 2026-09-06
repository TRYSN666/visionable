import { ChevronRight, CircleAlert, Pencil, Pin, RotateCcw, Save, X } from "lucide-react";
import { useState } from "react";
import type { TopologyNode } from "../shared/topology";
import type { GraphEdgeData, GraphNodeData } from "./graphModel";

interface InspectorProps {
  graphNode?: GraphNodeData;
  edge?: GraphEdgeData;
  nodeById: Map<string, TopologyNode>;
  pinned: boolean;
  savingAddress: boolean;
  onSaveServerAddresses: (hostname: string, values: { inBandIp: string; outOfBandIp: string }) => Promise<void>;
  onResetServerAddresses: (hostname: string) => Promise<void>;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function Inspector({ graphNode, edge, nodeById, pinned, savingAddress, onSaveServerAddresses, onResetServerAddresses, onClose, onMouseEnter, onMouseLeave }: InspectorProps) {
  if (!graphNode && !edge) return null;

  if (edge) {
    return (
      <aside className="inspector edge-inspector" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} aria-live="polite">
        <div className="inspector-heading">
          <div><p>聚合链路</p><h2>{edge.count} 条物理连接</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭链路详情"><X size={16} /></button>
        </div>
        <div className="edge-list">
          {edge.members.map((link) => (
            <div className="edge-row" key={link.id}>
              <div><strong>{nodeById.get(link.source)?.label ?? link.source}</strong><span>{link.sourceInterface}</span></div>
              <ChevronRight size={14} />
              <div><strong>{nodeById.get(link.target)?.label ?? link.target}</strong><span>{link.targetInterface}</span></div>
              <b>{link.bandwidth ?? "未知速率"}</b>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  if (!graphNode) return null;
  if (graphNode.kind === "cluster") {
    return (
      <aside className="inspector" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} aria-live="polite">
        <div className="inspector-heading">
          <div><p>{graphNode.cluster?.endpointType === "GPU" ? "GPU 分组" : "终端簇"}</p><h2>{graphNode.label}</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭终端簇详情"><X size={16} /></button>
        </div>
        <div className="cluster-summary"><strong>{graphNode.memberCount}</strong><span>台外部终端</span></div>
        <dl className="metadata"><div><dt>POD</dt><dd>{graphNode.pod}</dd></div><div><dt>机柜</dt><dd>{graphNode.cluster?.rack}</dd></div><div><dt>类型</dt><dd>{graphNode.cluster?.endpointType}</dd></div></dl>
        <p className="inspector-hint">{graphNode.cluster?.endpointType === "GPU" ? `点击该分组可展开或收起 ${graphNode.pod} 的全部 GPU。` : "点击拓扑中的六边形节点展开终端；展开后可逐台查看接口。"}</p>
      </aside>
    );
  }

  const node = graphNode.node;
  if (!node) return null;
  return (
    <DeviceInspector
      key={node.id}
      node={node}
      pinned={pinned}
      savingAddress={savingAddress}
      onSaveServerAddresses={onSaveServerAddresses}
      onResetServerAddresses={onResetServerAddresses}
      onClose={onClose}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
}

interface DeviceInspectorProps extends Pick<InspectorProps, "pinned" | "savingAddress" | "onSaveServerAddresses" | "onResetServerAddresses" | "onClose" | "onMouseEnter" | "onMouseLeave"> {
  node: TopologyNode;
}

function DeviceInspector({ node, pinned, savingAddress, onSaveServerAddresses, onResetServerAddresses, onClose, onMouseEnter, onMouseLeave }: DeviceInspectorProps) {
  const [onlyIp, setOnlyIp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inBandIp, setInBandIp] = useState(node.serverInfo?.inBandIp ?? "");
  const [outOfBandIp, setOutOfBandIp] = useState(node.serverInfo?.outOfBandIp ?? "");
  const visibleInterfaces = onlyIp ? node.interfaces.filter((item) => item.addresses.length > 0) : node.interfaces;

  const save = async () => {
    try {
      await onSaveServerAddresses(node.hostname, { inBandIp, outOfBandIp });
      setEditing(false);
    } catch {
      // The parent surfaces the request error while keeping the form open for correction.
    }
  };

  const reset = async () => {
    try {
      await onResetServerAddresses(node.hostname);
      setInBandIp(node.serverInfo?.inventoryInBandIp ?? "");
      setOutOfBandIp(node.serverInfo?.inventoryOutOfBandIp ?? "");
      setEditing(false);
    } catch {
      // The parent surfaces the request error.
    }
  };

  return (
    <aside className="inspector" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} aria-live="polite">
      <div className="inspector-heading">
        <div>
          <p>{node.kind === "configured" ? "网络设备" : node.endpointType === "GPU" || node.role === "SERVER" ? "服务器" : "外部终端"} · {node.role}</p>
          <h2>{node.label}</h2>
        </div>
        <div className="inspector-actions">{pinned && <Pin size={14} aria-label="详情已固定" />}<button type="button" onClick={onClose} aria-label="关闭设备详情"><X size={16} /></button></div>
      </div>
      <p className="hostname">{node.hostname}</p>
      <dl className="metadata">
        <div><dt>POD</dt><dd>{node.pod}</dd></div>
        <div><dt>机柜</dt><dd>{node.rack ?? "未识别"}</dd></div>
        <div><dt>管理 IP</dt><dd>{node.managementIp ?? "配置未提供"}</dd></div>
      </dl>
      {node.lids && node.lids.length > 0 && (
        <section className="device-lids">
          <div><span>设备 LID</span><b>{node.lids.length}</b></div>
          <p>{node.lids.map((lid) => <span className="address lid" key={lid}>{lid}</span>)}</p>
        </section>
      )}
      {node.serverInfo && (
        <section className="server-address-card">
          <div className="server-address-heading">
            <div><span>GPU 服务器地址</span>{node.serverInfo.manualOverride && <b>人工修订</b>}</div>
            {!editing && <button type="button" onClick={() => setEditing(true)}><Pencil size={13} />修改地址</button>}
          </div>
          {editing ? (
            <div className="server-address-editor">
              <label><span>带内地址</span><input value={inBandIp} onChange={(event) => setInBandIp(event.target.value)} placeholder="未配置" inputMode="decimal" /></label>
              <label><span>带外地址</span><input value={outOfBandIp} onChange={(event) => setOutOfBandIp(event.target.value)} placeholder="未配置" inputMode="decimal" /></label>
              <div>
                <button type="button" className="save-address" disabled={savingAddress} onClick={() => void save()}><Save size={13} />{savingAddress ? "保存中" : "保存"}</button>
                <button type="button" disabled={savingAddress} onClick={() => setEditing(false)}>取消</button>
                {node.serverInfo.manualOverride && <button type="button" disabled={savingAddress} onClick={() => void reset()}><RotateCcw size={13} />恢复清单值</button>}
              </div>
            </div>
          ) : (
            <dl className="server-address-values">
              <div><dt>带内</dt><dd>{node.serverInfo.inBandIp || "配置未提供"}</dd></div>
              <div><dt>带外</dt><dd>{node.serverInfo.outOfBandIp || "配置未提供"}</dd></div>
            </dl>
          )}
        </section>
      )}
      <div className="interface-title"><span>配置中使用的接口</span><div><button type="button" className={onlyIp ? "active" : ""} aria-pressed={onlyIp} onClick={() => setOnlyIp((current) => !current)}>仅查看 IP</button><b>{visibleInterfaces.length}/{node.interfaces.length}</b></div></div>
      <div className="interface-list">
        {visibleInterfaces.length === 0 ? (
          <div className="empty-interfaces"><CircleAlert size={16} />{onlyIp ? "没有配置 IP 的接口" : "配置中未提供接口信息"}</div>
        ) : visibleInterfaces.map((item) => (
          <div className="interface-row" key={item.name}>
            <div className="interface-name"><strong>{item.name}</strong>{item.logical ? <small>逻辑接口</small> : item.peers.length > 0 && <small>连接 {item.peers[0].device}</small>}</div>
            <div className="address-list">
              {item.addresses.length === 0 ? <span className="no-address">配置未提供 IP</span> : item.addresses.map((address) => (
                <span className={address.type === "vrr" ? "address vrr" : "address"} key={`${address.type}-${address.cidr}`}>
                  {address.type === "vrr" ? "VRR " : ""}{address.cidr}
                </span>
              ))}
            </div>
            {item.description && <p title={item.description}>{item.description}</p>}
          </div>
        ))}
      </div>
      <p className="inspector-hint">此处显示配置状态，不代表接口实时 up/down。</p>
    </aside>
  );
}
