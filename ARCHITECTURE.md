# 架构笔记 — 参考的开源实现与采纳决策

> 本轮实际克隆阅读：Ardour (libs/temporal 时间域模型)、Tone.js (effect 体系)。
> REAPER 为闭源，其行为（item timebase / rate change / send 路由 / 右键框选）按实测行为对齐。

## 1. 时间与 BPM（Ardour Temporal 库）

**Ardour 的模型**（`libs/temporal/temporal/`）：
- 每个时间位置对象 `timepos_t` 自带**时间域**：AudioTime（采样）/ BeatTime（音乐拍）/ BBT（小节.拍.刻度）。
- 唯一规范域是 superclock（高精度采样域）；其他域是**惰性推导**。
- tempo/meter 变更不走"遍历缩放对象"，而是 **domain bounce**：所有实现了 `TimeDomainSwapper` 的对象收到 `start_domain_bounce(DomainBounceInfo&)`，把自己的位置经 TempoMap 换算到新域，再 `finish_domain_bounce`。对象从不移动——是**域的换算**。

**我们的现状与采纳**：
- 现状：秒为规范域，BPM 变更 = `rescale` 循环（start/length/fade/loop/playhead 逐个乘 f）。已修齐所有时间类字段（fade/loop/playhead 曾漏）。
- 已知残留：非接管轨（BGM）保持绝对秒——这是产品决策（BGM 是固定参考），不是缺陷。
- 桌面化阶段切换 **beats 规范域**：clip 存 `{pos_beats, len_beats, rate}`，秒只在渲染/播放/绘制时推导。BPM 变更就变成"改一个数字"，所有换算天然正确——Ardour 方案的完整移植，也顺带解决 stretch 钳制边界问题。

## 2. 失效传播（REAPER/Ardour 通用模式）

路由/依赖变更时，**受影响对象集合必须在变更前快照，变更后向快照推送重算**。
我们踩过的坑：`removeWhipsOf` 先删路由再"顺着现有路由找受影响者" → 集合为空 → 重渲染从未发生。
已按 push 模式修复（变更前捕获目标轨集合）。

## 3. 效果器（Tone.js effect 体系）

- **Effect 基类**：干/湿双路（dry gain + wet 链），wet 参数统一 → 我们的每轨 FX 链同构。
- **Chorus**：双 delay（L/R），LFO 调制 delayTime（默认 1.5Hz / 3.5ms / depth 0.7），L 相位 0 / R 相位 180。
- **Reverb**：衰减噪声生成脉冲响应 → ConvolverNode（decay 1.5s + preDelay 10ms）。
- **EQ3**：lowshelf(320) / peaking(2.5k) / highshelf(8k)。
- **激励器**（Tone 没有）：Aphex 式 = 高频支路(HPF 3.2k) → WaveShaper 软削波谐波 → 按量混回干声。
- 采纳：原生 WebAudio 节点实现（无运行时依赖），全部节点常驻、参数原地更新（无重连线），bypass = wet 归零。

## 4. 性能现状与路线

| 阶段 | 架构 | 状态 |
|---|---|---|
| 现在 | Python 服务（多进程渲染池）+ 浏览器 WebAudio 播放 | 单块 30–70ms，5.5s 块 0.07s；编辑手感≈实时 |
| +rubberband-cli | 拉伸/变调换 RB R3（C++ 多线程） | 待安装，自动启用 |
| 桌面端 | Tauri 壳 + 现有 Python 内核做 sidecar，或 Rust 重写内核 | 未开始 |
| 真·实时监听 | 流式 PSOLA / RB process 层，或 GPU AI 变声（RVC 类） | 桌面化后评估 |

Python 不是当前瓶颈（渲染核心已经是 C++：Praat/Rubber Band/numpy）；瓶颈是"每次变更重渲染"的模型。流式化（播放图上挂实时 PSOLA 节点）才是质变，属于桌面端阶段。

## 5. 踩过的架构教训

- 失效传播：变更前快照受影响集合（v5.10）。
- 渲染缓存键必须含：引擎版本 + 所有影响输出的输入（v5.9/r6）。
- 坐标系变换（文件秒/窗口秒/块内秒/块内拉伸秒）每步显式注释（v5.6）。
