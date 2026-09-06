import express from "express";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogNotFoundError, InvalidLayoutNodeError, ServerNodeNotFoundError } from "./store.js";
export function createApp({ store, serveClient = false }) {
    const app = express();
    app.disable("x-powered-by");
    // JSON escaping can make a valid 12 MiB CSV larger on the wire.
    app.use(express.json({ limit: "26mb" }));
    const validName = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80;
    const catalogError = (error) => {
        if (error instanceof CatalogNotFoundError)
            return { status: 404, message: error.message };
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
            return { status: 409, message: "名称已存在" };
        return { status: 400, message: error instanceof Error ? error.message : "操作失败" };
    };
    const parsePositions = (rawPositions) => {
        if (!rawPositions || typeof rawPositions !== "object" || Array.isArray(rawPositions))
            return { error: "positions 必须是节点坐标对象" };
        const entries = Object.entries(rawPositions);
        if (entries.length === 0 || entries.length > 5000)
            return { error: "布局必须包含 1 至 5000 个节点" };
        const positions = Object.create(null);
        for (const [id, value] of entries) {
            const position = value;
            if (id.length === 0 || id.length > 256 || !position || typeof position.x !== "number" || typeof position.y !== "number" || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1_000_000 || Math.abs(position.y) > 1_000_000) {
                return { error: `节点 ${id || "(空)"} 的坐标无效` };
            }
            positions[id] = { x: position.x, y: position.y };
        }
        return { positions };
    };
    app.get("/healthz", (_request, response) => {
        response.status(200).json({ status: "ok" });
    });
    app.get("/readyz", (_request, response) => {
        if (!store.ready) {
            response.status(503).json({ status: "not-ready", error: store.error ?? "拓扑尚未加载" });
            return;
        }
        response.status(200).json({ status: "ready", revision: store.current?.revision });
    });
    app.get("/api/topology", (_request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (!store.current) {
            response.status(503).json({ error: store.error ?? "拓扑尚未加载" });
            return;
        }
        response.status(200).json(store.current);
    });
    app.post("/api/topology/refresh", async (_request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
            const snapshot = await store.refresh();
            response.status(200).json(snapshot);
        }
        catch (error) {
            response.status(503).json({
                error: error instanceof Error ? error.message : "无法刷新拓扑",
                retainedRevision: store.current?.revision,
            });
        }
    });
    app.get("/api/projects", (_request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(store.projects());
    });
    app.post("/api/projects", (request, response) => {
        const { name } = request.body;
        if (!validName(name))
            return void response.status(400).json({ error: "项目名称必须为 1 至 80 个字符" });
        try {
            response.status(201).json(store.createProject(name.trim()));
        }
        catch (error) {
            const result = catalogError(error);
            response.status(result.status).json({ error: result.message });
        }
    });
    app.put("/api/projects/:projectId", (request, response) => {
        const { name } = request.body;
        if (!validName(name))
            return void response.status(400).json({ error: "项目名称必须为 1 至 80 个字符" });
        try {
            response.status(200).json(store.renameProject(request.params.projectId, name.trim()));
        }
        catch (error) {
            const result = catalogError(error);
            response.status(result.status).json({ error: result.message });
        }
    });
    app.put("/api/projects/:projectId/topologies/:topologyId", (request, response) => {
        const { name } = request.body;
        if (!validName(name))
            return void response.status(400).json({ error: "拓扑名称必须为 1 至 80 个字符" });
        try {
            response.status(200).json(store.renameTopology(request.params.projectId, request.params.topologyId, name.trim()));
        }
        catch (error) {
            const result = catalogError(error);
            response.status(result.status).json({ error: result.message });
        }
    });
    app.get("/api/projects/:projectId/topologies/:topologyId", (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
            response.status(200).json(store.topology(request.params.projectId, request.params.topologyId));
        }
        catch (error) {
            const result = catalogError(error);
            response.status(result.status).json({ error: result.message });
        }
    });
    app.post("/api/projects/:projectId/topologies/:topologyId/refresh", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
            const summary = store.projects().flatMap((project) => project.topologies).find((topology) => topology.id === request.params.topologyId && topology.projectId === request.params.projectId);
            if (!summary)
                throw new CatalogNotFoundError("拓扑不存在");
            response.status(200).json(summary.sourceType === "nvue" ? await store.refresh() : store.topology(request.params.projectId, request.params.topologyId));
        }
        catch (error) {
            const result = catalogError(error);
            response.status(result.status).json({ error: result.message });
        }
    });
    app.post("/api/projects/:projectId/topologies/import", async (request, response) => {
        const { name, fileName, csvText, xlsxBase64 } = request.body;
        if (!validName(name))
            return void response.status(400).json({ error: "拓扑名称必须为 1 至 80 个字符" });
        if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 240 || !/\.(?:csv|xlsx)$/i.test(fileName))
            return void response.status(400).json({ error: "仅支持 CSV 或 XLSX 连线表" });
        const isXlsx = fileName.toLowerCase().endsWith(".xlsx");
        let fileContent;
        if (isXlsx) {
            if (typeof xlsxBase64 !== "string" || xlsxBase64.length === 0)
                return void response.status(400).json({ error: "XLSX 内容不能为空" });
            if (xlsxBase64.length > 16 * 1024 * 1024 + 16 || !/^[A-Za-z0-9+/]*={0,2}$/.test(xlsxBase64))
                return void response.status(400).json({ error: "XLSX 内容编码无效或文件超过 12 MiB" });
            fileContent = Buffer.from(xlsxBase64, "base64");
        }
        else {
            if (typeof csvText !== "string" || csvText.length === 0)
                return void response.status(400).json({ error: "CSV 内容不能为空" });
            fileContent = csvText;
        }
        try {
            const imported = await store.importTopology(request.params.projectId, name.trim(), fileContent, path.basename(fileName));
            response.status(201).json({ projects: store.projects(), topologyId: imported.id, snapshot: imported.snapshot });
        }
        catch (error) {
            const result = catalogError(error);
            response.status(result.status).json({ error: result.message });
        }
    });
    app.put("/api/topology/layout", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        const parsed = parsePositions(request.body?.positions);
        if ("error" in parsed)
            return void response.status(400).json({ error: parsed.error });
        try {
            response.status(200).json(await store.saveLayout(parsed.positions));
        }
        catch (error) {
            response.status(error instanceof InvalidLayoutNodeError ? 400 : 503).json({
                error: error instanceof Error ? error.message : "无法保存拓扑布局",
                retainedRevision: store.current?.revision,
            });
        }
    });
    app.put("/api/projects/:projectId/topologies/:topologyId/layout", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        const parsed = parsePositions(request.body?.positions);
        if ("error" in parsed)
            return void response.status(400).json({ error: parsed.error });
        try {
            response.status(200).json(await store.saveTopologyLayout(request.params.projectId, request.params.topologyId, parsed.positions));
        }
        catch (error) {
            response.status(error instanceof InvalidLayoutNodeError ? 400 : error instanceof CatalogNotFoundError ? 404 : 503).json({ error: error instanceof Error ? error.message : "无法保存拓扑布局" });
        }
    });
    const validAddress = (value) => {
        if (typeof value !== "string" || value.length > 64)
            return false;
        if (!value.trim())
            return true;
        const [address, prefix, extra] = value.trim().split("/");
        if (extra !== undefined || isIP(address) === 0)
            return false;
        if (prefix === undefined)
            return true;
        const prefixNumber = Number(prefix);
        return Number.isInteger(prefixNumber) && prefixNumber >= 0 && prefixNumber <= (isIP(address) === 4 ? 32 : 128);
    };
    app.put("/api/server-addresses/:hostname", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        const { inBandIp, outOfBandIp } = request.body;
        if (!validAddress(inBandIp) || !validAddress(outOfBandIp)) {
            response.status(400).json({ error: "带内和带外地址必须是有效的 IP 或 CIDR；留空表示未配置" });
            return;
        }
        try {
            const snapshot = await store.updateServerAddresses(request.params.hostname, inBandIp.trim(), outOfBandIp.trim());
            response.status(200).json(snapshot);
        }
        catch (error) {
            response.status(error instanceof ServerNodeNotFoundError ? 404 : 503).json({
                error: error instanceof Error ? error.message : "无法保存服务器地址",
                retainedRevision: store.current?.revision,
            });
        }
    });
    app.delete("/api/server-addresses/:hostname", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
            const snapshot = await store.resetServerAddresses(request.params.hostname);
            response.status(200).json(snapshot);
        }
        catch (error) {
            response.status(error instanceof ServerNodeNotFoundError ? 404 : 503).json({
                error: error instanceof Error ? error.message : "无法恢复服务器清单地址",
                retainedRevision: store.current?.revision,
            });
        }
    });
    if (serveClient) {
        const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
        const clientDirectory = path.resolve(currentDirectory, "../../client");
        app.use(express.static(clientDirectory, { index: false, maxAge: "1h" }));
        app.get("*path", (_request, response) => {
            response.sendFile(path.join(clientDirectory, "index.html"));
        });
    }
    return app;
}
//# sourceMappingURL=app.js.map