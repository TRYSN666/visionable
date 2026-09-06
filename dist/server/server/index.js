import path from "node:path";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { ServerAddressStore } from "./serverAddressStore.js";
import { TopologyStore } from "./store.js";
const defaultPort = process.env.NODE_ENV === "production" ? "3000" : "3001";
const port = Number.parseInt(process.env.PORT ?? defaultPort, 10);
const configDir = path.resolve(process.env.DEVICE_CONFIG_DIR ?? path.join(process.cwd(), "device-config"));
const dataDir = path.resolve(process.env.TOPOLOGY_DATA_DIR ?? path.join(process.cwd(), ".data"));
const store = new TopologyStore(configDir, new ServerAddressStore(path.join(dataDir, "topology.db")));
try {
    const snapshot = await store.refresh();
    console.info(`Topology loaded: ${snapshot.stats.configuredDevices} configured devices, ${snapshot.stats.externalDevices} external devices`);
    const initialPortsCsvPath = process.env.INITIAL_PORTS_CSV_PATH;
    if (initialPortsCsvPath && !store.projects().some((project) => project.id === "metta" && project.topologies.some((topology) => topology.id === "metta-ib" || topology.name.toLowerCase() === "metta ib网络".toLowerCase()))) {
        const resolvedPath = path.resolve(initialPortsCsvPath);
        await store.importTopology("metta", "Metta IB网络", await readFile(resolvedPath, "utf8"), path.basename(resolvedPath), "metta-ib");
        console.info("Initial Metta IB topology imported");
    }
}
catch (error) {
    console.error("Initial topology load failed:", error instanceof Error ? error.message : error);
}
const app = createApp({ store, serveClient: process.env.NODE_ENV === "production" });
app.listen(port, "0.0.0.0", () => {
    console.info(`Network topology service listening on port ${port}`);
});
//# sourceMappingURL=index.js.map