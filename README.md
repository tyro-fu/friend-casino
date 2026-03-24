# 好友德州扑克（可快速部署）

面向朋友私下娱乐：私密房间（可选密码）、WebSocket 实时同步、**本场**盈亏与局数统计（不跨房间、不长期累计）、SQLite 仅存房间密码便于重连。不收集手机号，不接入第三方登录与支付。

## 环境要求

- **本机运行**：Node.js 18+（Windows 需可编译 `better-sqlite3`，或直接使用 Docker）。
- **Docker**：Docker 20+ 与 Docker Compose v2。

## 配置（游戏名称与积分规则）

编辑 `config/game.json`（UTF-8）：

- `游戏名称`：网站标题；若留空则读环境变量 `GAME_NAME`，再默认「好友德州扑克」。
- `积分统计规则`：若整段缺失，则使用代码内默认（小盲 5、大盲 10、每轮上限 99999、初始筹码 2000、单桌 2～9 人）。
- `规则预设`（可选）：数组，每项含 `名称`、`说明` 与与上表相同字段的数值，供大厅展示参考；**实际对局只认 `积分统计规则`**。可将某一预设的数值整体拷贝进 `积分统计规则` 后保存以切换玩法。

字段说明（`积分统计规则`）：

| 字段 | 含义 |
|------|------|
| 小盲注积分 | 小盲大小 |
| 大盲注积分 | 大盲大小 |
| 每轮下注上限积分 | 单个玩家在当前街最多投入总量（含已下部分） |
| 初始筹码积分 | 入座时筹码 |
| 单桌最少开局人数 | 房主「开始一手」所需最少有筹码玩家数 |
| 单桌最多座位数 | 最大 9 |

修改后：**Docker** 下若挂载了 `./config` 会立即生效于新开局；**本机**可重启进程或后续可加接口热加载（当前实现为进程启动时读配置，部分接口每次请求会 `reload`）。

## 本机启动

```bash
cd nodetest
npm install
npm start
```

浏览器打开 `http://127.0.0.1:3001`（默认端口，避免与本机其它占用 3000 的服务冲突）。数据默认写在 `data/poker.sqlite`，可通过环境变量 `DATA_DIR` 指定目录。

## Docker 一键启动

```bash
docker compose up --build -d
```

访问 `http://服务器IP:3001`（`docker-compose` 将主机 3001 映射到容器内 3000）。数据库在命名卷 `poker_data` 中；`config` 目录以只读方式挂载，便于改规则。

探活地址：`GET /health`（返回纯文本 `ok`），便于云平台做健康检查。

## 部署到 Render（分步教程）

> **免费档须知**：`render.yaml` 已固定 `plan: free`，**不配置持久盘**。房间密码等 SQLite 数据在**重新部署**或**实例重建**后可能丢失；实例 15 分钟无流量会**休眠**，再次访问需冷启动约 30-60 秒，属正常现象。

---

### 前置条件

| 条件 | 说明 |
|------|------|
| GitHub 或 GitLab 账号 | 用于托管代码仓库 |
| Render 账号 | 前往 [render.com](https://render.com) 注册（可直接用 GitHub 登录） |
| Git 已安装 | 本机需要能执行 `git` 命令 |

---

### 第 1 步：初始化 Git 仓库并推送到 GitHub

如果你还没有 Git 仓库，在项目根目录执行：

```bash
git init
git add .
git commit -m "init: friend poker"
```

然后去 GitHub 创建一个**新仓库**（Public 或 Private 均可），按提示把代码推上去：

```bash
git remote add origin https://github.com/你的用户名/你的仓库名.git
git branch -M main
git push -u origin main
```

---

### 第 2 步：在 Render 关联 GitHub

1. 打开 [dashboard.render.com](https://dashboard.render.com)。
2. 若首次使用，点击头像 → **Account Settings** → **Connected Accounts**，授权绑定你的 **GitHub**（或 GitLab）。

---

### 第 3 步（推荐）：使用 Blueprint 一键部署

项目已包含 `render.yaml`，可直接用 Blueprint 自动配置：

1. 点击顶部导航栏的 **New** → 选择 **Blueprint**。
2. 在仓库列表中找到刚才推送的仓库，点击 **Connect**。
3. Render 会自动读取 `render.yaml`，显示将要创建的服务：
   - 名称：`friend-poker`
   - 类型：Web Service（Docker）
   - 区域：`singapore`
   - 计划：`free`
   - 健康检查：`/health`
4. 确认无误后，点击 **Apply** 开始构建。
5. 等待 2-5 分钟，构建完成后会得到一个公网地址，格式为：
   ```
   https://friend-poker-xxxx.onrender.com
   ```
6. 浏览器打开该地址即可开始游戏。

---

### 第 3 步（备选）：手动创建 Web Service

如果不想用 Blueprint，也可以手动配置：

1. 点击 **New** → **Web Service**。
2. 选择 **Build and deploy from a Git repository** → 选中你的仓库 → **Connect**。
3. 填写配置：
   - **Name**：`friend-poker`（或任意名称）
   - **Region**：`Singapore`（亚洲用户推荐）
   - **Runtime**：选择 **Docker**
   - **Dockerfile Path**：`./Dockerfile`
   - **Instance Type**：选择 **Free**
4. 展开 **Advanced** 部分：
   - **Health Check Path**：填入 `/health`
   - **Environment Variables**：添加一条 `NODE_ENV` = `production`（可选，Dockerfile 已内置）
5. 点击 **Create Web Service**，等待构建部署完成。

---

### 第 4 步：验证部署

部署完成后：

1. **访问首页**：打开 Render 分配的 URL，应看到游戏大厅页面。
2. **检查健康接口**：访问 `https://你的域名.onrender.com/health`，应返回纯文本 `ok`。
3. **测试创建房间**：输入昵称，创建一个房间，确认 WebSocket 连接正常。

---

### 第 5 步：后续更新

每次修改代码后，只需推送到 GitHub 默认分支：

```bash
git add .
git commit -m "update: 描述你的改动"
git push
```

Render 检测到推送后会**自动重新构建和部署**（约 2-5 分钟）。

---

### 第 6 步（可选）：自定义域名

1. 在 Render 服务面板中点击 **Settings** → **Custom Domains**。
2. 点击 **Add Custom Domain**，输入你的域名（如 `poker.example.com`）。
3. 按提示在你的域名 DNS 服务商处添加 **CNAME** 记录，指向 Render 给出的目标值。
4. 等待 DNS 生效（通常几分钟到几小时），Render 会自动签发 HTTPS 证书。

---

### 区域选择

`render.yaml` 默认 `region: singapore`，可改为其他区域以降低延迟：

| 值 | 区域 |
|----|------|
| `singapore` | 新加坡（亚洲推荐） |
| `oregon` | 美国西部 |
| `ohio` | 美国东部 |
| `frankfurt` | 欧洲 |

修改 `render.yaml` 中的 `region` 字段后推送即可生效。

---

### 常见部署问题

| 问题 | 解决方式 |
|------|----------|
| 构建失败提示 `npm install` 错误 | 检查 `package.json` 依赖版本；Dockerfile 已包含 `python3 make g++` 编译环境 |
| 部署后页面打不开 | 等待 2-5 分钟，查看 Render 面板 **Logs** 确认构建完成 |
| 访问显示 502 Bad Gateway | 检查 Logs 中是否有启动错误；确认 `Dockerfile` 中 `PORT=3000` 与 Render 注入的 `PORT` 一致 |
| 休眠后首次访问很慢 | 免费档正常现象，冷启动约 30-60 秒 |
| 房间密码丢失 | 免费档无持久盘，重部署后 SQLite 可能重建；需长期保留可升级付费档并挂载持久盘 |

## 部署到公网与免费/低成本主机建议

本项目是 **单进程 + WebSocket + 内存房间 + 本地 SQLite（仅房间密码等轻量数据）**，适合 **单实例常驻**；不适合多副本负载均衡（房间状态无法跨进程共享）。数据库文件需落在 **可持久化磁盘** 上，否则重启会丢房间密码记录；**本场牌局统计在服务端内存中**，进程重启即清空。

**可选方向简述：**

| 类型 | 代表 | 说明 |
|------|------|------|
| 永久免费 VPS | **Oracle Cloud 免费套餐**、**AWS 免费层 EC2**（12 个月常见） | 自己装 Docker 或直接 `node server/index.js`，配 Nginx/Caddy 做 HTTPS，**最贴合当前架构**。 |
| 容器平台 | **Fly.io**、**Railway**、**Render** 等 | 用 `Dockerfile` 部署；需要长期保留 SQLite 时请挂持久 Volume 并设 `DATA_DIR`。**Render 仅免费档**见上文：不挂盘，数据不保证保留。 |
| 纯静态+无状态 API | Vercel / Netlify | **不推荐做主部署**：WebSocket 长连接与 SQLite 文件与它们的无服务器模型不匹配。 |

**免费额度常见限制**：冷启动、睡眠、流量/CPU 限额、持久盘需单独开通。若以「长期稳定联机」为主，**Oracle 免费 VPS 或一台低价 VPS** 往往最省心。

**为部署与后续迭代建议保持的习惯：**

1. **环境变量**：端口与数据目录只用 `PORT`、`DATA_DIR`（见 `.env.example`），不要在代码里写死域名。
2. **HTTPS**：对外服务用 **Nginx / Caddy** 反向代理到容器或 Node，自动证书（Let’s Encrypt）；前端 `wss://` 与页面 `https://` 同源可避免混合内容问题。
3. **配置与代码分离**：规则继续放 `config/game.json`；镜像内自带默认配置，服务器上可用挂载覆盖（与现有 compose 一致）。
4. **更新流程**：`git pull` → `docker compose build --pull && docker compose up -d`；数据在 volume 中，不因镜像更新而丢失。
5. **备份**：定期拷贝 `data/poker.sqlite`（或挂载目录），便于回档。
6. **后续若要水平扩展**：需引入 **Redis 等共享房间状态** 与 **网络盘/托管数据库** 替代单机 SQLite，属于架构升级，与当前「好友桌」定位不同。

## 界面操作说明

1. 首页填写昵称（仅展示），可「创建房间」或输入房间号「加入」。
2. 创建者可不设密码；若设密码，请把房间号与密码私下发给朋友。
3. 进入牌桌后，将浏览器地址栏链接复制分享即可（格式 `.../room.html#房间号`）。
4. **房主**点击「开始一手」发牌；轮到自己时按按钮：弃牌、过牌、跟注、下注/加注（加注框为**本轮累计下注目标额**，受上限约束）。
5. 「测延迟」可粗略观察 WebSocket 往返（实际延迟受网络与设备影响）。

## 常见问题

- **端口占用**：本机默认已改为 **3001**。若仍冲突，可 `set PORT=3456`（Windows）或 `PORT=3456 npm start`；Docker 请改 `docker-compose.yml` 里 `ports` 左侧主机端口（如 `"3456:3000"`）。
- **Windows 下 npm install 失败**：缺少编译工具时，请安装「使用 C++ 的桌面开发」或改用 Docker 构建镜像。
- **玩家身份**：同一浏览器会复用本地 `poker_pid`；换浏览器或清除本地存储会得到新 ID（本场统计按房间内身份计算）。
- **房主离线**：当前版本房主 ID 不变；若需换房主可全员退出后由新房主重新建房间。

## 模块划分（实现对应）

| 模块 | 路径 |
|------|------|
| 房间与连接 | `server/index.js`、`server/rooms.js` |
| 游戏逻辑 | `server/poker/table.js`、`deck.js`、`evaluate.js` |
| 房间密码持久化 | `server/db.js`（`rooms` 表） |
| 前端大厅 | `public/index.html` |
| 牌桌 | `public/room.html` |

