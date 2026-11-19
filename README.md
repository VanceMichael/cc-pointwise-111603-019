# 农业气象采集台

Node.js 本地数据接入项目。已有一次来源读取、结构化导入与操作查询，来源服务和业务存储独立，来源变化不会自动刷新本地集合。当前导入以 sourceId 保存最新观察；历史版本、完整批次、身份决策及恢复流程尚未纳入接入生命周期。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源、读取首批并展示业务查询，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析现有首批页面并保留原始来源属性，返回 records 和 next；目前 demo 只导入首批。`src/service.js` 与 `src/repository.js` 维护持久集合；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

状态目录属于运行产物。扩展导入时应保留现有 CLI 和现有集合查询能力；新增状态可以另行组织。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令；原导入和查询使用显式的 ingest、query 动作。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放与业务查询，完成后清理临时状态。

## 多源可追溯服务值（src/rainfall）

在既有单源导入之外新增一层“服务值选择”，把自建传感器与公开气象页面接入同一份农事提示，但不合并观测口径：

- **口径即身份**：序列键为站点/时段结束/时长/指标/单位。网页 `rainfall-estimate` 与传感器 `rainfall-total` 时间相同也不兼容，分属不同序列，网页估值永远不会覆盖传感器原值；来源优先级只在同口径候选之间生效。
- **版本化入库**：`ObservationStore`（`var/rainfall/observations.json`）为每个 observationId 保存只追加版本历史，含接收时刻、来源路由、ETag 与内容签名；304 与签名重复不产生新版本，撤回与晚到修订都产生新版本并保留旧版本。
- **校准不猜测**：`CalibrationCatalog` 只对来源/指标/单位匹配且满足生效时间的观测应用其引用版本（`fixtures/calibrations.json` 含 c1/c2）；未知版本或范围不匹配保留原值并标因，不会因目录升级而隐式换版本。
- **不确定性显式化**：服务值（`evaluateServiceValues`）输出 ok/uncertain/withdrawn/absent 与不确定性原因；撤回、空值、来源故障（503/断连只记可用性事件）、未到达口径一律 `value=null`、`zeroAssumed=false`，绝不把来源缺失当成零降雨。
- **已发依据不可变**：`ForecastLedger`（`var/rainfall/forecasts.jsonl`，只追加 JSONL）固化发出时刻的观测签名、原值与校准版本；之后的撤回、晚到、校准升级只重新评估当前服务值，`verify` 给出 unchanged/superseded 核对结论，不改写历史；null 服务值拒绝下发。

命令：`npm run rainfall -- --help`（collect/evaluate/issue/service-values/verify），状态默认在 `var/rainfall/`。`npm run rainfall:demo` 演示首采→晚到修订→撤回→晚到替换→依据核对的完整过程；`npm run rainfall:acceptance` 在临时目录中做九步验收（含重启回读与 ETag 恢复），结束自动清理。测试位于 `test/rainfall/`，不访问外网。

