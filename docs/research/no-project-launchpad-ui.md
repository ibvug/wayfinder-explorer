# 无项目启动界面：研究结论

日期：2026-08-10
范围：Wayfinder Explorer 的“未打开项目”首屏。仅参考官方设计系统、游戏开发团队和 GDC 开发者材料。

## 结论

这应该是一张**游戏主菜单式的 blank slate**，不是项目仪表盘。

默认只显示一个视觉焦点、一句标题和一个主动作；最近项目、路径、项目管理和原理说明进入下一层。当前页面在项目行之前已有至少 14 个文字锚点，并让“创建新旅程”和“选择本地项目”同时争夺注意力，正是“乱、没有层次、字太多”的来源。

建议首屏文案：

```text
WAYFINDER // STANDBY

准备出发
选择一个项目，开始探索。

[ 打开项目 ]

新建项目
```

“打开项目”进入统一选择器，下一层才展示最近项目、项目库和磁盘目录。这样不强制打开任何项目，也不把所有选择一次铺满。

## 设计原则

1. **一屏只回答一个问题：下一步做什么。** 空状态采用“可选插画 → 短标题 → 一句说明 → 主 CTA → 可选弱动作”的层级，不再同时展示状态卡、项目列表和说明模块。[Carbon：Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/#anatomy)

2. **只有一个高强调 CTA。** 主按钮用明确的“动词＋对象”——`打开项目`；`新建项目`降为文字按钮。Carbon 明确建议多选项时挑最重要的动作，Shopify 要求空状态只设一个 primary CTA。[Carbon：No data empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/#no-data-empty-states) · [Shopify Polaris：Empty state](https://polaris-react.shopify.com/components/layout-and-structure/empty-state)

3. **设文字预算。** 标题 4–8 个汉字，正文仅一句，按钮不超过 4 个汉字；不重复“未打开项目”“系统待命”“项目库为空”等同义状态。Carbon 指出首次使用时更多内容会增加认知成本，并要求文字保持最少、可快速阅读和行动。[Carbon：When to use / Do and don’t](https://carbondesignsystem.com/patterns/empty-states-pattern/#when-to-use)

4. **逐层披露，不隐藏核心入口。** 首屏只保留 `打开项目` 和弱化的 `新建项目`；最近项目、路径、失联状态和管理操作放入选择器/抽屉。入口必须有可见文字，不能只靠悬停或无标签图标，因为渐进披露会有可发现性风险。[Microsoft：Progressive disclosure](https://learn.microsoft.com/en-us/windows/win32/uxguide/ctrl-progressive-disclosure-controls)

5. **游戏感来自一个强画面，不来自更多 HUD 文案。** 保留单个“待机星图/航标”：深色空间、细轨道、一个暖色脉冲；其余读数、双语眉题和技术页脚删除。Outer Wilds 团队把 UI 定义为“retro NASA、minimalistic and modern”，用细线区分功能，并记录了单个元素承担太多目标会变得杂乱。[Mobius Digital：Concepting UI](https://www.mobiusdigitalgames.com/news/concepting-ui)

6. **先建立情绪，再让动作一眼可见。** GDC 将主菜单视为玩家与游戏建立情绪连接的第一次机会；Destiny 的 UI 目标同时包含“新手易消化”和“老手有深度”。Wayfinder 因此应把深度留在第二层，把首层做成安静、可进入的远征起点。[GDC：Working the Crowd](https://gdcvault.com/browse/gdc-13/play/1017804) · [GDC：The Interface of Destiny](https://www.gdcvault.com/play/1023107/Tenacious-Design-and-The-Interface)

## 推荐布局

```text
┌──────────────────────────────────────────────┐
│ WAYFINDER                                    │
│                                              │
│      （缓慢呼吸的单个星图航标）              │
│                                              │
│                 准备出发                     │
│          选择一个项目，开始探索。             │
│                                              │
│               [ 打开项目 ]                   │
│                 新建项目                     │
└──────────────────────────────────────────────┘
```

- 整个内容组居中，文字组内对齐一致，最大宽度约 420–450px；不要左右拆成“视觉区＋信息区＋列表区”。大屏空状态可将左对齐内容组整体居中。[Carbon：Large empty spaces](https://carbondesignsystem.com/patterns/empty-states-pattern/#visual-guidelines-for-larger-empty-spaces) · [Shopify：Empty-state composition](https://shopify.dev/docs/api/app-home/patterns/compositions/empty-state)
- 默认不显示项目磁盘路径、项目数量、连接正常状态、`LOCAL-FIRST`、`NO PROJECT PROCESS RUNNING` 或操作解释。
- 只有连接失败时才临时显示状态；正常待命无需额外说明。
- 星图仅是氛围与焦点。悬停/键盘聚焦主按钮时，轨道可轻微收束到航标；点击后再过渡到项目选择器。这是基于上述资料的产品推导，不是资料原文。
- 动效遵守 `prefers-reduced-motion`；惊喜来自一次有因果关系的响应，而不是多个持续旋转、闪烁的装饰。

## 选择器的第二层

点击 `打开项目` 后再显示：

1. 最近项目（最多 3 个，只显示名称和简短状态）；
2. `浏览本地项目`；
3. `查看全部项目`；
4. 路径、重新关联、删除等管理信息只在选中项目后出现。

这让首屏承担“进入”，选择器承担“选择”，项目库承担“管理”，每层只有一个主要任务。

## 验收检查

- 不看说明，3 秒内能指出唯一主按钮。
- 默认可见中文不超过：1 个标题、1 句正文、2 个动作标签。
- 首屏不出现磁盘路径、项目卡片或并列说明模块。
- 用户可停留在无项目状态，且不会自动打开项目。
- 鼠标、键盘和减少动态效果模式都能完成相同流程。
