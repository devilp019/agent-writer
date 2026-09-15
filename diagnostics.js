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
 * 失败时的补充诊断：绕过所有包装，直接把上游响应原样打出来。
 *
 * 为什么需要：ConnectionManagerRequestService / ChatCompletionService 会把
 * 上游错误包装成一句没用的 "Internal Server Error"，真正的原因（哪个字段不对、
 * 哪个模型不存在、密钥有没有生效）全在里面被吃掉了。
 */
async function rawFailureProbe(profileId, extractData = true) {
    const context = ctx();
    const svc = context?.ConnectionManagerRequestService;
    if (!svc) return null;

    const out = [];
    let profile;
    try {
        profile = svc.getProfile(profileId);
    } catch (e) {
        out.push(`  取 profile 失败: ${e?.message}`);
        return out.join('\n');
    }

    const apiMap = context.CONNECT_API_MAP?.[profile.api] ?? {};
    const messages = [{ role: 'user', content: 'ping' }];

    // 优先用 ST 自己的构造器，保证发出去的 body 和正常路径一致；
    // 拿不到就手工拼一个等价的。
    let build;
    try {
        const creator = context.ChatCompletionService?.createRequestData;
        build = (extra) => (typeof creator === 'function'
            ? creator({ ...extra, messages })
            : { stream: false, messages, use_sysprompt: true, ...extra });
    } catch {
        build = (extra) => ({ stream: false, messages, use_sysprompt: true, ...extra });
    }

    const base = {
        model: profile.model,
        chat_completion_source: apiMap.source,
        max_tokens: 8,
        secret_id: profile['secret-id'],
        custom_url: profile['api-url'],
    };

    const attempts = [
        ['完整字段', build(base)],
        ['去掉 secret_id', build({ ...base, secret_id: undefined })],
        ['去掉 custom_url', build({ ...base, custom_url: undefined })],
        ['最小 body', { messages, chat_completion_source: apiMap.source, model: profile.model, max_tokens: 8 }],
    ];

    for (const [label, body] of attempts) {
        // 去掉 undefined，避免服务端把它当成有值
        for (const k of Object.keys(body)) {
            if (body[k] === undefined) delete body[k];
        }
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();

            if (resp.ok) {
                out.push(`  【${label}】✔ HTTP ${resp.status} —— 这条能通！`);
                out.push(`    响应: ${text.slice(0, 300)}`);
                break;
            }

            out.push(`  【${label}】✘ HTTP ${resp.status}`);
            out.push(`    响应: ${text.slice(0, 600)}`);
        } catch (e) {
            out.push(`  【${label}】抛错: ${e?.message}`);
        }
    }

    return out.join('\n');
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

    let profile = null;
    try {
        profile = svc.getProfile(id);
    } catch { /* 后面 sendRequest 会报更准确的信息 */ }

    const apiMap = profile ? (context.CONNECT_API_MAP?.[profile.api] ?? {}) : {};

    out.push(`探测目标: ${profile?.name ?? id} (${id})`);
    if (profile) {
        out.push(`  api=${profile.api}  →  selected=${apiMap.selected ?? '?'}  source=${apiMap.source ?? '?'}`);
        out.push(`  model=${profile.model || '(空)'}  api-url=${profile['api-url'] || '(空)'}  secret=${profile['secret-id'] ? '已设' : '(无)'}  preset=${profile.preset || '(空)'}`);
    }
    out.push('发送中（max_tokens=8）…');

    setDiagOutput(out.join('\n'));
    log(`开始探测连接配置「${profile?.name ?? id}」`);

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
        out.push('=== 裸请求诊断（绕过包装，看真实错误）===');
        setDiagOutput(out.join('\n'));
        try {
            const raw = await rawFailureProbe(id);
            out.push(raw ?? '  (无法执行裸请求诊断)');
        } catch (e) {
            out.push(`  裸请求诊断本身出错: ${e?.message}`);
        }

        out.push('');
        out.push('说明：上面每条是同一个请求的不同字段组合，看哪条能通就知道是哪个字段的问题。');
        log(`探测失败：${error?.message ?? error}`);
    }

    const text = out.join('\n');
    setDiagOutput(text);
    return text;
}

function getKnownProfiles(context) {
    try {
        return context.ConnectionManagerRequestService.getSupportedProfiles?.() ?? [];
    } catch {
        return [];
    }
}

/**
 * 针对「酒馆里手动测能通、程序调返回 error」这种情况的定向诊断。
 *
 * 最可能的差别是密钥来源：酒馆界面上直接用当前激活的密钥，
 * 而 ConnectionManagerRequestService 用的是存在 profile 里的 secret id，
 * 这两个可以是不同的（profile 里那个可能过期或属于另一个账号）。
 *
 * 所以把所有候选 secret 排列组合都试一遍，外加换模型对照。
 */
export async function probeSecret() {
    const context = ctx();
    const svc = context?.ConnectionManagerRequestService;
    if (!svc) {
        setDiagOutput('ConnectionManagerRequestService 不可用。');
        return null;
    }

    const profileId = getDiagProfileId(context);
    let profile;
    try {
        profile = svc.getProfile(profileId);
    } catch (e) {
        setDiagOutput(`取连接配置失败: ${e?.message}`);
        return null;
    }

    const apiMap = context.CONNECT_API_MAP?.[profile.api] ?? {};
    const out = [];
    const say = (s) => {
        out.push(s);
        setDiagOutput(out.join('\n'));
    };

    say('=== 密钥来源对照测试 ===');
    say(`配置「${profile.name}」  model=${profile.model || '(空)'}`);
    say('');

    const variants = [
        { label: '① 用 profile 里存的 secret', secret_id: profile['secret-id'] },
        { label: '② 不带 secret（酒馆用当前激活的密钥）', secret_id: undefined },
    ];

    // 把该配置自己声明的密钥也加进来对照
    try {
        const raw = context.extensionSettings?.connectionManager?.profiles
            ?.find((p) => p.id === profileId)?.secret;
        if (raw) variants.push({ label: `③ 用 profile.secret=${raw}`, secret_id: raw });
    } catch { /* 没有就算了 */ }

    // 同时也看看当前激活的是哪个
    try {
        const active = context.ChatCompletionSettings?.secret_id
            ?? context.chatCompletionSettings?.secret_id;
        if (active) say(`当前酒馆界面激活的 secret: ${active}`);
        say('');
    } catch { /* 读不到就算了 */ }

    const messages = [{ role: 'user', content: 'Say OK' }];

    for (const v of variants) {
        const body = {
            stream: false,
            messages,
            model: profile.model,
            chat_completion_source: apiMap.source ?? 'custom',
            custom_url: profile['api-url'],
            max_tokens: 8,
            use_sysprompt: true,
        };
        if (v.secret_id) body.secret_id = v.secret_id;

        say(`${v.label}`);
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

            const err = parsed?.error;
            if (err) {
                say(`   ✘ HTTP ${resp.status}  上游报错: ${err.message ?? JSON.stringify(err)}`);
            } else {
                const content = parsed?.choices?.[0]?.message?.content
                    ?? parsed?.choices?.[0]?.text
                    ?? parsed?.content
                    ?? '';
                say(`   ✔ HTTP ${resp.status}  返回: ${JSON.stringify(String(content).slice(0, 80))}`);
                say('   ⇒ 这条密钥来源是通的');
            }
        } catch (e) {
            say(`   抛错: ${e?.message}`);
        }
        say('');
    }

    // 换模型对照：区分「密钥问题」和「这个模型在该账号下不可用」
    if (profile.model) {
        say('=== 换模型对照（同一个密钥，只改 model）===');
        const body = {
            stream: false,
            messages,
            model: 'gpt-4o-mini',
            chat_completion_source: apiMap.source ?? 'custom',
            custom_url: profile['api-url'],
            max_tokens: 8,
            use_sysprompt: true,
        };
        if (profile['secret-id']) body.secret_id = profile['secret-id'];
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const parsed = await resp.json().catch(() => null);
            if (parsed?.error) {
                say(`   model=gpt-4o-mini → ✘ ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
                say('   ⇒ 换模型也不行，问题在密钥/端点而不在模型名');
            } else {
                say('   model=gpt-4o-mini → ✔ 通');
                say(`   ⇒ 端点与密钥没问题，是「${profile.model}」这个模型名在该账号下不可用`);
            }
        } catch (e) {
            say(`   抛错: ${e?.message}`);
        }
    }

    say('');
    say('判断方法：同密钥换模型能通 ⇒ 模型名的问题；两条密钥都报错 ⇒ 端点或密钥本身的问题。');
    log('密钥来源对照测试完成');
    return out.join('\n');
}

/** 挂到 window，方便不开面板直接调用 */
export function exposeGlobals() {
    globalThis.awDiagnose = diagnose;
    globalThis.awProbe = probe;
    globalThis.awProbeSecret = probeSecret;
}
