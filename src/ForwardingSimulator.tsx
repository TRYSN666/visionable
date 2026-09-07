import { AlertTriangle, Download, FileUp, LogOut, Play, Router, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveForwardingInjectionInterfaces } from "../shared/forwarding";
import type {
  ForwardingImportIssue,
  ForwardingSnapshotData,
  ForwardingSnapshotSummary,
  ForwardingTraceResult,
} from "../shared/forwarding";
import type { TopologySnapshot } from "../shared/topology";
import type { SimulationCanvasState, SimulationDevice } from "./TopologyCanvas";

interface Props {
  projectId: string;
  topologyId: string;
  topology: TopologySnapshot;
  simulationDevice?: SimulationDevice;
  onClose: () => void;
  onSimulationChange: (simulation: SimulationCanvasState | undefined, nodeIds: ReadonlySet<string>) => void;
  onTopologyChanged?: () => Promise<void> | void;
}

interface PacketProgress {
  id: string;
  transitionId: string;
  progress: number;
}

function snapshotApi(projectId: string, topologyId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/topologies/${encodeURIComponent(topologyId)}/forwarding-snapshots`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function availableInjectionInterfaces(data: ForwardingSnapshotData, deviceId: string, sourceIp: string): ForwardingSnapshotData["interfaces"] {
  const result = new Map<string, ForwardingSnapshotData["interfaces"][number]>();
  for (const item of data.interfaces) {
    if (item.deviceId !== deviceId || item.status !== "up" || !["physical", "lag"].includes(item.interfaceType)) continue;
    const key = item.interfaceName.trim().toLowerCase();
    if (!result.has(key)) result.set(key, resolveForwardingInjectionInterfaces(data, deviceId, item.interfaceName, sourceIp)[0] ?? item);
  }
  return [...result.values()].sort((left, right) => left.interfaceName.localeCompare(right.interfaceName, undefined, { numeric: true }));
}

export function ForwardingSimulator({ projectId, topologyId, topology, simulationDevice, onClose, onSimulationChange, onTopologyChanged }: Props) {
  const [snapshots, setSnapshots] = useState<ForwardingSnapshotSummary[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [snapshotDetail, setSnapshotDetail] = useState<{ snapshotId: string; data: ForwardingSnapshotData }>();
  const [sourceInterface, setSourceInterface] = useState("");
  const [destinationIp, setDestinationIp] = useState("");
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [trace, setTrace] = useState<ForwardingTraceResult>();
  const [visibleTransitions, setVisibleTransitions] = useState(new Set<string>());
  const [packets, setPackets] = useState<PacketProgress[]>([]);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [issues, setIssues] = useState<ForwardingImportIssue[]>([]);
  const expandedStates = useRef(new Set<string>());
  const packetSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const loadSnapshots = useCallback(async () => {
    const response = await fetch(snapshotApi(projectId, topologyId), { headers: { Accept: "application/json" } });
    const data = await response.json() as { snapshots?: ForwardingSnapshotSummary[]; defaultSnapshotId?: string; error?: string };
    if (!response.ok || !data.snapshots) throw new Error(data.error ?? "无法读取转发表快照");
    setSnapshots(data.snapshots);
    setSnapshotId((current) => data.snapshots?.some((item) => item.id === current && item.compatible) ? current : data.defaultSnapshotId ?? data.snapshots?.find((item) => item.compatible)?.id ?? "");
  }, [projectId, topologyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSnapshots().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "无法读取转发表快照"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSnapshots]);

  const clearSimulation = useCallback(() => {
    setTrace(undefined);
    setVisibleTransitions(new Set());
    setPackets([]);
    setPlaying(false);
    expandedStates.current.clear();
  }, []);

  const beginPlayback = useCallback((value: ForwardingTraceResult) => {
    if (reducedMotion) {
      setVisibleTransitions(new Set(value.transitions.map((transition) => transition.id)));
      setPackets([]);
      setPlaying(false);
      return;
    }
    const outgoing = value.transitions.filter((transition) => transition.fromStateId === value.rootStateId);
    expandedStates.current = new Set([value.rootStateId]);
    const initialPackets = outgoing.map((transition) => ({ id: String(++packetSequence.current), transitionId: transition.id, progress: 0 }));
    setVisibleTransitions(new Set(outgoing.map((transition) => transition.id)));
    setPackets(initialPackets);
    setPlaying(initialPackets.length > 0);
  }, [reducedMotion]);

  const injectionInterfaces = useMemo(
    () => snapshotDetail?.snapshotId === snapshotId && simulationDevice ? availableInjectionInterfaces(snapshotDetail.data, simulationDevice.deviceId, simulationDevice.sourceIp) : [],
    [simulationDevice, snapshotDetail, snapshotId],
  );
  const selectedInjectionInterface = injectionInterfaces.find((item) => item.interfaceName === sourceInterface);

  const openStartDialog = async () => {
    setError(undefined);
    if (!simulationDevice) {
      setError("请在拓扑设备上点击右键，创建模拟设备并填写源 IP");
      return;
    }
    if (!snapshotId) {
      setError("请先导入转发表");
      return;
    }
    setBusy(true);
    try {
      let detail = snapshotDetail?.snapshotId === snapshotId ? snapshotDetail.data : undefined;
      if (!detail) {
        const response = await fetch(`${snapshotApi(projectId, topologyId)}/${encodeURIComponent(snapshotId)}`, { headers: { Accept: "application/json" } });
        const data = await response.json() as ForwardingSnapshotData | { error?: string };
        if (!response.ok || !("interfaces" in data)) throw new Error("error" in data ? data.error : "无法读取转发表接口");
        detail = data;
        setSnapshotDetail({ snapshotId, data });
      }
      const interfaces = availableInjectionInterfaces(detail, simulationDevice.deviceId, simulationDevice.sourceIp);
      if (interfaces.length === 0) throw new Error(`设备 ${topology.nodes.find((node) => node.id === simulationDevice.deviceId)?.hostname ?? simulationDevice.deviceId} 在当前转发表中没有可用的流量注入端口`);
      setSourceInterface((current) => interfaces.some((item) => item.interfaceName === current) ? current : "");
      setStartDialogOpen(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取流量注入端口");
    } finally {
      setBusy(false);
    }
  };

  const startTrace = async () => {
    if (!snapshotId) {
      setError("请先导入转发表");
      setStartDialogOpen(false);
      return;
    }
    if (!simulationDevice) {
      setError("请先在拓扑设备上点击右键，创建模拟设备并填写源 IP");
      setStartDialogOpen(false);
      return;
    }
    if (!selectedInjectionInterface) {
      setError("请选择流量注入端口");
      return;
    }
    if (!isIpv4(destinationIp)) {
      setError("请输入有效的目的 IPv4 地址");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setIssues([]);
    try {
      const response = await fetch(`${snapshotApi(projectId, topologyId)}/${encodeURIComponent(snapshotId)}/traces`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceDeviceId: simulationDevice.deviceId,
          sourceIp: simulationDevice.sourceIp,
          destinationIp,
          sourceInterface: selectedInjectionInterface.interfaceName,
          vrf: selectedInjectionInterface.vrf,
        }),
      });
      const data = await response.json() as ForwardingTraceResult | { error?: string };
      if (!response.ok || !("states" in data)) throw new Error("error" in data ? data.error : "无法计算转发路径");
      setTrace(data);
      beginPlayback(data);
      setStartDialogOpen(false);
    } catch (traceError) {
      setError(traceError instanceof Error ? traceError.message : "无法计算转发路径");
    } finally {
      setBusy(false);
    }
  };

  const importWorkbooks = async (files: File[]) => {
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length === 0 || files.length > 50 || files.some((file) => !file.name.toLowerCase().endsWith(".xlsx")) || totalSize > 24 * 1024 * 1024) {
      setError("请选择 1 至 50 个 XLSX 文件，文件总大小不能超过 24 MiB");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setIssues([]);
    try {
      const payload = await Promise.all(files.map(async (file) => ({ name: file.name, contentBase64: await readFileAsBase64(file) })));
      const response = await fetch(snapshotApi(projectId, topologyId), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ files: payload }),
      });
      const data = await response.json() as ForwardingSnapshotSummary | { error?: string; issues?: ForwardingImportIssue[] };
      if (!response.ok || !("id" in data)) {
        if ("issues" in data) setIssues(data.issues ?? []);
        throw new Error("error" in data ? data.error : "转发表导入失败");
      }
      await loadSnapshots();
      await onTopologyChanged?.();
      setSnapshotId(data.id);
      setSnapshotDetail(undefined);
      setSourceInterface("");
      clearSimulation();
      setNotice(`已合并导入 ${files.length} 份转发表，并按设备名匹配到当前拓扑`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "转发表导入失败");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  useEffect(() => {
    if (!playing || !trace || packets.length === 0) return;
    let frame = 0;
    let previous = performance.now();
    const duration = 1150;
    const tick = (now: number) => {
      const delta = Math.min(64, now - previous) / duration;
      previous = now;
      setPackets((current) => {
        const completed = current.filter((packet) => packet.progress + delta >= 1);
        const remaining = current.filter((packet) => packet.progress + delta < 1).map((packet) => ({ ...packet, progress: packet.progress + delta }));
        const spawned: PacketProgress[] = [];
        for (const packet of completed) {
          const transition = trace.transitions.find((item) => item.id === packet.transitionId);
          if (!transition || expandedStates.current.has(transition.toStateId)) continue;
          expandedStates.current.add(transition.toStateId);
          for (const next of trace.transitions.filter((item) => item.fromStateId === transition.toStateId)) {
            spawned.push({ id: String(++packetSequence.current), transitionId: next.id, progress: 0 });
          }
        }
        if (spawned.length > 0) setVisibleTransitions((visible) => new Set([...visible, ...spawned.map((packet) => packet.transitionId)]));
        const next = [...remaining, ...spawned];
        if (next.length === 0) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [packets.length, playing, trace]);

  const activeTransitionIds = useMemo(() => new Set(packets.map((packet) => packet.transitionId)), [packets]);
  const simulation = useMemo<SimulationCanvasState | undefined>(() => trace ? {
    trace,
    visibleTransitionIds: visibleTransitions,
    activeTransitionIds,
    packets,
  } : undefined, [activeTransitionIds, packets, trace, visibleTransitions]);
  const simulationNodes = useMemo(() => new Set(trace?.states.map((state) => state.deviceId) ?? []), [trace]);

  useEffect(() => {
    onSimulationChange(simulation, simulationNodes);
  }, [onSimulationChange, simulation, simulationNodes]);
  useEffect(() => () => onSimulationChange(undefined, new Set()), [onSimulationChange]);

  const selectedDevice = topology.nodes.find((node) => node.id === simulationDevice?.deviceId);
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === snapshotId);
  const activePacket = packets[0] && trace?.states.find((state) => state.id === trace.transitions.find((transition) => transition.id === packets[0].transitionId)?.fromStateId)?.packet;

  return (
    <aside className="forwarding-panel" aria-label="流量路径仿真">
      <div className="forwarding-heading">
        <div><p>SIMULATION MODE</p><h2><Router size={16} />流量仿真模式</h2></div>
        <span className="simulation-live"><i />已开启</span>
      </div>

      <div className="simulation-mode-actions">
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={15} /><span>导入转发表</span></button>
        <button className="forwarding-start" type="button" disabled={busy} onClick={() => void openStartDialog()}><Play size={15} /><span>开始仿真</span></button>
        <button type="button" disabled={!trace} onClick={() => { clearSimulation(); setNotice("本次仿真已结束"); }}><Square size={14} /><span>结束仿真</span></button>
        <button type="button" onClick={() => { clearSimulation(); onClose(); }}><LogOut size={15} /><span>退出仿真</span></button>
        <input ref={fileInput} className="visually-hidden" type="file" multiple accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length > 0) void importWorkbooks(files); }} />
      </div>

      <div className="simulation-mode-guide">
        <b>操作提示</b>
        <p>右键拓扑上的任意设备，创建模拟设备并填写源 IP；开始时选择物理或聚合注入端口，系统按入口 VLAN 自动确定 VRF。</p>
        <a href="/templates/forwarding-state-template.xlsx" download><Download size={12} />下载 XLSX 模板</a>
      </div>

      <div className="simulation-status-grid">
        <div><span>转发表</span><b>{selectedSnapshot ? selectedSnapshot.batchName : "尚未导入"}</b><small>{selectedSnapshot ? `${selectedSnapshot.counts.routes} 条路由 · ${selectedSnapshot.counts.interfaces} 个接口` : "可一次选择多个文件合并导入"}</small></div>
        <div><span>模拟设备</span><b>{selectedDevice?.hostname ?? "尚未创建"}</b><small>{simulationDevice ? `源 IP ${simulationDevice.sourceIp}${sourceInterface ? ` · 注入 ${sourceInterface}` : ""}` : "请在画布设备上点击右键"}</small></div>
      </div>

      {activePacket && <div className="abstract-packet"><p>抽象报文</p><b>{activePacket.innerSourceIp} → {activePacket.innerDestinationIp}</b>{activePacket.vxlan && <span>VXLAN · {activePacket.vxlan.mode.toUpperCase()}VNI {activePacket.vxlan.vni}<br />外层 {activePacket.vxlan.outerSourceVtep} → {activePacket.vxlan.outerDestinationVtep} · UDP {activePacket.vxlan.udpDestinationPort}</span>}</div>}
      {trace && <div className="forwarding-result"><b>{trace.transitions.length} 条链路决策 · {trace.endpoints.length} 个终点</b>{trace.endpoints.map((endpoint, index) => <p key={`${endpoint.stateId}-${index}`} className={endpoint.code === "DELIVERED" ? "success" : "failure"}>{endpoint.code === "DELIVERED" ? "到达" : "停止"}：{endpoint.message}</p>)}</div>}
      {notice && <div className="forwarding-notice">{notice}</div>}
      {error && !startDialogOpen && <div className="forwarding-error"><AlertTriangle size={14} />{error}</div>}
      {issues.length > 0 && <div className="forwarding-issues">{issues.slice(0, 30).map((issue, index) => <p key={`${issue.sourceFile}-${issue.sheet}-${issue.row}-${issue.column}-${index}`}><b>{issue.sourceFile && `${issue.sourceFile} / `}{issue.sheet} {issue.row || ""}行 / {issue.column}</b>{issue.message}</p>)}</div>}

      {startDialogOpen && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setStartDialogOpen(false); }}>
          <form className="simulation-start-modal" role="dialog" aria-modal="true" aria-labelledby="simulation-start-title" onSubmit={(event) => { event.preventDefault(); void startTrace(); }}>
            <p>开始仿真</p>
            <h2 id="simulation-start-title">设置流量注入端口和目的地址</h2>
            <div className="simulation-route-summary"><span>{selectedDevice?.hostname}</span><b>{simulationDevice?.sourceIp}</b><i>→</i><span>目的 IPv4</span></div>
            <label><span>流量注入端口</span><select value={sourceInterface} onChange={(event) => { setSourceInterface(event.target.value); setError(undefined); }}>
              <option value="">请选择端口</option>
              {injectionInterfaces.map((item) => <option key={item.interfaceName} value={item.interfaceName}>{item.interfaceName} · {item.forwardingMode} · VRF {item.vrf}{item.vlan === undefined ? "" : ` · VLAN ${item.vlan}`}</option>)}
            </select></label>
            {selectedInjectionInterface && <div className="simulation-injection-summary">从 {selectedInjectionInterface.interfaceName} 注入 · {selectedInjectionInterface.interfaceType} / {selectedInjectionInterface.forwardingMode} · VRF {selectedInjectionInterface.vrf}{selectedInjectionInterface.vlan === undefined ? "" : ` · VLAN ${selectedInjectionInterface.vlan}`}</div>}
            <label><span>目的 IPv4</span><input value={destinationIp} onChange={(event) => setDestinationIp(event.target.value.trim())} placeholder="例如：10.0.0.2" /></label>
            {error && <div className="forwarding-error"><AlertTriangle size={14} />{error}</div>}
            <div className="import-actions"><button type="button" disabled={busy} onClick={() => setStartDialogOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "正在计算" : "确认开始"}</button></div>
          </form>
        </div>,
        document.body,
      )}
    </aside>
  );
}
