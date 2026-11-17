# 农业气象采集台

Node.js 本地数据接入项目。在既有“来源读取、结构化导入与操作查询”之外，新增多源观测的**可追溯服务值选择**：保留单位、时段、来源与校准版本，只对口径明确兼容的观测应用校准与优先级；来源晚到、撤回或拉取失败会重新评估当前服务值并标出不确定性，已发给农户的提示冻结当时的观测与参数依据，永不回溯改写。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行全部行为与本地接口测试；`npm run demo` 启动临时来源并演示“首批采集 → 发出提示 → 来源撤回 → 备用来源晚到恢复”的完整生命周期，结束自动清理；`npm run acceptance` 在临时目录验证旧导入生命周期与新服务值流水线，完成后清理临时状态。演示数据不访问生产站点。

`npm start` 或 `npm start -- --help` 查看命令：

| 动作 | 说明 |
| --- | --- |
| `ingest [文件]` | 既有结构化导入（默认 `fixtures/records.json`），行为不变 |
| `query [来源]` | 既有本地集合查询，行为不变 |
| `collect <回环URL> [校准文件]` | 多源采集一轮，追加观测档案并重评估当前服务值 |
| `values` | 查看当前服务值、不确定性原因与修订历史 |
| `forecasts [台账文件]` | 查看已发提示与只读基线台账（默认 `fixtures/forecasts.json`） |
| `issue <observationId> [校准文件]` | 按档案中的当前观测冻结依据并发出提示（只追加） |

## 服务值选择规则

1. **兼容性先于合并**。两个观测只有在站点、`intervalEnd`、`durationMinutes`、指标、单位全部一致时才属于同一选择槽（见 `src/compatibility.js`）。网页 `rainfall-estimate` 与传感器 `rainfall-total` 即使落在同一个小时也不兼容，网页估值永远停留在自己的指标槽，不能覆盖传感器原值。
2. **校准按声明版本且限定适用范围**。观测只应用自己 `calibration` 字段声明的版本，且校准的 source/metric/unit 必须匹配（`src/calibration.js`）。版本未知、范围不匹配或未声明校准时保留原值并把原因写入不确定性，绝不静默换算。
3. **优先级只在兼容槽内生效**。槽内先各自校准，再按来源优先级（默认 sensor 1、web 2，见 `src/service-value.js`）选择；撤回、原值为空或校准不可用的候选失去资格，全部不可服务时服务值为 `null` 并带不确定性原因，而不是 0。
4. **晚到与撤回触发重评估**。`collect` 每轮都基于档案最新状态重新评估；切换选择、状态或校准依据时向修订历史追加一条记录（`src/service-value-store.js`），重放相同数据不产生噪声修订。
5. **来源失败不等于零降雨**。某条路由 503、断连或超时时只在 `sourceGaps` 标记缺口，旧观测保留、服务值不被清零；来源接口没有数据，就不会有任何观测被写入档案。
6. **已发提示不可变**。`issue` 把当时的观测原值、来源路由、ETag、校准版本、乘子与计算结果整体冻结进只追加台账（`src/forecast-ledger.js`）。之后撤回或 `c2` 升级只改变当前服务值，台账记录原样保留；基线 `fixtures/forecasts.json` 只读，标记 `frozenLegacy`，系统不会回写。

## 组件和数据

- `source/server.js` 读取场景文件并监听随机回环端口，`publish(stage)` 切换 `opening`/`updated`/`backup` 三个来源观察，`failNext` 可注入 503 或断连。
- `src/source-client.js` 只接受 `127.0.0.1` 的 http 来源，基于 `node:net` 直连发 HTTP/1.1 请求（含 chunked 解码），因此不受环境代理变量影响。
- `src/adapter.js` 解析页面并保留全部原始来源属性；`collectionRoutes` 列出传感器与网页三条路由，适配器不做跨源合并。
- `src/observation-store.js` 是只追加观测档案（`var/observations.json`）：同一 `observationId` 的更新、撤回、置空都追加新版本，`currentObservations()` 取每个标识的最新版本。
- `src/calibration.js`、`src/compatibility.js`、`src/service-value.js` 分别承载校准、口径兼容与服务值选择的纯逻辑。
- `src/service-value-store.js` 持久化当前服务值与修订历史（`var/service-values.json`）；`src/forecast-ledger.js` 管理只追加的已发提示台账（`var/forecasts.json`）。
- `src/collector.js` 串联“逐路由采集 → 追加档案 → 重评估 → 发布服务值”；`src/operations.js` 在既有 rows 之外可选暴露 `serviceValues` 与 `issuedForecasts`，旧消费形状不变。
- 既有 `src/service.js`/`src/repository.js` 的 `var/records.json` 集合与 ingest/query 生命周期保持不变，新状态独立组织在各自文件中。

状态目录属于运行产物。测试直接使用随机端口来源，不需要等待真实时间或接入外网。
