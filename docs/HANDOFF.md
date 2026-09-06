# 项目交接说明

> 交接时间：2026-09-06 12:11（Asia/Shanghai）  
> 工作区：`D:\visionable`  
> 当前分支：`main`（尚无任何正式提交）  
> 本文档面向完全没有聊天历史的下一位 AI。除本文档外，本次交接没有修改业务代码。

## 项目目标

本项目是一个“网络拓扑中心”，目标是把真实网络配置和端口关系表转换为可共享、可搜索、可筛选、可编辑布局的拓扑，并在同一拓扑上进行基于转发表快照的符号化流量路径仿真。

核心范围如下：

1. 从 `device-config` 中的 NVUE `nv config show -o commands` Markdown 配置解析设备、接口、IP、VRR 地址和物理链路。
2. 从 CSV/XLSX 端口关系表导入 IB 或其他拓扑，支持中英文表头、LID、同设备逻辑接口以及互为对端的链路去重。
3. 从服务器 SN 核对 CSV 同步 GPU 服务器带内/带外地址，并允许在网页中人工覆盖。
4. 以“项目 → 拓扑”组织数据，把项目目录、导入后的结构化拓扑、服务器地址覆盖和每张拓扑的布局持久化到 SQLite。
5. 在 React/Cytoscape 前端展示 RoCE/IB 分层拓扑，支持搜索、角色/POD/平面筛选、GPU/服务器按需展开、单选/多选、框选、批量拖动、对齐、缩放和共享布局保存。
6. 当前新增方向：导入严格格式的 XLSX 转发表快照，基于 IPv4、路由、ARP、MAC、LAG 和 VXLAN 信息计算符号化转发路径，并在拓扑画布上动画展示分支路径和抽象报文。
7. 通过 Docker 和 Helm Chart 部署到 Kubernetes；设备配置挂载为只读 PVC，SQLite 数据使用可写 PVC，Ingress 负责访问边界。

## 当前项目状态

### Git 状态

- 仓库已初始化，当前分支为 `main`，但 `main` 是 unborn branch：`git log` 报错 `your current branch 'main' does not have any commits yet`。
- 没有配置 Git remote：`git remote -v` 无输出。
- 因为没有 `HEAD`，Git 无法区分初始代码、历史修改和本轮修改。`git status --short --branch` 把所有非忽略项目文件都显示为未跟踪，不能把普通 `git diff` 当作变更依据。
- 交接前 Git 状态包含以下未跟踪入口；完成本文档后还会新增 `?? docs/`：

  ```text
  ?? .dockerignore
  ?? .env.example
  ?? .gitignore
  ?? Dockerfile
  ?? README.md
  ?? backup-dont change/
  ?? charts/
  ?? eslint.config.mjs
  ?? index.html
  ?? package-lock.json
  ?? package.json
  ?? public/
  ?? server/
  ?? shared/
  ?? src/
  ?? tests/
  ?? tsconfig.json
  ?? tsconfig.server.json
  ?? vite.config.ts
  ?? vitest.config.ts
  ```

- `.data/`、`device-config/`、`dist/`、`node_modules/`、`.next/`、`.vinext/`、`.wrangler/`、`outputs/`、`work/` 被 `.gitignore` 忽略。
- 仓库中存在 Codex 内部 checkpoint refs，但它们指向 tree object，不是项目提交，也不在 `main` 历史中。最近的内部树为 `a0c98e2a639b2689895c3bab9bd8a102377a7963`，ref 时间为 2026-09-03 17:41:39 +08:00。它只能辅助比较，不能替代正式提交历史。

### 可运行状态

- 技术栈：Node.js + TypeScript；React 19 + Vite 8 + Cytoscape 前端；Express 5 API；Node 内置 `node:sqlite` 持久化；Vitest 测试。
- `package.json` 要求 Node `>=22.13.0`；本次验证环境为 Node `v24.12.0`、npm `11.6.2`。Dockerfile 使用 `node:24-alpine`。
- 本地开发默认：前端 `http://localhost:3000`，API `http://localhost:3001`；生产默认单端口 3000。
- 交接时端口 3000 和 3001 仍有旧的 Node 进程监听：3000/PID 28188（启动于 2026-09-02），3001/PID 30880（启动于 2026-09-04）。本次没有终止它们，因为无法从进程信息安全确认归属命令。PID 是瞬时信息，下一台设备不能依赖。
- HTTP 冒烟结果：3000 返回 200；3001 `/healthz` 返回 `{"status":"ok"}`，`/readyz` 返回 ready；`/api/projects` 返回 2 个项目；转发表快照列表返回空数组。

### 当前本地数据状态

对 `.data/topology.db` 做了只读查询，当前包含：

- 项目 `Metta`：
  - `Metta RoCE网络`，NVUE 来源，目录统计 702 个节点、2667 条链路。
  - `Metta IB网络`，端口表来源，1232 个节点、15230 条链路。
- 项目 `松江`：
  - `关系表_已填写_v2 (1)`，端口表来源，26 个节点、34 条链路。
- `forwarding_snapshots` 当前为 0 条：尚没有任何成功保存在本地数据库中的真实转发表快照。
- SQLite 使用 WAL；交接时存在 `.data/topology.db`、`.data/topology.db-wal` 和 `.data/topology.db-shm`，总计约 23 MB。数据库正在被其他进程使用，直接计算主 DB 文件哈希失败。迁移前必须先让写入进程退出，再用一致性方式复制数据库及相关状态。

## 本次会话实际已完成内容

本次可见会话一开始就是交接请求，没有在此之前完成业务功能。因此不要把工作区现有的转发仿真实现错误归因于本次会话。本次实际完成的只有：

1. 停止继续修改业务代码。
2. 检查当前目录、分支、Git 状态、remote、正式提交历史和 Codex 内部 refs。
3. 检查全部非忽略源码目录、运行脚本、部署配置、测试目录和本地数据概况。
4. 用只读哈希比较把当前工作区与 `backup-dont change/` 以及最近内部 checkpoint tree 对比，定位 2026-09-03 基线之后的文件变化。
5. 运行完整测试、Lint、生产构建和本地 HTTP 冒烟检查。
6. 创建本交接文档。

本次没有创建提交、分支、tag 或 remote，也没有修改 `server/`、`shared/`、`src/`、`tests/`、`public/`、Chart、Dockerfile 或本地 SQLite 数据。

## 当前正在进行的任务

当前业务任务应视为“暂停中的转发表快照导入与流量路径仿真功能收尾”。代码主体已经存在并通过自动化测试/构建，但还没有完成真实数据与浏览器层面的验收，也没有补齐部署和 README 文档。

已经落在代码中的实现包括：

- `public/templates/forwarding-state-template.xlsx`：八个 Sheet 的转发表模板（说明、元数据、接口属性、聚合成员、路由表、ARP表、MAC表、VXLAN）。
- `server/forwardingWorkbookParser.ts`：24 MiB 上限、固定 Sheet/表头、字段类型和引用关系的严格校验，最多返回 1000 条结构化行级错误；设备和接口必须能映射到当前拓扑。
- `server/serverAddressStore.ts`：把快照元数据、接口、LAG、路由、ARP、MAC、VXLAN 分表保存到 SQLite；同一拓扑最新导入为默认；事务写入；每个拓扑只保留最近 5 个成功快照。
- `server/topologyFingerprint.ts`：对设备 ID/hostname、接口名和物理链路结构生成 SHA-256 指纹；结构变化后旧快照标记为不兼容。
- `server/forwardingEngine.ts`：IPv4 最长前缀匹配、同前缀多分支/ECMP、LAG 成员展开、路由/ARP/MAC 决策、L2VNI/L3VNI 封装解封装、循环检测，以及缺失数据时的明确终止原因和证据行。
- `server/app.ts` / `server/store.ts`：快照列表、原始 XLSX 上传、路径计算 API 和错误映射。
- `src/ForwardingSimulator.tsx`：模板下载、上传、历史快照选择、源设备/源地址/目的地址输入、播放/暂停/重播/全局展示/清除，以及 reduced-motion 下的“下一跳”交互。
- `src/TopologyCanvas.tsx` / `src/graphModel.ts` / `src/App.tsx`：仿真节点强制可见、红色有向路径、活动虚线和移动报文标记；临时仿真元素不写入持久布局。

尚未达到“可交付完成”的部分见“已知问题”和“尚未验证的内容”。

## 修改过的文件

### Git 能确认的范围

由于正式提交数为 0，Git 只能确认所有项目文件都未提交，不能确认哪些文件由哪次会话修改。下一位 AI 不得把 `git status` 中的全部文件都解释为本次转发仿真改动。

### 辅助基线对比定位出的变化

`backup-dont change/` 与最近内部 checkpoint tree 在业务文件上可作为同一份 2026-09-03 辅助基线。相对该基线，当前工作区变化集中在以下 18 个文件。此清单是哈希/树对象比较的结果，不是正式 Git diff 历史。

| 文件 | 用途 | 当前验证程度 |
| --- | --- | --- |
| `package.json` | 将 Lint 范围从整个目录收窄到 `server shared src tests vite.config.ts vitest.config.ts`，避免扫描备份/生成目录 | `npm run lint` 通过 |
| `public/templates/forwarding-state-template.xlsx` | 新增转发表导入模板 | 模板可被解析器读取，错误报告路径有测试；真实成功导入未验证 |
| `shared/forwarding.ts` | 新增快照、表项、抽象报文、状态/边、终止原因等共享类型 | TypeScript 构建和相关测试通过 |
| `server/forwardingWorkbookParser.ts` | 新增严格 XLSX 解析与跨表引用校验 | 单元/API 测试通过；真实生产工作簿未验证 |
| `server/forwardingEngine.ts` | 新增符号化转发引擎 | 6 个核心引擎测试通过 |
| `server/topologyFingerprint.ts` | 新增拓扑结构指纹 | 快照兼容性测试通过 |
| `server/serverAddressStore.ts` | 新增 7 张转发相关表、事务导入、读取、5 快照保留策略 | 内存 SQLite 持久化测试通过；现有本地 DB 已自动出现表结构，但无实际快照 |
| `server/store.ts` | 串联解析、持久化、兼容性判断和引擎 | API/持久化测试通过 |
| `server/app.ts` | 新增快照列表、XLSX 上传、trace API | API 测试和本地 GET 冒烟通过；真实成功上传未验证 |
| `src/ForwardingSimulator.tsx` | 新增流量仿真侧栏及播放状态机 | 编译/Lint 通过；没有组件或 E2E 测试 |
| `src/App.tsx` | 接入仿真入口、状态和面板 | 编译/Lint 通过；未手工验收 |
| `src/graphModel.ts` | 仿真路径节点无视常规筛选强制进入画布 | 现有 graph model 测试整体通过；缺少专门仿真节点测试 |
| `src/TopologyCanvas.tsx` | 增加仿真边、报文标记、动画和拖动后位置同步，避免仿真节点污染布局 | 4 个画布工具测试通过；真实 Cytoscape 动画未手工验收 |
| `src/styles.css` | 新增仿真入口和侧栏样式，适配窄屏 | 构建通过；视觉/响应式未验收 |
| `tests/forwardingEngine.test.ts` | 新增 LPM/ECMP、65 路 LAG、L2VNI、L3VNI、缺失数据、循环测试 | 全部通过 |
| `tests/forwardingSnapshots.test.ts` | 新增 5 快照保留、快照隔离、结构兼容性、模板错误测试 | 全部通过 |
| `tests/api.test.ts` | 新增转发表 API 空列表、错误上传和未知快照隔离测试 | 全部通过 |
| `tests/topologyCanvas.test.ts` | 新增报文位置插值测试 | 全部通过 |

本交接会话另外新增：

- `docs/HANDOFF.md`：仅用于项目交接，已复核内容；这是本会话唯一的源码树写入。

## 关键技术决策及原因

1. **只保存结构化白名单数据，不保存原始配置/上传文件。** 设备配置可能包含 AAA、SNMP、密码、序列号等敏感内容。API 只返回设备、接口、IP、链路、布局和解析提示等明确字段；转发表工作簿解析成功后也只保存规范化表项。
2. **SQLite 是共享状态源。** 项目、导入拓扑、布局、服务器地址覆盖和转发表快照都落入同一数据目录，便于单副本服务通过 PVC 共享；因此部署固定为一个副本和 `ReadWriteOnce` 数据卷，不能直接水平扩为多写实例。
3. **配置 PVC 只读，数据 PVC 可写。** 原始 `device-config` 不应被应用修改；所有用户编辑写入 `.data`/`TOPOLOGY_DATA_DIR`。
4. **转发表模板采用严格 schema。** 固定 Sheet 和表头、严格枚举/IPv4/MAC/VLAN/VNI 检查以及跨表引用验证，避免把不完整或错配设备的数据悄悄用于路径推演；校验失败不保存任何快照。
5. **快照数据按拓扑隔离并规范化分表。** 便于精确查询和防止 snapshot ID/拓扑之间串数据；写入使用事务，最新快照默认，每拓扑最多保留 5 份以限制 SQLite 增长。
6. **拓扑结构指纹控制兼容性。** 设备、接口或物理链路发生变化后禁止继续使用旧快照，防止把旧转发表投射到新拓扑。指纹目前有意只覆盖结构，不覆盖布局、角色、POD 或 IP 值。
7. **路径引擎是证据驱动的符号模型，不是协议仿真器。** 它沿已有拓扑链路和上传表项计算所有可确认分支，记录命中的工作簿 Sheet/行号，并在资料不足处返回 `NO_ROUTE`、`NO_ARP`、`NO_MAC`、`NO_LINK` 等显式原因，而不是猜测路径。
8. **ECMP/LAG 不设隐藏的 64 分支上限。** 测试明确覆盖 65 个活动 LAG 成员，目标是完整展示所有可行分支；大规模真实数据的性能仍需评估。
9. **仿真元素是临时 Cytoscape 元素。** 红色仿真边和移动报文不参与选择、框选或布局持久化；真实节点移动时重新计算报文位置，保持用户已保存布局不被污染。
10. **尊重 reduced-motion。** 用户系统偏好减少动画时，不自动播放，改为手动“下一跳”。
11. **访问控制放在 Ingress/外围。** 应用自身没有登录。任何能访问 URL 的用户都能查看拓扑、刷新配置、导入拓扑/快照和修改共享布局，因此生产环境必须由 Ingress、网络策略或外部认证限制访问。

## 已知问题

1. **最高优先级：没有正式 Git 基线和 remote。** 当前所有源码都未跟踪，无法安全审阅、回滚、分支或跨设备同步，也无法可靠还原每轮工作归属。
2. **Docker 镜像很可能缺少 `public` 静态资源。** 当前 Dockerfile 的 build stage 只复制 `src`、`server`、`shared` 和配置文件，没有 `COPY public ./public`。本地 `npm run build` 会复制模板，但 Docker build 环境中不存在 `public/`，所以镜像中的 `/templates/forwarding-state-template.xlsx`（以及 favicon）预计缺失，模板下载可能 404。该问题本次未修改。
3. **README 尚未说明转发表功能。** 现有 README 只描述拓扑解析/展示/部署，没有记录模板 Sheet、字段、API、快照保留策略、兼容性、IPv4/模型边界或操作流程。
4. **没有真实成功导入记录。** 本地 SQLite 的转发表快照数为 0。现有模板测试是把模板放到空拓扑中并期待“设备无法匹配”的结构化错误，它证明错误处理，不证明一份真实数据可以成功导入和计算完整路径。
5. **前端仿真组件缺少直接测试。** 没有 `ForwardingSimulator` 的 React Testing Library 测试，也没有浏览器 E2E；播放、暂停、重播、全局展示、错误列表、窄屏和 reduced-motion 只通过代码审查/编译，尚未实际验收。
6. **生产 bundle 偏大。** Vite 构建成功，但生成约 686.96 kB 的单个 JS chunk（gzip 217.19 kB），触发大于 500 kB 警告；尚未 code split。
7. **`node:sqlite` 会打印 ExperimentalWarning。** 当前 Node 24 运行和测试均可用，但升级 Node 时必须复测 API/迁移行为。
8. **SQLite 当前处于被进程占用/WAL 状态。** 迁移时只复制 `topology.db` 可能遗漏 WAL 中的数据；先停止确认属于本项目的服务，然后 checkpoint/一致性备份。不要直接删除 `-wal`/`-shm` 文件。
9. **引擎能力有明确边界。** 只接受 IPv4；不支持嵌套 VXLAN；不模拟动态协议收敛、哈希选路、广播/未知单播泛洪、ACL/QoS/NAT 等设备行为。缺表时返回部分可确认路径，不应宣传为真实设备逐包仿真。
10. **自动化没有覆盖容器和 Helm。** 未执行 Docker image build、容器内模板下载、`helm lint/template`、Ingress/PVC 实机部署或滚动升级。
11. **活动开发进程归属不透明。** 3000/3001 仍在监听，且 Windows 进程查询未返回这两个进程的完整命令行。不要按 PID 盲目结束；应在复制前先确认父进程/终端会话。

## 当前阻塞项

1. **可靠跨设备版本交接被 Git 状态阻塞。** 在没有初始提交和 remote 的情况下，只能复制整个目录。需要用户确认哪些非敏感文件纳入首个提交，并配置目标 remote；下一位 AI 不应自行把 `device-config`、`.data` 或备份目录提交到 Git。
2. **本地运行状态迁移被活动 SQLite/WAL 阻塞。** 必须先确认并正常停止本项目写入进程，再做 SQLite 一致性备份/复制；否则新设备可能得到旧主 DB 或损坏/不完整状态。
3. **真实转发功能验收缺少与当前拓扑匹配的完整 XLSX 数据。** 没有有效快照就无法验证成功导入、复杂真实路径、动画和终止原因是否符合现场预期。这不阻塞单元开发，但阻塞功能验收。

## 项目限制和不能修改的内容

1. `backup-dont change/` 按目录命名视为不可修改的历史备份。只能只读比较；不要格式化、清理、升级依赖、运行会写入其数据库的程序，亦不要删除其中嵌套的 `.git`。
2. `device-config/` 是真实/挂载配置源并被 `.gitignore` 排除，可能含敏感配置。不要提交、上传、在日志中完整输出，也不要让应用写入；生产环境继续只读挂载。
3. `.data/` 是用户共享状态，不是可随意重建的缓存。不要删除、覆盖或重置，除非用户明确批准并已有备份。跨设备继续当前项目时需要单独、安全地迁移它。
4. 不要放宽服务端白名单以返回 AAA、SNMP、密码、SN 核对表的序列号或未明确允许的原始字段，也不要增加原始配置/工作簿下载接口，除非用户明确重新定义安全边界。
5. 当前 SQLite 部署约束是单副本 + 一个可写数据卷；不能只把 Helm `replicaCount` 调大而不先更换并发安全的数据层。
6. 项目没有内建认证。生产 URL 不能直接暴露到不可信网络；访问边界必须由 Ingress/外部认证承担。
7. 用户要求完成 `HANDOFF.md` 后不再修改业务代码。本次已遵守；下一位 AI 应先阅读本文档并等待新的继续开发指令。

## 已完成的测试及测试结果

验证均于 2026-09-06 在 `D:\visionable` 执行：

1. `npm test`：通过。
   - Vitest 4.1.11。
   - 9 个测试文件全部通过。
   - 39 个测试全部通过。
   - 覆盖：NVUE 解析、GPU inventory、CSV/XLSX 端口表解析、graph model、选择/框选、Inspector、画布工具、项目/拓扑/布局/API 持久化、转发表快照隔离/保留/兼容性、LPM/ECMP、65 路 LAG、L2VNI、L3VNI、缺失证据和循环终止。
   - 运行时仅出现 `node:sqlite` ExperimentalWarning，没有测试失败。
2. `npm run lint`：通过，0 个错误；检查范围为 `server shared src tests vite.config.ts vitest.config.ts`。
3. `npm run build`：通过。
   - Vite 客户端：1810 modules transformed，生成 `dist/client`。
   - TypeScript 服务端：`tsc -p tsconfig.server.json` 通过，生成 `dist/server`。
   - 唯一警告是客户端单 chunk 大于 500 kB。
4. 本地 HTTP 冒烟：通过。
   - `GET http://127.0.0.1:3000` → 200。
   - `GET http://127.0.0.1:3001/healthz` → `status: ok`。
   - `GET http://127.0.0.1:3001/readyz` → `status: ready`。
   - `GET http://127.0.0.1:3001/api/projects` → 2 个项目。
   - `GET /api/projects/metta/topologies/metta-roce/forwarding-snapshots` → `{"snapshots":[]}`。
5. 本地 SQLite 只读检查：成功读取项目、拓扑和转发表表清单；确认 7 张新转发数据表已存在且快照数为 0。

## 尚未验证的内容

1. 在浏览器中完整执行：下载模板 → 填入真实数据 → 成功上传 → 选择快照 → 运行路径 → 播放/暂停/重播/全局展示/清除。
2. `ForwardingSimulator` 组件的加载错误、422 行级错误展示、快照不兼容 UI、网络中断和并发点击行为。
3. 仿真路径跨越被筛选/隐藏的 GPU、服务器或不同 POD 时的真实画布表现，以及仿真结束后是否完全恢复用户选择/布局体验。
4. 大拓扑（当前最大目录统计为 1232 节点、15230 链路）叠加多分支转发动画时的 CPU、内存和交互性能。
5. 一份与 `Metta RoCE网络`、`Metta IB网络` 或 `松江` 拓扑匹配的真实 XLSX 是否能零错误导入。
6. 除测试覆盖样例外的真实 L2/L3VNI、ECMP、LAG、下线接口、重复/不完整 ARP、MAC remote 等组合。
7. Dockerfile 构建后的镜像是否包含模板和 favicon；根据 Dockerfile 静态检查，当前预计不包含。
8. Docker 运行、非 root/read-only root filesystem、PVC 权限、Helm schema、Ingress、TLS、探针和升级迁移。
9. 从当前活动 WAL 数据库迁移到另一台设备后的完整性和布局/项目保留。
10. 浏览器兼容性、键盘可访问性、窄屏视觉和 `prefers-reduced-motion` 实机行为。
11. 单元/集成测试之外的安全、负载、故障恢复和 SQLite 数据量增长测试。

## 推荐的下一步操作（按顺序）

1. **先完成一致性迁移。** 确认端口 3000/3001 对应的项目进程并正常停止写入；使用 SQLite 官方备份/checkpoint 方法或在服务完全停止后一起复制 `.data/topology.db`、`-wal`、`-shm`。同时安全复制 `device-config/`，但不要通过公共 Git remote 传输。
2. **在新设备复核目录完整性。** 首先阅读本文件，然后运行 `git status --short --branch`、检查 Node 版本、执行 `npm ci`、`npm test`、`npm run lint`、`npm run build`。不要复用旧设备的 `node_modules` 或 `dist`。
3. **建立正式版本基线。** 在确认敏感/运行数据仍被忽略、`backup-dont change/` 不应进入提交后，决定是否进一步把备份目录加入 `.gitignore`，再创建首个提交并配置私有 remote。此动作应由用户确认提交范围后进行。
4. **先修复 Docker 静态资源复制。** 在 build stage 加入 `COPY public ./public`，构建镜像并在容器中确认 `/templates/forwarding-state-template.xlsx` 和 `/favicon.svg` 可访问。
5. **准备一份与当前拓扑匹配的最小有效 XLSX。** 先覆盖一个直连路由场景，再增加 ECMP/LAG、L2VNI、L3VNI；通过 API 成功保存快照并核对数据库/路径证据。
6. **补前端测试与浏览器验收。** 至少覆盖快照加载、上传成功/失败、开始仿真、播放状态、reduced-motion、清除、拓扑切换和仿真临时元素不进入布局。
7. **补 README。** 记录模板版本和 8 个 Sheet、24 MiB/IPv4 限制、5 快照保留、结构兼容性、路径模型边界、API/用户操作流程和安全注意事项。
8. **验证部署。** 执行 Docker build/run、`helm lint`/`helm template`，再在测试集群验证只读配置 PVC、可写数据 PVC、Ingress、探针、单副本和重启后数据保留。
9. **做大规模性能检查。** 在 1232 节点/15230 链路级别测量首次渲染、筛选、全局多分支展示和动画；如需要，拆分前端 chunk 并限制/虚拟化结果面板，但不要偷偷截断引擎分支。
10. **完成验收后再提交功能。** 把转发功能、测试、Docker 修复和文档作为可审阅提交；重新运行全部验证，并记录真实快照/路径验收结果。

## 下一台设备上的 AI 特别需要注意

1. **不要假定存在提交历史。** `main` 没有 commit；Codex checkpoint refs 是 tree object，不是可依赖的项目分支。若要查看本轮转发功能相对辅助基线的差异，可只读比较当前文件与 `backup-dont change/`，但绝不能修改备份。
2. **不要直接 `git add .`。** 这会把约 342 MB 的 `backup-dont change/` 纳入索引，并可能造成历史/敏感数据泄漏。先确认 `.gitignore` 和提交范围，再显式添加源码目录。
3. **跨设备复制不能只靠 Git。** 当前 `.data/` 和 `device-config/` 都被忽略，却分别承载用户状态和真实配置；只 clone 未来的 remote 无法恢复当前项目现场。
4. **复制 SQLite 前先处理 WAL。** 当前 DB 被监听中的 API 使用。不要强行复制单个主 DB，不要删除 WAL/SHM，不要按本文 PID 盲杀进程。
5. **本地构建通过不代表 Docker 模板可用。** 本地 `public/` 存在，但 Docker build stage 没有复制它，这是继续工作时应首先修复和验证的部署缺口。
6. **现有模板测试不是成功导入测试。** 它有意在空拓扑下期待设备匹配错误；本地数据库也没有快照。不要向用户声称真实流量仿真已验收。
7. **服务端和前端 import 约定不同。** 服务端 TypeScript 源码使用 `.js` import 后缀以适配 ESM 编译产物；前端共享类型 import 当前无扩展名。调整模块配置时要同时验证 Vite 和 `tsc -p tsconfig.server.json`。
8. **Node 版本不能随意降级。** 项目依赖 `node:sqlite`，最低版本在 `package.json` 中声明为 22.13.0，Docker固定 Node 24；换设备后优先使用 Node 24 并重跑全部测试。
9. **仿真结果是“可证实的模型路径”。** 必须保留缺失数据的停止原因和工作簿行证据；不要为了画出完整路径而猜测 ARP/MAC/路由或隐藏不确定性。
10. **安全边界很重要。** 不得把 `device-config`、SN 原始表、`.data` 或上传工作簿内容暴露到日志、浏览器响应或公共仓库；应用又没有登录，生产部署必须受外部访问控制保护。
11. **用户已要求交接后停止业务修改。** 本文档完成后旧设备上的代码应保持冻结；下一位 AI 只有在用户明确要求继续开发后才开始改业务文件。
