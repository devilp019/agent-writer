/**
 * Agent Writer - 入口
 *
 * 骨架阶段只做四件事：
 *   1. 挂悬浮球（状态灯 + 面板开关）
 *   2. 挂扩展菜单项（第二入口 + 行内状态）
 *   3. 挂面板（自检 + 状态演示）
 *   4. 把设置落到 settings.json（验证「后端保存」这条链路）
 *
 * ①②③ 流水线在下一步接入。
 */

import { setState } from './state.js';
import { mountFab, unmountFab, resetFabPosition } from './ui/fab.js';
import { mountMenuItem, unmountMenuItem } from './ui/menu.js';
import {
    mountPanel,
    unmountPanel,
    togglePanel,
    isPanelOpen,
    log,
    setDiagOutput,
    getAutoCheckbox,
} from './ui/panel.js';
import { diagnose, probe, exposeGlobals } from './diagnostics.js';

const MODULE_NAME = 'agent_writer';
const EXTENSION_FOLDER = 'third-party/agent-writer';
const VERSION = '0.1.0';

const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    auto: false,
    logLines: true,
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getSettings() {
    const context = getContext();
    if (!context) throw new Error('SillyTavern.getContext() 不可用');

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = context.extensionSettings[MODULE_NAME];
    // 补齐新增的默认键，便于后续版本升级
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = DEFAULT_SETTINGS[key];
        }
    }
    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let started = false;

async function boot() {
    if (started) return;
    const context = getContext();
    if (!context) {
        console.error('[AgentWriter] getContext() 不可用，扩展无法启动');
        return;
    }
    started = true;

    const settings = getSettings();
    exposeGlobals();

    // 悬浮球与菜单项共用同一个开关动作
    const toggle = () => togglePanel();
    mountFab(toggle);
    mountMenuItem(toggle);

    try {
        await mountPanel({
            renderTemplate: (name) => context.renderExtensionTemplateAsync(EXTENSION_FOLDER, name),
            onAutoChange: (auto) => {
                settings.auto = !!auto;
                saveSettings();
                setState(auto ? 'idle' : 'off');
                log(`自动模式：${auto ? '开' : '关'}`);
            },
        });
    } catch (error) {
        console.error('[AgentWriter] 面板渲染失败', error);
        // 面板挂了不影响悬浮球和菜单项，至少还能看到状态
        return;
    }

    const autoBox = getAutoCheckbox();
    if (autoBox) autoBox.checked = !!settings.auto;
    setState(settings.auto ? 'idle' : 'off');

    log(`Agent Writer v${VERSION} 就绪`);
    log('提示：在「参数」页点「运行自检」可确认运行环境');

    // 首次安装时自动跑一次自检，把环境快照留在面板里
    if (!settings.diagnosedOnce) {
        settings.diagnosedOnce = true;
        saveSettings();
        diagnose().catch((error) => console.error('[AgentWriter] 自检失败', error));
    }
}

// ---------------------------------------------------------------------------
// 生命周期钩子（由 manifest.json 的 hooks 指定）
// ---------------------------------------------------------------------------

export function onActivate() {
    // 同步初始化：酒馆加载期、loader 还在转的时候。
    // APP_READY 可能已经错过，这里兜一次；boot() 自带幂等保护。
    boot().catch((error) => console.error('[AgentWriter] 启动失败', error));
}

export function onInstall() {
    console.log('[AgentWriter] onInstall');
}

export function onUpdate() {
    console.log('[AgentWriter] onUpdate');
}

export function onEnable() {
    boot().catch((error) => console.error('[AgentWriter] 启动失败', error));
}

export function onDisable() {
    teardown();
}

export function onDelete() {
    teardown();
}

export async function onClean() {
    const context = getContext();
    if (context?.extensionSettings) {
        delete context.extensionSettings[MODULE_NAME];
        delete context.extensionSettings.agent_writer_diag;
        context.saveSettingsDebounced?.();
    }
    localStorage.removeItem('aw_fab_pos_v1');
    localStorage.removeItem('aw_panel_pos_v1');
    teardown();
}

function teardown() {
    unmountFab();
    unmountMenuItem();
    unmountPanel();
    started = false;
}

// ---------------------------------------------------------------------------
// 启动时机
// ---------------------------------------------------------------------------

// APP_READY 时 UI 已就绪；若已触发过，eventSource.on 会自动补发
function scheduleBoot() {
    const context = getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;

    if (!eventSource?.on || !eventTypes?.APP_READY) {
        // 极端情况下退化为延时启动
        setTimeout(() => boot().catch((error) => console.error('[AgentWriter] 启动失败', error)), 500);
        return;
    }

    eventSource.on(eventTypes.APP_READY, () => {
        // APP_READY 的处理函数会被 await，耗时的初始化要延后
        setTimeout(() => boot().catch((error) => console.error('[AgentWriter] 启动失败', error)), 0);
    });
}

scheduleBoot();

window.addEventListener('pagehide', teardown);

// ---------------------------------------------------------------------------
// 调试入口（平板外接键盘 / 或从控制台调用）
// ---------------------------------------------------------------------------

globalThis.aw = {
    version: VERSION,
    diagnose,
    probe,
    boot,
    teardown,
    state: setState,
    togglePanel,
    isPanelOpen,
    resetFabPosition,
    getSettings,
    log,
    setDiagOutput,
    show: () => {
        boot().catch(() => {});
        setTimeout(() => (isPanelOpen() ? null : togglePanel()), 300);
    },
};
