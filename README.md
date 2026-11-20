# 施工区间公示控制台

多班组针对同一道路申报施工区间，审批端可能故障重试、也可能只批准其中一段。
本演示把三件事串起来：

1. **接收端**原样保留班组申报的起止区间（`originalSpan`），不做任何裁剪；
2. **区间裁决器**按审批有效区间切分交叠，后到者可发布的部分才进入公示；
3. **公示端**只发布审批有效的片段，并以不可变版本对外提供；审批被撤销后，
   旧链接仍展示撤销当时的快照，但可逐段核对出哪些片段已经失效。

仅使用 Node.js 内置模块，无第三方依赖。

## 启动

```bash
PORT=3000 node server.js
# 打开 http://127.0.0.1:3000
```

- 监听地址固定为 `127.0.0.1`，端口读取环境变量 `PORT`（默认 `3000`）。
- 页面上有三个业务入口：
  - **导入交叠区间** → `POST /api/import`，载入 `data/demo-scenario.json`；
  - **撤销一段审批** → `POST /api/revoke`，撤销当前生效的批准并生成新版本；
  - **查看公示片段** → `GET /api/publications/:id/inspect`，核对历史版本。
- 业务结果区带 `data-evidence-result="publication-fragments"`，
  旧链接核对区带 `data-evidence-result="obsolete-link-inspection"`，
  便于在操作前后比对内容。

## 测试

```bash
node --test
```

共 66 项，覆盖：

- 半开区间代数：同日相接不重叠、端点相减无残余、乱序遮挡、非法日期；
- 审批解析：故障重试、部分批准、整段拒绝、被取代、撤销；
- 场景校验：批准区间越界、部分批准等于全量、重复序号、非法 outcome；
- 区间裁决：切开重叠、完全覆盖、一次申报切多段、跨路隔离、两种优先级；
- 逐段修订与全量重建逐字节一致；
- 公示版本：不可变快照、版本链、撤销、旧链接核对、异常路径；
- HTTP：页面证据属性、导入、撤销、核对、405、404、路径穿越。

## 语义约定

### 区间是半开的 `[start, end)`

一段结束于某日、另一段从同一天开始，只是**同日相接**，不算重叠。
这是本演示最关键的边界：B 结束于 03-25、C 从 03-25 开始，两段都必须完整保留。

### 审批链

| 情况 | 处理 |
| --- | --- |
| `outcome=error` | 故障重试，不构成审批决定，进入待重试队列 |
| `outcome=approved` | 全量批准 |
| `outcome=partial` | 只按 `approvedSpan` 发布，原申报后段不公示 |
| `outcome=rejected` | 不产生任何片段 |
| `status=superseded` | 被后续审批取代，不参与生效判定 |
| 撤销 | 当前生效审批被标记 `revoked`，不再产生片段 |

生效审批取审批链中序号最大的非 `error`、非 `superseded` 项。

### 裁决优先级

- `first-submitted`（默认）：`submittedAt` 早者先占用；
- `latest-approval`：`decidedAt` 晚者先占用。

被完全覆盖的申报不会阻挡后续班组：只有真正发布的片段才占用道路。

### 公示版本

每次变更生成新的 `PUB-nnnn-<digest>` 版本，旧版本不可改写。
`GET /api/publications/:id/inspect` 返回：

- 旧版本自身快照（与当时一字不差）；
- 每段在**当前**审批下是否仍有效，及失效原因；
- 与当前版本相比新增/消失的片段。

页面支持 `?publication=<id>` 深链，直接复现“旧链接指向什么”。

### 重建与逐段修订

- `POST /api/rebuild`：按最新审批全量重建；
- `POST /api/revise`：只重算受影响道路，其余沿用上一版，并在服务端用
  摘要逐字节核对与全量重建一致后才发布（`verifiedAgainstRebuild: true`）。

## 合成数据

`data/demo-scenario.json`：

| 申报 | 班组 | 原申报 | 审批结果 |
| --- | --- | --- | --- |
| RPT-A | 一班组 | 03-01 ~ 03-21 | 先故障重试，再仅批准 03-01 ~ 03-10 |
| RPT-B | 二班组 | 03-08 ~ 03-25 | 全段批准 |
| RPT-C | 三班组 | 03-18 ~ 03-28 | 全段批准 |
| RPT-D | 四班组 | 03-28 ~ 03-31 | 全段批准（与 C 同日相接） |
| RPT-E | 五班组 | 03-12 ~ 03-14 | 整段拒绝 |
| RPT-F | 照明班组 | 03-05 ~ 03-09 | 连续两次故障，待重试 |
| RPT-X | 滨江班组 | 03-09 ~ 03-12 | 另一条道路，验证道路隔离 |

初始公示（R1）：

```
RPT-A 03-01 ~ 03-10   (审批只覆盖前段)
RPT-B 03-10 ~ 03-25   (与 A 交叠，切掉 03-08 ~ 03-10)
RPT-C 03-25 ~ 03-28   (与 B 同日相接，但 B 占用了 03-18 ~ 03-25)
RPT-D 03-28 ~ 03-31   (与 C 同日相接，完整保留)
```

撤销 `APR-B1` 后，C 恢复完整批准区间 `03-18 ~ 03-28`；
旧版本中 `RPT-B#1` 被标注为“审批已撤销”。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 场景、当前公示、版本列表、可撤销审批、历史 |
| POST | `/api/import` | 载入内置场景或请求体中的场景 |
| POST | `/api/rebuild` | 全量重建 |
| POST | `/api/revise` | 逐段修订（可选 `roadId` / `roadIds`） |
| POST | `/api/revoke` | 撤销审批 `{ approvalId, reason, actor }` |
| GET | `/api/publications` | 版本摘要列表 |
| GET | `/api/publications/:id` | 单个版本快照 |
| GET | `/api/publications/:id/inspect` | 旧链接核对 |
| GET | `/api/audit` | 历史与撤销记录 |

## 目录

```
server.js              启动入口（读取 PORT，绑定 127.0.0.1）
src/intervals.js       半开区间代数
src/approvals.js       审批链解析
src/scenario.js        场景校验
src/adjudicator.js     区间裁决（全量重建 / 逐段修订）
src/store.js           不可变公示版本仓库
src/app.js             HTTP 路由与静态资源
public/                页面（无框架）
data/demo-scenario.json 合成数据
test/                  node --test 用例
```
