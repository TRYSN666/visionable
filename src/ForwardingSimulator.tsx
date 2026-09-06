import { AlertTriangle, Download, FileUp, Globe2, Pause, Play, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ForwardingImportIssue,
  ForwardingSnapshotSummary,
  ForwardingTraceResult,
} from "../shared/forwarding";
import type { TopologySnapshot } from "../shared/topology";
import type { SimulationCanvasState } from "./TopologyCanvas";

interface Props {
  projectId: string;
  topologyId: string;
  topology: TopologySnapshot;
  onClose: () => void;
  onSimulationChange: (simulation: SimulationCanvasState | undefined, nodeIds: ReadonlySet<string>) => void;
}

interface PacketProgress {
  id: string;
  transitionId: string;
  progress: number;
}

function snapshotApi(projectId: string, topologyId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/topologies/${encodeURIComponent(topologyId)}/forwarding-snapshots`;
}

export function ForwardingSimulator({ projectId, topologyId, topology, onClose, onSimulationChange }: Props) {
  const [snapshots, setSnapshots] = useState<ForwardingSnapshotSummary[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [deviceQuery, setDeviceQuery] = useState("");
  const [sourceDeviceId, setSourceDeviceId] = useState("");
  const [sourceIp, setSourceIp] = useState("");
  const [destinationIp, setDestinationIp] = useState("");
  const [sourceInterface, setSourceInterface] = useState("");
  const [vrf, setVrf] = useState("");
  const [trace, setTrace] = useState<ForwardingTraceResult>();
  const [visibleTransitions, setVisibleTransitions] = useState(new Set<string>());
  const [packets, setPackets] = useState<PacketProgress[]>([]);
  const [playing, setPlaying] = useState(false);
  const [globalView, setGlobalView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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

  const devices = useMemo(() => topology.nodes.filter((node) => `${node.hostname} ${node.label}`.toLowerCase().includes(deviceQuery.trim().toLowerCase())).slice(0, 80), [deviceQuery, topology.nodes]);
  const selectedDevice = topology.nodes.find((node) => node.id === sourceDeviceId);

  const chooseDevice = (deviceId: string) => {
    const node = topology.nodes.find((item) => item.id === deviceId);
    setSourceDeviceId(deviceId);
    setDeviceQuery(node?.hostname ?? "");
    const firstAddress = node?.interfaces.flatMap((item) => item.addresses).find((address) => /^\d+\.\d+\.\d+\.\d+\//.test(address.cidr));
    setSourceIp(firstAddress?.cidr.split("/")[0] ?? "");
  };

  const clearSimulation = useCallback(() => {
    setTrace(undefined);
    setVisibleTransitions(new Set());
    setPackets([]);
    setPlaying(false);
    setGlobalView(false);
    expandedStates.current.clear();
  }, []);

  const beginPlayback = useCallback((value: ForwardingTraceResult) => {
    const outgoing = value.transitions.filter((transition) => transition.fromStateId === value.rootStateId);
    expandedStates.current = new Set([value.rootStateId]);
    const initialPackets = outgoing.map((transition) => ({ id: String(++packetSequence.current), transitionId: transition.id, progress: 0 }));
    setVisibleTransitions(new Set(outgoing.map((transition) => transition.id)));
    setPackets(initialPackets);
    setGlobalView(false);
    setPlaying(!reducedMotion && initialPackets.length > 0);
  }, [reducedMotion]);

  const advanceReducedMotion = () => {
    if (!trace) return;
    setPackets((current) => {
      const spawned: PacketProgress[] = [];
      for (const packet of current) {
        const transition = trace.transitions.find((item) => item.id === packet.transitionId);
        if (!transition || expandedStates.current.has(transition.toStateId)) continue;
        expandedStates.current.add(transition.toStateId);
        for (const next of trace.transitions.filter((item) => item.fromStateId === transition.toStateId)) spawned.push({ id: String(++packetSequence.current), transitionId: next.id, progress: 0 });
      }
      if (spawned.length > 0) setVisibleTransitions((visible) => new Set([...visible, ...spawned.map((packet) => packet.transitionId)]));
      return spawned;
    });
  };

  const startTrace = async () => {
    if (!snapshotId || !sourceDeviceId || !sourceIp || !destinationIp) {
      setError("请选择快照和源设备，并填写源/目的 IPv4 地址");
      return;
    }
    setBusy(true);
    setError(undefined);
    setIssues([]);
    try {
      const response = await fetch(`${snapshotApi(projectId, topologyId)}/${encodeURIComponent(snapshotId)}/traces`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ sourceDeviceId, sourceIp, destinationIp, sourceInterface: sourceInterface || undefined, vrf: vrf || undefined }),
      });
      const data = await response.json() as ForwardingTraceResult | { error?: string };
      if (!response.ok || !("states" in data)) throw new Error("error" in data ? data.error : "无法计算转发路径");
      setTrace(data);
      beginPlayback(data);
    } catch (traceError) {
      setError(traceError instanceof Error ? traceError.message : "无法计算转发路径");
    } finally {
      setBusy(false);
    }
  };

  const importWorkbook = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".xlsx") || file.size > 24 * 1024 * 1024) {
      setError("请选择不超过 24 MiB 的 XLSX 转发表工作簿");
      return;
    }
    setBusy(true);
    setError(undefined);
    setIssues([]);
    try {
      const response = await fetch(snapshotApi(projectId, topologyId), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        body: await file.arrayBuffer(),
      });
      const data = await response.json() as ForwardingSnapshotSummary | { error?: string; issues?: ForwardingImportIssue[] };
      if (!response.ok || !("id" in data)) {
        if ("issues" in data) setIssues(data.issues ?? []);
        throw new Error("error" in data ? data.error : "转发表导入失败");
      }
      await loadSnapshots();
      setSnapshotId(data.id);
      clearSimulation();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "转发表导入失败");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  useEffect(() => {
    if (!playing || !trace || globalView || packets.length === 0) return;
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
  }, [globalView, packets.length, playing, trace]);

  const activeTransitionIds = useMemo(() => new Set(packets.map((packet) => packet.transitionId)), [packets]);
  const simulation = useMemo<SimulationCanvasState | undefined>(() => trace ? {
    trace,
    visibleTransitionIds: globalView ? new Set(trace.transitions.map((transition) => transition.id)) : visibleTransitions,
    activeTransitionIds: globalView ? new Set<string>() : activeTransitionIds,
    packets: globalView ? [] : packets,
  } : undefined, [activeTransitionIds, globalView, packets, trace, visibleTransitions]);
  const simulationNodes = useMemo(() => new Set(trace?.states.map((state) => state.deviceId) ?? []), [trace]);

  useEffect(() => {
    onSimulationChange(simulation, simulationNodes);
  }, [onSimulationChange, simulation, simulationNodes]);
  useEffect(() => () => onSimulationChange(undefined, new Set()), [onSimulationChange]);

  const activePacket = packets[0] && trace?.states.find((state) => state.id === trace.transitions.find((transition) => transition.id === packets[0].transitionId)?.fromStateId)?.packet;

  return (
    <aside className="forwarding-panel" aria-label="流量路径仿真">
      <div className="forwarding-heading">
        <div><p>SYMBOLIC FORWARDING</p><h2>流量路径仿真</h2></div>
        <button type="button" onClick={onClose} aria-label="关闭流量仿真"><X size={16} /></button>
      </div>
      <div className="forwarding-tools">
        <a href="/templates/forwarding-state-template.xlsx" download><Download size={14} />下载模板</a>
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={14} />导入转发表</button>
        <input ref={fileInput} className="visually-hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importWorkbook(file); }} />
      </div>

      <label className="forwarding-field"><span>历史快照</span><select value={snapshotId} onChange={(event) => { setSnapshotId(event.target.value); clearSimulation(); }}><option value="">尚未导入</option>{snapshots.map((item) => <option key={item.id} value={item.id} disabled={!item.compatible}>{item.batchName} · {new Date(item.collectedAt).toLocaleString("zh-CN")}{item.isDefault ? "（最新）" : ""}{!item.compatible ? "（不兼容）" : ""}</option>)}</select></label>
      <label className="forwarding-field"><span>源设备搜索</span><div className="forwarding-search"><Search size={14} /><input value={deviceQuery} onChange={(event) => { setDeviceQuery(event.target.value); setSourceDeviceId(""); }} placeholder="输入设备名" /></div></label>
      {!sourceDeviceId && deviceQuery && <div className="forwarding-device-results">{devices.map((node) => <button type="button" key={node.id} onClick={() => chooseDevice(node.id)}><b>{node.hostname}</b><small>{node.role} · {node.pod}</small></button>)}</div>}
      {selectedDevice && <div className="forwarding-selected-device">源设备：<b>{selectedDevice.hostname}</b></div>}
      <div className="forwarding-addresses">
        <label className="forwarding-field"><span>源 IPv4</span><input value={sourceIp} onChange={(event) => setSourceIp(event.target.value)} placeholder="10.0.0.1" /></label>
        <label className="forwarding-field"><span>目的 IPv4</span><input value={destinationIp} onChange={(event) => setDestinationIp(event.target.value)} placeholder="10.0.0.2" /></label>
      </div>
      <details className="forwarding-advanced"><summary>地址归属不唯一时补充</summary><div><label className="forwarding-field"><span>源接口</span><input value={sourceInterface} onChange={(event) => setSourceInterface(event.target.value)} /></label><label className="forwarding-field"><span>VRF</span><input value={vrf} onChange={(event) => setVrf(event.target.value)} /></label></div></details>

      <div className="forwarding-controls">
        <button className="forwarding-start" type="button" disabled={busy} onClick={() => void startTrace()}><Play size={14} />{busy ? "处理中" : "开始"}</button>
        <button type="button" disabled={!trace || packets.length === 0} onClick={() => reducedMotion ? advanceReducedMotion() : setPlaying((value) => !value)}>{playing ? <Pause size={14} /> : <Play size={14} />}{reducedMotion ? "下一跳" : playing ? "暂停" : "继续"}</button>
        <button type="button" disabled={!trace} onClick={() => trace && beginPlayback(trace)}><RotateCcw size={14} />重播</button>
        <button type="button" disabled={!trace} onClick={() => { if (!trace) return; setGlobalView(true); setPlaying(false); setPackets([]); setVisibleTransitions(new Set(trace.transitions.map((item) => item.id))); }}><Globe2 size={14} />展示全局</button>
        <button type="button" disabled={!trace} onClick={clearSimulation}><Trash2 size={14} />清除</button>
      </div>

      {activePacket && <div className="abstract-packet"><p>抽象报文</p><b>{activePacket.innerSourceIp} → {activePacket.innerDestinationIp}</b>{activePacket.vxlan && <span>VXLAN · {activePacket.vxlan.mode.toUpperCase()}VNI {activePacket.vxlan.vni}<br />外层 {activePacket.vxlan.outerSourceVtep} → {activePacket.vxlan.outerDestinationVtep} · UDP {activePacket.vxlan.udpDestinationPort}</span>}</div>}
      {trace && <div className="forwarding-result"><b>{trace.transitions.length} 条链路决策 · {trace.endpoints.length} 个终点</b>{trace.endpoints.map((endpoint, index) => <p key={`${endpoint.stateId}-${index}`} className={endpoint.code === "DELIVERED" ? "success" : "failure"}>{endpoint.code === "DELIVERED" ? "到达" : "停止"}：{endpoint.message}</p>)}</div>}
      {error && <div className="forwarding-error"><AlertTriangle size={14} />{error}</div>}
      {issues.length > 0 && <div className="forwarding-issues">{issues.slice(0, 30).map((issue, index) => <p key={`${issue.sheet}-${issue.row}-${issue.column}-${index}`}><b>{issue.sheet} {issue.row || ""}行 / {issue.column}</b>{issue.message}</p>)}</div>}
    </aside>
  );
}
