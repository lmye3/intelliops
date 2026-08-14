# 可重复故障沙箱

`backend/main.js` 中的 payment sandbox 是进程内受控服务，不访问或修改宿主机生产应用。演示会将连接池从基线值缩小，发送真实并发请求并产生真实 `POOL_TIMEOUT`；Ranger只能修改沙箱连接池参数，并必须用另一批真实请求验证错误率和P95。方案A验证失败会恢复执行前快照；方案B为L3，必须人工批准。

所有数字都来自本次请求批次，不使用固定恢复指标。Runbook参数范围见 `runbook-connection-pool.json`。
