# 网络拓扑中心

从 NVUE `nv config show -o commands` Markdown 配置或 Ports CSV 连线表中提取设备、接口、IP、LID 与链路，并生成可搜索、筛选和分层展示的网络拓扑。GPU 服务器的带内、带外地址从 `device-config` 第一层的 SN 核对 CSV 同步，并可在网页中人工修订。

应用以“项目 → 拓扑”组织数据。首次启动会创建 `Metta` 项目及 `Metta RoCE网络`；可通过 `INITIAL_PORTS_CSV_PATH` 一次性导入 `Metta IB网络`。网页允许新增和重命名项目、重命名拓扑，并可在每个项目中把 CSV 拖入“新增拓扑”窗口。上传后的结构化拓扑和每张拓扑各自的布局都保存在 SQLite 数据卷中，其他用户打开同一实例时会看到相同结果。

CSV 或 XLSX 连线表必须包含本端设备、本端端口、对端设备和对端端口；支持关系表中的 `本端设备`、`本端端口`、`本端IP`、`对端设备`、`对端端口`、`对端IP`，也兼容 `System`、`Port`、`Peer Node`、`Peer Port` 及原有中英文表头。XLSX 默认读取第一个工作表。`LID` 和 `Peer LID` 为可选字段，存在时会聚合为设备属性并显示在设备详情中，不附着到单个接口。本端与对端设备名称相同的行会作为该设备的逻辑接口保留，不生成拓扑自环链路。服务端只保存解析后的白名单字段，不保存或下载原始上传文件。

IB 拓扑按照设备名识别 `IBCR → IBSP → IBLF → 服务器` 层级，并以 POD 独立分列。每个层级的高度会根据该层设备数量动态扩展，避免不同 POD 或层级互相重叠。服务器默认不显示；选择网络设备后只展开与所选设备直连的服务器，也可使用对应 POD 的服务器按钮显式展开。IB 与 RoCE 的核心、骨干、接入和终端节点使用相同图案、尺寸和颜色语义。

GPU 默认不进入拓扑画布。选中一台或多台交换机后，画布只显示与这些交换机直接相连的 GPU；侧栏“网络区域”中的 `POD1-GPU`、`POD2-GPU`、`POD3-GPU` 按钮可独立显示或隐藏对应 POD 的全部 GPU。

画布中的设备可以自由拖动。拖动只会产生当前页面的未保存修改；点击“保存拓扑”后，当前布局写入 SQLite，并通过 Kubernetes 数据 PVC 与其他访问用户共享。重新解析设备配置时，仍会保留有效设备的已保存坐标。

选择设备、切换筛选或更新链路时会保持当前画布的缩放与视角；只有首次加载或用户主动点击“适配画布”时才会自动调整视野。

画布不设置人为的最小或最大缩放限制，滚轮与工具栏缩放按钮均可持续缩小或放大。

普通点击设备或链路时只保留当前选择；按住 `Ctrl` 点击可追加或取消设备与链路，并同时高亮其关联路径。`Shift`、`Command` 以及不按修饰键的点击不会触发多选。

按住 `Alt` 在画布上拖拽可批量框选设备；框选后拖动任意一个已选设备会整体移动整组选中设备，最后点击“保存拓扑”持久化共享布局。`Ctrl+Alt` 框选会把新设备追加到现有选择中，终端簇不会被框选为设备。

批量选择设备后，右键其中一台已选设备可把它作为基准执行横向对齐（统一 Y 坐标）或纵向对齐（统一 X 坐标）；对齐操作同样需要点击“保存拓扑”后才会持久化。

## 本地运行

项目默认读取根目录下的 `device-config`：

```bash
npm install
npm run dev
```

前端运行于 `http://localhost:3000`，开发 API 运行于 `http://localhost:3001`。生产环境通过 `DEVICE_CONFIG_DIR` 指定只读配置目录，通过 `TOPOLOGY_DATA_DIR` 指定 SQLite 项目、拓扑、布局和修订数据目录（本地默认 `.data`）。如需首次启动自动导入 IB 表，可把 CSV 放到配置 PVC，并设置 `INITIAL_PORTS_CSV_PATH=/data/device-config/Ports-20260827.csv`；已存在同名 `Metta IB网络` 时不会重复导入。

## 生产构建

```bash
npm run test
npm run build
npm start
```

## 容器与 Kubernetes

镜像不会包含 `device-config`。运行时必须把配置目录只读挂载到 `/data/device-config`，并为 `/data/app` 提供可写持久卷以保存项目、上传拓扑、共享布局和服务器地址人工修订。

Helm Chart 位于 `charts/network-topology`，使用现有 PVC，并通过 Kubernetes 原生 Ingress 暴露服务。以下示例使用 nginx Ingress Controller：

```bash
helm upgrade --install topology charts/network-topology \
  --set image.repository=registry.example.com/visionable/network-topology \
  --set image.tag=0.1.0 \
  --set config.existingClaim=device-config \
  --set ingress.className=nginx \
  --set 'ingress.hostnames[0]=topology.internal.example'
```

集群必须已经安装 Ingress Controller；`Ingress` 资源本身不会转发流量。若控制器使用的 IngressClass 不是 `nginx`，请相应修改 `ingress.className`。可通过 `ingress.annotations` 配置控制器注解，通过 `ingress.tls` 引用已有 TLS Secret。Ingress 负责 DNS、TLS 和访问边界。应用本身不实现登录，任何能够访问 URL 的用户均可查看拓扑和触发重新解析。

Chart 默认创建一个 1Gi、`ReadWriteOnce` 的数据 PVC；也可以用 `data.existingClaim` 引用已有 PVC。SQLite 版本固定为单副本部署，配置 PVC 仍保持只读。

## 数据安全

服务端只向浏览器返回设备名、角色、POD、机柜、接口、IP、链路和解析提示；SN 核对表中的序列号及其他列不会返回浏览器。没有原始配置下载接口，也不会返回 AAA、SNMP、密码或其他未列入白名单的配置字段。
