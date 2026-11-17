# 来源与消费契约

## 来源

入口包含 `/weather/sensor-1`、`/weather/sensor-2` 与 `/weather/public`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening、updated、backup 是三个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

观测粒度包含 station/intervalEnd/durationMinutes/metric/source。网页 rainfall-estimate 与传感器 rainfall-total 不因小时相同就兼容：兼容判定要求站点、时段、指标、单位全部一致（`src/compatibility.js`），不同指标的观测分属不同选择槽，网页估值不能覆盖传感器原值。`fixtures/calibrations.json` 为有版本和适用范围的校准（c1、c2），观测只应用自己声明且 source/metric/unit 匹配的版本；`fixtures/forecasts.json` 保存已发服务值的只读基线依据。来源撤回时只能重新评估当前服务值，不能改写已发依据；来源缺失或路由失败标记为不确定性缺口，不合成零降雨观测。

## 采集与服务值

每轮 `collect` 逐路由采集：成功页面把完整条目（含单位、时段、来源、校准版本、state、路由与 ETag）追加进只追加观测档案，同一 observationId 的更新与撤回都保留历史版本；失败路由记录 sourceGaps，不删除旧观测。服务值按兼容槽重评估，槽内先校准后按来源优先级选择，撤回/空值/校准不可用产生显式不确定性且服务值为 null。选择结果、状态或校准依据变化时追加修订轨迹。

## 业务消费

`readOperations(repository, serviceValueStore?, forecastLedger?)` 仍返回 product 和 rows，每行带 sourceId/source/observedAt/attributes；传入可选存储时额外返回当前 serviceValues 与 issuedForecasts，旧消费形状不变。已发提示通过 `issue` 只追加，冻结发出时刻的观测原值、校准版本、乘子与结果，后续校准升级或来源撤回不回溯改写。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
