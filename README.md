# 读伴 ReaDouble

Rokid Glasses 上的读论文陪伴智能体（AIUI 0.17.0，单绿显示）。看英文论文时有一段看不懂，双击镜腿唤起 AIUI，说“这段什么意思”：眼镜先拍下视野里的段落，交给视觉大模型识别文字并给出中文解读、朗读出来；之后单击镜腿就能语音追问、翻译、总结或重拍。

## 眼镜画布与比例

| 层 | 尺寸 | 来源 |
| --- | --- | --- |
| 光学画布（整个显示区） | 480 × 640 px，3:4 竖屏 | AIUI Studio 1.1.0 真机模拟的 `.device-screen`（`width: 480px; height: 640px`，界面里缩放 0.75 显示），与官方光学设计指南一致 |
| AIUI 页面视口（Page 实际渲染区） | 480 × 352 px，15:11 横向 | 同一模拟器里的 `.ink-canvas-host`（`top: 144px; width: 480px; height: 352px`，垂直居中），与 0.17 附带的单绿设计规范的参考画布一致 |
| 安全区 | 左右 16 px、上下 12 px，内容宽 448 px | 设计规范 |
| 对话流内联卡片 | 448 × 150 px | Studio 的 `/debug` 卡片实测（2026-09-11） |

页面按 480 × 352 布局；高度不足 240 px 时（内联卡片）只保留状态、解读正文和操作提示。

## 导入 AIUI Studio

AIUI 工程根是仓库里的 `agent/` 子目录（它直接包含 `app.json`），不是仓库根：

```text
Repository: https://github.com/cnYui/readouble
Ref: main
AIUI project directory: agent
```

Studio 左上角「新建智能体」→「GitHub 导入」填 `https://github.com/cnYui/readouble/tree/main/agent`，导入后在项目「···」菜单选「上传云端」，再在对话框发送 `/debug 模拟眼镜设备运行读伴页面 pages/explain/index`，卡片上点「进入」。同一地址再导入会就地更新。

## 视觉识别：中转站与密钥

识别调用 `agent/config/vision.js` 里的 OpenAI 兼容中转站：`POST {baseUrl}/chat/completions`，照片作为 JPEG Data URL 放在 `image_url` 里，非流式返回。追问时连同照片和上一轮回答一起重发。

| 字段 | 默认值 |
| --- | --- |
| `baseUrl` | `https://api.aaccx.pw/v1` |
| `model` | `gpt-5.5` |
| `reasoningEffort` | `medium`（作为 `reasoning_effort` 发送；空字符串则不发送） |
| `timeoutMs` | `60000` |
| `apiKey` | 空 |

- **密钥放在仓库根目录的 `.env`，不进 Git。** 复制 `.env.example` 为 `.env`，填 `READOUBLE_VISION_KEY`；可选 `READOUBLE_VISION_MODEL`、`READOUBLE_VISION_EFFORT`、`READOUBLE_VISION_BASE_URL`。`.env` 和 `build/` 都在 `.gitignore` 里；`tests/secrets.test.js` 会在任何被 Git 跟踪的文件里出现 `sk-…`，或 `.env` 不再被忽略时，让 `npm test` 失败。
- **把密钥带进 Studio 和眼镜：** `npm run build:agent` 把 `agent/` 复制到 `build/agent/`，并把 `.env` 的配置写进 `build/agent/config/vision.js`。在 Studio 对项目「···」▸「本地导入」选择 `build/agent`，再「上传云端」；眼镜更新资源包后就带着密钥。GitHub 导入的是不含密钥的 `agent/`。
- `apiKey` 为空时页面退回宿主 `LanguageModel`，进度行写“宿主模型”；配置了密钥时写模型名。
- **Studio 网页模拟器调不通这个中转站：** 它拒绝来自 `https://aiui.rokid.com` 的跨域预检（HTTP 403，没有 `Access-Control-Allow-Origin`）。真机走原生网络，不受跨域限制，要在眼镜上验证。
- 发布前要在开发者后台登记中转站域名，并在提审表单里如实声明网络权限：照片和问题会发给这个第三方中转站。

### 先验证模型真的在读图

```bash
npm run test:live
```

`tests/relay.integration.test.js` 会把 `tests/fixtures/test-paper.jpg` 发给当前配置的模型。图里是编造的方法名 “Lattice Reweighting (LRW-7391)”，模型不可能凭记忆答出；回答里没有 `LRW-7391` 就判定失败。用 `READOUBLE_VISION_MODEL` 和 `READOUBLE_VISION_EFFORT` 可以临时换模型。

### 2026-09-11 实测

| 模型 | 结果 |
| --- | --- |
| Studio 宿主默认模型 | 照片确实随请求发出（`rcs.rokid.com/metis/api/chat/completions`，请求体 342,764 字节，含 256,077 字节的 JPEG），但一张 “OSAKA ROKID GLASSES” 海报被解读成 Transformer 论文段落：没有读图 |
| 中转站 `grok-4.5` / `grok-4.6`（开通 gpt-5.5 之前） | 4.6 返回 502；4.5 能返回但编造图片内容：测试图被说成“可控系统动力学”段落，一张 AIUI Studio 截图被说成“USDC 支付页面”；没有图片时它会正确回答 `NO_IMAGE` |
| 中转站 `gpt-5.5`，推理 medium（开通之后） | **读图正确**：原样引用测试图里的 `LRW-7391`，三段格式和术语都对；追问“为什么能降低方差”答对；“翻译一下”给出含 “38%” 的完整译文，说明追问时仍在看图 |

`gpt-5.5` 每轮耗时（`npm run test:live` 和三轮对话实测）：

| 请求 | 耗时 |
| --- | --- |
| 第一轮看图解读 | 27 秒、48 秒 |
| 追问 | 96 秒 |
| 翻译一下 | 29 秒 |

推理本身只用了约 95 个 token，慢的原因大概率在中转站，未确认。页面据此把中转站请求超时设为 150 秒，整轮看门狗为 160 秒。

## 交互流程

```text
对话里提问 ──► 解读 Page 打开 ──► 自动拍照 ──► 视觉模型识别 + 解读 ──► 显示三段 + 朗读【解读】
                                    │ 宿主要求用户操作                     │ 单击
                                    ▼                                      ▼
                              单击镜腿再拍                    语音追问 / 翻译一下 / 总结一下 / 重拍 / 结束
```

| 状态 | 单击 | 向前 / 向后滑动 |
| --- | --- | --- |
| 准备拍照（READY） | 拍照 | — |
| 拍照中 / 解读中 | 忽略 | 解读中可翻看已到达的内容 |
| 解读完成（DONE） | 开始语音追问 | 翻看解读（每次 120 px） |
| 聆听中（LISTEN） | 结束听写并发送（6 秒无声自动结束；宿主停不下来时 1.5 秒后页面自行收尾） | — |
| 出错（ERROR） | 拍照失败一次 → 重拍；连续两次、相机被拒或模型看不到照片 → 念出这段文字；模型或中转站失败 → 重试同一请求；语音失败 → 再试一次 | — |

双击由宿主处理（进入或退出全屏）；返回键不拦截，离开页面时会停止听写、朗读、相机和未完成的中转站请求。

## 页面输出

模型被要求按三段回答，页面把它们拆开显示：

- 【原文】不超过两句的关键原文摘录（48% 亮度，左侧 1 px 引线）
- 【解读】中文说明，120 字以内，会被朗读
- 【术语】最多 3 个“术语：一句话解释”

模型没有按格式回答时，整段文字作为解读显示。模型回答 `NO_IMAGE`（看不到照片）时页面不显示任何“原文”，改为请用户念出这段文字。追问的回答直接替换解读正文，原文摘录和术语保留。

## 目录

```text
agent/                     AIUI Studio 导入根（AIUI 0.17.0）
  AGENTS.md                智能体身份、语音路由规则、能力边界
  app.json                 pages: explain；permissions: CAMERA, RECORD_AUDIO
  config/vision.js         视觉中转站配置（apiKey 在 Git 中为空）
  pages/explain/index.ink  解读页（拍照 → 识别解读 → 朗读 → 语音追问）
  lib/reply.js             提示词、回答解析、NO_IMAGE 判断、口令识别、照片编码
  lib/vision.js            中转站请求、错误说明、对话历史裁剪
  lib/temple.js            镜腿输入去重（来自 doubletraining）
  aiui-audit-claims.json   审计声明
tests/                     Node 测试（不进 Studio）
  fixtures/test-paper.jpg  实测用的“论文”图片（编造的 LRW-7391）
tools/build_audit.py       从最新能力清单生成审计矩阵
docs/aiui-audit.md         UX / 能力审计矩阵（本机无签名权威，所有层为 BLOCKED）
```

## 开发

```bash
npm test
npm run validate
python tools/build_audit.py
```

需要 Node 20+。`tests/page.test.js`（宿主模型路径）和 `tests/page.relay.test.js`（中转站路径）会把 `.ink` 里的 `<script setup>` 当作真实模块加载，用假的相机、模型、网络、语音识别和朗读跑完整个状态机。

## Studio 模拟器里已验证（2026-09-11，Studio 1.1.0）

- GitHub 导入、上传云端、`/debug` 进入 480 × 352 效果预览；页面收到 `onTargetChanged(undefined → _current)`、`onLoad`、`onShow`，没有 `onReady`，所以自动拍照挂在首次 `onShow`。
- 单击 = `GlobalHook` + `Enter`（页面只执行一次动作）；向前 / 向后滑动 = `GlobalHook` + `ArrowUp` / `ArrowDown`；双击不会送到页面。
- 「摄像头」面板上传的本地图片会原样交给 `takePhoto()`（字节数和 SHA-256 一致）。
- 宿主 `LanguageModel` 的请求在「网络」面板里显示为 `POST · InkView Runtime`，看得到请求体大小，看不到流式响应正文。
- 听写一段英文原文后，宿主模型约 30–45 秒返回三段式回答，右侧出现 TTS 卡片朗读【解读】。
- 长文本通知不会被 `text-overflow: ellipsis` 截断，已在 JS 里裁剪。

## 未验证

- 在眼镜上用带密钥的副本跑通整条流程：真实相机拍照、中转站连通性、每轮 30–100 秒的等待是否能接受、相机照片的大小上限。Studio 网页模拟器因为跨域限制测不了中转站。
- 追问是否需要 `RECORD_AUDIO` 权限；清单里已按“真实使用麦克风”申报。
- 真机的光学、按键顺序、权限弹窗、朗读、性能。模拟器结论不等于真机通过。
