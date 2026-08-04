# FastCUA

**面向 AI Agent 的本地、元素优先 Windows 控制平面。**

[网站](https://guojiz.github.io/FastCUA/) · [English](README.md) · [技术论文](docs/TECHNICAL_PAPER.md) · [下一步设计](docs/NEXT_DESIGN.md)

> [!WARNING]
> FastCUA 仍是快速开发中的实验项目。请只用于测试，不要用于重要或无人值守的工作。

FastCUA 为 Agent 提供一套快速、可审计的 Windows 应用接口。它优先读取 Windows UI Automation 文本；当语义信息不足时，再切换到截图和正方形数字网格；相关的多个原生动作由一个常驻本地运行时执行。人类可以通过可见状态、按应用审批、全局暂停、插话和退出控制始终掌握电脑。

FastCUA 不绑定某一家 Agent，但完整安装必须在**同一个 Agent 宿主**内同时具备：

1. 完整的 `skills/computer-use/` 操作规范；
2. `sky-computer-use` stdio MCP Server。

只装 MCP 等于有能力却缺少必要操作规范；只装 Skill 则没有执行器。

## 模型要求

只使用**一个五官齐全的主模型**：理解文本和图像、可靠推理、调用 Skill 与 MCP，并保留完成整个任务所需的上下文。录制旁白时最好能原生理解音频，否则使用文字笔记。不再配置 writer、转写、备用或纯文本模型。

## 为什么使用 FastCUA

| | 视觉优先 Computer Use | 浏览器自动化 | FastCUA |
|---|---|---|---|
| 主要观察方式 | 截图 | DOM/CDP | UIA 文本，不足时再用视觉 |
| 范围 | 任意可见界面 | 网页内容 | Windows 应用、浏览器外壳、跨应用流程 |
| 执行方式 | 通常每轮一个动作 | 浏览器命令 | 一个模型回合执行多个原生动作 |
| 运行时状态 | 常按调用重建 | 浏览器会话 | 一个常驻 daemon 与原生 host |
| 人类接管 | 取决于集成 | 仅限浏览器 | 全局暂停、插话、审批、退出 |

FastCUA 是网页内自动化的补充，不是替代品。

## 架构

```mermaid
flowchart TB
  A["Agent 宿主 + computer-use Skill"] -->|"stdio MCP"| B["server.mjs"]
  B -->|"按路径隔离的命名管道"| C["常驻 daemon"]
  C --> D["Rust 原生 host"]
  D --> E["UI Automation / HWND"]
  D --> F["截图 / 正方形网格"]
  D --> G["键盘 / 鼠标输入"]
  C --> H["审批 / 暂停 / 插话"]
```

所有客户端共享一个 daemon、策略状态和物理光标。持久化 `js` cell 可在一个模型回合内执行一组相关 `sky.*` 动作；目标过期、焦点或光标变化、坐标越界、超时和人类控制信号都会停止执行。

## 定位逻辑

先调用 `get_window_state({include_text:true})` 并读取 `state.uia`：

| 观察结果 | 必须采取的动作 |
|---|---|
| `quality:"good"`，目标有名称和有效边界 | 点击当前快照的 `element_index` |
| `prefer_vision:true`、`weak`、`broken`、`[no-hit]`，或一次索引过期 | 停止语义点击，调用 `grid_view` |

视觉操控遵循**观察 → 选择 → 细分 → 提交**：

1. `grid_view({window})` 返回一张带正方形数字格的窗口图。
2. 看图后选择包含目标的格号。选择只是判断，不会产生输入。
3. 若目标没有安全地落在格子中心，调用 `grid_refine({window,grid,cell})`；它只裁出该格并重新画 3×3，可继续细分。
4. 只提交一次：格子中心用 `click_cell({window,grid,cell})`，格内偏移用 `click_in_cell({window,grid,cell,x,y,view})`，当前图或裁剪图中的精确位置用 `click_view({window,view,x,y})`。
5. 任何可能改变布局或焦点的动作后重新观察。

坐标始终属于当前窗口图或裁剪图，原点在左上角。helper 会反算截图缩放并拒绝窗口外坐标。完整机制与论证见[技术论文](docs/TECHNICAL_PAPER.md#4-observation-semantics-first-pixels-when-needed)。

## 安装

统一使用 PowerShell 安装器。它会在需要时通过 WinGet 安装 Node.js，从 GitHub Release 下载运行时并校验哈希：

```powershell
irm https://raw.githubusercontent.com/Guojiz/FastCUA/main/install.ps1 | iex
```

经过校验的安装器会在桌面生成 `FastCUA Agent Setup.txt`。把它交给真正要使用 FastCUA 的 Agent。该 Agent 必须：

1. 把完整 `skills\computer-use` 文件夹安装到自己的 Skill 系统；
2. 把 Node.js + 已安装的 `server.mjs` 配置为 `sky-computer-use` MCP；
3. 重新加载并确认 Skill 可被发现；
4. 成功调用 `list_windows`。

Skill 或 MCP 缺少任何一个，安装都不完整。

### 验证与更新

```powershell
& "$env:LOCALAPPDATA\FastCUA\asͼ��h��춻�q�^wn。',
    copy: '复制', copied: '已复制',
    deployNote: '使用无 Display Overlay 的 native host 时，请将二进制保留在本机，并把 overlayEnabled 设为 false。验证与安全说明见自部署指南。',
    emptyActivity: '等待下一次桌面操作', emptyApproved: '还没有审批记录',
    helperLive: '原生 helper 在线', helperIdle: '等待第一条请求',
    unavailable: '无法连接', tryAgain: '请启动 daemon 后重试',
  },
  en: {
    brandSub: 'Desktop automation control plane', connecting: 'Connecting', online: 'Local daemon connected', offline: 'Daemon offline',
    navConsole: 'Control center', navDeploy: 'Self-host',
    eyebrow: 'A persistent desktop control plane',
    heroTitle: 'One warm helper. Every desktop action stays in rhythm.',
    heroBody: 'FastCUA keeps a single native host alive so every connected client can automate the desktop with less setup and more continuity.',
    kpiWarm: 'shared warm helper', kpiProtocol: 'transparent local protocol', kpiStop: 'instant turn recovery',
    statusTitle: 'System pulse', statusWaiting: 'Waiting for daemon', statusLive: 'Ready for desktop actions',
    statusPaused: 'Paused by user', statusApproval: 'Awaiting approval',
    portLabel: 'Local endpoint',
    metricClients: 'Connected clients', metricClientsHint: 'shared session count',
    metricHelper: 'Native helper', metricHelperHint: 'one cursor, one state',
    metricApproved: 'Approved apps', metricApprovedHint: 'cached across clients',
    metricUptime: 'Uptime', metricUptimeHint: 'daemon lifetime',
    activityTitle: 'Action timeline', activityBody: 'Recent requests across connected clients.',
    approvedTitle: 'Approval memory', approvedBody: 'Apps approved for the shared helper.',
    refresh: 'Refresh', clear: 'Clear',
    runtimeTitle: 'Runtime & safety',
    runtimeBody: 'Settings stay local. Port and helper path changes need a daemon restart.',
    pause: 'Pause control', resume: 'Resume control', killHelper: 'Stop helper', shutdown: 'Exit FastCUA', restart: 'Restart daemon',
    allowOnce: '1 · Allow once', trustApp: '2 · Always approve', fullAccess: '3 · Full access', deny: '4 · Deny',
    costartLabel: 'Start policy', costartClaude: 'On demand', costartLogin: 'At sign-in', costartManual: 'Manual',
    costartDesc: { claude: 'Starts on the first MCP request.', login: 'Stays available after Windows sign-in.', manual: 'Runs only when you start the daemon.' },
    approvalLabel: 'Approval policy', approvalSafe: 'Safe access', approvalFull: 'Full access',
    approvalHelp: 'Safe: unknown apps need approval. Full: no prompts (high risk).',
    idleLabel: 'Idle shutdown (minutes)', idleHelp: 'Use 0 to keep the daemon alive.',
    portHelp: 'Restart the daemon after changing this value.',
    helperLabel: 'Native helper path', helperHelp: 'Leave empty to auto-discover; CUA_BIN takes precedence.',
    overlayLabel: 'Enable FastCUA status overlay', overlayHelp: 'Disable when using the native no-display host.',
    overlayTitleLabel: 'Overlay title',
    whitelistLabel: 'Whitelist', whitelistHelp: 'One executable name or absolute path per line.',
    save: 'Save settings', saved: 'Saved', localOnly: 'Runs locally on your Windows desktop',
    deployEyebrow: 'Repeatable self-hosting',
    deployTitle: 'From clone to first desktop action in four clear steps.',
    deployBody: 'A local daemon, a compatible native helper, and one MCP entry point. No cloud control plane required.',
    step1Title: 'Prepare Windows', step1Body: 'Install Node.js 18+ and place a compatible helper on the machine.',
    step2Title: 'Clone and configure', step2Body: 'Set the helper path in config.json or use CUA_BIN for a local override.',
    step3Title: 'Start the control plane', step3Body: 'Run the daemon, then verify its local health endpoint before connecting a client.',
    quickStartTitle: 'Quick start', quickStartBody: 'Built for copy, paste, verify.',
    mcpTitle: 'Connect an MCP client', mcpBody: 'Point your client to the thin stdio server; it reuses the shared daemon.',
    copy: 'Copy', copied: 'Copied',
    deployNote: 'For the native no-display host, keep the binary local and set overlayEnabled to false. See the self-hosting guide for verification and safety notes.',
    emptyActivity: 'Waiting for the next desktop action', emptyApproved: 'No approvals yet',
    helperLive: 'Native helper online', helperIdle: 'Waiting for first request',
    unavailable: 'Unavailable', tryAgain: 'Start the daemon and try again',
  }
};

const $ = (id) => document.getElementById(id);
let cfg = {};
let lang = localStorage.getItem('fastcua-lang') || ((navigator.language || '').startsWith('zh') ? 'zh' : 'en');
let events = [];
let pendingApproval = null;

const t = (k) => {
  const v = I18N[lang] && I18N[lang][k];
  return v == null ? k : v;
};

const api = (path, body) => fetch(path, body ? {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
} : undefined).then(async (r) => {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
});

function applyLanguage() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = 'FastCUA · ' + (lang === 'zh' ? '控制中心' : 'Control Center');
  $('locale').textContent = lang === 'zh' ? 'EN' : '中文';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = t(el.dataset.i18n);
    if (typeof v === 'string') el.textContent = v;
  });
  if (cfg.costartMode && t('costartDesc') && typeof t('costartDesc') === 'object') {
    $('costart-desc').textContent = t('costartDesc')[cfg.costartMode] || '';
  }
  renderEvents();
}

function selectSegment(id, value) {
  const group = $(id);
  if (!group) return;
  [...group.children].forEach((button) => button.classList.toggle('active', button.dataset.v === value));
  group.onclick = (e) => {
    if (!e.target.dataset.v) return;
    [...group.children].forEach((button) => button.classList.remove('active'));
    e.target.classList.add('active');
    if (id === 'costart' && t('costartDesc') && typeof t('costartDesc') === 'object') {
      $('costart-desc').textContent = t('costartDesc')[e.target.dataset.v] || '';
    }
  };
}

function renderEvents() {
  const box = $('activity');
  box.replaceChildren();
  if (!events.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = t('emptyActivity');
    box.append(e);
    return;
  }
  events.slice(-40).reverse().forEach((event) => {
    const row = document.createElement('div');
    row.className = 'event';
    const dot = document.createElement('span');
    dot.className = 'event-dot ' + (event.ok === false ? 'bad' : event.type === 'action_end' ? 'ok' : '');
    const text = document.createElement('div');
    const a = document.createElement('div');
    a.className = 'action';
    a.textContent = event.action || event.type || 'event';
    const s = document.createElement('div');
    s.className = 'summary';
    s.textContent = event.summary || event.error || event.client || '';
    text.append(a, s);
    const time = document.createElement('time');
    time.textContent = new Date(event.ts || Date.now()).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    row.append(dot, text, time);
    box.append(row);
  });
}

function renderApproved(apps) {
  const box = $('approved');
  box.replaceChildren();
  if (!apps || !apps.length) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = t('emptyApproved');
    box.append(empty);
    return;
  }
  apps.forEach((app) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = app;
    box.append(chip);
  });
}

function setPulse(state) {
  const control = state.controlState || 'running';
  const hasPending = (state.pendingApprovals || []).length > 0;
  if (control === 'paused_by_user') {
    $('dot').className = 'dot paused';
    $('big-status').textContent = t('statusPaused');
    $('status-copy').textContent = t('statusPaused');
    $('act-pause').hidden = true;
    $('act-resume').hidden = false;
  } else if (hasPending || control === 'awaiting_approval') {
    $('dot').className = 'dot approval';
    $('big-status').textContent = t('statusApproval');
    $('status-copy').textContent = t('statusApproval');
    $('act-pause').hidden = false;
    $('act-resume').hidden = true;
  } else {
    $('dot').className = 'dot live';
    $('big-status').textContent = state.binaryPid ? t('helperLive') : t('helperIdle');
    $('status-copy').textContent = state.binaryPid ? t('statusLive') : t('statusWaiting');
    $('act-pause').hidden = false;
    $('act-resume').hidden = true;
  }
  pendingApproval = (state.pendingApprovals || [])[0] || null;
  const callout = $('approval-callout');
  if (pendingApproval) {
    callout.hidden = false;
    $('pending-app').textContent = pendingApproval.app || pendingApproval.summary || 'app';
  } else {
    callout.hidden = true;
  }
}

async function load() {
  cfg = await api('/api/config');
  selectSegment('costart', cfg.costartMode || 'claude');
  selectSegment('approval', cfg.approvalPolicy === 'full' ? 'full' : 'safe');
  $('idle').value = cfg.idleTimeoutMin;
  $('port').value = cfg.port;
  $('whitelist').value = (cfg.whitelist || []).join('\n');
  $('overlay-en').checked = cfg.overlayEnabled !== false;
  $('overlay-title').value = cfg.overlayTitle || '';
  $('cuabin').value = cfg.cuaBinPath || '';
  applyLanguage();
}

async function refresh() {
  try {
    const [state, feed] = await Promise.all([
      api('/api/state'),
      api('/api/events?since=0'),
    ]);
    events = feed.events || [];
    $('connection').textContent = t('online');
    const version = state.runtime?.version || '—';
    $('version-pill').textContent = state.update?.status === 'available'
      ? `v${version} → v${state.update.latestVersion}`
      : `v${version}`;
    $('version-pill').title = state.update?.status === 'available'
      ? 'Update available - run & "$env:LOCALAPPDATA\\FastCUA\\app\\install.ps1" -Action Update'
      : (state.runtime?.root || '');
    $('endpoint').textContent = '127.0.0.1:' + (cfg.port || 8420);
    $('s-clients').textContent = state.clients;
    $('s-binary').textContent = state.binaryPid ? (lang === 'zh' ? '运行' : 'Live') : (lang === 'zh' ? '空闲' : 'Idle');
    $('s-approved').textContent = (state.approvedApps || []).length;
    $('s-uptime').textContent = state.uptime || '—';
    setPulse(state);
    renderApproved(state.approvedApps || []);
    renderEvents();
  } catch {
    $('dot').className = 'dot';
    $('connection').textContent = t('offline');
    $('big-status').textContent = t('unavailable');
    $('status-copy').textContent = t('tryAgain');
    $('act-pause').hidden = false;
    $('act-resume').hidden = true;
    $('approval-callout').hidden = true;
  }
}

async function save() {
  const costart = [...$('costart').children].find((b) => b.classList.contains('active'))?.dataset.v;
  const approval = [...$('approval').children].find((b) => b.classList.contains('active'))?.dataset.v;
  cfg = await api('/api/config', {
    costartMode: costart,
    approvalPolicy: approval,
    idleTimeoutMin: +$('idle').value,
    port: +$('port').value,
    whitelist: $('whitelist').value.split('\n').map((s) => s.trim()).filter(Boolean),
    bannerEnabled: !!cfg.bannerEnabled,
    overlayEnabled: $('overlay-en').checked,
    overlayTitle: $('overlay-title').value,
    overlayLanguage: cfg.overlayLanguage || 'auto',
    cuaBinPath: $('cuabin').value.trim(),
  });
  $('saved').classList.add('show');
  setTimeout(() => $('saved').classList.remove('show'), 1500);
  applyLanguage();
  await refresh();
}

async function control(action, token) {
  await api('/api/action', { action, token });
  await refresh();
}

document.querySelectorAll('.nav button').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === button.dataset.view));
  };
});
$('locale').onclick = () => {
  lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('fastcua-lang', lang);
  applyLanguage();
  refresh();
};
$('save').onclick = () => save().catch((error) => alert(error.message));
$('act-pause').onclick = () => control('pause').catch((error) => alert(error.message));
$('act-resume').onclick = () => control('resume').catch((error) => alert(error.message));
$('approve-once').onclick = () => pendingApproval && control('allowOnce', pendingApproval.token).catch((e) => alert(e.message));
$('approve-trust').onclick = () => pendingApproval && control('alwaysApprove', pendingApproval.token).catch((e) => alert(e.message));
$('approve-full').onclick = () => pendingApproval && control('fullAccess', pendingApproval.token).catch((e) => alert(e.message));
$('approve-deny').onclick = () => pendingApproval && control('denyApproval', pendingApproval.token).catch((e) => alert(e.message));
$('act-shutdown').onclick = () => api('/api/action', { action: 'shutdown' }).catch(() => {});
$('act-restart').onclick = () => api('/api/action', { action: 'restart' }).catch(() => {});
$('act-killbin').onclick = () => control('killBinary').catch((error) => alert(error.message));
$('act-clear').onclick = () => control('clearApprovals').catch((error) => alert(error.message));
$('clear-events').onclick = refresh;
document.querySelectorAll('.copy').forEach((button) => {
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText($(button.dataset.copy).textContent);
      const before = button.textContent;
      button.textContent = t('copied');
      setTimeout(() => { button.textContent = before; }, 1200);
    } catch {}
  };
});

// Approval keyboard: 1 once / 2 always / 3 full access / 4 deny (skip when typing in a field)
document.addEventListener('keydown', (event) => {
  if (!pendingApproval) return;
  const tag = (event.target && event.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
  if (event.key === '1') {
    event.preventDefault();
    control('allowOnce', pendingApproval.token).catch((e) => alert(e.message));
  } else if (event.key === '2') {
    event.preventDefault();
    control('alwaysApprove', pendingApproval.token).catch((e) => alert(e.message));
  } else if (event.key === '3') {
    event.preventDefault();
    control('fullAccess', pendingApproval.token).catch((e) => alert(e.message));
  } else if (event.key === '4') {
    event.preventDefault();
    control('denyApproval', pendingApproval.token).catch((e) => alert(e.message));
  }
});

load().then(refresh).catch(refresh);
setInterval(refresh, 1500);
</script>

</body>
</html>
