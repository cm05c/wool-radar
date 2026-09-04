# 🐑 羊毛雷达 LiveWool

全网薅羊毛渠道监控站：分渠道收纳、定时抓取数据链接与羊毛物品、主页实时展示。

## 项目结构

```
wool-radar/
├── index.html                  # 响应式主页（纯静态，无构建依赖）
├── data/deals.json             # 羊毛数据（抓取脚本的输出，页面动态加载）
├── fetcher/
│   ├── fetch.mjs               # 零依赖抓取脚本（Node 18+）
│   └── sources.json            # 渠道源配置（加源只改这里）
└── .github/workflows/deploy.yml  # 定时抓取 + 自动部署 GitHub Pages
```

## 工作原理

```
sources.json（渠道源配置）
      │
      ▼  GitHub Actions 每 30 分钟执行
fetch.mjs 抓取 → 合并去重 → data/deals.json → 自动 commit + 部署
      │
      ▼
index.html 加载 deals.json 渲染（前端每 5 分钟自动刷新，手动「↻ 刷新」随时可用）
```

## 本地运行

```bash
# 1. 跑一次抓取（可选，验证源是否可用）
node fetcher/fetch.mjs

# 2. 起一个静态服务器（任选其一）
python -m http.server 8077
# 或 npx serve .
```

浏览器打开 http://localhost:8077 即可。

## 部署上线（GitHub Pages，推荐）

1. **建仓库**：在 GitHub 新建公开仓库（如 `wool-radar`），把本项目全部文件推上去：

   ```bash
   git init && git add -A && git commit -m "init: 羊毛雷达"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/wool-radar.git
   git push -u origin main
   ```

2. **开启 Pages**：仓库 → Settings → Pages → Build and deployment → Source 选 **GitHub Actions**（不要选 Deploy from a branch）。

3. **触发部署**：Actions 页面手动触发一次 `Fetch & Deploy` workflow（Run workflow 按钮），或在仓库里随便推一个 commit。约 1 分钟后访问：
   `https://<你的用户名>.github.io/wool-radar/`

4. **验证**：
   - Actions 显示两次绿勾（fetch + deploy）
   - `data/deals.json` 出现 bot 的自动提交记录
   - 之后每小时第 13/43 分自动抓取更新并重新部署，无需人工干预

> 常见失败原因：Source 忘了改成 GitHub Actions（会 404）；仓库未推送 `.github/workflows/` 目录（workflow 不生效）；首次部署需等 DNS 生效几分钟。

## 添加新羊毛渠道

编辑 `fetcher/sources.json`，两种类型：

- **RSS 源**：填 `type: "rss"` + `url` 即可（优惠资讯站大多有 RSS）。
- **JSON API**：填 `type: "jsonapi"` + `mapping` 字段映射（`listPath` 指向数组所在路径）。

改完推送到 main，下一轮定时任务自动生效。

## 备选部署：腾讯 EdgeOne Pages

如需国内访问更快：控制台创建 Pages 项目 → 连接同一 GitHub 仓库 → 构建命令留空、输出目录填 `/` → 部署后获得 `*.edgeone.app` 域名。抓取仍由 GitHub Actions 完成，EdgeOne 只负责静态托管（仓库 push 后自动同步重部署）。

## 数据字段说明（deals.json items）

| 字段 | 说明 |
|---|---|
| `title` / `desc` | 羊毛物品名称与说明 |
| `channel` | 来源渠道（页面徽章 + 渠道统计） |
| `category` | 分类（自动生成筛选 tab：电商/外卖/话费/会员…） |
| `url` | 数据链接（「去薅羊毛」按钮跳转） |
| `value` | 优惠力度高亮（如「5 元无门槛红包」） |
| `expiresAt` | 到期时间（临期标红、过期置灰沉底） |
| `publishedAt` / `hot` | 发布时间与热度（排序用） |
