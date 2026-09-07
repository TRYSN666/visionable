function normalizedForwardingValue(value) {
    return value.trim().toLowerCase();
}
function injectionPortCarriesVlan(port, vlan) {
    if (vlan === undefined)
        return false;
    if (port.forwardingMode === "access")
        return port.vlan === vlan;
    if (port.forwardingMode === "trunk")
        return port.allowedVlans.includes(vlan);
    return false;
}
function uniqueInjectionContexts(items) {
    const result = new Map();
    for (const item of items) {
        const key = `${normalizedForwardingValue(item.interfaceName)}\0${normalizedForwardingValue(item.vrf)}\0${item.vlan ?? ""}`;
        if (!result.has(key))
            result.set(key, item);
    }
    return [...result.values()];
}
/** Resolve the VLAN/VRF in which traffic entering a physical or LAG port is actually forwarded. */
export function resolveForwardingInjectionInterfaces(data, deviceId, interfaceName, sourceIp) {
    const ports = data.interfaces.filter((item) => item.deviceId === deviceId && item.status === "up" && normalizedForwardingValue(item.interfaceName) === normalizedForwardingValue(interfaceName));
    const contexts = ports.flatMap((port) => {
        if (port.forwardingMode === "routed")
            return [{ ...port, vlan: undefined }];
        const sourceArpContexts = sourceIp ? data.arpEntries.flatMap((arp) => {
            if (arp.deviceId !== deviceId || arp.ip !== sourceIp || arp.status === "incomplete")
                return [];
            const arpInterface = data.interfaces.find((item) => item.deviceId === deviceId && item.status === "up" && normalizedForwardingValue(item.interfaceName) === normalizedForwardingValue(arp.interfaceName));
            if (!injectionPortCarriesVlan(port, arpInterface?.vlan))
                return [];
            return [{ ...port, vrf: arp.vrf, vlan: arpInterface.vlan }];
        }) : [];
        if (sourceArpContexts.length > 0)
            return sourceArpContexts;
        const vlanInterfaceContexts = data.interfaces
            .filter((item) => item.deviceId === deviceId && item.status === "up" && item.forwardingMode === "routed" && injectionPortCarriesVlan(port, item.vlan))
            .map((item) => ({ ...port, vrf: item.vrf, vlan: item.vlan }));
        if (vlanInterfaceContexts.length > 0)
            return vlanInterfaceContexts;
        const vxlanContexts = data.vxlanEntries
            .filter((item) => item.deviceId === deviceId && item.status === "up" && item.mode === "l2" && item.tenantVrf && injectionPortCarriesVlan(port, item.vlan))
            .map((item) => ({ ...port, vrf: item.tenantVrf, vlan: item.vlan }));
        return vxlanContexts.length > 0 ? vxlanContexts : [port];
    });
    return uniqueInjectionContexts(contexts);
}
//# sourceMappingURL=forwarding.js.map