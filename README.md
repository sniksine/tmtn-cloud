# TMTN Cloud · 多用户云端版

把开源的 [TMTN](https://github.com/bnbxcs/TMTN)（BSC Agent 内盘快速买卖终端，MIT 协议）搬到云上，让**每位访客用自己的币安 Agentic 钱包**登录使用。

功能和原版 TMTN 完全一样（战壕、K 线、活动流、一键买卖浮窗、持仓盈亏、Gang 老盘 / V2 盘与 Four 专属盘内盘买卖、自动领取、自动转出、换回 BNB、授权管理……），因为每位访客跑的就是一个原版 TMTN 实盘进程。

## 原理

```
访客浏览器 ──cookie──▶ gateway.js（对外唯一端口）
                          ├─ 访客 A → TMTN 进程 A（127.0.0.1:随机端口）→ baw 会话目录 A
                          ├─ 访客 B → TMTN 进程 B（127.0.0.1:随机端口）→ baw 会话目录 B
                          └─ …
```

- 每位访客：独立的 `BINANCE_BAW_DIR`、独立的 `BINANCE_INSTANCE_ID`、独立的 TMTN 数据目录（设置、持仓、收藏、屏蔽、单币规则、授权记录）。
- TMTN 进程只监听 `127.0.0.1`，外部只能通过网关、凭自己的 cookie 访问自己的进程。
- 登录用 TMTN 自带的登录遮罩：页面显示配对码 → 在币安 App 里核对并确认。**没有任何地方需要私钥或助记词。**
- 「自动转出」的目标地址在每个人自己的「☁ 我的会话」里设置（原版是 `.env` 的 `AUTO_TRANSFER_TO`）。
- 不打开页面 `IDLE_MIN` 分钟后停掉进程省内存；需要自动领取 / 自动转出的人可以勾选「离开后保持运行」。

## 对原版 TMTN 的改动（tmtn/ 目录）

1. 新增 `engine/dataDir.js`：数据目录可用 `TMTN_DATA_DIR` 指定；不设时和原版一样。各模块的 `data/xxx.json` 路径改为调用它。
2. `public/index.html` 左下角加了一个「☁ 我的会话」链接。
3. 附带币安技能里的 `agent-id-exclusive-token-launches.mjs`（Four 专属盘报价用），放在 `tmtn/.agents/skills/binance-agentic-wallet/scripts/`。

其余代码与上游一致。

## 免费运行：GitHub Codespaces（推荐自己用）

GitHub 个人账号每月免费约 60 小时（2 核机器），不用绑卡。适合**想交易时打开用一阵**，不适合 24 小时给别人用。

1. 手机或电脑浏览器打开本仓库页面 → 绿色 **Code** 按钮 → **Codespaces** 标签 → **Create codespace on main**。
2. 等 2–3 分钟（首次会自动安装依赖并启动终端）。
3. 底部打开 **端口 / Ports** 面板 → 3000 端口那一行点 🌐 地球图标，就会在新标签页打开 TMTN。
   - 端口默认是 **Private**：只有登录了你 GitHub 账号的浏览器能打开，别人拿到网址也进不来。**不要改成 Public。**
4. 勾选风险提示 → 进入终端 → 点登录 → 在币安 App 里核对配对码并确认。
5. 用完就停机省时长：github.com/codespaces → 这个 codespace 右边 ⋯ → **Stop codespace**。
   - 没操作最多约 4 小时会自动停机（可在 github.com/settings/codespaces 把 Default idle timeout 调到 240 分钟）。
   - 停机后文件保留，下次在 github.com/codespaces 里点它重新打开，终端会自动启动，钱包一般不用重新登录。
   - **不要点 Delete**，删除会清掉登录和持仓记录。
6. 网址打不开时：在 codespace 的 Terminal 里运行 `bash .devcontainer/start.sh`，或看日志 `tail -n 50 /tmp/tmtn-gateway.log`。

注意：停机期间自动领取、自动转出都不会运行。

## 部署到 Railway

1. 把本目录全部文件推到你自己的 GitHub 仓库（不要提交 `node_modules`、`data`、`.env`）。
2. 用 GitHub 账号登录 railway.com（连 GitHub 才能通过验证，否则试用版外网受限，连不上币安和 BSC）。
3. New Project → Deploy from GitHub repo → 选这个仓库。
4. 服务里 **Add Volume**，挂载路径 `/data`。
5. Variables 里至少加：
   - `DATA_DIR=/data`
   - `ACCESS_CODE=你自己定的邀请码`（强烈建议，否则任何拿到网址的人都能开进程）
   - 可选：`NODEREAL_RPC`、`MAX_PROCS`、`MAX_TRADE_BNB` 等，见 `.env.example`
6. Settings → Networking → Generate Domain，打开得到的 https 网址。
7. 勾选风险提示 → 进入终端 → 点登录 → 在币安 App 里核对配对码并确认。

## 钱包要求（每位访客）

- 在币安 App 里领取 `.ai` Agent ID（Agent 专属盘要求）；
- 打开开发者模式（内盘买卖走 `contract-call`，需要它）；
- 留一点 BNB 付 gas。
- 遇到风控（风险代币、价格偏离过大），交易会进入「等币安 App 确认」，到 App 里确认即可。

## 风险

- 这是会动用真实资金的未审计软件。链上交易不可撤销。不构成投资建议。
- 服务器上保存的是每位访客的 baw 登录会话。拿到某人的 cookie 就能用他的钱包下单（受该钱包在币安 App 里设置的每日限额约束）。请只给信任的人邀请码，并提醒大家在币安 App 里设置合理的每日限额。
- 任何人可在「☁ 我的会话」里一键在币安登出并删除自己的全部服务器数据。
