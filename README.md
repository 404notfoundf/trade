# 多资产多链机会观察与交易服务

TypeScript 本机服务：读取配置中 OKX 现货交易对的盘口、X Layer 与 Solana 上映射代币的 multiplier 和 OKX DEX Quote，将结果按资产和链写入 MySQL，并提供本机 HTML 页面。自动交易默认关闭；显式配置总闸并在 `/trade` 启动后，程序按库存选择 CEX 买、DEX 卖或 DEX 买、CEX 卖，支持 X Layer 与 Solana。交易先确认 DEX 成交，再提交 CEX IOC 限价单；任何未对冲或状态不确定的周期都会阻止后续自动下单。

## 代码结构

- `src/main.ts`、`src/collector.ts`：启动运行时并采集 Aggregator 观察数据。
- `src/market/`：盘口、OKX 接口、估值、收益计算、机会分组和固定池状态监控。
- `src/direct-pool/`：市场注册表、指定池报价、池状态与协议 adapters；只读观察与模拟归在这里。
- `src/trading/`：真实执行、预检、收益门槛、CEX IOC 对冲和交易周期恢复。
- `src/dashboard/`：页面、汇总报告、看板状态与独立看板入口。
- `src/config.ts`、`src/db.ts`、`src/observations.ts`、`src/risk.ts`：配置、MySQL、机会记录与拦截记录。
- `src/migrate.ts`、`src/logger.ts`：数据库迁移入口与日志。
- `config.yaml`：服务端口、运行时间参数、MySQL 连接和标的白名单；`.env`：OKX API 凭证。

## 补充说明

- [文档索引](docs/README.md)
- [交易执行与恢复](docs/TRADING_EXECUTION.md)
- [待办事项](docs/TODO.md)

## 运行

### 质量检查

安装依赖后，运行 `npm test` 执行离线回归，包含 `src/**/*.test.ts` 与 `src/**/*.check.ts`；运行 `npm run check` 同时执行 TypeScript 类型检查和离线回归。测试进程会屏蔽 OKX、RPC、钱包和数据库环境变量，并把 dotenv 文件路径指向不存在的临时路径；不启动采集器或 Dashboard，也不连接 MySQL 或外部 RPC。需要外部服务的人工 smoke test 不属于默认质量门。

1. 安装 Node.js 20+、MySQL 8+，创建本地数据库和仅供本程序使用的 MySQL 用户。
2. 复制 `config.example.yaml` 为本机 `config.yaml`，填写 MySQL 连接信息；复制 `.env.example` 为 `.env` 并填写 API 凭证。CEX API Key 需要 Read + Trade 权限，关闭 Withdraw 并绑定 IP；分别把专用低余额钱包私钥放入 `XLAYER_PRIVATE_KEY` 或 `SOLANA_PRIVATE_KEY`。启用 Solana 观察模拟时，另用 `SOLANA_SIMULATION_PRIVATE_KEY` 配置模拟专用钱包。Solana 私钥支持 base58 或 JSON 字节数组。私钥不会写入 YAML、数据库、页面或日志。
3. 在 `config.yaml` 的 `assets` 中配置资产共用参数，在 `routes` 下分别配置交易路线。固定池监控在独立的 `fixedPools` allowlist 中配置；直接池路线在 `market-registry.yaml` 中登记，并由 `marketdata.quote_provider` 显式切换，故障时不会回退到 Aggregator。`.env.example` 提供公开 X Layer/Solana RPC；各协议部署地址固定登记在 `market-registry.yaml`。长时间观察建议换成自己的专用 RPC。候选池的地址、token、精度、fee/factory 或 program ID 会在启动时与链上数据核对。
4. 运行 `npm ci` 后执行 `npm run db:migrate`，按编号应用 `migrations/*.sql` 中尚未执行的迁移；数据库用户需要该数据库的建表权限。`005_trade_execution.sql` 增加交易周期和链上交易记录，`006_dashboard_state.sql` 保存看板最近状态，`008_fixed_pool_monitor.sql` 保存固定池状态采样，`009_fixed_pool_history_gap.sql` 记录监控历史缺口，`010_direct_pool_observation.sql` 保存 direct-pool 报价和决策，`011_aggregator_shadow_quote.sql` 保存独立 shadow 报价，`013_direct_pool_gas_budget.sql` 增加观察 Gas 预算字段，`014` 修正 Solana multiplier 历史记录，`015` 增加决策池 ID，`016_direct_pool_simulation.sql` 增加模拟结果字段，`019` 至 `021` 为看板、报表与交易预检查询添加索引。
5. 一体启动仍可运行 `npm run dev`，生产构建后运行 `npm start`。需要采集和前端分开时，在两个终端分别运行 `npm run dev:collector` 与 `npm run dev:dashboard`；生产环境先 `npm run build`，再分别运行 `npm run start:collector` 与 `npm run start:dashboard`。
6. 打开 `http://127.0.0.1:3000`。独立看板从 MySQL 读取历史数据和最近一次状态；采集器停止后，页面仍可访问，但新观察不会产生，路线状态会显示为未知。独立看板只读，交易开关仍由一体启动方式提供。

### 在 Ubuntu 上用 Docker 运行

Ubuntu 主机不需要安装 Node.js，但需要安装 Docker Engine；应用镜像内含 Node.js 24。Docker Engine 安装步骤见 [Docker 官方 Ubuntu 文档](https://docs.docker.com/engine/install/ubuntu/)。

仓库的 `compose.yaml` 会在同一个 Compose 网络中启动应用和 MySQL 8.4，应用通过服务名 `mysql` 连接数据库。先准备 `mysql.env`、`.env` 和 `config.yaml`；首次配置时可从示例复制，再填写本机凭证：

```sh
cp -n mysql.env.example mysql.env
cp -n .env.example .env
cp -n config.example.yaml config.yaml
```

在 `config.yaml` 中设置 `mysql.host: mysql`、`mysql.port: 3306`、`mysql.user: root` 和对应的 root 密码。MySQL 数据保存在 `mysql_data` 命名卷中；`MYSQL_ROOT_HOST: "%"` 允许 root 远程登录。MySQL 已初始化过的数据卷不会因修改 `mysql.env` 自动更新账号密码。不要运行 `docker compose down -v`，否则会删除数据库卷。

在 Ubuntu 项目目录填写好配置后运行：

```sh
mkdir -p logs
docker compose build app
docker compose up -d mysql
docker compose run --rm app node dist/migrate.js
```

确认迁移成功后，若旧的独立应用容器 `trade-observer` 还在运行，先执行 `docker stop trade-observer` 释放 3000 端口，再启动 Compose 应用：

```sh
docker compose up -d app
docker compose ps
docker compose logs -f app
```

应用更新后运行 `docker compose up -d --build app`。Compose 会自动把应用和 MySQL 放在同一网络，应用始终使用 `mysql:3306`；MySQL 的 `3306:3306` 和应用的 `3000:3000` 仍发布到宿主机。远程客户端可访问 `<Ubuntu服务器公网IP>:3306`，网页访问 `http://<Ubuntu服务器地址>:3000`。云安全组应限制 3306 的来源 IP；Docker 发布的端口可能绕过 UFW 规则。公网开放 root 登录风险较高。若需保留旧版回滚，验证新服务前不要删除已停止的旧容器。

### 用新方法开始只读观察

1. 将 `.env.example` 中的 direct-pool RPC 配置（`XLAYER_RPC_HTTP/WS`、`SOLANA_RPC_URL/WS`）补齐或更新到现有 `.env`，保留已有 API 密钥并避免重复定义变量；也可替换为自己的 RPC。协议部署地址已固定登记在 `market-registry.yaml`。只读观察不需要私钥；启用 Solana 模拟时才配置 `SOLANA_SIMULATION_PRIVATE_KEY`。当前公开端点适合开始观察，持续运行时可能限流；对应项缺失时该链会显示 `not_configured`。
2. 在 `config.yaml` 设置 `marketdata.quote_provider: direct_pool`。不要打开交易；direct-pool 模式会强制关闭旧 Executor。
3. 运行 `npm run db:migrate` 应用尚未执行的迁移，再运行 `npm run dev`。
4. `market-registry.yaml` 当前的池仍是 `observe_only`：X Layer 使用 wNVDAx/USDG；Solana 使用 XNVDA/USDC，以及 XSPCX/USDC 的 Raydium CLMM、Orca Whirlpool、Meteora DLMM 和 Byreal CLMM。每个池可单独设 `enabled: false` 暂停报价和监控；省略时默认为 `true`，修改后重启采集器生效。采集器把 Exact-In 与同规模 OKX VWAP 对比，记录毛收益、CEX 手续费、固定 Gas 预算、观察净收益和 ROI；USDG/USDC 明确按 1:1 假设估值。`config.yaml` 的 `direct_pool_observation.simulation_enabled` 控制合格 Solana observe-only 报价的全局模拟；模拟签名使用 `SOLANA_SIMULATION_PRIVATE_KEY`，不会广播。X Layer Wrapper 只读读取 `asset()`，按方向调用 ERC-4626 `previewDeposit`、`previewMint` 或 `previewRedeem` 换算数量；EVM XNVDA 不再重复乘 Backed multiplier。异常时只阻断 X Layer 收益估算。所有结果继续固定为 `NOT_EXECUTABLE`。
5. 打开 `/direct-pools` 查看报价和收益拆分。当前 Gas 预算在 `config.yaml` 的 `direct_pool_observation`：X Layer 每方向 0.05 USDT（Wrapper + Swap），Solana 每次 Swap 0.01 USDT。后续待办会把固定预算替换为实时 OKB/SOL Gas 折算。观察净收益使用稳定币 1:1 假设，不代表真实兑换、充值提现成本或可成交净收益。

运行日志会同时输出到终端和 `logs/`，时间戳使用 UTC+8（ISO 8601 的 `+08:00`），并按 UTC+8 日期和级别共用文件（如 `info-YYYY-MM-DD.log`）；单个文件达到 20 MiB 后切分归档，归档名带轮转时间和随机标识。日志目录已加入 `.gitignore`。旧日志不自动删除，因此 20 MiB 限制单个文件大小，不限制日志目录总占用。Solana 成功报价日志按池和方向最多每分钟一条，期间的报价数量会汇总到 `suppressed`；报价明细仍可通过 `quote_id` 查询。健康状态变化和错误会记录一次，相同状态的重复错误会去重；详细依赖状态仍可在 `/health` 查看。

DEX Quote 请求由所有路线共享队列串行发送，间隔至少 1.1 秒，以适配试用 API 默认每秒 1 次的限频；两条路线、每条 3 个规模的双向报价一轮约需 13.2 秒。单边报价成功时仍会保存该方向结果。

服务启动时只连接数据库，不会修改表结构；未应用迁移时会提示先运行迁移命令。缺少配置或外部接口不可用时，页面显示对应依赖未就绪；不会因为配置缺失而交易。主页提供概览、机会列表与详情、UTC 小时/日报筛选和健康状态。

行情过期、订单簿深度不足、DEX 报价无效或 Gas 未知时，系统会保留拦截原因和诊断数据，不把记录计为正收益估算。DEX 收付的原生数量会保存。Solana 原生 USDT 与 X Layer USDT0 分别通过对应指数偏离检查后按 1:1 纳入 USDT 估值；X Layer 估值不扣跨链兑换或赎回费用，也不代表跨链后的实际到账金额。毛收益再扣 CEX 手续费与含安全缓冲的 DEX 预估 Gas。DEX `tokenUnitPrice` 仅作参考。仅监控路线的报价仍会保存，并与网络可用路线分开统计。

异常保护由 `runtime.guardrails` 控制。指数价格默认每 15 秒刷新，源时间最大 60 秒；USDT/USD 与 USDT0/USDT 阈值初始各 0.5%。交易执行还要求 DEX 价格影响不超限、盘口新鲜、余额充足、净边际至少 1%。X Layer 与 Solana 分别使用 USDT0 和 USDT 指数进行偏离检查。交易不执行跨链转账或提现。

机会观察仍按两边有库存估算，不代表可成交利润。执行会在每轮前查询对应方向的 CEX 和链上余额；只有 CEX USDT 与链上对应映射代币时仅执行 CEX 买、DEX 卖，反向还需 CEX 对应资产与链上 USDT0/USDT。当前自动执行顺序先链上成交后 CEX IOC，链上成交而 CEX 未完整成交时进入 `HEDGE_REQUIRED` 并暂停新单，需要人工对账。交易周期不会自动恢复重放。持续保存原始报价会增加 MySQL 占用，请定期备份并监控磁盘空间。

`config.yaml` 包含 MySQL 密码，已加入 `.gitignore`；请勿提交本机凭证、`.env`、API Key 或签名。
