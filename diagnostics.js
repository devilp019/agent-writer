/**
 * Agent Writer - 自检与连通性探测
 *
 * 为什么需要这个：酒馆后端在平板上，改完代码没法开 devtools 慢慢查。
 * 出问题时点一下「运行自检」，把文本框里的结果截图发出来即可。
 *
 * 同时挂到 window.awDiagnose() / window.awProbe()，平板外接键盘时可直接调。
 */

import { log, setDiagOutput } from './ui/panel.js';
import { describeMenuContainer, isMenuItemMounted } from './ui/menu.js';

/** 用于自检的独立命名空间，不占用扩展自己的设置 */
const DIAG_NS = 'agent_writer_diag';

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function line(label, value) {
    return `${label}: ${value}`;
}

function ok(value) {
    return value ? '✔' : '✘';
}

// ---------------------------------------------------------------------------
// 环境自检
// ---------------------------------------------------------------------------

async function collectEnvironment(context) {
    const out = [];

    out.push('=== 环境 ===');
    out.push(line('扩展版本', '0.1.0'));
    out.push(line('getContext()', ok(context) + (context ? '' : '  ← 致命：扩展环境异常')));
    out.push(line('ST 版本', context?.version ?? '(ctx.version 未暴露)'));
    out.push(line('主 API', context?.mainApi ?? '(空)'));
    out.push(line('聊天文件', context?.getCurrentChatId?.() ?? '(无)'));

    out.push('');
    out.push('=== 依赖的 API ===');
    const svc = context?.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    out.push(line('ConnectionManagerRequestService', ok(svc) + (svc ? '' : '  ← 致命：无法按配置发请求')));
    out.push(line('  .sendRequest', ok(typeof svc?.sendRequest === 'function')));
    out.push(line('  .handleDropdown', ok(typeof svc?.handleDropdown === 'function')));
    out.push(line('ChatCompletionService', ok(context?.ChatCompletionService)));
    out.push(line('generateRaw', ok(typeof context?.generateRaw === 'function')));
    out.push(line('getPresetManager', ok(typeof context?.getPresetManager === 'function')));
    out.push(line('getCharacterCardFields', ok(typeof context?.getCharacterCardFields === 'function')));
    out.push(line('getWorldInfoPrompt', ok(typeof context?.getWorldInfoPrompt === 'function')));
    out.push(line('saveSettingsDebounced', ok(typeof context?.saveSettingsDebounced === 'function')));
    out.push(line('parseReasoningFromString', ok(typeof context?.parseReasoningFromString === 'function')));

    out.push('');
    out.push('=== 连接管理器 ===');
    const disabled = context?.extensionSettings?.disabledExtensions;
    const cmDisabled = Array.isArray(disabled) && disabled.includes('connection-manager');
    out.push(line('connection-manager 已启用', ok(!cmDisabled)));
    out.push(line('disabledExtensions', Array.isArray(disabled) ? disabled.join(', ') || '(空)' : '(不可读)'));

    const profiles = context?.extensionSettings?.connectionManager?.profiles;
    out.push(line('连接配置数量', Array.isArray(profiles) ? profiles.length : '(不可读)'));

    if (Array.isArray(profiles) && profiles.length > 0) {
        out.push('');
        for (const profile of profiles) {
            let supported = '?';
            try {
                supported = svc?.isProfileSupported?.(profile) ? '可用' : '不支持的类型';
            } catch (error) {
                supported = `判定失败(${error.message})`;
            }
            out.push(`  · ${profile.name ?? '(无名)'} [${supported}]`);
            out.push(`      id=${profile.id ?? '?'} api=${profile.api ?? '?'} model=${profile.model || '(空)'}`);
            out.push(`      secret-id=${profile['secret-id'] ? '已设置' : '(无)'} api-url=${profile['api-url'] || '(空)'} preset=${profile.preset || '(空)'}`);
        }
    }

    out.push('');
    out.push('=== 界面挂载点 ===');
    out.push(line('#extensionsMenu', ok(document.getElementById('extensionsMenu'))));
    out.push(line('菜单容器探测', describeMenuContainer()));
    out.push(line('#aw-menu-item 已挂载', ok(isMenuItemMounted())));
    out.push(line('#aw-fab（悬浮球）', ok(document.getElementById('aw-fab'))));
    out.push(line('  位置', document.getElementById('aw-fab')?.style?.left
        ? `${document.getElementById('aw-fab').style.left} / ${document.getElementById('aw-fab').style.top}`
        : '(未定位)'));
    out.push(line('#aw-panel（面板）', ok(document.getElementById('aw-panel')) + (document.getElementById('aw-panel') ? '' : '  ← 点悬浮球应能补挂')));
    out.push(line('  display', document.getElementById('aw-panel')?.style?.display || '(空)'));
    out.push(line('aw 调试入口', ok(globalThis.aw)));
    out.push(line('prefers-reduced-motion', window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '是（动画已降级）' : '否'));
    out.push(line('视口', `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`));

    return out;
}

/**
 * 运行环境自检。结果写入面板文本框，同时打到日志。
 */
export async function diagnose() {
    const context = ctx();
    const out = [];

    try {
        out.push(...(await collectEnvironment(context)));
    } catch (error) {
        out.push(`自检本身出错: ${error?.message ?? error}`);
        console.error('[AgentWriter] 自检出错', error);
    }

    out.push('');
    out.push('=== 结论 ===');
    if (!context) {
        out.push('getContext() 拿不到 —— 扩展没有在酒馆环境里运行，请确认安装位置。');
    } else if (!(context.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService)) {
        out.push('ConnectionManagerRequestService 不可用 —— 请在扩展管理里确认 connection-manager 没有被禁用。');
    } else {
        out.push('环境看起来正常。可以再点「测试当前连接配置」验证请求链路。');
    }

    const text = out.join('\n');
    setDiagOutput(text);
    log('自检完成，结果见「参数」页的自检框');
    return text;
}

// ---------------------------------------------------------------------------
// 连通性探测
// ---------------------------------------------------------------------------

function getDiagProfileId(context) {
    const saved = context.extensionSettings?.[DIAG_NS]?.probeProfileId;
    if (saved) return saved;

    const svc = context.ConnectionManagerRequestService;
    const profiles = svc.getSupportedProfiles?.() ?? [];
    const selected = context.extensionSettings?.connectionManager?.selectedProfile;
    if (selected && profiles.some((p) => p.id === selected)) return selected;
    return profiles[0]?.id ?? '';
}

function setDiagProfileId(context, id) {
    if (!context.extensionSettings[DIAG_NS]) {
        context.extensionSettings[DIAG_NS] = {};
    }
    context.extensionSettings[DIAG_NS].probeProfileId = id;
    context.saveSettingsDebounced?.();
}

/**
 * 用指定（或当前）连接配置发一个 1 token 的真实请求，验证整条链路。
 * 这会消耗极少量额度 —— 是显式点击触发的，不是自动跑的。
 * @param {string} [profileId]
 */
export async function probe(profileId) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用，无法探测。');
        return null;
    }

    const svc = context.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    if (!svc) {
        setDiagOutput('ConnectionManagerRequestService 不可用，无法探测。');
        return null;
    }

    const id = profileId || getDiagProfileId(context);
    const out = [];

    if (!id) {
        out.push('没有可用的连接配置。');
        out.push('请先在酒馆的「连接配置 / Connection Manager」里建一个（选 API 源、填模型、关联密钥）。');
        const text = out.join('\n');
        setDiagOutput(text);
        return null;
    }

    let profileName = id;
    try {
        profileName = svc.getProfile(id)?.name ?? id;
    } catch { /* 后面 sendRequest 会报更准确的信息 */ }

    out.push(`探测目标: ${profileName} (${id})`);
    out.push('发送中（max_tokens=8）…');

    setDiagOutput(out.join('\n'));
    log(`开始探测连接配置「${profileName}」`);

    const started = Date.now();
    try {
        const result = await svc.sendRequest(
            id,
            [{ role: 'user', content: 'ping' }],
            8,
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
        );

        const elapsed = Date.now() - started;
        out.push('');
        out.push(`✔ 请求成功，耗时 ${elapsed}ms`);
        out.push(`  content: ${JSON.stringify(String(result?.content ?? '').slice(0, 120))}`);
        out.push(`  reasoning: ${result?.reasoning ? `${result.reasoning.length} 字` : '(空)'}`);
        out.push('');
        out.push('=== 思维链能力 ===');
        out.push(
            result?.reasoning
                ? '✔ 返回了 reasoning —— 非流式模式下可以直接读，不需要拦截 fetch。'
                : '△ 未返回 reasoning —— 可能是该模型不支持、或该源未透出。功能不受影响，只是思维链可能看不到。',
        );

        setDiagProfileId(context, id);
        log(`探测成功：${elapsed}ms，reasoning ${result?.reasoning?.length ?? 0} 字`);
    } catch (error) {
        const elapsed = Date.now() - started;
        out.push('');
        out.push(`✘ 请求失败，耗时 ${elapsed}ms`);
        out.push(`  ${error?.message ?? error}`);
        const cause = error?.cause;
        if (cause) out.push(`  cause: ${cause?.message ?? cause}`);
        out.push('');
        out.push('排查顺序：');
        out.push('  1. 该连接配置在酒馆里单独用一次是否正常？');
        out.push('  2. 密钥（secret）是否已关联到这个配置？');
        out.push('  3. 模型名 / API 地址是否正确？');
        out.push('  4. 平板能否访问该 API 地址（网络/代理）？');
        log(`探测失败：${error?.message ?? error}`);
    }

    const text = out.join('\n');
    setDiagOutput(text);
    return text;
}

/** 挂到 window，方便不开面板直接调用 */
export function exposeGlobals() {
    globalThis.awDiagnose = diagnose;
    globalThis.awProbe = probe;
}
