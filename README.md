# RPA 工作室

本机 Dify 风格的通用 RPA 流程图编辑器。画布、图 JSON、保存/打开、试运行，以及用 Playwright 打开 Chromium 的真实运行。模型还没接。

## 运行

```sh
pnpm install
npx playwright install chromium
pnpm dev
```

- `pnpm test` 校验默认图、解析和假浏览器驱动
- 工具栏 **试运行** 只走节点，不打开网页
- 工具栏 **运行** 会弹出 Chromium，按节点执行打开 / 点击 / 输入 / 抽取 / 等待
- `pnpm dist:mac` / `pnpm dist:win` 打安装包；打包前需在对应操作系统/架构执行 `npx playwright install chromium`，脚本会将该版本的 Chromium 复制进安装包。不支持在 macOS 上直接打包 Windows 浏览器，反之亦然
- 安装包图标来自 `build/source-favicon.ico`；macOS 使用 `build/icon.icns`，Windows 使用 `build/icon.ico`。更换源图后在 macOS 运行 `pnpm icons:generate` 重新生成图标，再执行打包。当前源图只有 32×32 像素，大尺寸图标会有放大痕迹。

## 服务地址环境

客户端服务地址通过三个固定环境文件中的 `VITE_RPA_SERVICE_URL` 配置，必须是以 `/api/v1` 结尾的完整 HTTP(S) 地址。Electron 主进程和页面共用同一构建值；它会写入安装包，不是安装后读取的环境变量，也不在客户端界面显示。构建时也可以用同名系统环境变量覆盖文件中的值。

- 本地开发：修改 `.dev`，运行 `pnpm dev` 或 `pnpm build`。
- 测试：修改 `.dev.test`，运行 `pnpm dev:test`、`pnpm build:test` 或 `pnpm dist:mac:test` / `pnpm dist:win:test`。测试安装包使用独立的应用名称和 ID，可与正式版并存。
- 生产：修改 `.dev.prod`，运行 `pnpm build:production` 或 `pnpm dist:mac` / `pnpm dist:win`。未配置或仍指向本机、示例地址时，生产构建会直接失败。
- 修改任一环境文件后需要重新启动开发进程或重新构建、分发安装包。地址不是密钥，仍可从程序文件中查看；不要将敏感信息写入该变量。

桌面端启动时会按所选环境的服务地址请求 `/api/v1/health`，检查服务端及数据库是否就绪。开发模式检查本机 Playwright Chromium；安装包检查随包浏览器，不依赖用户的 Playwright 缓存。服务临时不可用不会清除 PMS 登录会话；浏览器资源缺失时仍可编辑不依赖页面的流程，页面流程与元素拾取会提示管理员检查安装包。服务端需先部署包含健康接口的版本。

登录通过 `/api/v1/auth/login` 校验 PMS 账号，客户端只保存服务端签发的 JWT。工作流、AI 配置、执行记录、审批和定时任务等业务请求都带该 JWT；Electron 主进程仅在内存中持有已验证的 token，用于流程执行和元素拾取前读取 AI 配置。收到 401 或业务码 `40100` 后清除登录态并返回登录页；`/api/v1/health` 仍可匿名探活。升级前请确保服务端已配置 `JWT_SECRET` 并部署客户端鉴权变更。

图文件默认写在应用用户目录；也可以另存为任意 `.json`。

## 定时执行

在执行中心选择已发布流程，点击“定时执行”，可配置固定间隔、每天或每周的本机定时任务。服务端只保存规则、输入快照和触发/执行记录；计时器运行在 Electron 主进程，客户端每分钟同步配置，到点后由本机执行（页面步骤使用无头 Chromium）。任务绑定创建者的 PMS 账号和指定设备，发布版本固定不随草稿变化。

软件退出、电脑休眠或账号退出期间不会执行；重新上线时只补最近 5 分钟内的一次触发。服务端用“任务 ID + 计划时间”去重，避免多个客户端重复运行。含敏感输入、敏感固定变量、审批或转人工节点（包括子流程）的流程暂不允许创建定时任务。部署新服务端时须先执行数据库迁移 `npx prisma migrate deploy`。

## 节点盘

图片识别节点可从流程变量、输入或上游节点输出读取 PNG/JPEG/WebP/GIF 图片（URL、Base64、data URL，或含图片字段的对象），调用支持视觉输入和结构化输出的 AI 模型，按配置顺序选择第一个匹配分支，否则走“否则”出口。识别结果保存在节点配置的结果变量中，包含 `branch`、`label`、`reason`；图片内容不会写入该节点日志。纯变量/接口/图片流程可以不填写开始 URL。

开始 / 打开页面 / 点击 / 输入 / 抽取 / 等待 / Agent / 条件 / 循环 / 本次循环结束 / 结束

示例模板会打开 `https://example.com` 并抽取 `h1`。后面的点击需要你自己填选择器，空选择器会停下来等人。Agent 仍写入固定 JSON，不调用模型。
