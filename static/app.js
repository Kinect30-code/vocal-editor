/* vocal-editor v4 — 多轨时间线 (canvas) + WebAudio 走带 + WORLD 渲染
   v4: 顶部菜单 / 拖放导入(ffmpeg通吃) / Alt+拖缘=拉伸·直接拖=裁剪 / B·N循环选区 / whip视觉重做 */
'use strict';

// ================= 状态 =================
const RULER_H = 34, ROW_H = 88, EDGE = 12;
const S = {
  project: { bpm: 120, tracks: [], clips: [], midiClips: [], whips: [] },
  sel: null, multi: [],
  playhead: 0, playing: false, ctxStart: 0, startPos: 0,
  pps: 100, scrollX: 0, scrollY: 0,
  snap: true, grid: { mode: 'beat', div: 0.25 },
  loop: { a: 0, b: 4, on: false },
  peaks: new Map(), buffers: new Map(), srcInfo: new Map(),
  undoStack: [], redoStack: [],
  drag: null, whip: null, dirty: true,
  clipboard: [], lastProj: null,
};
const $ = id => document.getElementById(id);
const cv = $('tl'), ctx2d = cv.getContext('2d');
let AC = null, masterGain = null, active = [], monitorNodes = [];

const uid = () => Math.random().toString(36).slice(2, 9);
const beat = () => 60 / (S.project.bpm || 120);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gridSec = () => S.grid.mode === 'beat' ? beat() * S.grid.div : S.grid.div;
const baseName = p => p.split('/').pop();
// 算法渲染的"窗口长度"上限 (秒). 只取决于块窗口, 与源文件多长无关 (以前误用 srcDur 判超长 → 长源一旦变调就被降级成变速)
const WIN_LIMIT_PSOLA = 45;    // 接管(takeover) / 变速: 走 Praat PSOLA, 很慢
const WIN_LIMIT_PITCH = 240;   // 纯变调(不变速): 走 rubberband, 实测 ~24x 实时 (180s→7.4s), 可放宽

// ================= 会话自动保存 (localStorage) =================
// 工程 (含 MIDI 块/音符/滑音/whip/自由变调轨) 每隔一小会儿写一份到本机, 刷新/崩溃不丢;
// File→保存工程 仍是导出 .json 的正式路径。
const LS_KEY = 'vocal-editor:session:v1';
let lsTimer = null, lsLast = '';
function persistSession() {
  try {
    const s = JSON.stringify(S.project);
    if (s === lsLast) return;                      // 没变化就不写 (播放时 invalidate 每秒会叫几次)
    lsLast = s;
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, lastProj: S.lastProj || null, project: S.project }));
  } catch (e) { /* 隐私模式/配额满: 忽略, 不影响编辑 */ }
}
function saveSoon() {   // 合并写: 首个改动后 800ms 落一次盘
  if (lsTimer) return;
  lsTimer = setTimeout(() => { lsTimer = null; persistSession(); }, 800);
}
function loadSession() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    return (j && j.project && Array.isArray(j.project.tracks) && Array.isArray(j.project.clips)) ? j : null;
  } catch (e) { return null; }
}

function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j; });
}
function status(msg, isErr) {
  const s = $('status'); s.textContent = msg; s.classList.toggle('err', !!isErr);
}
function fixProject(p) {
  p.tracks = p.tracks || []; p.clips = p.clips || []; p.midiClips = p.midiClips || []; p.whips = p.whips || [];
  const num = (v, def, lo, hi) => {
    v = parseFloat(v);
    return (typeof v === 'number' && isFinite(v)) ? clamp(v, lo, hi) : def;
  };
  for (const c of p.clips) {
    c.start = num(c.start, 0, 0, 1e6);
    c.length = num(c.length, 1, 0.01, 1e6);
    c.offset = num(c.offset, 0, 0, 1e6);
    c.stretch = num(c.stretch, 1, 0.1, 16);
    c.pitch = num(c.pitch, 0, -24, 24);
    c.vol = c.vol === undefined ? 1 : num(c.vol, 1, 0, 1.5);
    c.srcDur = num(c.srcDur, c.length, 0.01, 1e6);
    if (!c.src) c.src = '';
  }
  for (const m of p.midiClips) {
    m.start = num(m.start, 0, 0, 1e6);
    m.length = num(m.length, 1, 0.05, 1e6);
    m.trans = num(m.trans, 0, -24, 24);
    m.notes = Array.isArray(m.notes) ? m.notes : [];
    const nat = m.notes.length ? Math.max(0.05, ...m.notes.map(n2 => n2.end)) : 1;
    m.off = num(m.off, 0, 0, 1e6);                       // 裁剪入点 (自然音符时间)
    m.scale = num(m.scale, m.length / nat, 0.05, 64);    // 缩放系数 (迁移: 沿用当前伸缩)
  }
  if (!isFinite(p.bpm) || p.bpm <= 0) p.bpm = 120;
  return p;
}

// ================= 工程基础操作 =================
function pushUndo() {
  S.undoStack.push(JSON.stringify(S.project));
  if (S.undoStack.length > 200) S.undoStack.shift();
  S.redoStack.length = 0;
}
function undo() {
  if (!S.undoStack.length) return status('没有可撤销的操作', true);
  S.redoStack.push(JSON.stringify(S.project));
  S.project = fixProject(JSON.parse(S.undoStack.pop()));
  afterProjectSwap('已撤销');
}
function redo() {
  if (!S.redoStack.length) return status('没有可重做的操作', true);
  S.undoStack.push(JSON.stringify(S.project));
  S.project = fixProject(JSON.parse(S.redoStack.pop()));
  afterProjectSwap('已重做');
}
function afterProjectSwap(msg) {
  if (PR.open && !S.project.midiClips.includes(PR.open)) prClose();   // 换工程/撤销后旧块已不存在 → 关窗
  PS_CACHE.clear();                                                   // 即时变调缓存随工程走
  S.sel = null; S.multi = [];
  rebuildPanel(); drawBindings(); invalidate();
  for (const c of S.project.clips) ensureRender(c);   // whip 路由随工程状态重渲染
  if (S.playing) { stopSources(); scheduleAll(); }
  status(msg + '  (Ctrl+Z / Ctrl+Y)');
}
function addTrack(name) {
  pushUndo();
  S.project.tracks.push({ id: uid(), name: name || ('Track ' + (S.project.tracks.length + 1)), vol: 1, pan: 0, mute: false, solo: false });
  rebuildPanel(); drawBindings(); invalidate();
}
const trackById = id => S.project.tracks.find(t => t.id === id);
// 轨道色标 (面板左侧 4px 竖条, 给轨道一个稳定可扫读的身份色).
// 注意: 用低饱和的"标签色" —— 设计规范规定功能色(静音红/独奏黄/吸附绿/自由变调紫/滑音橙…)
// 有固定语义, 不得挪作装饰, 否则会和状态混淆。
const TRACK_HUES = ['#6d8cb0', '#619a90', '#8877a3', '#a2925f', '#6f936d', '#a2826f', '#7485a3', '#9a7889'];
function trackHue(t) {
  const s = String(t.id || t.name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TRACK_HUES[h % TRACK_HUES.length];
}
const clipById = id => S.project.clips.find(c => c.id === id);
const midiById = id => S.project.midiClips.find(c => c.id === id);
const anySolo = () => S.project.tracks.some(t => t.solo);
const trackGain = t => (anySolo() ? (t.solo ? 1 : 0) : (t.mute ? 0 : 1)) * t.vol;

function selectionItems() {
  const seen = new Set(), out = [];
  for (const it of [S.sel, ...S.multi]) {
    if (!it) continue;
    const k = it.kind + ':' + it.id;
    if (seen.has(k)) continue;
    const obj = it.kind === 'audio' ? clipById(it.id) : midiById(it.id);
    if (obj) { seen.add(k); out.push({ kind: it.kind, id: it.id, obj }); }
  }
  return out;
}
const selAudioClips = () => selectionItems().filter(it => it.kind === 'audio').map(it => it.obj);

function deleteSel() {
  const items = selectionItems();
  if (!items.length) return;
  pushUndo();
  const ids = new Set(items.map(it => it.id));
  S.project.clips = S.project.clips.filter(c => !ids.has(c.id));
  S.project.midiClips = S.project.midiClips.filter(c => !ids.has(c.id));
  S.sel = null; S.multi = [];
  if (PR.open && !S.project.midiClips.includes(PR.open)) prClose();   // 正在编辑的块被删了 → 关窗, 别在幽灵块上继续画
  invalidate(); status('已删除 ' + items.length + ' 个块');
}

function copySel(cut) {
  const items = selectionItems();
  if (!items.length) return;
  S.clipboard = items.map(it => ({ kind: it.kind, data: JSON.parse(JSON.stringify(it.obj)) }));
  if (cut) deleteSel();
  else status('已复制 ' + items.length + ' 块 — Ctrl+V 粘贴到播放头');
}
function paste() {
  if (!S.clipboard.length) return;
  pushUndo();
  const t0 = Math.min(...S.clipboard.map(x => x.data.start));
  const dt = snapT(S.playhead) - t0;
  const sel = [];
  for (const it of S.clipboard) {
    const d = JSON.parse(JSON.stringify(it.data));
    d.id = uid();
    d.start = Math.max(0, d.start + dt);
    d.render = null; d.renderKey = null;
    if (!trackById(d.trackId)) {
      if (!S.project.tracks.length) break;
      d.trackId = S.project.tracks[0].id;
    }
    if (it.kind === 'audio') { S.project.clips.push(d); ensureRender(d); }
    else S.project.midiClips.push(d);
    sel.push({ kind: it.kind, id: d.id });
  }
  S.sel = sel[sel.length - 1] || null; S.multi = sel;
  invalidate();
  if (S.playing) scheduleAll();
  status('已粘贴 ' + sel.length + ' 块到播放头');
}

function splitSel() {
  let targets = selectionItems()
    .map(it => ({ kind: it.kind, obj: it.obj }))
    .filter(it => S.playhead > it.obj.start + 0.02 && S.playhead < it.obj.start + it.obj.length - 0.02);
  if (!targets.length) {
    // Vegas 式兜底: 没有可切的选中块时, 切播放头下的所有块 (音频+MIDI)
    targets = [];
    for (const c of S.project.clips)
      if (S.playhead > c.start + 0.02 && S.playhead < c.start + c.length - 0.02) targets.push({ kind: 'audio', obj: c });
    for (const mc of S.project.midiClips)
      if (S.playhead > mc.start + 0.02 && S.playhead < mc.start + mc.length - 0.02) targets.push({ kind: 'midi', obj: mc });
    if (!targets.length) return status('把播放头点进块内再按 S (点击块即定位)', true);
  }
  pushUndo();
  let n = 0;
  for (const tg of targets) {
    const o = tg.obj;
    const leftLen = S.playhead - o.start;
    if (tg.kind === 'audio') {
      const right = JSON.parse(JSON.stringify(o));
      right.id = uid();
      right.start = S.playhead;
      right.offset = o.offset + leftLen / o.stretch;
      right.length = o.length - leftLen;
      right.render = null; right.renderKey = null;
      o.length = leftLen; o.render = null; o.renderKey = null;
      S.project.clips.push(right);
      ensureRender(o); ensureRender(right);
    } else {
      // MIDI 切分: off 前进到切点, 跨界音符由 off/长度窗口自动左右两半
      const right = JSON.parse(JSON.stringify(o));
      right.id = uid();
      right.start = S.playhead;
      right.off = (o.off || 0) + leftLen / (o.scale || 1);
      right.length = o.length - leftLen;
      o.length = leftLen;
      S.project.midiClips.push(right);
    }
    n++;
  }
  invalidate();
  if (S.playing) scheduleAll();
  status('已切开 ' + n + ' 块');
}

function pitchSelection(d) {
  const items = selectionItems();
  if (!items.length) return status('先选中素材块 (点击选中, Ctrl+点击 / 右键 / 框选多选)', true);
  pushUndo();
  let na = 0, degraded = 0; const midiTracks = new Set();
  for (const it of items) {
    if (it.kind === 'audio') {
      const c = it.obj, tr = trackById(c.trackId), free = !!(tr && tr.noTune);
      const win = c.length / c.stretch;
      // 自由变调轨 = 普通升降调: 只改音高、保时长、不变速; 浏览器内即时算, 不进渲染队列
      if (free && Math.abs(c.stretch - 1) < 1e-4) {
        c.pitch = clamp((c.pitch || 0) + d, -24, 24);
        if (c.render) { c.render = null; c.renderKey = null; }
        c._pend = false; c._tk = false;
        psDrop(c); psWarm(c);
        na++;
        continue;
      }
      // varispeed (REAPER rate change: 音高与时长一起变) 只用于两种情况:
      //   ① 块级"瞬时自由变调" (右键块 → 不接管 MIDI pitch) 且不在自由变调轨上
      //   ② 窗口长到算法渲染也做不了时的兜底 (自由变调轨除外 —— 该轨禁止变速)
      if (!free && (c.bypassWhip || win > WIN_LIMIT_PITCH)) {
        c.stretch = clamp(c.stretch / Math.pow(2, d / 12), 0.1, 16);
        c.length = win * c.stretch;
        if (win > WIN_LIMIT_PITCH) degraded++;
        ensureRender(c); na++;
        continue;
      }
      c.pitch = clamp((c.pitch || 0) + d, -24, 24);   // 普通升降调: 保时长、不变速 (走算法渲染)
      ensureRender(c); na++;
    } else {
      it.obj.trans = (it.obj.trans || 0) + d;    // MIDI 块转调
      midiTracks.add(it.obj.trackId); na++;
    }
  }
  for (const tid of midiTracks) refreshTargetsOf(tid);   // 转调 → whip 目标轨自动重渲染
  invalidate();
  status('变调 ' + (d > 0 ? '+' : '') + d + ' 半音 × ' + na + ' 块'
    + (midiTracks.size ? ' (MIDI 转调, whip 已同步)' : '')
    + (degraded ? ' · ' + degraded + ' 块窗口超过 ' + WIN_LIMIT_PITCH + 's, 只能降级为变速变调' : ''));
}

function resetSel(field) {
  const items = selectionItems();
  if (!items.length) return status('先选中素材块', true);
  pushUndo();
  let n = 0; const midiTracks = new Set();
  for (const it of items) {
    if (it.kind === 'midi') {
      if (field === 'pitch') { it.obj.trans = 0; n++; }   // MIDI 块转调归零
      midiTracks.add(it.obj.trackId);
      continue;
    }
    if (field === 'pitch') { it.obj.pitch = 0; n++; }
    if (field === 'stretch') { it.obj.stretch = 1; n++; }
    ensureRender(it.obj);
  }
  for (const tid of midiTracks) refreshTargetsOf(tid);
  invalidate();
  status(n ? '已重置 ' + (field === 'pitch' ? '变调' : '拉伸') + ' × ' + n + ' 块'
    : '选中的块没有可重置的' + (field === 'pitch' ? '变调' : '拉伸'));
}

// 离线渲染: whip 路由感知 — 目标轨上的块持续按 MIDI pitch 接管 (路由属性, 非一次性)
function whipNotesFor(c) {
  // 轨道路由: 该 MIDI 轨在【时间轴绝对时刻】上定义一条全局音高曲线, 素材块的窗口取这条曲线的一段.
  // 关键: 不对音符时间做 [0,win] 钳制. 钳制会把"块头之前就已开始 / 已经滑到一半"的事件拽到 0,
  // 滑音键被拽到块头 → 变成"从块头重新滑一遍"(滑音横跨开头几键), 钢琴窗 chip 却按真实时间算 → 对不上.
  // 后端 _cmd_pitch 只依赖 t ≤ tt 的事件, 负起点能被正确求值 (滑到一半的值 / 已保持的目标音高).
  const tr = trackById(c.trackId);
  if (c.bypassWhip || (tr && tr.noTune)) return null;   // 块级绕过 / 自由变调轨: 永不被 MIDI 接管
  const w = S.project.whips.find(w => w.targetTrackId === c.trackId);
  if (!w) return null;
  const mids = S.project.midiClips.filter(m => m.trackId === w.midiTrackId);
  if (!mids.length) return null;
  const win = c.length / c.stretch;
  const notes = [];
  let overlap = false;
  for (const m of mids) {
    const tp = m.trans || 0, off = m.off || 0, sc = m.scale || 1;
    // 该 MIDI 块在时间轴上的发声区间 → 换算到本块窗口
    const ba = (m.start - c.start) / c.stretch;
    const bb = (m.start + m.length - c.start) / c.stretch;
    if (bb <= 0 || ba >= win) continue;        // 整块都在窗口之外 → 与本块无关 (块与块是离散的)
    overlap = true;
    // 块边界 = 接管边界: 出块即交还素材原音高 (end 后端理解成 kind 2 "释放"),
    // 这样上一块的尾巴不会一路吊到下一块的头 —— 这是"每个 MIDI 块都从自己头开始"的关键
    if (ba > 0 && ba < win) notes.push({ start: ba, end: ba, midi: 0, none: true });
    if (bb < win) notes.push({ start: bb, end: bb, midi: 0, none: true });
    for (const n of m.notes) {
      const a = (m.start + (n.start - off) * sc - c.start) / c.stretch;   // 窗口内秒 (可为负)
      let b = (m.start + (n.end - off) * sc - c.start) / c.stretch;
      if (a >= win) continue;      // 窗口结束之后才开始的事件 → 与本块无关 (其之前的事件仍需作为保持值)
      if (b > bb) b = bb;          // 音符不越出所属块 (块外音符不发声)
      if (b <= a || b <= 0) continue;
      notes.push({ start: a, end: b, midi: n.midi + tp, slide: !!n.slide });
    }
  }
  if (!overlap) return null;       // 整条 MIDI 曲线都在窗口之外 → 不接管, 沿用素材原音高
  notes.sort((a, b) => (a.start - b.start) || ((a.slide ? 1 : 0) - (b.slide ? 1 : 0)));   // 同刻先普通后滑音
  return notes.length ? notes : null;
}

function ensureRender(c) {
  const win = c.length / c.stretch;
  const tn = whipNotesFor(c);
  const tr0 = trackById(c.trackId);
  const free = !!(tr0 && tr0.noTune);
  // 自由变调轨 + 纯变调(没拉伸, 且窗口不大) → 浏览器内即时算 (相位声码器), 压根不进渲染队列
  if (free && Math.abs(c.stretch - 1) < 1e-4 && !tn && c.length <= PS_INLINE_MAX) {
    if (c.render) { c.render = null; c.renderKey = null; }
    c._pend = false; c._tk = false;
    return;
  }
  // 上限只看窗口: 接管/变速走 PSOLA 很慢 → 45s; 纯变调走 rubberband ~24x 实时 → 240s.
  // 自由变调轨一律给 240s: 宁可慢也不能偷偷变速 (该轨的定义就是只变调不变速).
  const lim = (free || !(tn || Math.abs(c.stretch - 1) > 1e-4)) ? WIN_LIMIT_PITCH : WIN_LIMIT_PSOLA;
  if (win > lim) {   // 防渲染池卡死
    c.render = null; c.renderKey = 'toolong'; c._pend = false; c._tk = false;
    if (!c._warnedLong) { c._warnedLong = true; status('素材窗口 ' + Math.round(win) + 's 超过算法渲染上限 (' + lim + 's), 已跳过 — 变调会用瞬时变速兜底, 或先切片', true); }
    return;
  }
  if (tn) {
    // MIDI pitch 接管: 输出 F0(t) = 音符(t); 块几何完全不动, 每次相关变动自动重渲染
    const key = ['tk', S.renderVer || '?', JSON.stringify(tn), c.src, c.offset.toFixed(4), win.toFixed(4)].join('|');
    if (c.renderKey === key && c.render) return;
    c.renderKey = key; c.render = null; c._pend = true; c._tk = true;
    post('/api/render-clip', { path: c.src, offset: c.offset, win, stretch: c.stretch, takeover: tn })
      .then(j => {
        if (c.renderKey === key) {
          c.render = j.path; c._pend = false;
          preloadBuffer(j.path).then(() => { invalidate(); if (S.playing) scheduleAll(); });
        }
      })
      .catch(e => { c._pend = false; status('接管渲染失败: ' + e.message, true); });
    return;
  }
  c._tk = false;
  if (Math.abs(c.pitch) < 1e-6 && Math.abs(c.stretch - 1) < 1e-4) { c.render = null; c.renderKey = null; return; }
  const key = [S.renderVer || '?', S.rbFlag || '?', c.src, c.offset.toFixed(4), win.toFixed(4), c.pitch, c.stretch.toFixed(4)].join('|');
  if (c.renderKey === key) return;
  c.renderKey = key; c.render = null; c._pend = true;
  post('/api/render-clip', { path: c.src, offset: c.offset, win, pitch: c.pitch, stretch: c.stretch })
    .then(j => {
      if (c.renderKey === key) {
        c.render = j.path; c._pend = false;
        preloadBuffer(j.path).then(() => { invalidate(); if (S.playing) scheduleAll(); });
      }
    })
    .catch(e => { c._pend = false; status('渲染失败: ' + e.message, true); });
}

function refreshTargetsOf(midiTrackId) {
  for (const w of S.project.whips.filter(w => w.midiTrackId === midiTrackId))
    for (const c of S.project.clips.filter(c => c.trackId === w.targetTrackId))
      ensureRender(c);
  invalidate();
}

function refreshClipsOf(trackId) {   // 轨级属性变更 (自由变调轨) → 该轨所有块重算渲染
  for (const c of S.project.clips.filter(c => c.trackId === trackId)) ensureRender(c);
  invalidate();
}

// ================= 导入 (ffmpeg 通吃: mp3/m4s/mp4/webm/… + 拖放上传) =================
function addClipFromImport(j, dispName) {
  let tr = (S.sel && S.sel.kind === 'audio' && clipById(S.sel.id)) ? trackById(clipById(S.sel.id).trackId) : S.project.tracks[0];
  if (!tr) { S.project.tracks.push(tr = { id: uid(), name: 'Track 1', vol: 1, pan: 0, mute: false, solo: false }); rebuildPanel(); }
  pushUndo();
  const c = {
    id: uid(), trackId: tr.id, src: j.path, render: null,
    name: dispName || baseName(j.path).replace(/\.wav$/i, ''),
    start: snapT(S.playhead), offset: 0, length: j.duration, stretch: 1, pitch: 0, srcDur: j.duration,
  };
  S.project.clips.push(c);
  S.srcInfo.set(j.path, { sr: j.sr, duration: j.duration });
  ensureRender(c);                                   // whip 路由自动接管新素材
  select({ kind: 'audio', id: c.id });
  status('已导入 "' + c.name + '" → ' + tr.name + ' @ ' + c.start.toFixed(2) + 's (' + j.duration.toFixed(2) + 's)');
}

async function importMediaPath(p) {
  try {
    status('ffmpeg 转换中… ' + baseName(p));
    const j = await post('/api/import-media', { path: p });
    addClipFromImport(j, baseName(p).replace(/\.[^.]+$/, ''));
  } catch (e) { status(e.message, true); }
}
async function uploadAndImport(file) {
  try {
    status('上传/转换中… ' + file.name);
    const j = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
      .then(r => r.json());
    if (j.error) throw new Error(j.error);
    addClipFromImport(j, file.name.replace(/\.[^.]+$/, ''));
  } catch (e) { status(e.message, true); }
}

// 拖放导入
const dtHasFiles = e => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.from(t).indexOf('Files') >= 0; };
window.addEventListener('dragover', e => {
  e.preventDefault();
  if (dtHasFiles(e)) $('dropHint').classList.add('show');   // 只有真的拖文件才提示, 文字拖拽不打扰
});
window.addEventListener('dragleave', e => {
  if (!e.relatedTarget) $('dropHint').classList.remove('show');
});
window.addEventListener('drop', async e => {
  e.preventDefault();
  $('dropHint').classList.remove('show');
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  for (const f of files) await uploadAndImport(f);
});
// 页面内元素的原生 HTML5 拖拽 (选中文字后拖动 / 拖输入框) = 会顶掉画布拖块 → 全局掐掉, 输入框内保留
document.addEventListener('dragstart', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  e.preventDefault();
});

// ---- whip: MIDI 轨道 → 目标轨道 的 pitch 管线 ----
function createWhip(midiTrackId, targetTrackId) {
  if (midiTrackId === targetTrackId) { status('whip 不能连到自己', true); return Promise.resolve(false); }
  const tt0 = trackById(targetTrackId);
  if (tt0 && tt0.noTune) {
    status('「' + tt0.name + '」是自由变调轨 (不矫正音高), 不接受 MIDI 接管 — 如需接管请先关掉该轨的 ±', true);
    return Promise.resolve(false);
  }
  pushUndo();
  S.project.whips = S.project.whips.filter(w => w.midiTrackId !== midiTrackId);
  S.project.whips.push({ id: uid(), midiTrackId, targetTrackId });
  const tt = trackById(targetTrackId);
  if (tt && !tt.followBpm) tt.followBpm = true;   // 接管轨自动跟随BPM
  rebuildPanel(); drawBindings();
  refreshTargetsOf(midiTrackId);
  return Promise.resolve(true);
}

function removeWhipsOf(midiTrackId) {
  const ws = S.project.whips.filter(w => w.midiTrackId === midiTrackId);
  if (!ws.length) return false;
  pushUndo();
  const targets = new Set(ws.map(w => w.targetTrackId));   // 失效传播: 受影响轨在变更【前】捕获
  S.project.whips = S.project.whips.filter(w => w.midiTrackId !== midiTrackId);
  rebuildPanel(); drawBindings();
  for (const tid of targets)
    for (const c of S.project.clips.filter(c => c.trackId === tid))
      ensureRender(c);                                     // 断开 → 目标轨块重渲染回原 pitch
  invalidate();
  if (S.playing) scheduleAll();
  status('已断开 whip (目标轨恢复原 pitch)');
  return true;
}
function applyWhip(midiTrackId) {
  const ws = S.project.whips.filter(w => w.midiTrackId === midiTrackId);
  if (!ws.length) return status('该 MIDI 轨道还没有 whip 连接 (拖 🌀 到目标轨道)', true);
  let n = 0;
  for (const w of ws)
    for (const c of S.project.clips.filter(c => c.trackId === w.targetTrackId)) {
      ensureRender(c); n++;
    }
  invalidate();
  status('🌀 whip 路由生效: ' + n + ' 块持续按 MIDI pitch 接管 (移动素材/编辑MIDI 自动重渲染)');
}
async function applyAllWhips() {
  for (const w of [...S.project.whips]) await applyWhip(w.midiTrackId);
  if (!S.project.whips.length) status('没有 whip 连接', true);
}

function whipAnchor(trackId) {
  const mainRect = $('main').getBoundingClientRect();
  const btn = document.querySelector('.trk[data-trackid="' + trackId + '"] .whip');
  if (btn) {
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2 - mainRect.left, y: r.top + r.height / 2 - mainRect.top };
  }
  const row = document.querySelector('.trk[data-trackid="' + trackId + '"]');
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left - mainRect.left + 14, y: r.top - mainRect.top + r.height / 2 };
}

function drawBindings() {
  const svg = $('whipSvg');
  svg.innerHTML = '';
  const ex = whipEdgeX();     // 左侧面板右边缘: 两端都锚在这里, 线只在画布里鼓出去
  let wk = 0;
  for (const w of S.project.whips) {
    const ys = whipRowY(w.midiTrackId), yd = whipRowY(w.targetTrackId);
    if (ys === null || yd === null) continue;
    const bulge = 44 + (wk++) * 16;      // 同一行出发的多条线扇开, 不重叠
    const my = (ys + yd) / 2;
    const a = { x: ex, y: ys }, b = { x: ex, y: yd };
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + bulge} ${my}, ${b.x + bulge} ${my}, ${b.x} ${b.y}`);
    p.setAttribute('stroke-width', '2.5');
    svg.appendChild(p);
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('cx', a.x); ring.setAttribute('cy', a.y); ring.setAttribute('r', 4);
    ring.setAttribute('fill', 'none'); ring.setAttribute('stroke-width', '2');
    svg.appendChild(ring);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', b.x); dot.setAttribute('cy', b.y); dot.setAttribute('r', 5);
    dot.setAttribute('fill', '#2dd4bf');
    svg.appendChild(dot);
    const stub = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    stub.setAttribute('x1', b.x); stub.setAttribute('y1', b.y);
    stub.setAttribute('x2', b.x + 20); stub.setAttribute('y2', b.y);
    stub.setAttribute('stroke-width', '2.5');
    svg.appendChild(stub);
  }
  if (S.whip) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'draft');
    line.setAttribute('x1', S.whip.ax); line.setAttribute('y1', S.whip.ay);
    line.setAttribute('x2', S.whip.cx); line.setAttribute('y2', S.whip.cy);
    svg.appendChild(line);
  }
}

function whipStart(e, midiTrackId) {
  e.preventDefault(); e.stopPropagation();
  const mainRect = $('main').getBoundingClientRect();
  const a = whipAnchor(midiTrackId);
  if (!a) return;
  S.whip = { midiTrackId, ax: a.x, ay: a.y, cx: a.x, cy: a.y, x0: e.clientX, y0: e.clientY };
  const move = ev => {
    if (!S.whip) return;
    S.whip.cx = ev.clientX - mainRect.left; S.whip.cy = ev.clientY - mainRect.top;
    document.querySelectorAll('.trk.drop').forEach(el => el.classList.remove('drop'));
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const trk = el && el.closest('.trk');
    const tt = trk && trk.dataset.trackid ? trackById(trk.dataset.trackid) : null;
    if (tt && tt.id !== midiTrackId && !tt.noTune) trk.classList.add('drop');   // 自由变调轨不接受接管
    drawBindings();
  };
  const up = ev => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const moved = Math.hypot(ev.clientX - S.whip.x0, ev.clientY - S.whip.y0) > 5;
    const from = S.whip.midiTrackId;
    S.whip = null;
    document.querySelectorAll('.trk.drop').forEach(el2 => el2.classList.remove('drop'));
    if (!moved) {   // 单击 🌀 = 仅提示 (断开走右键, 防误触丢路由)
      status('按住 🌀 拖到目标轨道建立连接 · 右键 🌀 断开');
      return;
    }
    // 落点解析: 左面板的轨道行, 或时间线上按 Y 找轨道行
    let targetId = null, droppedSomewhere = false;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const trk = el && el.closest('.trk');
    if (trk && trk.dataset.trackid) {
      droppedSomewhere = true;
      if (trk.dataset.trackid !== from) targetId = trk.dataset.trackid;
    } else if (el === cv || (el && cv.contains(el))) {
      droppedSomewhere = true;
      const r2 = cv.getBoundingClientRect();
      const ti = Math.floor((ev.clientY - r2.top - RULER_H + S.scrollY) / ROW_H);
      if (ti >= 0 && ti < S.project.tracks.length && S.project.tracks[ti].id !== from)
        targetId = S.project.tracks[ti].id;
    }
    if (targetId) {
      const targetName = trackById(targetId).name;
      createWhip(from, targetId).then(ok => {   // 失败(自连/自由变调轨)时 createWhip 已给提示, 这里不覆盖
        if (ok) status('🌀 whip: ' + (trackById(from) || {}).name + ' → ' + targetName +
          ' · 已按素材块位置矫正 pitch (改动后自动重渲染)');
      });
    } else if (droppedSomewhere) {
      status('whip 不能连到 MIDI 轨自己', true);
    } else {
      status('未连接 — 请在目标轨道上行内松手 (左侧面板或时间线对应行)', true);
    }
    drawBindings();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  drawBindings();
}

// ================= 同轨自动交叉淡化 (Vegas / REAPER 的 auto-crossfade) =================
// 规则: 同一轨道同一时刻只有"一路声音" —— 前后两个片段重叠时不是两遍叠着一起放,
// 而是重叠区里前块线性淡出、后块线性淡入 (线性 = 相加恒为 1: 同一素材叠着放不会鼓包,
// 且播放与导出用同一条曲线, 不会有差别). 这里的长度就是"从块头/块尾量起的淡变量".
function autoXfade(c) {
  const cs = c.start, ce = c.start + c.length;
  let fi = 0, fo = 0;
  for (const o of S.project.clips) {
    if (o === c || o.trackId !== c.trackId) continue;
    const os = o.start, oe = o.start + o.length;
    if (oe <= cs + 1e-6 || os >= ce - 1e-6) continue;      // 不重叠
    if (os < cs - 1e-6) fi = Math.max(fi, Math.min(oe, ce) - cs);          // 前块伸进我这块
    else if (os > cs + 1e-6) fo = Math.max(fo, Math.min(oe, ce) - os);     // 后块从我这块里开始
    else if (ce <= oe) fo = Math.max(fo, ce - cs);         // 同起点: 短的淡出
    else fi = Math.max(fi, oe - os);                       // 同起点: 长的淡入
  }
  return { in: Math.min(fi, c.length), out: Math.min(fo, c.length) };
}
// 实际生效的淡变量 = 用户设的与自动交叉淡化取更长者
function clipFades(c) {
  const xf = autoXfade(c);
  return { in: Math.max(c.fadeIn || 0, xf.in), out: Math.max(c.fadeOut || 0, xf.out) };
}

// whip 连线锚点: 都贴在【左侧面板区域的右边缘】(= 时间线画布左边界)。
// 以前锚在面板内部 / 目标行左内侧 +10px, 线会横穿左侧面板, 压住音量/声像滑块。
function whipEdgeX() {
  const mainRect = $('main').getBoundingClientRect();
  const tlRect = $('tl').getBoundingClientRect();
  return tlRect.left - mainRect.left + 2;
}
function whipRowY(trackId) {
  const row = document.querySelector('.trk[data-trackid="' + trackId + '"]');
  if (!row) return null;
  const mainRect = $('main').getBoundingClientRect();
  const r = row.getBoundingClientRect();
  return r.top - mainRect.top + r.height / 2;
}

// ================= 导出 / 工程 =================
async function exportMix() {
  const useRegion = S.loop.on && S.loop.b > S.loop.a;
  const ra = useRegion ? S.loop.a : 0;
  const rb = useRegion ? S.loop.b : Math.max(1, ...S.project.clips.map(c => c.start + c.length));
  const items = [];
  for (const c of S.project.clips) {
    const t = trackById(c.trackId); if (!t) continue;
    const g = trackGain(t) * (c.vol ?? 1); if (g <= 0) continue;
    const cs = Math.max(c.start, ra), ce = Math.min(c.start + c.length, rb);
    if (ce <= cs) continue;
    const skip = cs - c.start;
    const theta = (t.pan + 1) * Math.PI / 4;
    // rate = 每秒时间轴消耗的源秒数; pitch = 自由变调轨的即时普通变调量
    const cinfo = clipBufferInfo(c) || {};
    const rate = c.render ? 1 : (cinfo.rate || 1);
    items.push({
      path: c.render || c.src, start: cs - ra,
      offset: (c.render ? 0 : c.offset) + skip * rate,   // 源秒
      length: (ce - cs) * rate,                          // 消耗的源秒
      rate,
      pitch: cinfo.ps ? cinfo.ps.semitones : 0,          // 普通变调: 后端同算法, 保时长
      gainL: g * Math.cos(theta), gainR: g * Math.sin(theta),
      fadeIn: Math.max(0, clipFades(c).in - Math.max(0, ra - c.start)),      // 含同轨自动交叉淡化
      fadeOut: Math.max(0, clipFades(c).out - Math.max(0, c.start + c.length - rb)),
    });
  }
  if (!items.length) return status('选区/工程里没有可导出的音频块', true);
  try {
    let sr = 44100;
    for (const c of S.project.clips) {
      if (!S.srcInfo.has(c.src)) S.srcInfo.set(c.src, await post('/api/load-audio', { path: c.src }));
      sr = S.srcInfo.get(c.src).sr; break;
    }
    const resp = await fetch('/api/mixdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, sr, duration: rb - ra }) });
    if (!resp.ok) { const j = await resp.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + resp.status)); }
    downloadBlob(await resp.blob(), 'mixdown' + (useRegion ? '_' + ra.toFixed(2) + '-' + rb.toFixed(2) + 's' : '') + '.wav');
    status('混音已导出 (浏览器下载对话框)' + (useRegion ? ' — 选区 ' + ra.toFixed(2) + '–' + rb.toFixed(2) + 's' : ' — 整曲'));
  } catch (e) { status(e.message, true); }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

function saveProjectDL() {
  const base = (S.lastProj || 'project.json').split('/').pop();
  downloadBlob(new Blob([JSON.stringify(S.project, null, 1)], { type: 'application/json' }),
    base.endsWith('.json') ? base : base + '.json');
  status('工程已下载 (浏览器保存对话框)');
}

async function saveProject(dest) {
  dest = dest || S.lastProj || 'projects/project.json';
  const j = await post('/api/save-project', { dest, project: S.project });
  S.lastProj = j.dest;
  $('projname').textContent = baseName(j.dest);
  status('工程已保存: ' + j.dest);
}
async function openProject(p) {
  p = p || S.lastProj;
  if (!p) return status('请给工程路径', true);
  try {
    const j = fixProject(await post('/api/open-project', { path: p }));
    pushUndo();
    S.project = j; S.lastProj = p;
    $('projname').textContent = baseName(p);
    afterProjectSwap('工程已打开');
  } catch (e) { status(e.message, true); }
}
function newProject() {
  pushUndo();
  S.project = fixProject({
    bpm: S.project.bpm || 120, clips: [], midiClips: [], whips: [],
    tracks: [{ id: uid(), name: 'Track 1', vol: 1, pan: 0, mute: false, solo: false }],
  });
  S.lastProj = null;
  $('projname').textContent = '';
  afterProjectSwap('已新建空工程');
}
async function loadDemo() {
  try {
    const j = fixProject(await fetch('/api/demo-project').then(r => r.json()));
    pushUndo();
    S.project = j;
    $('projname').textContent = '演示工程';
    afterProjectSwap('演示工程已加载');
  } catch (e) { status(e.message, true); }
}

// ================= 坐标 / 命中 =================
const t2x = t => t * S.pps - S.scrollX;
const x2t = x => (x + S.scrollX) / S.pps;
const trackY = i => RULER_H + i * ROW_H - S.scrollY;
function y2track(y) {
  const i = Math.floor((y - RULER_H + S.scrollY) / ROW_H);
  return (i >= 0 && i < S.project.tracks.length) ? i : -1;
}
function snapT(t) {
  if (!S.snap) return Math.max(0, t);
  const g = gridSec();
  return Math.max(0, Math.round(t / g) * g);
}
function totalLen() {
  const ends = [8];
  for (const c of S.project.clips) ends.push(c.start + c.length);
  for (const m of S.project.midiClips) ends.push(m.start + m.length);
  return Math.max(...ends) * 1.05 + 3;
}
const totalPx = () => totalLen() * S.pps;
function hitTest(x, y) {
  if (y < RULER_H) return { kind: 'ruler' };
  const ti = y2track(y);
  if (ti < 0) return { kind: 'empty' };
  const tr = S.project.tracks[ti];
  const t = x2t(x);
  for (const c of [...S.project.clips].reverse()) {   // 后入数组 = 顶层 (与绘制层级一致), 重叠时命中上层块
    if (c.trackId !== tr.id) continue;
    const x0 = t2x(c.start), x1 = t2x(c.start + c.length);
    if (x >= x0 - 1 && x <= x1 + 1) {
      const yTop = RULER_H + ti * ROW_H - S.scrollY + 4;
      const relY = y - yTop;
      if (x1 - x0 > 40 && relY >= 0 && relY < 10) {
        if (x - x0 < 14) return { kind: 'clip', clip: c, zone: 'fadein' };
        if (x1 - x < 14) return { kind: 'clip', clip: c, zone: 'fadeout' };
        return { kind: 'clip', clip: c, zone: 'vol' };
      }
      if (x - x0 < EDGE && x1 - x0 > 14) return { kind: 'clip', clip: c, zone: 'l' };
      if (x1 - x < EDGE && x1 - x0 > 14) return { kind: 'clip', clip: c, zone: 'r' };
      return { kind: 'clip', clip: c, zone: 'body' };
    }
  }
  for (const m of [...S.project.midiClips].reverse()) {
    if (m.trackId !== tr.id) continue;
    const x0 = t2x(m.start), x1 = t2x(m.start + m.length);
    if (x >= x0 - 1 && x <= x1 + 1) {
      if (x - x0 < EDGE && x1 - x0 > 14) return { kind: 'midi', clip: m, zone: 'l' };
      if (x1 - x < EDGE && x1 - x0 > 14) return { kind: 'midi', clip: m, zone: 'r' };
      return { kind: 'midi', clip: m, zone: 'body' };
    }
  }
  return { kind: 'empty' };
}
const isSel = (kind, id) =>
  (S.sel && S.sel.kind === kind && S.sel.id === id) ||
  S.multi.some(it => it.kind === kind && it.id === id);

// ================= 交互 =================
cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 2) return;
  hideMenu();
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const h = hitTest(x, y);
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  // 右键拖拽框选 (任意非标尺位置起始; 无拖动=右键菜单)
  if (e.button === 2 && h.kind !== 'ruler') {
    S.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y, moved: false };
    return;
  }
  if (y > cv.clientHeight - 12 && x2t(x) < totalLen()) {
    // 底部横向滚动条
    S.drag = { mode: 'hscroll', grabDX: x - (S.scrollX / Math.max(1, totalPx())) * cv.clientWidth };
    return;
  }
  if (h.kind === 'ruler') {
    if (e.shiftKey) {
      S.drag = { mode: 'loop' };
      S.loop = { a: x2t(x), b: x2t(x), on: true }; $('loopOn').checked = true;
    } else { S.drag = { mode: 'scrub' }; seek(Math.max(0, x2t(x))); }
    invalidate(); return;
  }
  // Ctrl+拖空白处 = 凭空新建 MIDI 块
  if (e.ctrlKey && h.kind === 'empty' && !e.altKey) {
    const ti0 = y2track(y);
    if (ti0 >= 0) { S.drag = { mode: 'createmidi', ti: ti0, s0: Math.max(0, x2t(x)), cur: null }; status('松手创建 MIDI 块 (双击进钢琴窗画音符)'); invalidate(); return; }
  }
  if (h.kind === 'empty') {
    S.drag = { mode: 'scrub' }; seek(Math.max(0, x2t(x)));
    select(null); invalidate(); return;
  }
  const kind = h.kind === 'midi' ? 'midi' : 'audio';
  if (e.ctrlKey || e.metaKey) {
    const already = isSel(kind, h.clip.id);
    if (already) {
      S.multi = S.multi.filter(it => !(it.kind === kind && it.id === h.clip.id));
      if (S.sel && S.sel.kind === kind && S.sel.id === h.clip.id) S.sel = S.multi[S.multi.length - 1] || null;
    } else {
      S.multi.push({ kind, id: h.clip.id });
      S.sel = { kind, id: h.clip.id };
    }
    status('多选 ' + selectionItems().length + ' 个块');
    invalidate(); return;
  }
  if (!isSel(kind, h.clip.id)) select({ kind, id: h.clip.id });
  const t = x2t(x);
  if (h.zone === 'body') seek(Math.max(0, t));   // Vegas 行为: 点块=选中+光标到位
  pushUndo();
  if (h.kind === 'midi') {
    const mgrp = selectionItems().filter(it => it.kind === 'midi').map(it => ({
      c: it.obj, s0: it.obj.start, i0: S.project.tracks.findIndex(tr => tr.id === it.obj.trackId),
    }));
    if (h.zone === 'l') S.drag = { mode: 'midiTrimL', m: h.clip, grabDt: t - h.clip.start };
    else if (h.zone === 'r') S.drag = { mode: e.altKey ? 'midiStretch' : 'midiTrimR', m: h.clip, grabDt: t - h.clip.start };
    else S.drag = { mode: 'midiMove', m: h.clip, grabT: t, ti0: y2track(y), group: mgrp };
    invalidate(); return;
  }
  const c = h.clip;
  const group = () => selectionItems().filter(it => it.kind === 'audio').map(it => ({
    c: it.obj, s0: it.obj.start, i0: S.project.tracks.findIndex(tr => tr.id === it.obj.trackId),
  }));
  if (h.zone === 'vol') S.drag = { mode: 'vol', c };
  else if (h.zone === 'fadein') S.drag = { mode: 'fadein', c };
  else if (h.zone === 'fadeout') S.drag = { mode: 'fadeout', c };
  else if (h.zone === 'l') S.drag = { mode: 'trimL', c, grabDt: t - c.start };
  else if (h.zone === 'r') S.drag = { mode: e.altKey ? 'stretchR' : 'trimR', c, grabDt: t - c.start - c.length };
  else S.drag = {
    mode: e.altKey ? 'slide' : 'move', c,
    grabDt: t - c.start, grabT0: t, grabOffset: c.offset,
    grabT: t, ti0: y2track(y), group: group(),      // 多选整组移动
  };
  invalidate();
});

cv.addEventListener('pointermove', e => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (!S.drag) {
    const h = hitTest(x, y);
    cv.style.cursor = (h.kind === 'clip' || h.kind === 'midi')
      ? (h.zone === 'body' ? (e.altKey ? 'ew-resize' : 'grab')
        : h.zone === 'vol' ? 'ns-resize'
        : (h.zone === 'fadein' || h.zone === 'fadeout') ? 'crosshair'
        : 'ew-resize')
      : (h.kind === 'ruler' ? 'text' : 'default');
    return;
  }
  const t = x2t(x);
  const d = S.drag;
  const sn = tt => (S.snap && !e.shiftKey) ? snapT(tt) : Math.max(0, tt);
  if (d.mode === 'marquee') { d.x1 = x; d.y1 = y; }
  else if (d.mode === 'createmidi') {
    d.cur = { a: Math.min(d.s0, Math.max(0, sn(x2t(x)))), b: Math.max(gridSec(), Math.abs(x2t(x) - d.s0)) };
    invalidate();
  }
  else if (d.mode === 'scrub') { seek(Math.max(0, t)); }
  else if (d.mode === 'loop') { S.loop.b = Math.max(S.loop.a + gridSec(), t); S.loop.on = true; }
  else if (d.mode === 'hscroll') {
    const w = cv.clientWidth;
    S.scrollX = clamp((x - d.grabDX) / w * totalPx(), 0, Math.max(0, totalPx() - w));
  }
  else if (d.mode === 'move') {
    const dt2 = t - d.grabT;
    const ti = y2track(y);
    const dRow = ti >= 0 ? ti - d.ti0 : 0;
    for (const g of d.group) {                      // 多选整组一起移动/换轨
      g.c.start = Math.max(0, sn(g.s0 + dt2));
      const ni = g.i0 + dRow;
      if (ni >= 0 && ni < S.project.tracks.length) g.c.trackId = S.project.tracks[ni].id;
    }
    if (ti >= 0) d.c.trackId = S.project.tracks[ti].id;
    else {
      const n = S.project.tracks.length;
      if (!d.createdTrack && y >= trackY(n) - 10) {
        d.createdTrack = true;   // REAPER 式: 拖到最后一行之下自动加轨
        S.project.tracks.push({ id: uid(), name: 'Track ' + (n + 1), vol: 1, pan: 0, mute: false, solo: false });
        d.c.trackId = S.project.tracks[n].id;
        rebuildPanel(); drawBindings();
      }
    }
  }
  else if (d.mode === 'trimL') {
    const ns = clamp(sn(t - d.grabDt), 0, d.c.start + d.c.length - 0.05);
    const delta = ns - d.c.start;
    const no = d.c.offset + delta / d.c.stretch;
    if (no >= 0 && no <= d.c.srcDur) { d.c.start = ns; d.c.offset = no; d.c.length -= delta; }
  }
  else if (d.mode === 'trimR') {
    const maxL = (d.c.srcDur - d.c.offset) * d.c.stretch;
    d.c.length = clamp(sn(t) - d.c.start, 0.05, maxL);
  }
  else if (d.mode === 'stretchR') {
    const win = d.c.length / d.c.stretch;
    const st = clamp((t - d.c.start) / win, 0.25, 4);
    d.c.stretch = st; d.c.length = win * st;
  }
  else if (d.mode === 'slide') {
    // 滑动素材内容 (抓波形拖着走): 方向与鼠标一致 (往左拖 = 内容往左 = 露出后面那段);
    // 越过源尾/源头的部分按【循环源】回绕 —— 所以整块素材也能滑
    // (以前钳在 [0, srcDur-win]: 没裁剪过时 srcDur==win, 上下限都是 0, 拖了完全没反应)
    const sd = d.c.srcDur || 0;
    if (sd > 0.02) {
      let off = d.grabOffset - (t - d.grabT0) / d.c.stretch;
      off %= sd;
      if (off < 0) off += sd;
      d.c.offset = off;
    }
  }
  else if (d.mode === 'vol') {
    const ti = S.project.tracks.findIndex(tr => tr.id === d.c.trackId);
    const rowTop = trackY(ti) + 4;
    d.c.vol = clamp(1 - (y - rowTop - 10) / (ROW_H - 24), 0, 1);
    applyMixLive();          // 播放中拖块音量线即时可听 (淡入淡出包络不受影响)
  }
  else if (d.mode === 'fadein') {
    d.c.fadeIn = clamp(x2t(x) - d.c.start, 0, Math.min(d.c.length * 0.9, 4));
  }
  else if (d.mode === 'fadeout') {
    d.c.fadeOut = clamp(d.c.start + d.c.length - x2t(x), 0, Math.min(d.c.length * 0.9, 4));
  }
  else if (d.mode === 'midiMove') {
    const dt2 = t - d.grabT;
    const ti = y2track(y);
    const dRow = ti >= 0 ? ti - d.ti0 : 0;
    for (const g of d.group) {                      // 多选 MIDI 块整组移动
      g.c.start = Math.max(0, sn(g.s0 + dt2));
      const ni = g.i0 + dRow;
      if (ni >= 0 && ni < S.project.tracks.length) g.c.trackId = S.project.tracks[ni].id;
    }
  }
  else if (d.mode === 'midiTrimL') {
    // 裁剪头: 块头后移裁掉之前的音符; off>0 时也允许往回扩 (恢复被裁的头)
    const back = (d.m.off || 0) * (d.m.scale || 1);   // 可回扩的量
    const ns = clamp(sn(t - d.grabDt), d.m.start - back, d.m.start + d.m.length - gridSec() / 2);
    const delta = ns - d.m.start;
    d.m.start = ns;
    d.m.off = Math.max(0, (d.m.off || 0) + delta / (d.m.scale || 1));
    d.m.length -= delta;
  }
  else if (d.mode === 'midiTrimR') {
    // 裁剪尾: 只缩短块, 音符时值不缩放 (超出部分不发声不显示)
    d.m.length = Math.max(gridSec() / 2, sn(t) - d.m.start);
  }
  else if (d.mode === 'midiStretch') {
    // 缩放: 音符时值跟着伸缩 (以块头为锚)
    const f = (t - d.m.start) / Math.max(d.m.length, 1e-4);
    d.m.scale = clamp((d.m.scale || 1) * f, 0.05, 64);
    d.m.length = Math.max(gridSec() / 2, sn(t) - d.m.start);
  }
  invalidate();
});

cv.addEventListener('pointerup', e => {
  if (!S.drag) return;
  const d = S.drag; S.drag = null;
  if (d.mode === 'createmidi') {
    const t = S.project.tracks[d.ti];
    pushUndo();
    const len = Math.max(gridSec(), d.cur.b - d.cur.a);
    const mc = { id: uid(), trackId: t.id, name: 'MIDI', start: d.cur.a, length: len, off: 0, scale: 1, trans: 0,
      notes: [{ start: 0, end: Math.min(0.5, len), midi: 60 }] };
    S.project.midiClips.push(mc);
    rebuildPanel(); invalidate();
    select({ kind: 'midi', id: mc.id });
    status('已创建 MIDI 块 (' + len.toFixed(2) + 's) — 双击进钢琴窗画音符');
    return;
  }
  if (d.mode === 'marquee') {
    const moved = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 6;
    if (moved) {
      S.suppressCtx = true;
      const ta = x2t(Math.min(d.x0, d.x1)), tb = x2t(Math.max(d.x0, d.x1));
      const r0 = clamp(y2track(Math.min(d.y0, d.y1)), 0, S.project.tracks.length - 1);
      const r1 = clamp(y2track(Math.max(d.y0, d.y1)), 0, S.project.tracks.length - 1);
      const sel = [];
      const consider = (kind, c) => {
        const ti2 = S.project.tracks.findIndex(tr => tr.id === c.trackId);
        if (ti2 < r0 || ti2 > r1) return;
        if (c.start + c.length >= ta && c.start <= tb) sel.push({ kind, id: c.id });
      };
      for (const c of S.project.clips) consider('audio', c);
      for (const m of S.project.midiClips) consider('midi', m);
      S.multi = sel; S.sel = sel[sel.length - 1] || null;
      status('框选 ' + sel.length + ' 个块 — = / - 变调 · 拖动整组移动 · Delete 删除');
    }
    invalidate(); return;
  }
  if (d.c) ensureRender(d.c);                       // 移动/裁剪/拉伸/滑动都影响渲染 (whip 曲线随位置变)
  if (d.m) refreshTargetsOf(d.m.trackId);           // MIDI 块动了 → 目标轨自动重渲染
  if (d.c || d.m) { if (S.playing) scheduleAll(); }
  invalidate();
});

cv.addEventListener('dblclick', e => {
  const r2 = cv.getBoundingClientRect();
  const h = hitTest(e.clientX - r2.left, e.clientY - r2.top);
  if (h.kind === 'midi') prOpen(h.clip);
});
cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (S.suppressCtx) { S.suppressCtx = false; return; }
  const r = cv.getBoundingClientRect();
  const h = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (h.kind === 'clip' || h.kind === 'midi') {
    const kind = h.kind === 'midi' ? 'midi' : 'audio';
    if (!isSel(kind, h.clip.id)) {
      // 右键未选中的块 = 加进多选 (不清掉已选)
      S.multi.push({ kind, id: h.clip.id });
      S.sel = { kind, id: h.clip.id };
      status('多选 ' + selectionItems().length + ' 个块 — 菜单操作作用于全部');
      invalidate();
    }
    showMenu(e.clientX, e.clientY, kind);
  } else {
    hideMenu();
    if (h.kind === 'empty') select(null);
  }
});
document.addEventListener('pointerdown', e => {
  if (!$('ctxMenu').contains(e.target) && !e.target.closest('.mroot')) hideMenu();
}, true);

// ---- 右键菜单 ----
function hideMenu() { $('ctxMenu').style.display = 'none'; }
function showMenu(x, y, kind) {
  const menu = $('ctxMenu');
  const n = selectionItems().length;
  const items = [];
  if (kind === 'audio') {
    const cSel = S.sel && S.sel.kind === 'audio' ? clipById(S.sel.id) : null;
    items.push([(cSel && cSel.bypassWhip) ? '恢复 MIDI 接管' : '不接管 MIDI pitch (瞬时变速变调)', () => {
      const list = selectionItems().filter(it => it.kind === 'audio');
      for (const it of list) { it.obj.bypassWhip = !it.obj.bypassWhip; ensureRender(it.obj); }
      invalidate();
      status((list[0].obj.bypassWhip
        ? '已脱离接管: = / - 走瞬时变速变调 (音高与时长一起变; 要不变速请用轨道"自由变调轨")'
        : '已恢复 MIDI 接管') + ' × ' + list.length + ' 块');
    }]);
    items.push(['变调 +1 半音', () => pitchSelection(1)]);
    items.push(['变调 -1 半音', () => pitchSelection(-1)]);
    items.push(['重置变调', () => resetSel('pitch')]);
    items.push(['重置拉伸', () => resetSel('stretch')]);
    items.push(['在播放头切开 (S)', () => splitSel()]);
  } else {
    items.push(['应用 whip (重跑对齐)', () => {
      const m = midiById(S.sel.id);
      if (m) applyWhip(m.trackId);
    }]);
  }
  items.push(['sep']);
  items.push(['删除 (' + n + ' 块) [Del]', () => deleteSel()]);
  renderMenu(menu, x, y, items);
}

// 通用小菜单渲染 (块右键 / 轨道行右键共用)
function renderMenu(menu, x, y, items) {
  menu.innerHTML = '';
  for (const it of items) {
    if (it[0] === 'sep') {
      const d = document.createElement('div'); d.className = 'ctx-sep'; menu.appendChild(d);
      continue;
    }
    const d = document.createElement('div');
    d.className = 'ctx-item'; d.textContent = it[0];
    d.addEventListener('click', () => { hideMenu(); it[1](); });
    menu.appendChild(d);
  }
  menu.style.display = 'block';
  const wmax = Math.max(190, menu.offsetWidth + 10);
  menu.style.left = Math.min(x, Math.max(4, window.innerWidth - wmax)) + 'px';
  menu.style.top = Math.min(y, Math.max(4, window.innerHeight - menu.offsetHeight - 10)) + 'px';
}

// 轨道行右键菜单: 自由变调轨 / 跟随BPM / 断开 whip / 删除轨道
function showTrackMenu(x, y, t) {
  const ws = S.project.whips.filter(w => w.midiTrackId === t.id);
  const used = S.project.clips.some(c => c.trackId === t.id) || S.project.midiClips.some(m => m.trackId === t.id);
  const items = [
    [(t.noTune ? '✓ ' : '　 ') + '自由变调轨 — 素材不跟随 MIDI, = / - 为普通变调 (保时长·不变速)',
      () => setTrackFreeTune(t, !t.noTune)],
    [(t.followBpm ? '✓ ' : '　 ') + '跟随 BPM (♩ 节拍时基)', () => setFollowBpm(t, !t.followBpm)],
  ];
  if (ws.length) items.push(['断开本轨发出的 whip (' + ws.length + ')', () => removeWhipsOf(t.id)]);
  items.push(['sep']);
  items.push([used ? '删除轨道 (轨道上还有素材)' : '删除轨道', () => {
    if (used) return status('轨道上还有素材, 先删掉它们', true);
    pushUndo();
    S.project.tracks = S.project.tracks.filter(x => x.id !== t.id);
    S.project.whips = S.project.whips.filter(w => w.midiTrackId !== t.id && w.targetTrackId !== t.id);
    rebuildPanel(); drawBindings(); invalidate();
  }]);
  renderMenu($('ctxMenu'), x, y, items);
}

cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const tAnchor = x2t(x);
    S.pps = clamp(S.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 4, 2000);
    S.scrollX = Math.max(0, tAnchor * S.pps - x);
  } else if (e.shiftKey) {
    S.scrollY = clamp(S.scrollY + e.deltaY, 0, Math.max(0, S.project.tracks.length * ROW_H - (cv.clientHeight - RULER_H)));
  } else {
    S.scrollX = Math.max(0, S.scrollX + e.deltaY * 0.8);
  }
  invalidate();
}, { passive: false });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); return; }   // 别把整页文字选上 (之后一拖就变拖文本)
  if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (e.key === '=') pitchSelection(1);
  else if (e.key === '+') pitchSelection(12);
  else if (e.key === '-') pitchSelection(-1);
  else if (e.key === '_') pitchSelection(-12);
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (PR.open) {   // 钢琴窗内: Delete 只删音符, 绝不碰时间线上的块
      // (开窗时那个 MIDI 块正是选中状态, 以前没选音符时会走到 deleteSel 把整块删掉 —
      //  全屏卷帘挡着看不见, 一关窗才发现 "MIDI 消失了")
      if (!PR.sel.length) return status('钢琴窗: 先点选音符再删 (要删块请关窗后在时间线上删)', true);
      pushUndo();
      PR.open.notes = PR.open.notes.filter(n2 => !PR.sel.includes(n2));
      PR.sel = [];
      refreshTargetsOf(PR.open.trackId); prDraw();
      status('已删除选中音符');
      return;
    }
    deleteSel();
  }
  else if (e.key === 's' || e.key === 'S') splitSel();
  else if (e.key === 'b' || e.key === 'B') { S.loop.a = S.playhead; syncLoop(); }
  else if (e.key === 'n' || e.key === 'N') { S.loop.b = S.playhead; syncLoop(); }
  else if (e.key === 'Escape') { if (PR.open) { prClose(); return; } select(null); invalidate(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { if (selectionItems().length) { e.preventDefault(); copySel(false); } }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { if (selectionItems().length) { e.preventDefault(); copySel(true); } }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { if (S.clipboard.length) { e.preventDefault(); paste(); } }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProjectDL(); }
});

function syncLoop() {
  if (S.loop.b > S.loop.a) { S.loop.on = true; $('loopOn').checked = true; }
  invalidate();
  status('循环选区: ' + S.loop.a.toFixed(2) + ' – ' + S.loop.b.toFixed(2) + 's' +
    (S.loop.on ? ' (开)' : ' — 勾「循环」或 B/N 后自动开'));
}

function select(sel, additive) {
  if (additive && sel) {
    if (isSel(sel.kind, sel.id)) {
      S.multi = S.multi.filter(it => !(it.kind === sel.kind && it.id === sel.id));
      if (S.sel && S.sel.kind === sel.kind && S.sel.id === sel.id) S.sel = S.multi[S.multi.length - 1] || null;
    } else {
      S.multi.push(sel); S.sel = sel;
    }
  } else {
    S.sel = sel; S.multi = sel ? [sel] : [];
  }
  const items = selectionItems();
  const c = S.sel && S.sel.kind === 'audio' ? clipById(S.sel.id) : null;
  status(items.length > 1 ? ('已选 ' + items.length + ' 个块 — = / - 变调, 对齐到MIDI, Delete 删除 都作用于全部选中')
    : c ? ('选中 ' + c.name + (c.pitch ? ' [Pitch ' + (c.pitch > 0 ? '+' : '') + c.pitch + ']' : '')
      + (Math.abs(c.stretch - 1) > 1e-4 ? ' [Rate ' + c.stretch.toFixed(2) + ']' : '')
      + ' · = / - 变调, S 切开, Delete 删除') : '');
  invalidate();
}

// ================= WebAudio 走带 =================
function ensureAC() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = AC.createGain();
    masterGain.gain.value = parseFloat($('master').value);
    masterGain.connect(AC.destination);
  }
  if (AC.state === 'suspended') AC.resume();
}
function preloadBuffer(path) {
  if (S.buffers.has(path)) return Promise.resolve(S.buffers.get(path));
  if (!S.loading) S.loading = new Map();
  if (S.loading.has(path)) return S.loading.get(path);   // 同一个源只解码一次
  ensureAC();
  const p = fetch('/audio?path=' + encodeURIComponent(path))
    .then(r => r.arrayBuffer())
    .then(ab => AC.decodeAudioData(ab))
    .then(buf => { S.buffers.set(path, buf); S.loading.delete(path); return buf; })
    .catch(err => { S.loading.delete(path); throw err; });
  S.loading.set(path, p);
  return p;
}
// 播放源解析: inBuf = 直接用渲染缓存 (已是时间轴时长); rate = 每秒时间轴消耗的源秒数 (1 = 原速)
function clipBufferInfo(c) {
  if (c.render) return { path: c.render, inBuf: true, rate: 1 };
  const tr = trackById(c.trackId);
  const stretch = (isFinite(c.stretch) && c.stretch > 0) ? c.stretch : 1;
  const semis = c.pitch || 0;
  // 自由变调轨 + 纯变调(没拉伸) → 浏览器内即时普通变调: 不排队渲染、不等"渲染中"
  // (窗口超过 PS_INLINE_MAX 秒时浏览器里算太慢, 退回后端同算法渲染)
  if (tr && tr.noTune && Math.abs(stretch - 1) < 1e-4 && Math.abs(semis) > 1e-6 && c.length <= PS_INLINE_MAX) {
    return { ps: { src: c.src, offset: c.offset || 0, win: c.length, semitones: semis }, inBuf: true, rate: 1 };
  }
  if (c.bypassWhip) return { path: c.src, inBuf: false, rate: 1 / stretch };
  if (Math.abs(semis) < 1e-6 && Math.abs(stretch - 1) < 1e-4) return { path: c.src, inBuf: false, rate: 1 };
  return null;   // 需要算法渲染但还没就绪 → 本帧跳过
}

// ================= 普通变调 (浏览器内即时, 零渲染队列) =================
// 自由变调轨上的素材: 只改音高、不改时长; 按下 = / - 立刻生效, 不进渲染队列、不显示"渲染中"。
// 算法 = 相位声码器 (STFT 时间拉伸 ×r + 严格 r 倍重采样) —— 与后端 dsp.simple_pitch 同一套参数,
// 保证"试听 == 导出"。这就是普通升降调 (Vegas 里非 elastique 的那类), 不是 PSOLA/音高矫正那套。
const PS_N = 2048, PS_GRAIN_SEC = 0.045, PS_INLINE_MAX = 24;   // 窗长 / 极短素材兜底 / 超过这个秒数交给后端同算法
const PS_CACHE = new Map();          // psKey -> AudioBuffer
const psKeyOf = (src, offset, win, semis) => 'ps|' + src + '|' + offset.toFixed(4) + '|' + win.toFixed(4) + '|' + semis.toFixed(3);
function psDrop(c) {                 // 音高/裁剪变了 → 丢掉该块的即时变调缓存
  const pre = 'ps|' + c.src + '|';
  for (const k of [...PS_CACHE.keys()]) if (k.startsWith(pre)) PS_CACHE.delete(k);
}
// 原地 radix-2 复数 FFT (N 为 2 的幂)
function fft2(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const pr = re[i + k + half], pi = im[i + k + half];
        const vr = pr * cr - pi * ci, vi = pr * ci + pi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// 颗粒法兜底 (极短素材: 声码器没有意义)
function grainPitch(ex, sr, r, n) {
  const out = new Float32Array(n);
  const N = Math.max(32, Math.round(sr * PS_GRAIN_SEC)), H = Math.max(8, N >> 2);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const ws = new Float32Array(n);
  for (let t0 = 0; t0 < n; t0 += H) {
    const m = Math.min(N, n - t0);
    for (let k = 0; k < m; k++) {
      const sp = (t0 + k) * r;
      const i0 = Math.min(n - 1, Math.floor(sp)), fr = sp - i0;
      const i1 = Math.min(n - 1, i0 + 1);
      out[t0 + k] += (ex[i0] + (ex[i1] - ex[i0]) * fr) * w[k];
      ws[t0 + k] += w[k];
    }
  }
  for (let i = 0; i < n; i++) out[i] = ws[i] > 0.35 ? out[i] / ws[i] : 0;
  return out;
}
// 相位声码器: ex(源窗口, 已回绕取好) → 长度不变的变调结果
function pvPitch(ex, sr, semis) {
  const n = ex.length, r = Math.pow(2, semis / 12);
  if (n >= 2 * PS_N) {
    const N = PS_N, Ha = N >> 2, Hs = Math.max(1, Math.round(Ha * r)), nb = (N >> 1) + 1;
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const omega = new Float64Array(nb);
    for (let k = 0; k < nb; k++) omega[k] = 2 * Math.PI * k * Ha / N;
    const nf = 1 + Math.floor((n - N) / Ha);
    const ylen = (nf - 1) * Hs + N;
    const y = new Float64Array(ylen), ws = new Float64Array(ylen);
    const re = new Float64Array(N), im = new Float64Array(N);
    const mag = new Float64Array(nb), phi = new Float64Array(nb);
    const prev = new Float64Array(nb), syn = new Float64Array(nb);
    for (let f = 0; f < nf; f++) {
      const t0 = f * Ha;
      for (let i = 0; i < N; i++) { re[i] = ex[t0 + i] * w[i]; im[i] = 0; }
      fft2(re, im, false);
      for (let k = 0; k < nb; k++) {
        mag[k] = Math.hypot(re[k], im[k]);
        phi[k] = Math.atan2(im[k], re[k]);
      }
      for (let k = 0; k < nb; k++) {
        let d = phi[k] - prev[k] - omega[k];
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));      // 相位残差卷绕
        prev[k] = phi[k];
        syn[k] += (omega[k] + d) * (Hs / Ha);                  // 真实频率推进到合成格点
        const a = syn[k], m = mag[k];
        re[k] = m * Math.cos(a); im[k] = m * Math.sin(a);
      }
      for (let k = 1; k < N >> 1; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }   // 共轭对称
      fft2(re, im, true);
      const s0 = f * Hs;
      for (let i = 0; i < N; i++) { y[s0 + i] += re[i] * w[i]; ws[s0 + i] += w[i] * w[i]; }
    }
    for (let i = 0; i < ylen; i++) if (ws[i] > 1e-6) y[i] /= ws[i];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {                              // 严格 r 倍速读回 (不是按长度比)
      const p = i * r;
      let i0 = Math.floor(p);
      if (i0 > ylen - 2) i0 = Math.max(0, ylen - 2);
      let fr = p - i0; if (fr < 0) fr = 0; else if (fr > 1) fr = 1;
      out[i] = y[i0] + (y[i0 + 1] - y[i0]) * fr;
    }
    return out;
  }
  return grainPitch(ex, sr, r, n);
}
function simplePitchBuffer(buf, semitones, offset, win) {
  const sr = buf.sampleRate, nCh = buf.numberOfChannels, sl = buf.length;
  const n = Math.max(4, Math.round(win * sr));
  const offS = Math.round((offset || 0) * sr);
  const out = AC.createBuffer(nCh, n, sr);
  const ex = new Float32Array(n);
  for (let ch = 0; ch < nCh; ch++) {
    const x = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) ex[i] = x[((offS + i) % sl + sl) % sl];   // 取窗口 (循环源回绕)
    out.getChannelData(ch).set(pvPitch(ex, sr, semitones));
  }
  return out;
}
function psWarm(c) {   // 提前算好 (典型几十~几百 ms), 让播放零延迟
  const info = clipBufferInfo(c);
  if (info && info.ps) psBufferFor(info.ps);
}
function psBufferFor(spec) {
  const key = psKeyOf(spec.src, spec.offset, spec.win, spec.semitones);
  const hit = PS_CACHE.get(key);
  if (hit) return hit;
  const srcBuf = S.buffers.get(spec.src);
  if (!srcBuf) {                    // 源还没解码好 → 先解码, 好了回来补算 + 重排
    preloadBuffer(spec.src).then(() => { psBufferFor(spec); if (S.playing) scheduleAll(); }).catch(() => {});
    return null;
  }
  const t0 = performance.now();
  const b = simplePitchBuffer(srcBuf, spec.semitones, spec.offset, spec.win);
  if (PS_CACHE.size > 12) PS_CACHE.clear();
  PS_CACHE.set(key, b);
  const ms = performance.now() - t0;
  if (ms > 200) console.log('[simple-pitch] ' + spec.win.toFixed(1) + 's ×' + spec.semitones + '半音 用时 ' + Math.round(ms) + 'ms');
  return b;
}
// ===== 轨道 FX 链 (EQ3 / 合唱 / 混响 / 激励器 — 模式参考 Tone.js Effect) =====
const trackChains = new Map();
function fxOf(t) {
  return t.fx || (t.fx = {
    eq: { low: 0, mid: 0, high: 0 },
    chorus: { on: false, depth: 0.4, rate: 1.5 },
    reverb: { on: false, wet: 0.22, decay: 1.7 },
    exciter: { on: false, amount: 0.35 },
  });
}
function makeIR(decay) {
  const len = Math.max(1, Math.floor(AC.sampleRate * decay));
  const buf = AC.createBuffer(2, len, AC.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  return buf;
}
function exciterCurve(amount) {
  const k = 1 + amount * 6, n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}
function ensureTrackChain(t) {
  if (!AC) return null;
  let ch = trackChains.get(t.id);
  if (ch) { applyFxParams(t, ch); return ch; }
  const fx = fxOf(t);
  const input = AC.createGain();
  let node = input;
  const eqL = AC.createBiquadFilter(); eqL.type = 'lowshelf'; eqL.frequency.value = 320;
  const eqM = AC.createBiquadFilter(); eqM.type = 'peaking'; eqM.frequency.value = 2500; eqM.Q.value = 1;
  const eqH = AC.createBiquadFilter(); eqH.type = 'highshelf'; eqH.frequency.value = 8000;
  node.connect(eqL); eqL.connect(eqM); eqM.connect(eqH); node = eqH;
  // 合唱: 干 + LFO调制延迟 (Tone.Chorus 简化单声道版)
  const chDry = AC.createGain(), chWet = AC.createGain();
  const chSum = AC.createGain();
  const chDelay = AC.createDelay(0.1); chDelay.delayTime.value = 0.025;
  const chLfo = AC.createOscillator(); chLfo.frequency.value = fx.chorus.rate;
  const chLfoG = AC.createGain(); chLfoG.gain.value = 0.006;
  chLfo.connect(chLfoG); chLfoG.connect(chDelay.delayTime); chLfo.start();
  node.connect(chDry); node.connect(chDelay); chDelay.connect(chWet);
  chDry.connect(chSum); chWet.connect(chSum); node = chSum;
  // 混响: 衰减噪声 IR 卷积 (Tone.Reverb 模式)
  const rvDry = AC.createGain(), rvWet = AC.createGain();
  const rvSum = AC.createGain();
  const conv = AC.createConvolver();
  conv.buffer = makeIR(fx.reverb.decay);
  node.connect(rvDry); node.connect(conv); conv.connect(rvWet);
  rvDry.connect(rvSum); rvWet.connect(rvSum); node = rvSum;
  // 激励器: 高频支路 WaveShaper 谐波 (Aphex 式)
  const exDry = AC.createGain(), exWet = AC.createGain();
  const exSum = AC.createGain();
  const exHp = AC.createBiquadFilter(); exHp.type = 'highpass'; exHp.frequency.value = 3200;
  const exSh = AC.createWaveShaper(); exSh.curve = exciterCurve(fx.exciter.amount);
  node.connect(exDry); node.connect(exHp); exHp.connect(exSh); exSh.connect(exWet);
  exDry.connect(exSum); exWet.connect(exSum); node = exSum;
  const out = AC.createGain();
  const pan = AC.createStereoPanner();
  node.connect(out); out.connect(pan); pan.connect(masterGain);
  ch = { input, out, pan, eqL, eqM, eqH, chWet, chDry, chLfo, rvWet, rvDry, conv, exWet, exDry, exSh };
  trackChains.set(t.id, ch);
  applyFxParams(t, ch);
  return ch;
}
function applyFxParams(t, ch) {
  const fx = fxOf(t);
  ch.eqL.gain.value = fx.eq.low; ch.eqM.gain.value = fx.eq.mid; ch.eqH.gain.value = fx.eq.high;
  ch.chWet.gain.value = fx.chorus.on ? fx.chorus.depth : 0;
  ch.chDry.gain.value = fx.chorus.on ? 1 - fx.chorus.depth * 0.5 : 1;
  ch.chLfo.frequency.value = fx.chorus.rate;
  ch.rvWet.gain.value = fx.reverb.on ? fx.reverb.wet : 0;
  ch.rvDry.gain.value = fx.reverb.on ? 1 - fx.reverb.wet * 0.4 : 1;
  ch.exWet.gain.value = fx.exciter.on ? fx.exciter.amount * 0.5 : 0;
}

function stopSources() {
  for (const a of active) {
    try { a.src.stop(); } catch (e) {}
    try { a.src.disconnect(); } catch (e) {}
    try { a.gEnv && a.gEnv.disconnect(); } catch (e) {}
    try { a.gClip && a.gClip.disconnect(); } catch (e) {}
  }
  active = [];
  for (const o2 of monitorNodes) { try { o2.stop(); } catch (e) {} try { o2.disconnect(); } catch (e) {} }
  monitorNodes = [];
}
let _bleepAt = 0;
function bleep(midi, dur) {   // 建/改音符时的即时试听音 (UI 反馈: 不知道是什么键也能听出来)
  ensureAC();
  if (!AC) return;
  if (AC.state === 'suspended') AC.resume();
  midi = clamp(Math.round(midi), 0, 127);
  const now = performance.now();
  if (now - _bleepAt < 60) return;      // 拖音高时别糊成一片
  _bleepAt = now;
  const t0 = AC.currentTime + 0.005, d = dur || 0.25;
  const o = AC.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
  const gn = AC.createGain();
  gn.gain.setValueAtTime(0.0001, t0);
  gn.gain.linearRampToValueAtTime(0.16, t0 + 0.012);
  gn.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  o.connect(gn); gn.connect(masterGain || AC.destination);
  o.start(t0); o.stop(t0 + d + 0.03);
}
function scheduleMonitor() {   // 钢琴窗试听: chip 方波, 仅编辑器内, 不进外发
  if (!(PR.monitor && PR.open && AC)) return;
  const m = PR.open;
  const cmds = buildSlideCommands(m.notes, m.trans || 0);
  if (!cmds.length) return;
  const sc = m.scale || 1, off = m.off || 0;
  const uEnd = Math.max(off + m.length / sc, ...m.notes.map(n2 => n2.end));
  const step = 0.02, fs = [];
  let tl0 = null;
  for (let u = cmds[0].t; u <= uEnd + 1e-9; u += step) {   // 与后端同一套滑音曲线 → 听得到滑音
    const tl = uToTL(u);
    if (tl < S.startPos - 0.01) continue;
    const pn = cmdPitch(cmds, u);
    if (pn === null) continue;
    if (tl0 === null) tl0 = tl;
    fs.push(440 * Math.pow(2, (pn - 69) / 12));
  }
  if (fs.length < 2) return;
  const t0 = S.playing ? S.ctxStart + (tl0 - S.startPos) : AC.currentTime + 0.03;
  const dur = (fs.length - 1) * step;
  const o2 = AC.createOscillator(); o2.type = 'square';
  o2.frequency.setValueCurveAtTime(new Float32Array(fs), t0, dur);
  const gn = AC.createGain();
  gn.gain.setValueAtTime(0.0001, t0);
  gn.gain.linearRampToValueAtTime(0.1, t0 + Math.min(0.012, dur / 3));
  gn.gain.setValueAtTime(0.1, Math.max(t0 + 0.02, t0 + dur - 0.03));
  gn.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  o2.connect(gn); gn.connect(masterGain);
  o2.start(t0); o2.stop(t0 + dur + 0.02);
  monitorNodes.push(o2);
}
function scheduleAll() {
  stopSources();
  if (!AC) return;
  const now = AC.currentTime, pos = S.startPos;
  for (const c of S.project.clips) {
   let t = null, info = null, buf = null, when = 0, bufOffset = 0, dur = 0, pbRate = 1, src = null, gClip = null, gEnv = null, chain = null;
   try {
    t = trackById(c.trackId);
    info = clipBufferInfo(c);
    if (!t || !info) continue;
    buf = info.ps ? psBufferFor(info.ps) : S.buffers.get(info.path);
    if (!buf) {
      if (!info.ps) {   // 即时变调分支自己会去解码源文件, 好了自动重排
        preloadBuffer(info.path)
          .then(() => { if (S.playing) scheduleAll(); })
          .catch(() => { if (info.inBuf) { c.render = null; c.renderKey = null; ensureRender(c); } });   // 渲染缓存文件被清了 → 重渲染
      }
      continue;
    }
    const cEnd = c.start + c.length;
    if (cEnd <= pos + 0.005) continue;
    when = Math.max(0, c.start - pos);
    const skip = Math.max(0, pos - c.start);
    bufOffset = info.inBuf ? skip : c.offset + skip * info.rate;   // 源秒
    if (!isFinite(bufOffset) || bufOffset >= buf.duration - 0.01) continue;
    dur = (cEnd - Math.max(pos, c.start)) + 0.03;
    pbRate = info.rate;                        // 自由变调 = 变速播放 (音高与时长一起变)
    src = AC.createBufferSource();
    src.buffer = buf;
    // 源不够长 (窗口越过源尾) → 循环源回绕, 与 Alt+滑动 / 后端的 take_window 同一套语义
    const wrapLoop = !info.inBuf && (c.offset + c.length / c.stretch) > buf.duration + 1e-3;
    if (wrapLoop) { src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration; }
    gEnv = AC.createGain();                    // 淡入淡出包络 (归一化 0~1, 与块音量分离)
    gClip = AC.createGain();                   // 块音量 (实时可改, 不再覆盖包络)
    chain = ensureTrackChain(t);
    src.connect(gEnv); gEnv.connect(gClip); gClip.connect(chain.input);   // → FX链 → 声像 → 总线
    if (pbRate !== 1) src.playbackRate.value = pbRate;
    gClip.gain.value = c.vol ?? 1;
    // 淡入淡出包络 (用户设的 + 同轨重叠的自动交叉淡化)
    const _fd = clipFades(c);
    const fi = _fd.in, fo = _fd.out;
    const clipStart = c.start, clipEnd = c.start + c.length;
    const Tin = tl => S.ctxStart + (tl - S.startPos);
    const inPos = Math.max(pos, clipStart);
    if (fi > 0 || fo > 0) {
      const pts = [];
      if (fi > 0) pts.push([clipStart, 0], [clipStart + fi, 1]); else pts.push([clipStart, 1]);
      pts.push([Math.max(clipStart + fi, clipEnd - fo), 1]);
      if (fo > 0) pts.push([clipEnd, 0]);
      pts.sort((a, b) => a[0] - b[0]);
      const vAt = tq => {
        if (tq <= pts[0][0]) return pts[0][1];
        for (let i = 1; i < pts.length; i++) {
          if (tq <= pts[i][0]) {
            const [ta, va] = pts[i - 1], [tb, vb] = pts[i];
            return va + (vb - va) * ((tq - ta) / Math.max(1e-6, tb - ta));
          }
        }
        return pts[pts.length - 1][1];
      };
      gEnv.gain.setValueAtTime(vAt(inPos), Tin(inPos));
      for (const [tt, vv] of pts) if (tt > inPos + 1e-4) gEnv.gain.linearRampToValueAtTime(vv, Tin(Math.min(tt, clipEnd)));
    }
    if (wrapLoop) {   // 循环源: 用 stop 收尾 (duration 参数在 loop 下不可靠)
      src.start(now + when + 0.02, bufOffset);
      src.stop(now + when + 0.02 + dur + 0.02);
    } else {
      src.start(now + when + 0.02, bufOffset, Math.min(dur * pbRate, buf.duration - bufOffset));
    }
    active.push({ src, gEnv, gClip, chain, trackId: t.id, clip: c });
   } catch (err) {
    const sv = v => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(3) : String(v);
    if (!window.__schedErrs) window.__schedErrs = [];
    window.__schedErrs.push((c.name || '?') + ': ' + err.message + ' | start=' + sv(c.start) + ' len=' + sv(c.length) + ' stretch=' + sv(c.stretch) + ' offset=' + sv(c.offset) + ' bypass=' + !!c.bypassWhip + ' bufDur=' + (buf ? sv(buf.duration) : 'null') + ' | when=' + sv(when) + ' bufOffset=' + sv(bufOffset) + ' D=' + sv(dur * pbRate) + ' pbRate=' + pbRate);
    if (window.__schedErrs.length > 10) window.__schedErrs.shift();
    status('块 "' + (c.name || '?') + '" 调度失败已跳过: ' + err.message, true);
   }
  }
  scheduleMonitor();
  applyMixLive();
}
function applyMixLive() {   // 实时参数更新 (音量/声像/M/S): 只碰"常数"节点, 不碰自动化里的包络
  for (const a of active) {
    const t = trackById(a.trackId);
    if (!t) continue;
    if (a.chain) { a.chain.out.gain.value = trackGain(t); a.chain.pan.pan.value = clamp(t.pan, -1, 1); }
    if (a.gClip && a.clip) a.gClip.gain.value = (a.clip.vol ?? 1);   // gClip 只装块音量, 包络在 gEnv
  }
  if (masterGain) masterGain.gain.value = parseFloat($('master').value);
}
function pendingRenders() { return S.project.clips.filter(c => c._pend).length; }
function play() {
  if (S.playing) return;
  const p = pendingRenders();
  if (p > 0) {   // 就绪门: 没渲染好不起播, 就绪后自动播 (宁等勿错)
    status('渲染中 (' + p + ' 块) — 就绪后自动播放…');
    S.autoPlay = true; S.autoPlayAt = performance.now();
    return;
  }
  startPlayback();
}
function startPlayback() {
  ensureAC();
  S.playing = true;
  S.startPos = S.playhead;
  S.ctxStart = AC.currentTime + 0.05;
  scheduleAll();
  status('播放中… (Space 暂停)');
}
function pause() {
  if (!S.playing) return;
  S.playhead = curPos();
  stopSources();
  S.playing = false;
  status('已暂停 @ ' + S.playhead.toFixed(2) + 's');
}
function stop() {
  stopSources();
  S.playing = false;
  S.playhead = S.loop.on && S.loop.b > S.loop.a ? S.loop.a : 0;
  invalidate();
  status('已停止');
}
function seek(t) {
  S.playhead = Math.max(0, t);
  if (S.playing) { stopSources(); S.startPos = S.playhead; S.ctxStart = AC.currentTime + 0.02; scheduleAll(); }
  invalidate();
}
function curPos() {
  return S.playing ? S.startPos + (AC.currentTime - S.ctxStart) : S.playhead;
}

// ================= 轨道面板 (DOM) =================
// 轨级开关: 面板按钮 与 轨道行右键菜单 共用同一套逻辑
function setTrackFreeTune(t, on) {
  t.noTune = !!on;
  rebuildPanel();                 // 按钮高亮/勾选随状态重绘
  refreshClipsOf(t.id);           // 接管 ↔ 不接管 → 该轨整轨重算渲染 (与 whip 失效传播同构)
  status('轨道 "' + t.name + '" ' + (t.noTune
    ? '自由变调轨: 开 — 素材不跟随 MIDI; = / - 为普通变调 (保时长、不变速)'
    : '自由变调轨: 关 — 恢复 whip 的 MIDI 音高接管'));
}
function setFollowBpm(t, on) {
  t.followBpm = !!on;
  rebuildPanel();
  status('轨道 "' + t.name + '" 跟随BPM: ' + (t.followBpm
    ? '开 — 改 BPM 时此轨素材随节拍变速变位'
    : '关 — 绝对时间 (BGM 用)'));
}

// ---------- 轨道行上下拖拽换序 ----------
// 拖行内空白/编号即可换序 (输入框、滑块、按钮、🌀 不抢); 换序后必须重画 whip 连线 ——
// 连线是按轨道行位置算的, 重排后不重画就还挂在旧位置上。
function trackRowCenterY(trackId) {
  const row = document.querySelector('.trk[data-trackid="' + trackId + '"]');
  if (!row) return null;
  const pr = $('panel').getBoundingClientRect(), r = row.getBoundingClientRect();
  return r.top - pr.top + r.height / 2;
}
function trackInsertIndex(clientY) {
  const pr = $('panel').getBoundingClientRect();
  let k = 0;
  for (const t of S.project.tracks) {
    const y = trackRowCenterY(t.id);
    if (y !== null && clientY > pr.top + y) k++;
  }
  return k;
}
function trackDragStart(e, t) {
  e.preventDefault();
  const panel = $('panel');
  const ins = document.createElement('div');
  ins.id = 'insLine';
  panel.appendChild(ins);
  const dragRow = document.querySelector('.trk[data-trackid="' + t.id + '"]');
  if (dragRow) dragRow.classList.add('dragging');
  const move = ev2 => {
    const k = trackInsertIndex(ev2.clientY);
    const pr = panel.getBoundingClientRect();
    const rows = S.project.tracks
      .map(x => document.querySelector('.trk[data-trackid="' + x.id + '"]')).filter(Boolean);
    let y = 0;
    if (k < rows.length) y = rows[k].getBoundingClientRect().top - pr.top;
    else if (rows.length) y = rows[rows.length - 1].getBoundingClientRect().bottom - pr.top;
    ins.style.top = Math.round(y) + 'px';
    ins.dataset.k = k;
  };
  move(e);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const k = parseInt(ins.dataset.k || '0', 10);
    ins.remove();
    if (dragRow) dragRow.classList.remove('dragging');
    const from = S.project.tracks.indexOf(t);
    const to = clamp(k > from ? k - 1 : k, 0, S.project.tracks.length - 1);
    if (to === from) return;
    pushUndo();
    S.project.tracks.splice(from, 1);
    S.project.tracks.splice(to, 0, t);
    status('轨道 "' + t.name + '" → 第 ' + (to + 1) + ' 行 (whip 连线已重画)');
    rebuildPanel();       // 行序号/位置
    drawBindings();       // ← 关键: 连线按新位置重画
    draw(); invalidate();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function rebuildPanel() {
  const panel = $('panel');
  panel.innerHTML = '';
  for (const t of S.project.tracks) {
    const hasMidi = S.project.midiClips.some(m => m.trackId === t.id);
    const div = document.createElement('div');
    div.className = 'trk';
    div.dataset.trackid = t.id;
    div.style.setProperty('--tag', trackHue(t));
    div.innerHTML = `
      <div class="row2">
        <span class="tidx">${String(S.project.tracks.indexOf(t) + 1).padStart(2, '0')}</span>
        <input class="name" value="${t.name.replace(/"/g, '&quot;')}">
        ${hasMidi ? '<button class="whip" title="按住拖到目标轨道: 把 MIDI pitch 发给它 · 右键=断开"><span class="gl">🌀</span></button>' : ''}
      </div>
      <div class="row2"><span class="vol">音量<input type="range" min="0" max="1.5" step="0.01" value="${t.vol}"></span></div>
      <div class="row2">
        <span class="pan">声道<input type="range" min="-1" max="1" step="0.01" value="${t.pan}"></span>
        <span class="ms">
          <button class="nt ${t.noTune ? 'on' : ''}" title="自由变调轨: 该轨素材永不被 MIDI 接管; = / - 为普通变调 — 保时长、不变速 (右键轨道行也可切换)">±</button>
          <button class="tmb ${t.followBpm ? 'on' : ''}" data-track="${t.id}" title="跟随BPM (节拍时基): 改BPM时此轨素材随节拍变速变位">♩</button>
          <button class="fxb ${anyFxOn(t) ? 'on' : ''}" data-track="${t.id}">FX</button>
          <button class="m ${t.mute ? 'on' : ''}">M</button>
          <button class="s ${t.solo ? 'on' : ''}">S</button>
        </span>
        <button class="del" title="删除空轨道">✕</button>
      </div>`;
    div.querySelector('.name').addEventListener('input', e => { t.name = e.target.value; invalidate(); });
    div.querySelector('.vol input').addEventListener('input', e => { t.vol = parseFloat(e.target.value); applyMixLive(); });
    div.querySelector('.pan input').addEventListener('input', e => { t.pan = parseFloat(e.target.value); applyMixLive(); });
    div.querySelector('.m').addEventListener('click', e => { t.mute = !t.mute; e.target.classList.toggle('on', t.mute); applyMixLive(); });
    div.querySelector('.s').addEventListener('click', e => { t.solo = !t.solo; e.target.classList.toggle('on', t.solo); applyMixLive(); rebuildPanel(); drawBindings(); });
    div.querySelector('.del').addEventListener('click', () => {
      const used = S.project.clips.some(c => c.trackId === t.id) || S.project.midiClips.some(m => m.trackId === t.id);
      if (used) return status('轨道上还有素材, 先删掉它们', true);
      pushUndo();
      S.project.tracks = S.project.tracks.filter(x => x.id !== t.id);
      S.project.whips = S.project.whips.filter(w => w.midiTrackId !== t.id && w.targetTrackId !== t.id);
      rebuildPanel(); drawBindings(); invalidate();
    });
    const tmb = div.querySelector('.tmb');
    if (tmb) tmb.addEventListener('click', () => setFollowBpm(t, !t.followBpm));
    const ntb = div.querySelector('.nt');
    if (ntb) ntb.addEventListener('click', () => setTrackFreeTune(t, !t.noTune));
    div.addEventListener('pointerdown', e => {   // 拖行内空白/编号 = 上下换序 (滑块/按钮/输入框不抢)
      if (e.button !== 0) return;
      if (e.target.closest('input,button,.whip,.name')) return;
      trackDragStart(e, t);
    });
    div.addEventListener('contextmenu', e => {   // 轨道行右键 = 轨道菜单 (含自由变调轨开关)
      e.preventDefault(); e.stopPropagation();
      showTrackMenu(e.clientX, e.clientY, t);
    });
    const fxb = div.querySelector('.fxb');
    if (fxb) fxb.addEventListener('click', e => {
      e.stopPropagation();
      const pop = $('fxPop');
      const opening = pop.style.display !== 'block' || pop.dataset.track !== t.id;
      pop.style.display = 'none';
      if (opening) openFxPop(t, fxb);
    });
    const whipBtn = div.querySelector('.whip');
    if (whipBtn) {
      whipBtn.addEventListener('pointerdown', e => whipStart(e, t.id));
      whipBtn.addEventListener('contextmenu', e => {   // 右键 🌀 = 断开 (防误触)
        e.preventDefault(); e.stopPropagation();
        removeWhipsOf(t.id);
      });
    }
    panel.appendChild(div);
  }
}

// ================= 绘制 =================
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

async function peaksFor(path) {
  if (S.peaks.has(path)) return S.peaks.get(path);
  S.peaks.set(path, 'pending');
  try {
    const j = await post('/api/peaks', { path, pps: 100 });
    S.peaks.set(path, j);
    invalidate();
    return j;
  } catch (e) { S.peaks.delete(path); return null; }
}

function fmtPos(t) {
  const b = t * (S.project.bpm || 120) / 60;
  const bar = Math.floor(b / 4) + 1, beatIn = Math.floor(b % 4) + 1, frac = Math.floor((b % 1) * 10);
  return bar + '.' + beatIn + '.' + frac + ' | ' + t.toFixed(2) + 's';
}

function draw() {
  const { w, h } = resizeCanvas();
  const g = ctx2d;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#12151a'; g.fillRect(0, 0, w, h);
  // 轨道面板与时间线垂直同步
  $('panel').style.transform = 'translateY(' + (-S.scrollY) + 'px)';

  // ---- 标尺 + 网格 ----
  g.fillStyle = '#161a22'; g.fillRect(0, 0, w, RULER_H);
  const gs = gridSec();
  const g0 = Math.floor(x2t(0) / gs), g1 = Math.ceil(x2t(w) / gs);
  g.font = '11px ui-monospace,monospace';
  g.textBaseline = 'middle';
  for (let gi = Math.max(0, g0); gi <= g1; gi++) {
    const t = gi * gs, x = t2x(t);
    if (x < -50 || x > w + 50) continue;
    const isBeatMode = S.grid.mode === 'beat';
    const barSteps = Math.round(4 / S.grid.div);
    const isBar = isBeatMode && gi % barSteps === 0;
    const isSec = !isBeatMode && Math.abs(t - Math.round(t)) < 1e-6;
    g.strokeStyle = (isBar || isSec) ? '#2b3342' : '#222834';
    g.beginPath(); g.moveTo(x, (isBar || isSec) ? 8 : 22); g.lineTo(x, RULER_H); g.stroke();
    if ((isBar || isSec) && S.pps * gs * (isBeatMode ? barSteps : 1) > 60) {
      g.fillStyle = '#94a3b8';
      g.fillText(isBeatMode ? (gi / barSteps + 1) + '.' + 1 : t.toFixed(0) + 's', x + 3, 12);
    }
    if (S.pps * gs > 14) {
      g.strokeStyle = '#181d26'; g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, h); g.stroke();
    }
    if (isBar || isSec) { g.strokeStyle = '#2b3342'; g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, h); g.stroke(); }
  }
  // 循环选区
  if (S.loop.on && S.loop.b > S.loop.a) {
    const xa = t2x(S.loop.a), xb = t2x(S.loop.b);
    g.fillStyle = 'rgba(59,130,246,0.14)'; g.fillRect(xa, 0, xb - xa, h);
    g.fillStyle = '#3b82f6'; g.fillRect(xa, 0, xb - xa, 4);
    g.fillRect(xa - 1, 0, 3, RULER_H); g.fillRect(xb - 2, 0, 3, RULER_H);
  }

  // ---- 轨道行 ----
  for (let i = 0; i < S.project.tracks.length; i++) {
    const y = trackY(i);
    if (y + ROW_H < RULER_H || y > h) continue;
    g.fillStyle = i % 2 ? '#161a22' : '#12161d';
    g.fillRect(0, y, w, ROW_H);
    g.strokeStyle = '#2b3342';
    g.beginPath(); g.moveTo(0, y + ROW_H); g.lineTo(w, y + ROW_H); g.stroke();
  }

  // ---- 音频块 ----
  for (const c of S.project.clips) {
    const ti = S.project.tracks.findIndex(t => t.id === c.trackId);
    if (ti < 0) continue;
    const y = trackY(ti);
    if (y + ROW_H < RULER_H || y > h) continue;
    const x0 = t2x(c.start), x1 = t2x(c.start + c.length);
    if (x1 < 0 || x0 > w) continue;
    const muted = trackGain(S.project.tracks[ti]) <= 1e-6;   // 静音/被独奏压掉 → 整块变暗
    if (muted) g.globalAlpha = 0.38;
    const sel = isSel('audio', c.id);
    g.fillStyle = sel ? '#1e3355' : '#1a2331';
    g.fillRect(x0, y + 4, x1 - x0, ROW_H - 8);
    g.strokeStyle = sel ? '#3b82f6' : '#2b3342';
    g.strokeRect(x0 + 0.5, y + 4.5, x1 - x0 - 1, ROW_H - 9);
    const pk = S.peaks.get(c.src);
    if (!pk) peaksFor(c.src);
    const nPk = (pk && pk !== 'pending') ? pk.min.length : 0;
    if (nPk && x1 - x0 > 3) {
      g.fillStyle = sel ? '#6aa6c9' : '#33586e';   // 波形是"素材"不是"信号读数": 低饱和钢蓝, 不抢状态色
      const mid = y + ROW_H / 2, amp = ROW_H * 0.32;
      const xStart = Math.max(0, Math.ceil(x0)), xEnd = Math.min(w, Math.floor(x1));
      for (let px = xStart; px < xEnd; px++) {
        const srcT = c.offset + (x2t(px + 0.5) - c.start) / c.stretch;
        let idx = Math.floor(srcT * pk.pps) % nPk;   // 循环源: 越过源尾 → 回绕到开头
        if (idx < 0) idx += nPk;
        const lo = mid - pk.max[idx] * amp, hi = mid - pk.min[idx] * amp;
        g.fillRect(px, lo, 1, Math.max(1, hi - lo));
      }
      // 循环源接缝 (素材回绕处) — 拖 Alt 滑动时能看到接缝跑
      if (c.srcDur > 0.02 && c.offset + c.length / c.stretch > c.srcDur + 1e-3) {
        g.strokeStyle = 'rgba(255,255,255,0.32)';
        g.setLineDash([4, 4]);
        const perLoop = c.srcDur * c.stretch;
        let guard = 0;
        for (let sTl = c.start + (c.srcDur - c.offset) * c.stretch; sTl < c.start + c.length - 1e-6 && guard < 400; sTl += perLoop) {
          guard++;
          const sx = t2x(sTl);
          if (sx < x0 || sx > x1) continue;
          g.beginPath(); g.moveTo(sx + 0.5, y + 4); g.lineTo(sx + 0.5, y + ROW_H - 4); g.stroke();
        }
        g.setLineDash([]);
      }
    }
    g.fillStyle = '#f8fafc';
    g.font = '11px system-ui';
    g.textBaseline = 'top';
    let label = c.name;
    if (c.pitch) label += '  [Pitch ' + (c.pitch > 0 ? '+' : '') + c.pitch + ']';
    if (Math.abs(c.stretch - 1) > 1e-4) label += '  [Rate ' + c.stretch.toFixed(2) + ']';
    if (c._tk) label += '  [MIDI接管]';
    if (c.bypassWhip) label += '  [脱离MIDI]';
    else if (S.project.tracks[ti].noTune) label += '  [自由变调轨]';
    if (c.srcDur > 0.02 && c.offset + c.length / c.stretch > c.srcDur + 1e-3) label += '  [循环源]';
    if (c._pend) label += '  渲染中…';
    g.fillText(label, x0 + 5, y + 7, Math.max(10, x1 - x0 - 10));
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(x0, y + 4, 5, ROW_H - 8);
    g.fillRect(x1 - 5, y + 4, 5, ROW_H - 8);
    // 块音量线 + 淡入淡出 (REAPER 式)
    const vol = c.vol ?? 1;
    const clipTop = y + 4;
    const lineY = clipTop + 10 + (1 - vol) * (ROW_H - 30);
    if (c.fadeIn > 0) {
      const fw = Math.min(t2x(c.start + c.fadeIn) - x0, x1 - x0);
      if (fw > 0) {
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.beginPath(); g.moveTo(x0, clipTop); g.lineTo(x0 + fw, lineY); g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.beginPath(); g.moveTo(x0, clipTop); g.lineTo(x0 + fw, clipTop); g.lineTo(x0 + fw, lineY); g.closePath(); g.fill();
      }
    }
    if (c.fadeOut > 0) {
      const fw = Math.min(x1 - t2x(c.start + c.length - c.fadeOut), x1 - x0);
      if (fw > 0) {
        const fx1 = x1 - fw;
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.beginPath(); g.moveTo(fx1, lineY); g.lineTo(x1, clipTop); g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.beginPath(); g.moveTo(fx1, clipTop); g.lineTo(x1, clipTop); g.lineTo(fx1, lineY); g.closePath(); g.fill();
      }
    }
    // 同轨自动交叉淡化: 在"我这块被前一块压住"的那段上画 X (前块淡出 / 我这块淡入).
    // 每个重叠区只由后一块画一次 (两块各自算出的区间完全相同, 不会重复叠加)
    const _xf = autoXfade(c);
    if (_xf.in > 0) {
      const xa = Math.max(x0, t2x(c.start)), xb = Math.min(x1, t2x(c.start + _xf.in));
      const hClip = ROW_H - 8, yb = clipTop + hClip;
      if (xb - xa >= 1.5) {
        g.fillStyle = 'rgba(150,172,205,0.13)';
        g.fillRect(xa, clipTop, xb - xa, hClip);
        g.strokeStyle = 'rgba(220,232,248,0.8)';
        g.beginPath();
        g.moveTo(xa, clipTop); g.lineTo(xb, yb);
        g.moveTo(xa, yb); g.lineTo(xb, clipTop);
        g.stroke();
      }
    }
    g.strokeStyle = sel ? '#8ed5ff' : 'rgba(255,255,255,0.55)';
    g.beginPath(); g.moveTo(x0 + 2, lineY); g.lineTo(x1 - 2, lineY); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(x0 + 1, lineY - 3, 7, 6);
    g.fillRect(x1 - 8, lineY - 3, 7, 6);
    g.globalAlpha = 1;
  }

  // ---- MIDI 块 ----
  for (const m of S.project.midiClips) {
    const ti = S.project.tracks.findIndex(t => t.id === m.trackId);
    if (ti < 0) continue;
    const y = trackY(ti);
    if (y + ROW_H < RULER_H || y > h) continue;
    const x0 = t2x(m.start), x1 = t2x(m.start + m.length);
    if (x1 < 0 || x0 > w) continue;
    const muted = trackGain(S.project.tracks[ti]) <= 1e-6;
    if (muted) g.globalAlpha = 0.38;
    const sel = isSel('midi', m.id);
    g.fillStyle = sel ? '#332148' : '#241d33';
    g.fillRect(x0, y + 4, x1 - x0, ROW_H - 8);
    g.strokeStyle = sel ? '#a855f7' : '#3b2f52';
    g.strokeRect(x0 + 0.5, y + 4.5, x1 - x0 - 1, ROW_H - 9);
    const tp = m.trans || 0, off = m.off || 0, sc = m.scale || 1;
    const pitches = m.notes.map(n => n.midi + tp);
    const lo = Math.min(...pitches) - 1, hi = Math.max(...pitches) + 1;
    const laneH = (ROW_H - 14) / (hi - lo + 1);
    for (const n of m.notes) {
      let nx = t2x(m.start + (n.start - off) * sc);
      let nw = Math.max(1.5, (n.end - n.start) * sc * S.pps);
      if (nx + nw > x1) nw = x1 - nx;       // 裁剪: 块尾之外的音符不画
      if (nx < x0) { nw -= x0 - nx; nx = x0; }
      if (nw <= 0.5) continue;              // 裁剪: 块头之前的音符不画
      const ny = y + 7 + (hi - n.midi - tp) * laneH;
      g.fillStyle = '#a855f7';
      g.fillRect(nx, ny, nw, Math.max(2, laneH - 1));
    }
    g.fillStyle = '#f8fafc'; g.font = '11px system-ui'; g.textBaseline = 'top';
    g.fillText(m.name + '  [MIDI]' + ((m.trans || 0) ? '  [转调' + (m.trans > 0 ? '+' : '') + m.trans + ']' : ''), x0 + 5, y + 7, Math.max(10, x1 - x0 - 10));
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(x1 - 3, y + 4, 3, ROW_H - 8);
    g.globalAlpha = 1;
  }

  // ---- 横向滚动条 ----
  const SB = 12, totPx = totalPx();
  if (totPx > w + 1) {
    g.fillStyle = '#12151a'; g.fillRect(0, h - SB, w, SB);
    const tw = Math.max(30, w / totPx * w);
    const tx = clamp(S.scrollX / totPx * w, 0, w - tw);
    g.fillStyle = '#2f3b4d'; g.fillRect(tx, h - SB + 2, tw, SB - 4);
  }

  // ---- 框选虚线框 ----
  if (S.drag && S.drag.mode === 'marquee') {
    const d = S.drag;
    g.strokeStyle = '#3b82f6'; g.setLineDash([5, 4]);
    g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g.setLineDash([]);
    g.fillStyle = 'rgba(59,130,246,0.10)';
    g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }

  // ---- 播放头 ----
  const px = t2x(curPos());
  if (px >= 0 && px <= w) {
    g.strokeStyle = '#f43f5e';
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
    g.fillStyle = '#f43f5e'; g.beginPath();
    g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 9); g.fill();
  }
  $('pos').textContent = fmtPos(curPos());
}

function invalidate() { S.dirty = true; saveSoon(); }   // 顺带触发会话自动保存

function tick() {
  if (S.autoPlay) {
    const p = pendingRenders();
    if (p === 0) { S.autoPlay = false; play(); }
    else if (performance.now() - S.autoPlayAt > 8000) { S.autoPlay = false; status('部分渲染未完成, 按现有音频播放'); play(); }
  }
  if (S.playing && AC) {
    const p = curPos();
    if (S.loop.on && S.loop.b > S.loop.a && p >= S.loop.b) {
      S.startPos = S.loop.a; S.ctxStart = AC.currentTime + 0.01;
      scheduleAll();
    }
    const px = t2x(curPos());
    const w = cv.clientWidth;
    if (px > w - 60) S.scrollX = curPos() * S.pps - w * 0.25;
    S.dirty = true;
  }
  if (S.dirty) { S.dirty = false; draw(); }
  if (PR.open) {
    try {
      if (S.playing) prFollow();   // 播放中: 钢琴窗跟着播放头滚
      prDraw();
    }   // 隔离: 钢琴窗任何错误不得冻结主循环
    catch (e) { if (!window.__prErr) { window.__prErr = e.message; status('钢琴窗渲染出错: ' + e.message + ' (已自动关闭)', true); prClose(); } }
  }
  requestAnimationFrame(tick);
}

// ================= 菜单栏 =================
const MENUS = {
  File: [
    ['导入音频/媒体… (可多选, mp3/m4s/mp4/webm…)', () => $('fileAudio').click()],
    ['导入 MIDI…', () => $('fileMidi').click()],
    'sep',
    ['保存工程 (下载 .json)  Ctrl+S', saveProjectDL],
    ['打开工程 (.json)…', () => $('fileProj').click()],
    'sep',
    ['导出混音 (循环选区/整曲)…', exportMix],
    'sep',
    ['新建空工程 (清空)', newProject],
    ['加载演示工程', loadDemo],
  ],
  Edit: [
    ['撤销  Ctrl+Z', undo], ['重做  Ctrl+Y', redo], 'sep',
    ['在播放头切开  S', splitSel], ['删除  Del', deleteSel], 'sep',
    ['变调 +1  =', () => pitchSelection(1)], ['变调 -1  -', () => pitchSelection(-1)],
    ['重置变调', () => resetSel('pitch')], ['重置拉伸', () => resetSel('stretch')], 'sep',
    ['应用所有 whip', applyAllWhips],
  ],
  View: [
    ['放大  Ctrl+滚轮', () => zoomBy(1.3)], ['缩小', () => zoomBy(1 / 1.3)], ['适应工程', zoomFit], 'sep',
    ['网格: 1拍', () => setGrid('b1')], ['网格: 1/2拍', () => setGrid('b0.5')],
    ['网格: 1/4拍', () => setGrid('b0.25')], ['网格: 1/8拍', () => setGrid('b0.125')],
    ['网格: 1秒', () => setGrid('t1')], ['网格: 帧(30fps)', () => setGrid('t0.0333333')],
  ],
};

function buildMenus() {
  for (const root of document.querySelectorAll('.mroot')) {
    const raw = root.dataset.m;
    const name = MENUS[raw] ? raw : raw.charAt(0).toUpperCase() + raw.slice(1);
    const drop = root.querySelector('.mdrop');
    drop.innerHTML = '';
    for (const it of MENUS[name]) {
      if (it === 'sep') {
        const d = document.createElement('div'); d.className = 'ctx-sep'; drop.appendChild(d);
        continue;
      }
      const d = document.createElement('div');
      d.className = 'ctx-item'; d.textContent = it[0];
      d.addEventListener('click', () => { closeMenus(); it[1](); });
      drop.appendChild(d);
    }
    root.addEventListener('click', e => {
      e.stopPropagation();
      const was = root.classList.contains('open');
      closeMenus();
      if (!was) root.classList.add('open');
    });
    root.addEventListener('pointerenter', () => {
      if (document.querySelector('.mroot.open')) { closeMenus(); root.classList.add('open'); }
    });
  }
  document.addEventListener('click', closeMenus);
}
function closeMenus() { document.querySelectorAll('.mroot.open').forEach(el => el.classList.remove('open')); }

function zoomBy(f) { S.pps = clamp(S.pps * f, 4, 2000); invalidate(); }
function zoomFit() {
  const end = Math.max(8, ...S.project.clips.map(c => c.start + c.length), ...S.project.midiClips.map(m => m.start + m.length));
  S.pps = clamp((cv.clientWidth - 40) / end, 4, 2000);
  S.scrollX = 0; invalidate();
}
function setGrid(v) {
  $('grid').value = v;
  $('grid').dispatchEvent(new Event('change'));
}

// ================= 轨道 FX 弹出面板 =================
function anyFxOn(t) {
  const fx = fxOf(t);
  return fx.chorus.on || fx.reverb.on || fx.exciter.on || !!fx.eq.low || !!fx.eq.mid || !!fx.eq.high;
}
function openFxPop(t, anchor) {
  const pop = $('fxPop');
  const fx = fxOf(t);
  pop.innerHTML = `
    <h4>FX — ${t.name}</h4>
    <div class="fxsec">
      <div class="frow"><label><input type="checkbox" data-k="chorus.on" ${fx.chorus.on ? 'checked' : ''}>合唱</label></div>
      <div class="frow">深度<input type="range" min="0" max="1" step="0.01" value="${fx.chorus.depth}" data-k="chorus.depth">速率<input type="range" min="0.2" max="6" step="0.1" value="${fx.chorus.rate}" data-k="chorus.rate"></div>
    </div>
    <div class="fxsec">
      <div class="frow"><label><input type="checkbox" data-k="reverb.on" ${fx.reverb.on ? 'checked' : ''}>混响</label></div>
      <div class="frow">湿度<input type="range" min="0" max="1" step="0.01" value="${fx.reverb.wet}" data-k="reverb.wet">衰减<input type="range" min="0.3" max="6" step="0.1" value="${fx.reverb.decay}" data-k="reverb.decay"></div>
    </div>
    <div class="fxsec">
      <div class="frow"><label><input type="checkbox" data-k="exciter.on" ${fx.exciter.on ? 'checked' : ''}>激励器</label></div>
      <div class="frow">激励量<input type="range" min="0" max="1" step="0.01" value="${fx.exciter.amount}" data-k="exciter.amount"></div>
    </div>
    <div class="fxsec">
      <div class="frow">EQ低<input type="range" min="-12" max="12" step="0.5" value="${fx.eq.low}" data-k="eq.low">dB</div>
      <div class="frow">EQ中<input type="range" min="-12" max="12" step="0.5" value="${fx.eq.mid}" data-k="eq.mid">dB</div>
      <div class="frow">EQ高<input type="range" min="-12" max="12" step="0.5" value="${fx.eq.high}" data-k="eq.high">dB</div>
    </div>`;
  pop.style.display = 'block';
  const r2 = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r2.right + 8, window.innerWidth - 250) + 'px';
  pop.style.top = Math.min(r2.top - 10, window.innerHeight - 300) + 'px';
  pop.dataset.track = t.id;
  for (const inp of pop.querySelectorAll('input')) {
    inp.addEventListener('input', () => {
      const k = inp.dataset.k.split('.');
      const fx2 = fxOf(t);
      if (inp.type === 'checkbox') fx2[k[0]][k[1]] = inp.checked;
      else fx2[k[0]][k[1]] = parseFloat(inp.value);
      if (AC) applyFxParams(t, ensureTrackChain(t));
      const btn = document.querySelector('.fxb[data-track="' + t.id + '"]');
      if (btn) btn.classList.toggle('on', anyFxOn(t));
      invalidate();
    });
  }
}
document.addEventListener('click', e => {
  const pop = $('fxPop');
  if (!pop || !pop.style.display || pop.style.display === 'none') return;
  if (pop.contains(e.target) || e.target.closest('.fxb')) return;
  pop.style.display = 'none';
});

// ================= 工具栏接线 =================
$('btnPlay').addEventListener('click', play);
$('btnPause').addEventListener('click', pause);
$('btnStop').addEventListener('click', stop);
$('bpm').addEventListener('change', e => {
  const nb = clamp(parseFloat(e.target.value) || 120, 20, 300);
  const ob = S.project.bpm || 120;
  if (Math.abs(nb - ob) < 1e-9) return;
  pushUndo();
  const f = ob / nb;                       // BPM 变快(f>1) → 接管轨素材提速: 位置/时长缩短, Rate 加快
  const follow = new Set(S.project.whips.map(w => w.targetTrackId));
  for (const t of S.project.tracks) if (t.followBpm) follow.add(t.id);
  let n = 0;
  for (const c of S.project.clips) {
    if (!follow.has(c.trackId)) continue;   // 未开 ♩ 的轨 (BGM) 保持绝对时间
    c.start *= f; c.length *= f;
    if (c.fadeIn) c.fadeIn *= f;
    if (c.fadeOut) c.fadeOut *= f;
    c.stretch = clamp(c.stretch * f, 0.1, 16);
    ensureRender(c); n++;
  }
  for (const m of S.project.midiClips) { m.start *= f; m.length *= f; }
  S.loop.a *= f; S.loop.b *= f; S.playhead *= f;   // 循环区/播放头随节拍 (Ardour domain bounce 思路)
  S.project.bpm = nb;
  rebuildPanel(); invalidate();
  if (S.playing) { stopSources(); S.playing = false; }
  status('BPM ' + ob + ' → ' + nb + ': ♩跟随轨 ' + n + ' 块缩放重渲染, 其余轨道原位不动 (轨面板 ♩ 可开关)');
});
function setSnap(on) {   // 磁铁吸附: 主工具栏与钢琴窗共用一个状态
  S.snap = !!on;
  const b = $('snap'); if (b) b.classList.toggle('on', S.snap);
  const pb = $('prSnap'); if (pb) pb.classList.toggle('on', S.snap);
  status(S.snap ? '磁铁吸附: 开 (拖拽时按住 Shift 可临时忽略, 做微调)' : '磁铁吸附: 关 (完全自由拖动)');
}
$('snap').addEventListener('click', () => setSnap(!S.snap));
$('prSnap').addEventListener('click', () => setSnap(!S.snap));
$('grid').addEventListener('change', e => {
  const v = e.target.value;
  if (v[0] === 'b') S.grid = { mode: 'beat', div: parseFloat(v.slice(1)) };
  else S.grid = { mode: 'time', div: parseFloat(v.slice(1)) };
  invalidate();
  status('网格: ' + e.target.options[e.target.selectedIndex].text);
});
$('loopOn').addEventListener('change', e => { S.loop.on = e.target.checked; invalidate(); });
$('master').addEventListener('input', applyMixLive);
$('zoomIn').addEventListener('click', () => zoomBy(1.3));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 1.3));
$('zoomFit').addEventListener('click', zoomFit);
$('addTrack').addEventListener('click', () => addTrack());
$('fileAudio').addEventListener('change', async e => {
  const fs = [...e.target.files]; e.target.value = '';
  for (const f of fs) await uploadAndImport(f);
});
$('fileMidi').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }).then(r => r.json());
    if (j.error) throw new Error(j.error);
    if (!j.notes || !j.notes.length) throw new Error('MIDI 里没有音符');
    pushUndo();
    let tr = S.project.tracks.find(t => t.name === '参考MIDI' && S.project.midiClips.some(m => m.trackId === t.id));
    if (!tr) { S.project.tracks.push(tr = { id: uid(), name: '参考MIDI', vol: 1, pan: 0, mute: false, solo: false }); }
    pushUndo();
    const natural = Math.max(...j.notes.map(n => n.end));
    S.project.midiClips.push({ id: uid(), trackId: tr.id, name: f.name.replace(/\.[^.]+$/, ''), start: snapT(S.playhead), length: natural, notes: j.notes });
    rebuildPanel(); drawBindings();
    select({ kind: 'midi', id: S.project.midiClips[S.project.midiClips.length - 1].id });
    status('MIDI 已导入: ' + j.notes.length + ' 个音符');
  } catch (err) { status(err.message, true); }
});
$('fileProj').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  f.text().then(txt => {
    pushUndo();
    S.project = fixProject(JSON.parse(txt));
    S.lastProj = f.name; $('projname').textContent = f.name;
    afterProjectSwap('工程已打开: ' + f.name);
  }).catch(err => status('打开失败: ' + err.message, true));
});
window.addEventListener('resize', () => { invalidate(); drawBindings(); if (PR.open) prResize(); });

// ================= 启动 =================
const sess = loadSession();
if (sess) {   // 恢复上次会话 (刷新/重开浏览器不丢工程, 含 MIDI 块与音符)
  S.project = fixProject(sess.project);
  S.lastProj = sess.lastProj || null;
  if (S.lastProj) $('projname').textContent = baseName(S.lastProj);
}
fetch('/api/info').then(r => r.json()).then(j => {
  $('engine').textContent = '引擎: ' + j.engine + (j.rb ? '+rubberband' : '');
  S.rbFlag = j.rb ? 'rb' : j.engine;
  S.renderVer = j.ver;
  S.dirty = true;
  for (const c of S.project.clips) ensureRender(c);   // 服务端渲染语义升级后自动重渲染
  if (sess) {
    rebuildPanel(); drawBindings();
    for (const c of S.project.clips) peaksFor(c.src);
    zoomFit();
    status('已恢复上次会话 (工程自动存在本机, 刷新不丢) · File→加载演示工程 换回演示 · File→新建空工程 清空');
  }
});
if (!sess) {
  fetch('/api/demo-project').then(r => r.json()).then(j => {
    S.project = fixProject(j);
    rebuildPanel(); drawBindings();
    for (const c of S.project.clips) peaksFor(c.src);
    zoomFit();
    status('已加载演示工程 — 文件可直接拖进窗口导入 (ffmpeg 通吃) · 参考MIDI轨 🌀 拖到人声轨 = whip');
  }).catch(() => status('演示加载失败, 可从 File 菜单导入', true));
}
buildMenus();
rebuildPanel();
requestAnimationFrame(tick);
window.__VE = { S, seek, play, pause, undo, redo, select, clipById, midiById, trackById, invalidate, ensureRender, createWhip, applyWhip, snapT, selectionItems, importMediaPath, exportMix, saveProject, openProject, setGrid, zoomFit, persistSession, loadSession, newProject };
// ===== 实验性钢琴窗 (双击 MIDI 块; 全屏+滚动+多选; 网格与主时间线拍位对齐) =====
const PR = { open: null, drag: null, h: 0, v: 48, pps: 140, laneH: 14, sel: [], gridV: null };
const prWrap = $('prWrap'), prCv = $('prCanvas'), prG = prCv.getContext('2d');
const PR_KEYS = 64, PR_RULER = 22;

function prOpen(m) {
  PR.open = m; PR.drag = null; PR.sel = []; PR.h = 0;
  prUpdateHead();
  $('prSlide').classList.toggle('on', !!PR.slide);
  $('prSnap').classList.toggle('on', S.snap);
  if (!PR.gridV) PR.gridV = $('grid').value;   // 首次打开继承主网格, 之后独立
  $('prGrid').value = PR.gridV;
  $('prMon').checked = !!PR.monitor;
  prWrap.style.display = 'flex';
  prInitScroll();
  prResize();
}
function prUpdateHead() {   // 标题里把"块在时间轴上的位置"写清楚: 标尺是绝对时间, 所以不是从 0 起
  const m = PR.open; if (!m) return;
  const off = m.off || 0, barLen = beat() * 4;                 // 4/4
  const at = uToTL(off);
  const bar = Math.floor(at / barLen + 1e-9) + 1;
  $('prTitle').textContent = '钢琴窗 — ' + (m.name || 'MIDI')
    + ((m.trans || 0) ? ' [转调' + (m.trans > 0 ? '+' : '') + m.trans + ']' : '')
    + ' · 块头 ' + at.toFixed(3) + 's (第 ' + bar + ' 小节)'
    + (off > 1e-6 ? ' · 已裁头 ' + off.toFixed(3) + 's' : '')
    + (Math.abs((m.scale || 1) - 1) > 1e-4 ? ' · 缩放 ' + (m.scale || 1).toFixed(3) : '');
}
function prClose() {
  if (PR.open) refreshTargetsOf(PR.open.trackId);
  PR.open = null; PR.drag = null; PR.sel = [];
  prWrap.style.display = 'none';
  $('prMenu').style.display = 'none';
  invalidate();
}
$('prClose').addEventListener('click', prClose);
$('prSlide').addEventListener('click', e => {
  PR.slide = !PR.slide;
  e.target.classList.toggle('on', PR.slide);
  status(PR.slide ? '滑音模式: 新画的音符为滑音键 (覆盖长音时滑向其音高)' : '滑音模式: 关');
});
$('prMon').addEventListener('change', e => {
  PR.monitor = e.target.checked;
  stopSources(); if (S.playing) scheduleAll();
  status('试听 (chip 音色): ' + (PR.monitor ? '开 — 仅钢琴窗激活时发声, 不进外发路由' : '关'));
});

// ---- 钢琴窗网格刻度 (独立于主时间线; 头部下拉 或 标尺右键) ----
const PR_GRIDS = [['1 拍', 'b1'], ['1/2 拍', 'b0.5'], ['1/4 拍', 'b0.25'], ['1/8 拍', 'b0.125'],
                  ['1/16 拍', 'b0.0625'], ['1 秒', 't1'], ['帧 30fps', 't0.0333333']];
function prGridLabel(v) { const it = PR_GRIDS.find(o => o[1] === v); return it ? it[0] : v; }
function setPrGrid(v) {
  PR.gridV = v;
  const sel = $('prGrid'); if (sel) sel.value = v;
  prUpdateHead();
  status('钢琴窗网格: ' + prGridLabel(v) + (S.snap ? ' (吸附生效)' : ' (磁铁吸附已关 — 网格仅作参考)'));
  prDraw();
}
function prGridMenu(cx, cy) {   // 标尺右键 = 改网格刻度 (标尺上的"拍子")
  const el = $('prMenu');
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ctx-head'; head.textContent = '钢琴窗网格刻度';
  el.appendChild(head);
  for (const [label, v] of PR_GRIDS) {
    const d = document.createElement('div');
    d.className = 'ctx-item';
    d.textContent = (PR.gridV === v ? '✓ ' : '　 ') + label;
    d.addEventListener('click', () => { el.style.display = 'none'; setPrGrid(v); });
    el.appendChild(d);
  }
  el.style.display = 'block';
  el.style.left = Math.min(cx, window.innerWidth - 170) + 'px';
  el.style.top = Math.min(cy, window.innerHeight - el.offsetHeight - 10) + 'px';
}
$('prGrid').addEventListener('change', e => setPrGrid(e.target.value));

function prResize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight - 42;
  prCv.style.width = w + 'px'; prCv.style.height = h + 'px';
  if (prCv.width !== Math.round(w * dpr) || prCv.height !== Math.round(h * dpr)) {
    prCv.width = Math.round(w * dpr); prCv.height = Math.round(h * dpr);
  }
  prG.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function prSpan() { const m = PR.open; return Math.max(0.1, m.length / (m.scale || 1)); }
function prViewSec() { return (prCv.clientWidth - PR_KEYS) / PR.pps; }
function prRows() { return Math.floor((prCv.clientHeight - PR_RULER) / PR.laneH); }
function prTopPitch() { return PR.v + prRows() - 1; }
// PR.h = 横向滚动量【像素】(prU/prX/滚动条/滚轮/网格循环统一用像素, 以前混了秒 → 滚动条位置一直不对)
function prU(x) { return (PR.open.off || 0) + (PR.h + (x - PR_KEYS)) / PR.pps; }
function prX(u) { return PR_KEYS + (u - (PR.open.off || 0)) * PR.pps - PR.h; }
function prPitchAt(y) { return Math.round(prTopPitch() - (y - PR_RULER) / PR.laneH); }
function prY(p) { return PR_RULER + (prTopPitch() - p) * PR.laneH + PR.laneH / 2; }
// 自然时间 <-> 时间轴时间 (网格/标尺以时间轴拍位为准, 与主时间线对齐)
function uToTL(u) { const m = PR.open; return m.start + (u - (m.off || 0)) * (m.scale || 1); }
function tlToU(t) { const m = PR.open; return (m.off || 0) + (t - m.start) / (m.scale || 1); }
function prSnapU(u, allowGrow) {
  const m = PR.open, off = m.off || 0, sc = m.scale || 1;
  const g = prGridSec() / sc;    // 网格步长 (块内自然秒); 锚点 = 块头, 与画出的网格线同源
  const u2 = off + Math.round((u - off) / g) * g;
  return clamp(u2, off, allowGrow ? 1e7 : off + prSpan());
}
function prGrowTo(u) {   // 音符越出块尾 → MIDI 块自动加长, 保证"画得出就听得到"
  const m = PR.open, off = m.off || 0;
  if (u > off + prSpan() + 1e-6) {
    m.length = Math.max(m.length, (u - off) * (m.scale || 1));
    invalidate();
    return true;
  }
  return false;
}
function prSeekFromX(x) {   // 顶部标尺 → 时间轴【绝对时间】定位 (与外侧轨道同坐标系)
  const m = PR.open;
  const u = prU(clamp(x, PR_KEYS, prCv.clientWidth));
  const tl = clamp(uToTL(u), Math.max(0, m.start), m.start + m.length);
  seek(tl);
  prDraw();
}
// FL 式滑音: 普通键=音高台阶; 滑音键=从"当前音高"在其跨度内线性滑向自身音高,
// 滑完保持该音高 (直到下一个事件) — 所以一个长键可叠多个滑音键, 键越长滑得越慢.
function buildSlideCommands(notes, trans) {
  const tp = trans || 0;
  const evs = notes.map(n => ({
    t: +n.start, e: +n.end, p: n.midi + tp, slide: !!n.slide,
  })).sort((a, b) => (a.t - b.t) || ((a.slide ? 1 : 0) - (b.slide ? 1 : 0)));   // 同刻先普通后滑音
  return evs.map(x => x.slide
    ? { t: x.t, kind: 1, t1: Math.max(x.e, x.t + 1e-6), p: x.p }
    : { t: x.t, kind: 0, p: x.p });
}
function cmdPitch(cmds, tt) {   // 返回该时刻的半音数 (含 trans); 无事件覆盖 → null
  let cur = null, ramp = null;
  for (const c of cmds) {
    if (c.t > tt + 1e-9) break;
    if (c.kind === 0) { cur = c.p; ramp = null; }
    else { ramp = { base: (cur === null ? c.p : cur), c }; cur = c.p; }
  }
  if (ramp && tt < ramp.c.t1) {
    const { base, c } = ramp;
    return base + (c.p - base) * ((tt - c.t) / (c.t1 - c.t));
  }
  return cur;
}
function prGridDiv() {   // 钢琴窗网格: 拍数 (beat 型) 或秒数 (time 型); 0 = 时间型
  const v = PR.gridV || 'b0.25';
  return v[0] === 'b' ? parseFloat(v.slice(1)) : 0;
}
function prGridSec() {   // 钢琴窗网格换算成"时间轴秒" (与标尺/主时间线同坐标系)
  const v = PR.gridV || 'b0.25';
  return v[0] === 'b' ? beat() * parseFloat(v.slice(1)) : parseFloat(v.slice(1));
}
function prClampScroll() {
  PR.h = clamp(PR.h, 0, Math.max(0, prSpan() * PR.pps - (prCv.clientWidth - PR_KEYS) + 2));
  PR.v = clamp(PR.v, -4, 127 - prRows() + 5);
}
function prFollow() {   // 播放时钢琴窗跟着播放头滚 (与主时间线同一套做法: 越过右侧 60px 就把它放回 25% 处)
  const m = PR.open;
  if (!m) return;
  const uRel = (curPos() - m.start) / (m.scale || 1);        // 块内自然时间
  const span = m.length / (m.scale || 1);
  if (uRel < -0.05 || uRel > span + 0.05) return;            // 播放头不在本块内 → 不滚
  const avail = prCv.clientWidth - PR_KEYS;
  const rel = uRel * PR.pps - PR.h;                          // 视口内像素位置
  if (rel > avail - 60 || rel < 0)
    PR.h = clamp(uRel * PR.pps - avail * 0.25, 0, Math.max(0, prSpan() * PR.pps - avail + 2));
}
function prInitScroll() {
  const m = PR.open;
  const ps = m.notes.map(n => n.midi);
  const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
  PR.pps = 140; PR.h = 0;
  PR.v = clamp(mid - prRows() / 2, -4, 127);
}

function prDraw() {
  prResize();
  if (!PR.open) return;
  const m = PR.open;
  const W = prCv.clientWidth, H = prCv.clientHeight;
  const g = prG;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#12151a'; g.fillRect(0, 0, W, H);
  prClampScroll();
  const rows = prRows(), top = prTopPitch(), laneH = PR.laneH;
  // 钢琴窗自己的网格刻度 (头部 select / 标尺右键可切): 小节 / 拍 / 细分 三级.
  // 刻度是【块内时间】: 0 = 块头, 小节 1 = 块头 —— MIDI 块彼此离散, 每块从自己的 0 开始数.
  const mOff = m.off || 0, mSc = m.scale || 1;
  const gU = prGridSec() / mSc;                                       // 网格步长 (块内自然秒)
  const gdiv = prGridDiv();
  const perBeat = gdiv > 0 ? Math.max(1, Math.round(1 / gdiv)) : 0;   // 每拍几条 (时间型网格 = 0)
  const perBar = perBeat * 4;                                         // 4/4
  const showSub = perBeat === 0 || PR.pps * gU >= 5;                  // 太密就不画细分线
  g.font = '10px ui-monospace,monospace'; g.textBaseline = 'middle';
  // 视口范围 (块内自然秒)
  const gi0 = Math.floor(PR.h / (gU * PR.pps)), gi1 = Math.ceil((PR.h + prViewSec() * PR.pps) / (gU * PR.pps));
  const uAt = gi => mOff + gi * gU;
  // 时间网格
  for (let gi = gi0; gi <= gi1; gi++) {
    const u = uAt(gi), x = prX(u);
    if (x < PR_KEYS - 1 || x > W) continue;
    const onBar = perBeat > 0 && gi % perBar === 0;
    const onBeat = perBeat > 0 && gi % perBeat === 0;
    if (!onBeat && !showSub) continue;
    g.strokeStyle = onBar ? '#2b3342' : onBeat ? '#232b38' : '#191e27';
    g.beginPath(); g.moveTo(x, PR_RULER); g.lineTo(x, H); g.stroke();
    if (onBar) {
      g.fillStyle = '#94a3b8';
      g.fillText(String(gi / perBar + 1), x + 4, PR_RULER / 2);
    } else if (perBeat === 0 && Math.abs(u - mOff - Math.round(u - mOff)) < 1e-6 && PR.pps >= 24) {
      g.fillStyle = '#94a3b8';                             // 时间型网格: 标整秒 (块内)
      g.fillText((u - mOff).toFixed(0) + 's', x + 4, PR_RULER / 2);
    }
  }
  // 标尺条
  g.fillStyle = '#161a22'; g.fillRect(0, 0, W, PR_RULER);
  for (let gi = gi0; gi <= gi1; gi++) {
    const u = uAt(gi), x = prX(u);
    if (x < PR_KEYS - 1 || x > W) continue;
    const onBar = perBeat > 0 && gi % perBar === 0;
    const onBeat = perBeat > 0 && gi % perBeat === 0;
    if (!onBeat && !showSub) continue;
    g.strokeStyle = onBar ? '#3b4657' : onBeat ? '#222834' : '#1e2430';
    g.beginPath(); g.moveTo(x, onBar ? 4 : onBeat ? 12 : 17); g.lineTo(x, PR_RULER); g.stroke();
    if (onBar) { g.fillStyle = '#94a3b8'; g.fillText(String(gi / perBar + 1), x + 4, 8); }
  }
  // 钢琴键 + 行
  for (let r = 0; r < rows; r++) {
    const p = PR.v + r, y = PR_RULER + (top - p) * laneH;
    if (p < 0 || p > 127) continue;
    const black = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    g.fillStyle = black ? '#161a22' : '#262a32';   // 白键比黑键亮一档, 键盘要能一眼读出
    g.fillRect(0, y, PR_KEYS, laneH);
    g.fillStyle = black ? '#0b0e13' : '#1d222d';
    g.fillRect(0, y, PR_KEYS - 8, laneH);
    if (((p % 12) + 12) % 12 === 0) {
      g.fillStyle = '#94a3b8'; g.font = '9px ui-monospace,monospace'; g.textBaseline = 'middle';
      g.fillText('C' + (Math.floor(p / 12) - 1), 4, y + laneH / 2);
    }
    g.strokeStyle = '#2b3342'; g.beginPath(); g.moveTo(PR_KEYS, y); g.lineTo(W, y); g.stroke();
  }
  g.strokeStyle = '#2b3342'; g.beginPath(); g.moveTo(PR_KEYS, PR_RULER); g.lineTo(PR_KEYS, H); g.stroke();
  // 音符
  const tpM = m.trans || 0;
  const slideCmds = m.notes.some(n2 => n2.slide) ? buildSlideCommands(m.notes, tpM) : null;
  const yOf = pp => PR_RULER + (top - pp) * laneH + laneH / 2;
  for (const n of m.notes) {
    const x = prX(n.start), w = Math.max(3, (n.end - n.start) * PR.pps);
    if (x + w < PR_KEYS || x > W) continue;
    const y = PR_RULER + (top - n.midi) * laneH;
    if (y + laneH < PR_RULER || y > H) continue;
    const nSel = PR.sel.includes(n);   // 不叫 isSel: 别遮蔽全局 isSel() 函数
    const hN = Math.max(2, laneH - 1);
    if (n.slide) {
      // 滑音键: 半透明填充 + 1px 描边 + 真实滑音轨迹 (起点=当前音高 → 终点=本键音高)
      const hitP = slideCmds ? cmdPitch(slideCmds, n.start) : null;
      const base = (hitP === null ? n.midi : hitP - tpM);
      g.fillStyle = nSel ? 'rgba(249,115,22,.40)' : 'rgba(249,115,22,.20)';
      g.fillRect(x, y, w, hN);
      g.strokeStyle = nSel ? '#fdba74' : '#f97316';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), hN - 1);
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, yOf(base)); g.lineTo(x + w, yOf(n.midi)); g.stroke();
      g.lineWidth = 1;
    } else {
      g.fillStyle = nSel ? 'rgba(168,85,247,.42)' : 'rgba(168,85,247,.20)';
      g.fillRect(x, y, w, hN);
      g.strokeStyle = nSel ? '#c4a3ff' : '#a855f7';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), hN - 1);
    }
    // 右缘把手 (拉伸用, 滑音键也要看得见)
    g.fillStyle = 'rgba(248,250,252,.55)';
    g.fillRect(x + Math.max(0, w - 2), y, 2, hN);
  }
  // 播放头 (播放中要用 curPos(): S.playhead 只在 seek/暂停时落值)
  const phTL = (S.playing ? curPos() : S.playhead) - m.start;
  if (phTL >= 0 && phTL <= m.length) {
    const u = (m.off || 0) + phTL / (m.scale || 1);
    const px = prX(u);
    g.strokeStyle = '#f43f5e'; g.beginPath(); g.moveTo(px, PR_RULER); g.lineTo(px, H); g.stroke();
  }
  // 框选虚线
  if (PR.drag && PR.drag.mode === 'prmarquee') {
    const d = PR.drag;
    g.strokeStyle = '#3b82f6'; g.setLineDash([5, 4]);
    g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g.setLineDash([]);
  }
  // 横向滚动条
  const SB = 10, totPx = prSpan() * PR.pps, avail = W - PR_KEYS;
  if (totPx > avail) {
    const tw = Math.max(30, avail / totPx * avail);
    const tx = PR_KEYS + (PR.h / totPx) * avail;
    g.fillStyle = '#12151a'; g.fillRect(PR_KEYS, H - SB, avail, SB);
    g.fillStyle = '#2f3b4d'; g.fillRect(tx, H - SB + 2, tw, SB - 4);
  }
}
function prHit(x, y) {
  const m = PR.open;
  for (let i = m.notes.length - 1; i >= 0; i--) {
    const n = m.notes[i];
    const nx = prX(n.start), nw = Math.max(3, (n.end - n.start) * PR.pps);
    const ny = prY(n.midi) - PR.laneH / 2, nh = PR.laneH;
    // 右缘把手: 音符够宽(≥10px)才留拉伸区, 否则整块都算"移动" — 短音符也拖得动
    const rz = nw >= 10 ? Math.min(6, nw * 0.3) : 0;
    if (x >= nx && x <= nx + nw && y >= ny && y <= ny + nh)
      return { n, i, resize: rz > 0 && x > nx + nw - rz };
  }
  return null;
}
prCv.addEventListener('contextmenu', e => e.preventDefault());
prCv.addEventListener('pointerdown', e => {
  if (!PR.open) return;
  const r2 = prCv.getBoundingClientRect();
  const x = e.clientX - r2.left, y = e.clientY - r2.top;
  $('prMenu').style.display = 'none';
  try { prCv.setPointerCapture(e.pointerId); } catch (err) {}
  if (e.button === 2) {
    if (y < PR_RULER && x >= PR_KEYS) { prGridMenu(e.clientX, e.clientY); return; }   // 标尺右键 = 改网格刻度
    PR.drag = { mode: 'prmarquee', x0: x, y0: y - PR_RULER, x1: x, y1: y - PR_RULER };  // 其余位置右键拖 = 框选
    return;
  }
  if (e.button !== 0) return;
  // 顶部标尺: 点/拖 = 播放头定位到该绝对时刻 (与外侧时间线同步) — 不再误建音符
  if (y < PR_RULER && x >= PR_KEYS) { PR.drag = { mode: 'prscrub' }; prSeekFromX(x); return; }
  if (x < PR_KEYS) { bleep(prPitchAt(y), 0.45); return; }   // 左侧键盘列: 点一下听这个键 (不建音符)
  pushUndo();
  const hit = prHit(x, y);
  if (hit && e.altKey) {   // 删除
    PR.open.notes.splice(hit.i, 1);
    PR.sel = PR.sel.filter(n2 => n2 !== hit.n);
    refreshTargetsOf(PR.open.trackId); invalidate(); prDraw(); return;
  }
  if (hit) {
    if (e.ctrlKey || e.metaKey) {   // Ctrl+点 = 加选/减选
      if (PR.sel.includes(hit.n)) PR.sel = PR.sel.filter(n2 => n2 !== hit.n);
      else PR.sel.push(hit.n);
      PR.drag = { mode: 'idle' };
      prDraw(); return;
    }
    if (!PR.sel.includes(hit.n)) PR.sel = [hit.n];
    PR.drag = {
      mode: hit.resize ? 'resize' : 'move', n: hit.n,
      grabUabs: prU(x), grabP: prPitchAt(y),
      orig: PR.sel.map(n2 => ({ n: n2, start: n2.start, midi: n2.midi, len: n2.end - n2.start })),
      len0: hit.n.end - hit.n.start, changed: false,
    };
    return;
  }
  PR.sel = [];   // 空白: 清多选 + 新增音符
  const u0 = Math.max((PR.open.off || 0), prU(x));
  const u = e.shiftKey ? u0 : prSnapU(u0, true);
  const p = clamp(prPitchAt(y), 0, 127);
  const len = prGridSec() / (PR.open.scale || 1);
  const n = { start: u, end: u + len, midi: p, slide: !!PR.slide };
  PR.open.notes.push(n);
  PR.sel = [n];
  bleep(p);                                   // 建键即发声: 按下就知道是什么音
  PR.drag = { mode: 'resize', n, changed: true };
  refreshTargetsOf(PR.open.trackId); invalidate(); prDraw();
});
prCv.addEventListener('pointermove', e => {
  if (!PR.open) return;
  const r2 = prCv.getBoundingClientRect();
  const x = e.clientX - r2.left, y = e.clientY - r2.top;
  if (!PR.drag) {
    const hit = prHit(x, y);
    prCv.style.cursor = hit ? (hit.resize ? 'ew-resize' : 'move') : 'crosshair';
    return;
  }
  const d = PR.drag, m = PR.open;
  if (d.mode === 'prmarquee') {
    d.x1 = x; d.y1 = y - PR_RULER; prDraw(); return;
  }
  if (d.mode === 'prscrub') { prSeekFromX(x); return; }
  if (d.mode === 'idle') return;
  if (d.mode === 'move') {   // 整组平移 (吸附到时间轴网格; Shift = 临时忽略吸附)
    const dU = prU(x) - d.grabUabs;                 // 块内自然时间增量
    const sc = m.scale || 1, gU = prGridSec() / sc, off0 = m.off || 0;
    const g0 = d.orig.find(o2 => o2.n === d.n) || d.orig[0];
    if (!g0) { prDraw(); return; }
    // 以"被抓的那个音符"的【目标位置】吸附到块内网格, 整组按同一增量走 (组内相对间距不变) ——
    // 拖一下就能把偏掉的音符吸回网格线; 锚点与画出的网格线一致 (0 = 块头)
    const dAbs = (S.snap && !e.shiftKey)
      ? (Math.round((g0.start + dU - off0) / gU) * gU + off0) - g0.start
      : dU;
    const dP = prPitchAt(y) - d.grabP;   // 屏幕上"往上"= 音高更高 (与 prY 的 y 方向相反)
    let maxEnd = 0;
    const pBefore = d.n ? d.n.midi : null;
    for (const o2 of d.orig) {
      o2.n.start = clamp(o2.start + dAbs, off0, 1e6);
      // 移动要保持时值: start 与 end 一起走 (以前只改 start → 音符被压扁/拉长, 横拖一下就成碎片)
      o2.n.end = o2.n.start + o2.len;
      o2.n.midi = clamp(o2.midi + dP, 0, 127);
      maxEnd = Math.max(maxEnd, o2.n.end);
    }
    if (d.n && pBefore !== null && d.n.midi !== pBefore) bleep(d.n.midi);   // 上下拖改音高 → 边拖边出声
    if (prGrowTo(maxEnd)) d.grew = true;   // 拖出块尾 → 块跟着长
    d.changed = true;
    prDraw(); return;
  }
  if (d.mode === 'resize') {
    // 拖右缘: 向右不设上限 (越出块尾 → 块自动加长); Shift = 忽略吸附做微调
    const raw = Math.max(prU(x), d.n.start + 0.02);
    const ne = Math.max(d.n.start + 0.02, e.shiftKey ? raw : prSnapU(raw, true));
    if (ne !== d.n.end) { d.n.end = ne; d.changed = true; }
    if (prGrowTo(d.n.end)) d.grew = true;
    prDraw(); return;
  }
});
prCv.addEventListener('pointerup', () => {
  if (!PR.drag) return;
  const d = PR.drag; PR.drag = null;
  if (d.mode === 'prmarquee') {   // 框选: 命中矩形内的音符
    const u0 = prU(Math.min(d.x0, d.x1)), u1 = prU(Math.max(d.x0, d.x1));
    const pTop = prPitchAt(Math.min(d.y0, d.y1) + PR_RULER), pBot = prPitchAt(Math.max(d.y0, d.y1) + PR_RULER);
    const pHi = Math.max(pTop, pBot), pLo = Math.min(pTop, pBot);
    PR.sel = PR.open.notes.filter(n => n.end > u0 && n.start < u1 && n.midi >= pLo && n.midi <= pHi);
    status('框选 ' + PR.sel.length + ' 个音符');
    prDraw(); return;
  }
  if (d.changed) refreshTargetsOf(PR.open.trackId);
});
prCv.addEventListener('wheel', e => {
  if (!PR.open) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    PR.pps = clamp(PR.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 20, 600);
  } else if (e.shiftKey) {
    PR.h = clamp(PR.h + (e.deltaX || e.deltaY), 0, Math.max(0, prSpan() * PR.pps - (prCv.clientWidth - PR_KEYS) + 2));
  } else {
    PR.v = clamp(PR.v - Math.round(e.deltaY / 30), -4, 127 - prRows() + 5);
  }
  prDraw();
}, { passive: false });

window.__errs = [];
window.addEventListener('error', e => { window.__errs.push('ERR: ' + e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno); if (window.__errs.length > 20) window.__errs.shift(); });
window.addEventListener('unhandledrejection', e => { const r = e.reason; window.__errs.push('REJ: ' + (r && r.message ? r.message : r) + ' ||| ' + String(r && r.stack || '').split('\n').slice(0, 3).join(' <- ')); if (window.__errs.length > 20) window.__errs.shift(); });
window.__restoreProject = (p) => { S.project = fixProject(p); S.lastProj = 'restored'; rebuildPanel(); drawBindings(); invalidate(); for (const c of S.project.clips) ensureRender(c); };
window.__PR = () => ({ open: PR.open ? PR.open.name : null, drag: PR.drag ? { mode: PR.drag.mode, grabU: PR.drag.grabU, len0: PR.drag.len0, nStart: PR.drag.n ? PR.drag.n.start : null, nMidi: PR.drag.n ? PR.drag.n.midi : null } : null, pps: +PR.pps.toFixed(1), h: +PR.h.toFixed(2), v: +PR.v.toFixed(2), laneH: PR.laneH });
window.__PRNotes = () => {
  if (!PR.open) return null;
  return {
    dbg: { v: PR.v, rows: prRows(), top: prTopPitch(), ch: prCv.clientHeight, cw: prCv.clientWidth, pps: PR.pps, laneH: PR.laneH },
    selCount: PR.sel.length,
    notes: PR.open.notes.map(n => ({ midi: n.midi, start: +n.start.toFixed(3), x: +prX(n.start).toFixed(1), y: +prY(n.midi).toFixed(1), w: +((n.end - n.start) * PR.pps).toFixed(1), laneH: +PR.laneH.toFixed(1) })),
  };
};
window.__audbg = () => ({
  ac: AC ? AC.state : null, acTime: AC ? +AC.currentTime.toFixed(2) : null,
  master: masterGain ? +masterGain.gain.value : null,
  chains: Object.fromEntries([...trackChains.entries()].map(([id, c]) => [id, { out: +c.out.gain.value, pan: +c.pan.pan.value }])),
  active: active.length, buffers: S.buffers.size, pend: (S.project.clips.filter(c => c._pend)).length,
  playing: S.playing, playhead: +S.playhead.toFixed(2),
});