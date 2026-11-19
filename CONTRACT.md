# 来源与消费契约

## 来源

入口 `/weather/sensor-1`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

观测粒度包含 station/intervalEnd/durationMinutes/metric/source。网页 rainfall-estimate 与传感器 rainfall-total 不因小时相同就兼容。fixtures/calibrations.json 为有版本和适用范围的校准，fixtures/forecasts.json 保存已发服务值的依据；来源撤回时只能重新评估当前服务值，不能改写已发依据。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

## 多源服务值选择（src/rainfall）

`/weather/sensor-1` 与 `/weather/public` 是两个独立来源路由，各自带 ETag；304 表示来源版本未变化，不产生新观测版本。观测身份与口径规则：

- 口径序列键为 station|intervalEnd|durationMinutes|metric|unit。网页 `rainfall-estimate` 与传感器 `rainfall-total` 即使 intervalEnd 与 durationMinutes 完全相同也不是同一种观测，分属不同序列，永远不能互相覆盖；来源优先级（sensor 高于 web）只在同序列候选之间使用。
- 每个 observationId 保存只追加的版本历史（含 receivedAt、来源路由、ETag、内容签名）。内容签名未变化的重拉不产生新版本；撤回（state=withdrawn）与修订都以新版本表达，旧版本保留可审计。
- 校准按观测自己声明的 calibration 版本查目录，只有来源、指标口径、单位匹配且观测时间不早于 effectiveFrom 才应用；引用未知版本或范围不匹配时保留原值并记录原因，不猜测、不隐式升级到新校准。
- 服务值每行保留单位、时段、来源、选中 observationId、校准版本、乘数、原值与完整候选依据（basis）。状态为 ok/uncertain/withdrawn/absent；不确定性包含 web-estimate、conflicting-candidates、late-arrival、null-observation、source-unavailable/stale、校准未应用原因、all-candidates-withdrawn、no-observation。
- 来源晚到或撤回后必须重新评估当前服务值；任何撤回、空值、来源缺失或尚未到达的口径一律 value=null 且 zeroAssumed=false，绝不把来源缺失当成降雨为零。expectedSeries 声明应覆盖的口径，未到达时输出 absent 行。
- 已发农户提示（forecasts.jsonl）为只追加账本，固化发出时刻的服务值、观测内容签名、原值与校准版本依据。之后的撤回、晚到、校准升级只能重新评估当前服务值并通过 verify 给出核对结论（unchanged/superseded），不得改写、替换或删除历史依据；value=null 的服务值不允许下发。

