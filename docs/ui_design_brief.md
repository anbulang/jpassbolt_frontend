# JPassbolt 前端 UI 设计纲要 & Claude Design 提示词

> 用途:用 Claude Design(或任意 AI UI 设计工具)产出可落地的 JPassbolt 前端设计稿。
> 校准日期:2026-06-13。本文基于**实际代码**核对,非 CLAUDE.md 中已过时的"仅 Login + Dashboard 两页"描述。

---

## 0. 现状盘点(以代码为准)

**已有路由页**(`src/App.tsx`):`/login` · `/`(Vault)· `/users` · `/groups` · `/settings`

| 页面/组件 | 文件 | 规模 | 形态 |
|-----------|------|------|------|
| Login | `pages/Login.tsx` | 112 行(偏薄) | GPG 三阶段认证 |
| Vault | `pages/Vault.tsx` + `vault/*` | 477 + 386 + 278 行 | 文件夹树 + 资源列表 + Secret 抽屉 |
| Users | `pages/Users.tsx` | 1001 行 | CRUD |
| Groups | `pages/Groups.tsx` | 1511 行 | CRUD + 成员管理 |
| Settings | `pages/Settings.tsx` | 1377 行 | 账户/MFA/服务器 |
| SecretPanel | `vault/SecretPanel.tsx` | 右侧 slide-in **抽屉** | Username/密码/URI/描述/时间 + Share/Edit |
| ShareDialog | `components/ShareDialog.tsx` | Modal | search-aros + 权限矩阵 + simulate + 重新加密 |

**共享服务层已齐全**(`src/services/`):comments / favorites / folders / groups / mfa / permissions / profile / resources / secrets / settings / share / users。

**后端 20 个 Controller**已提供对应 API,前端尚未消费的能力即为"缺口"(见 §4)。

---

## 1. 设计系统(严格固定,不可漂移)

取自 `src/index.css` 的 `:root` 变量,这是权威值。

| 类别 | 值 |
|------|-----|
| 主题 | 深色 Dark + 玻璃拟态 (glassmorphism) |
| 页面背景 | `linear-gradient(135deg, #0b0f19 0%, #1a1b26 100%)`,`background-attachment: fixed` |
| 面板 `.glass-panel` | `bg rgba(22,27,34,0.6)` + `backdrop-filter: blur(12px)` + `1px solid rgba(255,255,255,0.08)` + `box-shadow 0 8px 32px rgba(0,0,0,0.3)`,圆角 12px |
| 主色 | `#0070f3`,hover `#3291ff`,glow `rgba(0,112,243,0.4)` |
| 语义色 | 危险 `#f85149`,成功 `#2ea043` |
| 文字 | 主 `#e6edf3` / 次 `#8b949e` / 弱 `#6e7681` |
| 字体 | Inter(Google Fonts,300–700) |
| 圆角 | sm 6px / md 12px / lg 24px |
| 过渡 | 快 `0.15s ease` / 常规 `0.3s cubic-bezier(0.25,0.8,0.25,1)` |
| 图标 | lucide-react |
| 技术栈 | React 19 + TS + Vite,**纯 CSS,无 Tailwind / 无 UI 组件库** |

已有共享组件可复用:`Avatar` `Badge` `ConfirmDialog` `EmptyState` `FolderTree` `Layout` `Modal` `PasswordField` `Spinner` `Toast`。

---

## 2. 安全 UX 原则(E2EE 零知识 · 一等公民)

1. **密文默认遮罩**:密码以 `••••••` 呈现,显式点眼睛/复制才在客户端解密。
2. **复制即焚**:复制后提示"X 秒后自动清空剪贴板"(现实现为 30s,见 `SecretPanel`)。
3. **锁定态可见**:顶栏显示已解锁/已锁定;锁定时密码区显示锁图标 + 解锁引导,而非空白。
4. **加密可视化**:共享/改群成员时,提示"将为 N 个收件人各自重新加密一份密文"。
5. **私钥永不外泄**:任何位置不显示私钥/passphrase 明文;GPG 指纹可见,但用等宽字体分组脱敏。
6. **防静默锁死**:为某 ARO 授权却拿不到其公钥时,必须报错阻断,不得提交(见 ShareDialog 的 CORRECTNESS INVARIANT)。

---

## 3. 现有页面优化需求(refine)

| 页面 | 现状要点 | 优化方向 |
|------|---------|---------|
| **Vault** | 树 + 列表 + 抽屉 | 列表密度/网格切换/排序;收藏星标;过期角标;空库插画引导 |
| **SecretPanel** | 单滚动抽屉,无 Tab | **加 Tab:详情 / 评论(线程)/ 谁有权限 / 活动**;详情区加收藏星标 |
| **ShareDialog** | 功能完整 | **纯视觉打磨**:把内联 style 提炼为 CSS class;simulate 预览卡片质感;权限行对齐 |
| **Users** | 表格 CRUD | 角色徽章/状态(活跃/禁用/未激活)低饱和处理;删除时所有权转移向导 |
| **Groups** | 列表 + 成员管理 | 群管理员开关;成员变更"重新加密 N 份"进度态 |
| **Settings** | 账户/MFA/服务器 | 子导航分区;TOTP 二维码 + 6 位绑定流程;指纹等宽展示 |
| **Login** | 112 行,偏薄 | 拆成 登录 → 解锁 → MFA 三屏旅程(见 §4) |

---

## 4. 真实缺口(建议新增页面)

| 模块 | 后端支撑 | 说明 |
|------|---------|------|
| Setup / 注册引导 | `SetupController` | 邀请 → 生成/导入密钥 → 设 passphrase → 下载恢复包 → 完成。**无 UI** |
| 账户恢复 | `SetupController`(recover) | 换设备后凭恢复包重新取回访问权 |
| 登录态 MFA 挑战 | `MfaController` | 当前 MFA 仅在 Settings 配置,登录链路缺验证码输入屏 |
| 个人资料 / 头像 | `profile.ts` / `AvatarController` | 改名、上传头像、查看自己的指纹 |
| 资源评论区 | `comments.ts` / `CommentController` | SecretPanel 内线程化评论(见 §3 Tab) |

---

## 5. Claude Design 主提示词(每次设计先粘这段)

```
你是 JPassbolt 的 UI 设计师。JPassbolt 是一个端到端加密(E2EE)、零知识架构的
开源密码管理器(Passbolt 的 Java 重写版)的 Web 前端。

【技术栈】React 19 + TypeScript + Vite,纯 CSS(无 Tailwind、无任何 UI 组件库),
图标统一用 lucide-react。请输出可直接落地为单文件 React 组件 + 配套 CSS 的设计,
className 用语义化短横线命名(如 .vault-list、.secret-card),可把样式提炼为 class
而非堆内联 style。

【设计系统 — 严格固定,不可改动】
- 主题:深色 + 玻璃拟态(glassmorphism)
- 页面背景:linear-gradient(135deg, #0b0f19 0%, #1a1b26 100%),固定不滚动
- 面板:背景 rgba(22,27,34,0.6) + backdrop-filter: blur(12px) + 1px rgba(255,255,255,0.08)
  边框 + box-shadow 0 8px 32px rgba(0,0,0,0.3),圆角 12px
- 主色:#0070f3(hover #3291ff),主按钮带蓝色 glow 阴影 rgba(0,112,243,0.4)
- 语义色:危险 #f85149,成功 #2ea043
- 文字:主 #e6edf3 / 次 #8b949e / 弱 #6e7681
- 字体:Inter,字重 300–700
- 圆角档位:6 / 12 / 24px;过渡:0.15s ease(快)/ 0.3s cubic-bezier(0.25,0.8,0.25,1)(常规)

【安全 UX 铁律 — 这是密码管理器,必须体现】
1. 密码/密文默认遮罩(••••••),需显式点眼睛图标或"复制"才显示
2. 复制成功后提示"30s 后自动清空剪贴板"
3. 顶栏始终可见"已解锁/已锁定"状态,支持手动锁定;锁定时密码区显示锁图标+解锁引导
4. 共享/改权限时可视化"将为 N 个收件人各自重新加密一份密文"
5. 任何位置都不显示私钥明文;GPG 指纹用等宽字体分组脱敏展示

【布局基底】左侧固定侧边栏(盾牌 Logo "JPassbolt" + 导航 Vault/Users/Groups/Settings
+ 底部当前用户头像与登出)+ 右侧主区(sticky 顶栏 + 滚动内容区)。

请始终产出:① 桌面 1440px 布局;② 关键交互态(hover/active/loading/empty/error);
③ 深色玻璃拟态质感的精致细节。不要输出浅色主题。
```

---

## 6. 子提示词(按屏)

### ① Vault(密码库 · 核心页)
```
设计 Vault 三区布局(注意:详情是右侧 slide-in 抽屉,不是固定第三栏):
- 左栏:可折叠文件夹树(根 + 嵌套),"个人/共享"图标区分,悬浮操作。
- 主区:资源列表,每行显示 名称 / username / URI 域名图标 / 收藏星标 / 过期角标;
  顶部搜索框、列表/网格切换、排序。空库态要有插画与"新建密码"引导。
- 右侧抽屉:点击某资源滑出 SecretPanel(见 ③)。
- 顶部主操作:醒目"+ 新建密码"主按钮(带 glow)。
产出:列表 hover 态、选中态、空库态 三个画面。
```

### ② 新建/编辑密码 Modal
```
设计资源表单弹窗(玻璃拟态 Modal,居中,背景虚化遮罩):
字段:名称、username、URI、密码(强度条 + 生成随机密码骰子按钮 + 显示切换)、
描述(多行)、所属文件夹(下拉树)、资源类型(password / password+description / TOTP)。
底部:取消(次按钮)/ 保存(主按钮 glow)。一处提示"密码将在你的浏览器本地加密后再上传"。
产出:默认态 + 密码生成器展开态。
```

### ③ SecretPanel 抽屉(refine — 当前无 Tab)
```
重新设计右侧 slide-in 抽屉(420px 宽,玻璃拟态,带背景遮罩)。
保留头部:锁图标 + 资源名 + 关闭;保留底部:Share / Edit 双按钮。
内容区改为 Tab 切换:
- 详情:Username、密码(默认 ••••••,眼睛显示 + 复制后"已复制 · 30s 后清空")、
  URI 外链、描述、创建/修改时间;标题右侧加收藏星标。
- 评论:线程化评论列表(头像+作者+时间+正文,可回复),底部输入框。
- 谁有权限:用户/群组列表 + 权限徽章(只读/可改/拥有者),"管理共享"按钮跳 ShareDialog。
- 活动:时间线(创建/修改/共享事件)。
锁定态:Tab 内容替换为锁图标 + "你的密码库已锁定,解锁后查看"。
产出:详情 Tab(密码已显示)+ 评论 Tab + 锁定态 三个画面。
```

### ④ ShareDialog(refine — 功能已完整,纯视觉打磨)
```
现有共享 Modal 功能已齐全,只做视觉精修,不改交互:
- 顶部搜索框(放大镜图标内嵌),结果下拉:头像 + 名称 + 副标题 + User/Group 徽章 + 加号。
- "谁有权限"列表:每行 头像/名称/副标题 + New/Removing 徽章 + 权限下拉
  (Can read / Can update / Owner)+ 移除(垃圾桶)/撤销。removing 行用红色低饱和底 + 删除线。
- 锁定时顶部黄色警告横幅:"密码库已锁定,需解锁以重新加密密文"。
- Simulate 结果卡片:"获得访问"(绿色徽章组)/ "失去访问"(红色徽章组)。
- 底部:Close / Simulate / Apply(apply 时 "Sharing…" + spinner)。
把现有内联 style 提炼为干净的 CSS class。
产出:搜索展开态 + 含 simulate 预览态 两个画面。
```

### ⑤ Login + Unlock + MFA(认证旅程,一组三屏)
```
为 GPG 端到端登录设计三个全屏居中卡片(玻璃拟态,背景同主渐变):
A. 登录:盾牌 Logo + 标题,选择/导入 GPG 私钥(拖拽 .asc 上传区),
   文案"我们永远不会把你的私钥发送到服务器"。
B. 解锁(已认证但密钥锁定时):显示密钥指纹脱敏 + 头像,只输入 passphrase 解锁,
   含"记住本设备"开关。
C. MFA 挑战:6 位 TOTP 分格输入,自动聚焦跳格,下方倒计时 + "使用恢复码"。
每屏给默认态 + 错误态(密钥错误 / 验证码错误)。
```

### ⑥ Setup / 注册引导(多步向导)
```
设计账户注册引导(从邀请链接进入),顶部步骤指示器:
1) 欢迎/确认邮箱 → 2) 生成密钥对(生成中动画,强调"本地生成")
→ 3) 设置 passphrase(强度校验 + 二次确认)→ 4) 下载恢复包(强提示"妥善保存,丢失无法找回")
→ 5) 完成进入 Vault。每步玻璃卡片居中,主按钮 glow。
产出:步骤 2(生成密钥)+ 步骤 3(设 passphrase)两屏。
```

### ⑦ Users 管理(管理员)
```
设计用户管理页:顶部搜索 + 角色筛选 + "邀请用户"主按钮。
表格列:头像+姓名、username(邮箱)、角色徽章(admin/user)、
状态(活跃/已禁用/未激活)、最近登录、操作菜单。禁用行低饱和处理。
删除用户时弹"所有权转移"向导:列出该用户拥有的资源,逐项指派新拥有者。
产出:列表态 + 所有权转移向导。
```

### ⑧ Groups 管理
```
设计群组管理:左侧群组列表(名称 + 成员数徽章),右侧群组详情。
详情含:成员表(头像/姓名/"群管理员"开关/移除)、"添加成员"搜索框。
保存成员变更时显示"正在为新成员重新加密 N 份群组密文…"进度。
产出:群详情默认态 + 成员变更保存中态。
```

### ⑨ Settings + 个人资料
```
设计设置页,左侧子导航分区:账户资料 / 安全(MFA)/ 服务器信息。
- 账户资料:圆形头像上传(带上传遮罩)、名/姓、username 只读、
  GPG 指纹等宽分组展示。
- 安全 MFA:TOTP 开关 → 二维码 + 手动密钥 + 6 位验证码绑定 → 已启用显示绿色已验证徽章。
- 服务器信息:只读卡片 hostname / domain / 健康状态。
产出:账户资料 + MFA 绑定流程 两屏。
```

---

## 7. 落地校验清单(设计稿转代码时核对)

- [ ] 颜色/圆角/字体是否全部取自 §1 的 token(不是新造的色值)
- [ ] 是否深色主题(绝不出现浅色稿)
- [ ] 密码默认遮罩、复制有自动清空提示
- [ ] 锁定态有专门视觉,不是空白
- [ ] 共享/群变更有"重新加密 N 份"提示
- [ ] 指纹脱敏、私钥明文零出现
- [ ] 用 lucide-react 图标,className 语义化、可对应现有组件
```
