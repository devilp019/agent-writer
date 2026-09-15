/**
 * Agent Writer - 自检与连通性探测
 *
 * 为什么需要这个：酒馆后端在平板上，改完代码没法开 devtools 慢慢查。
 * 出问题时点一下「运行自检」，把文本框里的结果截图发出来即可。
 *
 * 同时挂到 window.awDiagnose() / window.awProbe()，平板外接键盘时可直接调。
 */

import { log, setDiagOutput, VERSION, getMountCount } from './ui/panel.js?v=0.8.26';
import { describeMenuContainer, isMenuItemMounted } from './ui/menu.js?v=0.8.26';
import { getStreamHookStats } from './stream-hook.js?v=0.8.26';

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
    out.push(line('扩展版本', VERSION ?? '(未导出)'));
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

    // 上游拦截 —— 思维链和实时正文的唯一来源。
    // 「拦到没有」必须是可观测的，否则出了问题只能靠猜。
    const hook = getStreamHookStats();
    out.push('');
    out.push('=== 上游流式拦截 ===');
    out.push(line('fetch 已替换', ok(hook.patched) + (hook.patched ? '' : '  ← 致命：思维链与实时正文都拿不到')));
    if (hook.error) out.push(line('  出错', hook.error));
    out.push(line('  打到生成端点的请求', String(hook.seen)));
    out.push(line('  其中认领并拦截', String(hook.matched) + (hook.seen > 0 && hook.matched === 0
        ? '  ← 一次都没认领上：槽位标记没进请求体？'
        : '')));
    out.push(line('  流式 / 非流式', `${hook.streaming} / ${hook.nonStreaming}`));
    out.push(line('  收到分片', `${hook.chunks}（其中带思维链 ${hook.reasoningChunks}）`));
    if (hook.errors.length) out.push(line('  解析中断', hook.errors.slice(-2).join(' | ')));
    out.push('  说明：这四个数字是**本次页面加载以来**的累计值。');
    out.push('  跑一次 ② 之后，matched 应该 +1、chunks 应该变大；');
    out.push('  思维链一直是 0 就说明这个模型/渠道压根没回 reasoning 字段。');

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

/** 发一次请求，流式或非流式。返回统一的 { ok, content, reasoning, note } */
async function runOnce(svc, profileId, useStream) {
    const messages = [{ role: 'user', content: 'Say OK' }];
    const options = { stream: useStream, extractData: true, includePreset: false, includeInstruct: false };

    if (!useStream) {
        const result = await svc.sendRequest(profileId, messages, 1024, options);
        const content = String(result?.content ?? '');
        return {
            ok: !!content,
            content,
            reasoning: String(result?.reasoning ?? ''),
            note: content ? '' : 'HTTP 成功但解析不出正文（包裹格式可能不被酒馆识别）',
        };
    }

    const streamFn = await svc.sendRequest(profileId, messages, 1024, options);
    if (typeof streamFn !== 'function') {
        return { ok: false, content: '', reasoning: '', note: '这个配置不支持流式' };
    }
    let full = '';
    let reasoning = '';
    for await (const { text, state } of streamFn()) {
        full = text ?? full;
        reasoning = state?.reasoning ?? reasoning;
    }
    return { ok: !!full, content: full, reasoning, note: full ? '' : '流式也没拿到正文' };
}

/**
 * 用指定（或当前）连接配置发一个真实请求，验证整条链路。
 * 这会消耗极少量额度 —— 是显式点击触发的，不是自动跑的。
 *
 * 关键：先试非流式，正文为空就自动改走流式。
 * 有些上游（例如 Cline）的非流式包裹格式酒馆解析不了，
 * 只看 HTTP 状态会得到一个假的成功信号。
 *
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

    setDiagOutput(out.join('\n'));
    log(`开始探测连接配置「${profile?.name ?? id}」`);

    try {
        // —— 第一轮：非流式 ——
        out.push('');
        out.push('【非流式】发送中…');
        setDiagOutput(out.join('\n'));

        const started = Date.now();
        const plain = await runOnce(svc, id, false);
        out.push(`  耗时 ${Date.now() - started}ms`);
        if (plain.ok) {
            out.push(`  ✔ 正文: ${JSON.stringify(plain.content.slice(0, 100))}`);
            out.push(`  思维链: ${plain.reasoning ? `${plain.reasoning.length} 字` : '(空)'}`);
        } else {
            out.push(`  △ HTTP 通了，但没拿到正文${plain.note ? ` —— ${plain.note}` : ''}`);
        }

        // —— 第二轮：需要时才试流式 ——
        let final = { ok: plain.ok, mode: '非流式', content: plain.content, reasoning: plain.reasoning };

        if (!plain.ok) {
            out.push('');
            out.push('【流式】自动重试中…');
            setDiagOutput(out.join('\n'));

            const started2 = Date.now();
            const streamed = await runOnce(svc, id, true);
            out.push(`  耗时 ${Date.now() - started2}ms`);
            if (streamed.ok) {
                out.push(`  ✔ 正文: ${JSON.stringify(streamed.content.slice(0, 100))}`);
                out.push(`  思维链: ${streamed.reasoning ? `${streamed.reasoning.length} 字` : '(空)'}`);
                final = { ok: true, mode: '流式', content: streamed.content, reasoning: streamed.reasoning };
            } else {
                out.push(`  ✘ ${streamed.note || '流式也没拿到正文'}`);
            }
        }

        out.push('');
        out.push('=== 结论 ===');
        if (final.ok) {
            out.push(`✔ 这条配置可用，走${final.mode}。`);
            if (final.mode === '流式') {
                out.push('');
                out.push('⚠ 非流式的包裹格式酒馆解析不了，这条配置必须开流式。');
                out.push('  扩展会自动对这类配置启用流式，你不用手动管。');
            }
            out.push('');
            out.push('=== 思维链能力 ===');
            out.push(
                final.reasoning
                    ? '✔ 返回了 reasoning —— 非流式/流式都能直接读，不需要拦截 fetch。'
                    : '△ 未拿到 reasoning —— 可能是模型不支持、或该源未透出。功能不受影响，只是思维链看不到。',
            );
            setDiagProfileId(context, id);
        } else {
            out.push('✘ 非流式和流式都没拿到正文。');
            out.push('  下一步需要看酒馆后台日志里上游返回的原始响应。');
        }
    } catch (error) {
        out.push('');
        out.push(`✘ 请求失败: ${error?.message ?? error}`);
        const cause = error?.cause;
        if (cause) out.push(`  cause: ${cause?.message ?? cause}`);
    }

    const text = out.join('\n');
    setDiagOutput(text);
    log('探测完成');
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

/**
 * 空请求体对照：极端 A/B 测试。
 *
 * 背景：cline2 在酒馆里手动用能通，但程序构造请求时上游回 500
 * （而换一个不存在的模型名回的是 Bad Request，说明请求确实到达并被解析了）。
 * 「能判断模型名不合法、却在对的模型名上崩掉」通常意味着请求体里有它不接受的字段。
 *
 * 所以这里发一个几乎空的 body，看它认不认。如果空 body 能通，
 * 就逐个把字段加回去，二分找出是哪个字段把上游搞崩的。
 *
 * @param {string} [model] 留空则用 profile 的模型
 */
export async function probeShape(model) {
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
    const useModel = String(model ?? '').trim() || profile.model;
    const url = profile['api-url'];

    const out = [];
    const say = (s) => {
        out.push(s);
        setDiagOutput(out.join('\n'));
    };

    say('=== 请求体形状对照 ===');
    say(`配置「${profile.name}」  api-url=${url || '(空)'}`);
    say(`使用模型 ${useModel || '(空)'}`);
    say('');

    async function attempt(label, body, { viaService = false } = {}) {
        // 干掉 undefined，避免服务端把它当成"有值"
        for (const k of Object.keys(body)) {
            if (body[k] === undefined) delete body[k];
        }

        const shown = JSON.stringify(body);
        say(`${label}`);
        say(`   发出: ${shown.length > 320 ? `${shown.slice(0, 320)}…` : shown}`);

        try {
            if (viaService) {
                // 走酒馆自己的服务代码，拿到的是上游错误对象（如果它选择抛错）
                const result = await svc.sendRequest(
                    profileId,
                    body.messages,
                    body.max_tokens ?? 8,
                    { stream: false, extractData: true, includePreset: false, includeInstruct: false },
                    useModel ? { model: useModel } : {},
                );
                const content = String(result?.content ?? '');
                say(`   ✔ 服务代码返回: ${JSON.stringify(content.slice(0, 80))}`);
                return true;
            }

            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

            if (parsed?.error) {
                say(`   ✘ HTTP ${resp.status}  上游报错: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
                return false;
            }
            const content = parsed?.choices?.[0]?.message?.content
                ?? parsed?.choices?.[0]?.text ?? parsed?.content ?? '';
            say(`   ✔ HTTP ${resp.status}  返回: ${JSON.stringify(String(content).slice(0, 80))}`);
            return true;
        } catch (e) {
            const cause = e?.cause?.message ?? e?.cause;
            say(`   ✘ 抛错: ${e?.message}${cause ? ` / cause: ${cause}` : ''}`);
            return false;
        } finally {
            say('');
        }
    }

    const messages = [{ role: 'user', content: 'Say OK' }];

    // 1. 最干净：只有 messages + model，连 source 都不给
    await attempt('① 极简 body（只有 messages + model）', {
        stream: false,
        messages,
        model: useModel,
    });

    // 2. 加 source 和 custom_url（我目前用的形状）
    await attempt('② 加 chat_completion_source + custom_url', {
        stream: false,
        messages,
        model: useModel,
        chat_completion_source: apiMap.source ?? 'custom',
        custom_url: url,
    });

    // 3. 再加 max_tokens / use_sysprompt
    await attempt('③ 再加 max_tokens + use_sysprompt', {
        stream: false,
        messages,
        model: useModel,
        chat_completion_source: apiMap.source ?? 'custom',
        custom_url: url,
        max_tokens: 8,
        use_sysprompt: true,
    });

    // 4. 换成一个看起来很正常的 max_tokens（8 太小可能被上游嫌弃）
    await attempt('④ max_tokens 改成 1024', {
        stream: false,
        messages,
        model: useModel,
        chat_completion_source: apiMap.source ?? 'custom',
        custom_url: url,
        max_tokens: 1024,
        use_sysprompt: true,
    });

    // 5. 走酒馆自己的服务代码（它内部会按 source 分派）
    await attempt('⑤ 走 ConnectionManagerRequestService（非流式）', {
        messages,
        max_tokens: 1024,
    }, { viaService: true });

    // 6. 流式：有些上游的非流式包裹格式酒馆解析不了，只能走流式
    say('=== 流式对照 ===');
    say('（非流式返回空内容时，这一节通常才是真相）');
    say('');
    try {
        const streamFn = await svc.sendRequest(
            profileId,
            messages,
            1024,
            { stream: true, extractData: true, includePreset: false, includeInstruct: false },
        );

        if (typeof streamFn !== 'function') {
            say('✘ 没有拿到流式迭代器（这个配置可能不支持流式）');
        } else {
            let full = '';
            let reasoning = '';
            let chunks = 0;
            const started = Date.now();
            for await (const { text, state } of streamFn()) {
                full = text ?? full;
                reasoning = state?.reasoning ?? reasoning;
                chunks++;
            }
            const elapsed = Date.now() - started;
            say(`   分片数 ${chunks}   耗时 ${elapsed}ms`);
            say(`   正文   ${full ? JSON.stringify(full.slice(0, 120)) : '(空)'}`);
            say(`   思维链 ${reasoning ? `${reasoning.length} 字` : '(空)'}`);
            say('');
            if (full) {
                say('   ✔ 流式能拿到正文 ⇒ 这个配置必须走流式，非流式的包裹格式酒馆解析不了');
            } else {
                say('   ✘ 流式也没拿到正文 ⇒ 需要看酒馆后台的原始响应');
            }
        }
    } catch (e) {
        const cause = e?.cause?.message ?? e?.cause;
        say(`   ✘ 流式抛错: ${e?.message}${cause ? ` / cause: ${cause}` : ''}`);
    }

    say('');
    say('判断方法：');
    say('  · 非流式返回空、流式有正文 ⇒ 该配置只能走流式');
    say('  · ① 不通而 ② 通 ⇒ 缺 custom_url 时酒馆无法路由');
    say('  · ⑤ 能通 ⇒ 用服务路径就行');
    log('请求体形状对照完成');
    return out.join('\n');
}

/**
 * 显示最近一次各阶段实际发出的请求体。
 *
 * 「附加参数没发出去」这类问题，看代码看不出来 —— 必须看真实请求。
 * 数据来自 CHAT_COMPLETION_SETTINGS_READY 事件里那一份 generate_data
 * （注入之后的快照），不是我以为发了什么。
 *
 * 三种结果对应三种病因：
 *   · 显示「没认领到」     ⇒ 槽位标记没进 messages，或事件根本没发
 *   · 认领到了但字段是空的 ⇒ 面板里那个阶段没填附加参数
 *   · 字段在、模型行为不符 ⇒ 上游不认这个字段名（各家写法不一样）
 */
export async function showLastRequests() {
    const out = [];

    let snapshot;
    try {
        const mod = await import('./pipeline.js?v=0.8.26');
        snapshot = mod.getLastRequests?.();
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }

    if (!snapshot) {
        setDiagOutput('读不到最近请求记录（pipeline.getLastRequests 不可用）。');
        return null;
    }

    const pretty = (v) => (v == null ? '(无)' : JSON.stringify(v, null, 2));

    for (const stage of ['critic', 'final']) {
        const record = snapshot[stage];
        out.push(`=== ${stage === 'critic' ? '② 校验' : '③ 改写'} ===`);
        if (!record) {
            out.push('（还没跑过这个阶段）');
            out.push('');
            continue;
        }

        if (record.claimed === false) {
            out.push('✘ 没认领到这次请求');
            out.push(`  ${record.note ?? ''}`);
            out.push('');
            continue;
        }

        out.push('✔ 已认领并注入');
        out.push('-- 本次附加的字段 --');
        out.push(pretty(record.applied));
        out.push('');
        out.push('-- 注入后请求体顶层字段（messages 省略）--');
        out.push(pretty(record.body));
        out.push('');
    }

    out.push('排查要点：');
    out.push('  · 「没认领到」 ⇒ 附加参数根本没发出去，不是上游不认');
    out.push('  · 「本次附加的字段」是 {} ⇒ 面板里那个阶段没填附加参数');
    out.push('  · 字段在、模型行为不符 ⇒ 上游不认这个字段名（各家写法不一样）');
    out.push('  · reasoning_effort 只调「想多久」，关思考要用 thinking');

    const text = out.join('\n');
    setDiagOutput(text);
    log('已导出最近请求体');
    return text;
}

/**
 * 换渠道专项诊断：把「面板里填的明文密钥」按**两种请求形状**送给上游。
 *
 * 背景：同一个 key 在别的扩展里能通，在本扩展里 401。既然直连探针已经
 * 证明 key 本身没问题，那问题就在「酒馆怎么把这个凭据送出去」这一步。
 * 这一步有两条不同的路，必须分开测：
 *
 *   形状 A —— 扩展现在用的：custom_api.key
 *     TavernHelper 的 resolveProxyPreset / applyCustomApiOverrides 会把它
 *     落到 reverse_proxy + proxy_password 上，由酒馆按厂商分支去设请求头。
 *
 *   形状 B —— 织幕（st-end-component-generator）用的：顶层 custom_include_headers
 *     直接给酒馆一份「要附加哪些请求头」的 YAML，酒馆只负责合并。
 *     这条路对请求头的控制是精确的，不依赖厂商分支。
 *
 * 两个形状都不通 ⇒ 端点在酒馆这条链路上确实不接受这个密钥；
 * 形状 B 通而 A 不通 ⇒ 就是 custom_api.key 这条路的解析出了问题，改用 B。
 *
 * @param {string} [apiUrl]
 * @param {string} [key]
 * @param {string} [model]
 * @param {boolean} [useStream]
 */
export async function probeChannel(apiUrl, key, model, useStream = false) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用。');
        return null;
    }

    const svc = context.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    const profile = (() => {
        try {
            return svc?.getProfile?.(getDiagProfileId(context));
        } catch { return null; }
    })();

    // 地址/模型优先用面板里填的 —— 这个诊断是要验证「扩展配的那套」，
    // 不是验证连接配置里那套。
    const url = String(apiUrl ?? '').trim() || profile?.['api-url'] || '';
    const useModel = String(model ?? '').trim() || profile?.model || '';
    const plainKey = String(key ?? '').trim();

    const out = [];
    const say = (s) => { out.push(s); setDiagOutput(out.join('\n')); };

    const mask = (v) => {
        const s = String(v ?? '');
        if (!s) return '(空)';
        if (s.length <= 12) return `${s.slice(0, 3)}…${s.slice(-2)}（${s.length} 字符）`;
        return `${s.slice(0, 6)}…${s.slice(-4)}（${s.length} 字符）`;
    };

    const hash = async (v) => {
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v)));
            return [...new Uint8Array(buf)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch {
            return '(算不出)';
        }
    };

    say('=== 面板填的渠道 ===');
    say(`API 地址           ${url || '(空 ← 空的话根本不会走换渠道，会掉回当前连接)'}`);
    say(`模型               ${useModel || '(空)'}`);
    say(`API 密钥           ${mask(plainKey)}`);
    say(`  指纹             ${await hash(plainKey)}`);
    say(`流式               ${useStream ? '开（Cline 必须开：非流式会被包一层 data）' : '关'}`);
    say('');
    if (!url || !plainKey) {
        say('⚠ 地址或密钥是空的。这两个都填上才有意义 ——');
        say('  密钥为空时酒馆会退回「当前连接」的凭据，于是拿别的密钥去打 Cline，必然 401。');
        say('');
    }

    const messages = [{ role: 'user', content: 'Say OK' }];

    async function attempt(label, body, note = '') {
        say(`${label}`);
        if (note) say(`   ${note}`);
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();

            // 开了流式时返回的是 SSE，不是 JSON —— 别拿 JSON.parse 去判成败，
            // 否则「成功但正文在 SSE 里」会被误报成失败（这里踩过一次）。
            if (body.stream && resp.ok && /^\s*data:/m.test(text)) {
                const lines = text.split('\n').filter((l) => l.startsWith('data:'));
                const done = lines.some((l) => l.includes('[DONE]'));
                let chars = 0;
                for (const line of lines) {
                    if (line.includes('[DONE]')) continue;
                    let j = null;
                    try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
                    const innerD = j?.data ?? j;
                    chars += String(innerD?.choices?.[0]?.delta?.content ?? '').length;
                }
                say(`   ✔ HTTP ${resp.status}  流式通：分片 ${lines.length} 个，正文 ${chars} 字${done ? '，收到 [DONE]' : ''}`);
                return true;
            }

            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

            if (parsed?.error) {
                const msg = typeof parsed.error === 'object'
                    ? (parsed.error.message ?? JSON.stringify(parsed.error))
                    : String(parsed.error);
                say(`   ✘ HTTP ${resp.status}  ${msg}`);
                return false;
            }
            // 注意 Cline 非流式会把标准结构包一层 data，这里两种都认
            const inner = parsed?.data ?? parsed;
            const content = inner?.choices?.[0]?.message?.content
                ?? inner?.choices?.[0]?.text
                ?? parsed?.content
                ?? '';
            if (typeof content === 'string' && content.trim()) {
                say(`   ✔ HTTP ${resp.status}  返回: ${JSON.stringify(content.slice(0, 60))}`);
                return true;
            }
            say(`   △ HTTP ${resp.status} 通了，但正文为空`);
            if (parsed?.data && !parsed?.choices) {
                say('     （响应被包了一层 data —— 这是 Cline 非流式的特征，换流式就正常）');
            }
            if (!parsed) say(`     （响应不是 JSON，前 120 字：${text.slice(0, 120)}）`);
            return false;
        } catch (e) {
            say(`   抛错: ${e?.message}`);
            return false;
        } finally {
            say('');
        }
    }

    const base = {
        stream: useStream,
        messages,
        model: useModel,
        chat_completion_source: 'custom',
        custom_url: url,
        max_tokens: 32,
        use_sysprompt: true,
    };

    const okA = await attempt(
        '形状 A —— 旧做法：custom_api.key（TavernHelper 会拼一份 Authorization）',
        { ...base, key: plainKey },
    );

    const okB = await attempt(
        '形状 B —— 现在用的：顶层 custom_include_headers 直接指定 Authorization',
        { ...base, custom_include_headers: `"Authorization": "Bearer ${plainKey}"` },
    );

    // 顺便看看酒馆里那个密钥是不是同一个（只比指纹）
    let serverKey = null;
    try {
        const resp = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'api_key_custom' }),
        });
        if (resp.ok) serverKey = (await resp.json())?.value ?? null;
    } catch { /* 读不到就算了 */ }
    if (serverKey) {
        say(`酒馆里存的 api_key_custom   ${mask(serverKey)}  指纹 ${await hash(serverKey)}`);
        say(`⇒ 与面板里填的${serverKey === plainKey ? '一致' : '**不一致** ← 若形状 A 失败而这条能通，就是它'}`);
        say('');
        if (serverKey !== plainKey) {
            await attempt('形状 A′ —— 改用酒馆里存的密钥值', { ...base, key: serverKey });
        }
    }

    say('=== 判断 ===');
    say('形状 A 是 0.8.26 之前的旧做法，形状 B 是现在用的 —— 所以「A 不通、B 通」是预期结果。');
    say('');
    if (okB) {
        if (okA) {
            say('✔ 两种形状都通。B 是现在用的那条，配置没问题。');
        } else {
            say('✔ 形状 B 通 —— 这正是扩展现在用的那条路，配置正确。');
            say('  （形状 A 不通是正常的，它已经不用了，列在这里只为了对照。）');
        }
        say('');
        say('下一步不是继续看这个诊断，而是看扩展**实发**的那次请求：');
        say('  跑一次 ②，再点「查看实际请求体」，确认 custom_include_headers 带上了 Authorization。');
    } else if (okA) {
        say('△ 形状 A 通、形状 B 不通 —— 少见。把结果发我。');
    } else {
        say('✘ 形状 B 也不通 ⇒ 酒馆这条链路确实不接受这个密钥。');
        say('  但如果直连探针（probe-endpoint.mjs）同一个 key 是通的，');
        say('  那就说明差别在酒馆服务端转发这一层，需要看酒馆后台日志里真正的请求。');
    }
    log('换渠道诊断完成');
    return out.join('\n');
}

/**
 * 显示扩展**实际会构造出来的** custom_api —— 不发任何请求。
 *
 * 为什么需要它：换渠道诊断测的是「酒馆接受哪种形状」，那是关于**酒馆**的结论；
 * 这个函数回答的是另一个问题 ——「**扩展自己**发出去的是哪一种」。
 * 401 那轮排查里这两个问题被混在一起，绕了很久。
 *
 * 用的是 tavern.buildCustomApi，和真正发请求时同一个函数，
 * 所以这里显示的就是实发内容，不存在「文档和实现走偏」的可能。
 */
export async function dumpChannelPlan(settings) {
    const out = [];

    let buildCustomApi;
    try {
        const mod = await import('./tavern.js?v=0.8.26');
        buildCustomApi = mod.buildCustomApi;
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }
    if (typeof buildCustomApi !== 'function') {
        setDiagOutput('tavern.buildCustomApi 不可用（装的可能是旧版）。');
        return null;
    }

    const mask = (v) => {
        const s = String(v ?? '');
        if (!s) return '(空)';
        return s.length <= 12 ? `${s.slice(0, 3)}…${s.slice(-2)}` : `${s.slice(0, 6)}…${s.slice(-4)}`;
    };

    /** 密钥不能明文打到面板上 */
    const redact = (api) => {
        const copy = JSON.parse(JSON.stringify(api));
        if (copy.custom_include_headers?.Authorization) {
            const raw = String(copy.custom_include_headers.Authorization);
            copy.custom_include_headers.Authorization =
                `${mask(raw.replace(/^Bearer\s+/i, ''))}${/^Bearer\s+/i.test(raw) ? '  ⚠ 带 Bearer 前缀（会被拼成双前缀）' : '（裸 key，正确）'}`;
        }
        return copy;
    };

    out.push('=== 扩展实际会构造的 custom_api（不发请求）===');
    out.push('');

    for (const stage of ['critic', 'final']) {
        const label = stage === 'critic' ? '② 校验' : '③ 改写';
        const s = settings?.[stage];
        out.push(`--- ${label} ---`);
        if (!s) {
            out.push('（读不到该阶段设置）');
            out.push('');
            continue;
        }

        const api = buildCustomApi(s);
        out.push(`走哪条路: ${s.apiUrl ? '直接地址（形状 B）' : (s.proxyPreset ? '酒馆代理预设' : '当前连接')}`);
        out.push('custom_api = ' + JSON.stringify(redact(api), null, 2));
        out.push('');

        // 思考开关不在这里 —— 它走 CHAT_COMPLETION_SETTINGS_READY 事件注入，
        // 是另一条路。不显示的话，用户没法从这个 dump 确认自己的思考设置。
        const fields = s.bodyFields ?? {};
        const hasThinking = Object.prototype.hasOwnProperty.call(fields, 'thinking');
        out.push('附加请求体字段（思考开关走这条，不在上面的 custom_api 里）:');
        out.push('  ' + (Object.keys(fields).length ? JSON.stringify(fields) : '{}  ← 空'));
        if (hasThinking) {
            out.push(`  ⇒ thinking.type = ${JSON.stringify(fields.thinking?.type)}`);
        } else {
            out.push('  ⚠ 没设 thinking，上游默认值会生效 ——');
            out.push('     DeepSeek 官方 API 默认**开**思考，要关就得显式写');
            out.push('     {"thinking":{"type":"disabled"}}。');
            out.push('     Cline 则是怎么写都关不掉（实测它静默忽略这个字段）。');
        }
        out.push('');

        if (s.apiUrl && !s.apiKey) {
            out.push('⚠ 填了地址但没填密钥 —— 酒馆会退回「当前连接」的凭据，');
            out.push('  拿别的密钥去打这个端点，必然认证失败。');
            out.push('');
        }
        if (api.custom_include_headers?.Authorization?.startsWith?.('Bearer')) {
            out.push('⚠ Authorization 值里带了 Bearer 前缀，TavernHelper 会再加一次，');
            out.push('  拼成 "Bearer Bearer ..."。值应该只放裸 key。');
            out.push('');
        }
        if (api.key !== undefined) {
            out.push('⚠ 仍在传 custom_api.key —— 0.8.26 起应该走 custom_include_headers。');
            out.push('');
        }
    }

    out.push('怎么看：');
    out.push('  · custom_include_headers.Authorization 应该是「裸 key」');
    out.push('  · 不该出现 custom_api.key');
    out.push('  · 地址应该是 base url，/chat/completions 由酒馆补');
    out.push('  · 思考开关在「附加请求体字段」那一节，不在 custom_api 里');

    const text = out.join('\n');
    setDiagOutput(text);
    log('已导出扩展实际构造的 custom_api');
    return text;
}

/** 把 Authorization 脱敏，但保留能否看出「有没有 Bearer 前缀」 */
function redactAuth(v) {
    return String(v ?? '')
        .replace(/Bearer\s+\S+/g, 'Bearer <已打码>')
        .replace(/sk_\S+/g, '<已打码>');
}

/**
 * 打出这次请求的关键操作数。
 *
 * 前面几轮反复绕的原因就是只看结论、不看送出去的东西到底长什么样。
 * 这里把 custom_url 和 custom_include_headers 脱敏后原样显示，
 * 并直接点明「有没有 Bearer 前缀」——那是 401 的实际触发点。
 */
function describeKeyFields(body, say) {
    say('--- 这次实际发出的关键字段 ---');
    say(`custom_url              ${JSON.stringify(body.custom_url ?? null)}`);

    const raw = body.custom_include_headers;
    if (typeof raw === 'string') {
        say(`custom_include_headers  ${JSON.stringify(redactAuth(raw))}`);
        say(`  ↑ 字符串（YAML）  "Bearer " 前缀：${/Bearer\s/.test(raw) ? '有' : '**没有 ← 问题在这**'}`);
    } else if (raw && typeof raw === 'object') {
        const shown = { ...raw };
        if (shown.Authorization !== undefined) shown.Authorization = redactAuth(shown.Authorization);
        say(`custom_include_headers  ${JSON.stringify(shown)}`);
        say(`  ↑ 对象  "Bearer " 前缀：${/Bearer\s/.test(String(raw.Authorization ?? '')) ? '有' : '**没有 ← 问题在这**'}`);
    } else {
        say('custom_include_headers  (没有) **← 问题在这**');
    }
    say('');
}

/**
 * 真正走 TavernHelper 那条路跑一次，并**截获实际发出的 generate_data**。
 *
 * 为什么需要它：probeExact 是「我手写 body → 打酒馆后端」，而真链路是
 *   custom_api → TavernHelper 编译 → generate_data → 酒馆后端
 * 这两条**不一定等价**。前面反复出现「诊断通、实跑不通」，根源就在这 ——
 * 我一直在验证第一条路，而用户在跑第二条。
 *
 * 这个函数走第二条：调 tavernGenerate（和流水线同一个函数），同时监听
 * CHAT_COMPLETION_SETTINGS_READY 把 generate_data 截下来。于是
 * 「实跑发的是什么」和「它返回什么」都拿到了，不用再推。
 *
 * 成功时酒馆助手不往 chat 里写东西（should_silence），所以安全。
 *
 * @param {object} stage 单阶段设置
 */
export async function probeViaTavernHelper(stage) {
    const out = [];
    const say = (s) => { out.push(s); setDiagOutput(out.join('\n')); };

    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用。');
        return null;
    }

    let tavern;
    try {
        tavern = await import('./tavern.js?v=0.8.26');
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }

    say('=== 真正走 TavernHelper 跑一次（和流水线同一条路）===');
    say(`（扩展版本 ${VERSION ?? '?'}）`);
    say('');

    const probe = tavern.probeTavernHelper?.();
    say(`酒馆助手可用：${probe?.ok ? `是${probe.version ? `（v${probe.version}）` : ''}` : '否 ← 到这里就断了'}`);
    if (!probe?.ok) {
        say(`  缺：${(probe?.missing ?? []).join('；')}`);
        const t = out.join('\n');
        setDiagOutput(t);
        return t;
    }
    say('');

    const customApi = tavern.buildCustomApi(stage);
    say('会把这份 custom_api 交给 TavernHelper：');
    const shown = { ...customApi };
    if (shown.custom_include_headers?.Authorization) {
        shown.custom_include_headers = {
            ...shown.custom_include_headers,
            Authorization: redactAuth(shown.custom_include_headers.Authorization),
        };
    }
    say('  ' + JSON.stringify(shown, null, 2).split('\n').join('\n  '));
    say('');

    // 截获 generate_data
    let captured = null;
    let unsub = null;
    try {
        const es = context.eventSource;
        if (es?.on && context.eventTypes?.CHAT_COMPLETION_SETTINGS_READY) {
            unsub = es.on(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
                if (generateData?.custom_url || generateData?.custom_include_headers) {
                    captured = generateData;
                }
            });
        }
    } catch (e) {
        say(`挂事件监听失败：${e?.message}`);
    }

    say('开始调用 tavernGenerate…');
    const started = Date.now();
    let result = null;
    let failure = null;
    try {
        result = await tavern.tavernGenerate({ stage, generationId: `aw-probe-${Date.now()}` });
    } catch (e) {
        failure = e;
    } finally {
        try { unsub?.stop?.(); } catch { /* 忽略 */ }
    }
    say(`耗时 ${Date.now() - started}ms`);
    say('');

    say('--- TavernHelper 编译后实际发出的 generate_data ---');
    if (!captured) {
        say('（没截到）可能这次调用没触发 CHAT_COMPLETION_SETTINGS_READY。');
    } else {
        say(`custom_url              ${JSON.stringify(captured.custom_url ?? null)}`);
        const h = captured.custom_include_headers;
        if (typeof h === 'string') {
            say(`custom_include_headers  字符串 ${JSON.stringify(redactAuth(h))}`);
            say(`  "Bearer " 前缀：${/Bearer\s/.test(h) ? '有' : '**没有 ← 问题在这**'}`);
        } else if (h && typeof h === 'object') {
            say(`custom_include_headers  对象 ${JSON.stringify({ ...h, Authorization: redactAuth(h.Authorization ?? '') })}`);
            say(`  "Bearer " 前缀：${/Bearer\s/.test(String(h.Authorization ?? '')) ? '有' : '**没有 ← 问题在这**'}`);
        } else {
            say('custom_include_headers  (没有) **← 问题在这**');
        }
        const body = captured.custom_include_body;
        say(`custom_include_body     ${body === undefined ? '(没有)' : `${String(body).length} 字，含 providerOptions：${/providerOptions/.test(String(body)) ? '是' : '否'}`}`);
        say(`model                   ${JSON.stringify(captured.model ?? null)}`);
        say(`max_tokens              ${JSON.stringify(captured.max_tokens ?? null)}`);
        say(`reverse_proxy           ${JSON.stringify(captured.reverse_proxy ?? null)}`);
        say(`proxy_password          ${captured.proxy_password ? `(有，${String(captured.proxy_password).length} 字)` : '(空)'}`);
    }
    say('');

    say('--- 调用结果 ---');
    if (failure) {
        say(`✘ 抛错：${failure?.name ?? 'Error'}`);
        say(`  ${String(failure?.message ?? failure)}`);
    } else {
        say(`✔ 返回 ${String(result ?? '').length} 字：${JSON.stringify(String(result ?? '').slice(0, 120))}`);
    }
    say('');

    say('=== 判断 ===');
    say('  · 这里通而实跑不通 ⇒ 差别不在 TavernHelper，去看流水线自己做了什么');
    say('  · 这里也不通、且上面显示「没有前缀」⇒ 就是它');
    say('  · 这里也不通、前缀也在 ⇒ 把上面整段发我，这次有实际操作数了');

    const text = out.join('\n');
    setDiagOutput(text);
    log('走 TavernHelper 的真实复现完成');
    return text;
}

/**
 * 用**面板里真实的参数**复现一次 ② 的请求。
 *
 * 为什么需要它：`probeChannel` 用的是它自己编的参数（temperature 0.3、
 * max_tokens 32/100），而那和实跑的值可能差很远（实测面板里是 0.9 / 50000）。
 * 拿近似值测出来的「通」，不能证明实跑会通 —— 上游完全可能因为
 * max_tokens 超限之类的理由拒绝，而各家对这类拒绝的报错文案又很不一样。
 *
 * 所以这里严格照抄实跑：同一个 custom_api、同一组 bodyFields、同一个 useStream。
 *
 * @param {object} settings 完整设置（含 critic / final）
 */
export async function probeExact(settings) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用。');
        return null;
    }

    const out = [];
    const say = (s) => { out.push(s); setDiagOutput(out.join('\n')); };

    const mask = (v) => {
        const s = String(v ?? '');
        if (!s) return '(空)';
        return s.length <= 12 ? `${s.slice(0, 3)}…${s.slice(-2)}（${s.length}）` : `${s.slice(0, 6)}…${s.slice(-4)}（${s.length}）`;
    };

    let buildCustomApi;
    try {
        ({ buildCustomApi } = await import('./tavern.js?v=0.8.26'));
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }

    const stage = settings?.critic;
    if (!stage) {
        setDiagOutput('读不到 ② 的设置。');
        return null;
    }

    const customApi = buildCustomApi(stage);
    const bodyFields = stage.bodyFields ?? {};
    const useStream = stage.useStream !== false;

    say('=== 用真实参数复现 ② 的请求 ===');
    say(`（扩展版本 ${VERSION ?? '?'}）`);
    say('');
    say(`API 地址     ${customApi.apiurl ?? '(用当前连接)'}`);
    say(`模型         ${customApi.model ?? '(不覆盖)'}`);
    say(`密钥         ${mask(stage.apiKey)}`);
    say(`temperature  ${customApi.temperature ?? '(不传)'}`);
    say(`max_tokens   ${customApi.max_tokens ?? '(不传)'}`);
    say(`流式         ${useStream ? '开' : '关'}`);
    say(`附加字段     ${Object.keys(bodyFields).length ? JSON.stringify(bodyFields) : '{}（空）'}`);

    // 原始文本也打出来 —— 只有它能区分「没填」和「填了但 JSON 解析失败」。
    // 而且现在原文是**照发**的（走 custom_include_body），所以它比解析后的
    // 对象更能代表真正发出去的东西。
    const rawFields = stage.bodyFieldsRaw;
    if (typeof rawFields === 'string') {
        say(`附加字段原文 ${JSON.stringify(rawFields.slice(0, 200))}`);
        if (rawFields.trim() && rawFields.trim() !== '{}' && Object.keys(bodyFields).length === 0) {
            say('  ℹ 原文不是严格 JSON ⇒ 会被原样发给上游（这是想要的效果：');
            say('     严格 JSON 会被酒馆解析后丢掉它不认识的字段，例如 providerOptions）');
        }
    }
    say('');

    // 严格照抄 buildCustomApi 的产出 + 附加字段，只替掉 messages。
    //
    // 但 `apiurl` 要拿掉：它是 TavernHelper 的**配置字段**，不是酒馆后端的
    // 入参。留着它，酒馆后端可能会把不认识的顶层字段一起转给上游，
    // 而第三方端点遇到多余字段的反应不可预期。真实链路里
    // custom_api.apiurl 是被 applyCustomApiOverrides 消费掉的，不会进 generate_data，
    // 所以这里也必须一致 —— 否则这个诊断本身就不是「照抄实跑」。
    const body = {
        ...customApi,
        messages: [{ role: 'user', content: 'Say OK' }],
        stream: useStream,
        chat_completion_source: 'custom',
        custom_url: customApi.apiurl,
        use_sysprompt: false,
    };
    // 附加字段已经在 customApi.custom_include_body 里（buildCustomApi 放的原文），
    // 所以这里**不能**再 spread bodyFields —— 那会把解析后的对象又塞回顶层，
    // 而酒馆会严格解析并丢掉不认识的字段，正好和用户要的效果相反。
    delete body.apiurl;
    // key 已经在 custom_include_headers 里了，这里绝不能带 —— 带了就退回旧做法
    delete body.key;

    say('发出的 body 顶层字段：');
    say('  ' + Object.keys(body).join(', '));
    say('');

    const exact = await sendAndReport(context, body, say, out);

    // 把**实际操作数**打出来 —— 前面反复绕的原因就是只看结论、不看送出去的东西
    // 到底长什么样。
    describeKeyFields(body, say);

    // 自证：把判断依据打出来。
    // 这里出过一次事故 —— 输出里既有「✘ 上游/酒馆报错」又走了「通过」分支，
    // 而我只能靠比对文案去猜用户装的是哪一版。打出来就不必猜。
    say(`（判断依据：${exact.verdict}；HTTP ${exact.status ?? '?'}；响应 ${exact.raw.length} 字）`);
    say('');

    // 只有真的复现了失败才继续二分 —— 没失败说明触发条件还没找到。
    if (exact.verdict !== 'fail') {
        say('=== 判断 ===');
        say('  · 用真实参数这里是通的 ⇒ 差别在「走不走酒馆助手的 generate()」，');
        say('    下一步看「查看实际请求体」里实发的那份 generate_data。');
        const okText = out.join('\n');
        setDiagOutput(okText);
        log('真实参数复现完成（通过）');
        return okText;
    }

    say('=== 复现成功，继续二分 ===');
    // 输出太长时，可以用面板里的「复制结果」按钮，或者只跑一个变体：
    // 在诊断输出框里能看到全部；想精简就看 hash，例如打开 #awOnly=1
    let only = null;
    try {
        const m = /awOnly=(\d+)/.exec(globalThis.location?.hash ?? '');
        if (m) only = Number(m[1]);
    } catch { /* 无所谓 */ }
    say(only ? `只跑变体 ${only}（URL 带了 #awOnly=${only}）` : '每次只改一处，看哪个字段是触发点。');
    say('');

    const variants = [
        // 头三条专测「酒馆后端到底认哪种 Authorization 写法」——
        // 二分到最干净的 body 也失败后，唯一剩下的变量就是它。
        ['① custom_include_headers 的值改成带 Bearer 前缀',
            (b) => { b.custom_include_headers = `"Authorization": "Bearer ${stage.apiKey}"`; }],
        ['② custom_include_headers 的值保持裸 key（当前做法）',
            (b) => { /* 不动 */ }],
        ['③ 改用顶层 key 字段（TavernHelper 的旧做法）',
            (b) => { delete b.custom_include_headers; b.key = stage.apiKey; }],
        ['④ 用 secret_id 让服务端取密钥',
            (b) => { delete b.custom_include_headers; }],
        ['⑤ 去掉 source', (b) => { delete b.source; }],
        ['⑥ 去掉 chat_completion_source', (b) => { delete b.chat_completion_source; }],
        ['⑦ 去掉 use_sysprompt', (b) => { delete b.use_sysprompt; }],
        ['⑧ 只留 model + messages + stream + custom_include_headers', (b) => {
            for (const k of Object.keys(b)) {
                if (!['model', 'messages', 'stream', 'custom_include_headers'].includes(k)) delete b[k];
            }
        }],
    ];

    let found = null;
    for (const [label, mutate] of variants) {
        if (only !== null && !label.startsWith(String(only))) continue;
        const v = JSON.parse(JSON.stringify(body));
        mutate(v);
        say(`--- ${label}`);
        const result = await sendAndReport(context, v, say, out);
        if (result.verdict === 'ok') {
            found = label;
            say(`⇒ 「${label}」让它通了 —— 触发点就在这一项改掉的字段上。`);
            break;
        }
    }

    say('');
    say('=== 判断 ===');
    if (found) {
        say(`触发点在「${found}」改掉的字段上。`);
    } else {
        say('连最干净的 ⑧ 也失败 ⇒ 不是字段问题，是这条链路或这个 key 此刻的状态。');
        say('拿同一个 key 跑 agent-writer-tools/probe-endpoint.mjs 对照：');
        say('  直连通、这里不通 ⇒ 问题在酒馆后端这一层');
        say('  直连也不通       ⇒ key 的问题（额度用尽 / 已失效）');
    }

    const text = out.join('\n');
    setDiagOutput(text);
    log('真实参数复现 + 二分完成');
    return text;
}

/**
 * 把 body 发给酒馆后端并如实报告结果。
 *
 * 之所以要「如实」：上游的拒绝理由和 HTTP 状态码经常对不上
 * （Cline 就是撞额度也回 401），所以状态码和响应体必须都打出来，
 * 不能只凭状态码下结论。
 */
/**
 * 把 body 发给酒馆后端并如实报告结果。
 *
 * 之所以要「如实」：上游的拒绝理由和 HTTP 状态码经常对不上
 * （Cline 就是撞额度也回 401），所以状态码和响应体必须都打出来，
 * 不能只凭状态码下结论。
 *
 * 判读交给 classifyBackendResponse（纯函数，有测试）。
 *
 * @returns {{verdict: 'ok'|'fail'|'unknown', status: number|null, message: string, raw: string}}
 */
async function sendAndReport(context, body, say, out) {
    say(`HTTP …`);
    try {
        const resp = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await resp.text();
        const result = classifyBackendResponse(text, resp.status);
        // 把刚刚那行占位的 "HTTP …" 换成真实状态码
        out[out.length - 1] = `HTTP ${resp.status}`;
        say(result.verdict === 'fail' ? '✘ 上游/酒馆报错：' : '');
        if (result.message) say('  ' + result.message);
        say('');
        return result;
    } catch (e) {
        const detail = `${e?.message}${e?.cause ? ` / cause: ${e?.cause?.message ?? e.cause}` : ''}`;
        out[out.length - 1] = `HTTP (请求抛错)`;
        say(`抛错: ${detail}`);
        say('');
        return { verdict: 'fail', status: null, message: `抛错: ${detail}`, raw: '' };
    }
}

/**
 * 把酒馆后端的响应文本判读成「通 / 不通 / 说不清」。
 *
 * 抽成纯函数是为了能单独测 —— 这段逻辑出过一次事故：
 * 输出里明明白白写着「✘ 上游/酒馆报错」，而调用方却判出 unknown，
 * 于是二分不跑、还走了「通过」分支，白绕了好几轮。
 * 读代码看不出问题（.message 的分支确实写了），所以必须有测试。
 *
 * @returns {{verdict: 'ok'|'fail'|'unknown', status: number|null, message: string, raw: string}}
 */
export function classifyBackendResponse(text, status = null) {
    const raw = String(text ?? '');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 可能是 SSE 或纯文本 */ }

    // 上游/酒馆的报错：error 可能是字符串、对象，也可能是布尔 true。
    // 注意空字符串和 false 不算报错 —— 直接判 `!== undefined` 会把
    // {"error":""} 误判成失败（这个边界是测试抓出来的）。
    const errField = parsed?.error;
    const hasError = typeof errField === 'string'
        ? errField.trim().length > 0
        : Boolean(errField);
    if (hasError) {
        const message = typeof errField === 'object'
            ? (errField.message ?? JSON.stringify(errField))
            : String(errField);
        return { verdict: 'fail', status, message, raw };
    }

    // 流式：SSE
    if (/^\s*data:/m.test(raw)) {
        const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
        const done = lines.some((l) => l.includes('[DONE]'));
        let chars = 0;
        for (const line of lines) {
            if (line.includes('[DONE]')) continue;
            let j = null;
            try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
            chars += String((j?.data ?? j)?.choices?.[0]?.delta?.content ?? '').length;
        }
        return {
            verdict: 'ok',
            status,
            message: `流式成功：分片 ${lines.length} 个，正文 ${chars} 字${done ? '，收到 [DONE]' : ''}`,
            raw,
        };
    }

    // 非流式：Cline 会把标准结构再包一层 data，两种都认
    if (parsed && typeof parsed === 'object') {
        const inner = parsed.data ?? parsed;
        const content = inner?.choices?.[0]?.message?.content
            ?? inner?.choices?.[0]?.text
            ?? parsed.content
            ?? '';
        if (String(content).trim()) {
            return { verdict: 'ok', status, message: `成功：${JSON.stringify(String(content).slice(0, 80))}`, raw };
        }
        return { verdict: 'unknown', status, message: `通了但没正文。原始响应前 300 字：\n  ${raw.slice(0, 300)}`, raw };
    }

    return { verdict: 'unknown', status, message: `响应不是 JSON，前 300 字：\n  ${raw.slice(0, 300)}`, raw };
}

/**
 * 快照酒馆的关键设置状态，用于「动手前后对比」。
 *
 * 为什么需要它：我打算临时改 oai_settings 来换渠道，而用户反馈
 * 「手动改 API 设置会导致预设的正则被关闭」。原因不明 ——
 * 正则被关的机制在 regex/index.js:351（applyPresetList 会把不在预设里的
 * 正则全 disabled），但**是什么触发了它**我没查出来。
 *
 * 这种情况下不该推理，该测量：改之前拍一张、改之后再拍一张、对比差异。
 *
 * @returns {object|null}
 */
export function snapshotSettings() {
    const context = ctx();
    if (!context) return null;

    let oai = null;
    try {
        oai = context.chatCompletionSettings ?? context.oai_settings ?? null;
    } catch { /* 读不到 */ }

    let regexState = null;
    try {
        const scripts = context.extensionSettings?.regex ?? null;
        if (Array.isArray(scripts)) {
            const disabled = scripts.filter((s) => s?.disabled).length;
            regexState = { total: scripts.length, disabled, enabled: scripts.length - disabled };
        }
    } catch { /* 读不到 */ }

    return {
        // 扩展**读到的** auto —— 触发钩子判断用的就是它
        'settings.auto': (() => {
            try { return context.extensionSettings?.agent_writer?.auto ?? '(没有)'; } catch { return '(读不到)'; }
        })(),
        // 面板勾选框的状态 —— 用户看到的。两者不一致就是「我明明开了却不跑」的原因
        '面板勾选框 checked': (() => {
            try { return document.getElementById('aw-auto')?.checked ?? '(没有这个控件)'; } catch { return '(读不到)'; }
        })(),
        // 面板被重建过几次。> 1 就会清空输出框 ——「框闪一下就不见了」多半是这个
        '面板重建次数': (() => {
            try { return getMountCount?.() ?? '(读不到)'; } catch { return '(读不到)'; }
        })(),
        chat_completion_source: oai?.chat_completion_source ?? null,
        custom_url: oai?.custom_url ?? null,
        custom_model: oai?.custom_model ?? null,
        preset_settings_openai: oai?.preset_settings_openai ?? null,
        reverse_proxy: oai?.reverse_proxy ?? null,
        proxy_password_set: Boolean(oai?.proxy_password),
        regex: regexState,
        regex_preset_id: context.extensionSettings?.regex_preset ?? null,
    };
}

/**
 * 打印快照，并和上一次的快照对比。
 *
 * 用法：点「拍快照」→ 手动做那个操作（例如改 API 设置）→ 再点一次 → 看差异。
 */
let lastSnapshot = null;

export function compareSnapshot() {
    const now = snapshotSettings();
    if (!now) {
        setDiagOutput('读不到酒馆设置。');
        return null;
    }

    const out = [];
    const pretty = (v) => (v === null || v === undefined ? '(无)' : JSON.stringify(v));

    out.push('=== 设置快照 ===');
    out.push('');
    for (const [k, v] of Object.entries(now)) {
        out.push(`  ${k.padEnd(24)} ${pretty(v)}`);
    }
    out.push('');

    if (lastSnapshot) {
        out.push('=== 与上一次快照的差异 ===');
        out.push('');
        const keys = new Set([...Object.keys(lastSnapshot), ...Object.keys(now)]);
        let changed = 0;
        for (const k of keys) {
            const a = JSON.stringify(lastSnapshot[k]);
            const b = JSON.stringify(now[k]);
            if (a === b) continue;
            changed++;
            out.push(`  ✘ ${k}`);
            out.push(`      之前: ${pretty(lastSnapshot[k])}`);
            out.push(`      现在: ${pretty(now[k])}`);
        }
        if (!changed) out.push('  （没有差异）');
        out.push('');
        out.push('如果 regex 的 enabled 数变了，说明那个操作确实动了正则 ——');
        out.push('  机制在 public/scripts/extensions/regex/index.js:351：');
        out.push('  applyPresetList 会把「不在当前预设里」的正则全部 disabled。');
    } else {
        out.push('（这是第一张快照。现在去做那个操作，然后再点一次对比。）');
    }

    lastSnapshot = now;
    const text = out.join('\n');
    setDiagOutput(text);
    log('已导出设置快照');
    return text;
}

/**
 * 监听一段时间内**实际发生**的流式相关事件，把结果打到面板上。
 *
 * 为什么需要它：平板上开控制台不方便，而「思维链为什么是空的」这类问题
 * 只能靠「事件到底有没有发」来判断。之前是靠读源码 + 推理，绕了很久。
 *
 * 用法：点按钮 → 在 20 秒内跑一次 ② → 回来看输出。
 *
 * @param {number} [seconds]
 */
export async function watchStreamEvents(seconds = 20) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用。');
        return null;
    }

    const es = context.eventSource;
    const et = context.eventTypes;
    if (!es?.on) {
        setDiagOutput('eventSource 不可用。');
        return null;
    }

    // 想确认存在性的那些事件。带 ★ 的是扩展真正依赖的。
    const wanted = [
        ['★ js_stream_token_received_fully', 'js_stream_token_received_fully'],
        ['  js_stream_token_received_incrementally', 'js_stream_token_received_incrementally'],
        ['★ STREAM_REASONING_DONE', et?.STREAM_REASONING_DONE],
        ['  STREAM_TOKEN_RECEIVED（怀疑是死的）', et?.STREAM_TOKEN_RECEIVED],
        ['  GENERATION_STARTED', et?.GENERATION_STARTED],
        ['  GENERATION_ENDED', et?.GENERATION_ENDED],
        ['  CHAT_COMPLETION_SETTINGS_READY', et?.CHAT_COMPLETION_SETTINGS_READY],
    ].filter(([, name]) => name);

    const hits = new Map();
    const subs = [];
    const started = Date.now();

    const pad = (n) => String(n).padStart(2, '0');
    const elapsed = () => {
        const s = Math.round((Date.now() - started) / 100) / 10;
        return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${pad(Math.round(s % 60))} 秒`;
    };

    const render = () => {
        const body = [];
        body.push('=== 流式事件监听 ===');
        body.push(`（已监听 ${elapsed()}，共 ${seconds} 秒）`);
        body.push('');
        for (const [label] of wanted) {
            const h = hits.get(label);
            if (!h) {
                body.push(`  ○ ${label}  —— 没发生`);
            } else {
                body.push(`  ● ${label}  —— ${h.count} 次（其中带文本 ${h.nonEmpty ?? 0} 次）`);
                if (h.sample) body.push(`      样本(非空): ${h.sample}`);
                if (h.firstSample && h.firstSample !== h.sample) {
                    body.push(`      首次:      ${h.firstSample}`);
                }
            }
        }
        body.push('');
        body.push('怎么看：');
        body.push('  · ★ 那两个是扩展依赖的。带文本 0 次 ⇒ 事件在发但没内容，进度必然不动');
        body.push('  · 首次样本是空串属正常（思考型模型首个分片只有思维链，正文为空）');
        body.push('  · STREAM_REASONING_DONE 没发生 ⇒ 思维链抓不到（那条路只能靠它）');
        body.push('  · 看它的参数形状，能判断思维链是在第一个参数里还是在 state 里');
        setDiagOutput(body.join('\n'));
        return body.join('\n');
    };

    for (const [label, name] of wanted) {
        try {
            const sub = es.on(name, (...args) => {
                const prev = hits.get(label) ?? { count: 0, sample: '', firstSample: '', nonEmpty: 0 };
                prev.count++;

                const text = typeof args[0] === 'string' ? args[0] : '';
                if (text) prev.nonEmpty++;

                const format = () => args
                    .map((a) => {
                        if (typeof a === 'string') return `"${a.slice(0, 60)}"`;
                        if (a && typeof a === 'object') return `{${Object.keys(a).slice(0, 8).join(',')}}`;
                        return String(a);
                    })
                    .join(' | ');

                // 第一次的参数往往没参考价值 —— 思考型模型的首个分片只有
                // reasoning_content，正文是空字符串，于是「首个样本」永远是 ""。
                // 之前只留第一个样本，结果把一个完全正常的事件判成了没带文本。
                // 所以首样本和最新的非空样本都留下。
                if (!prev.firstSample) prev.firstSample = format();
                if (text || !prev.sample) prev.sample = format();

                hits.set(label, prev);
                render();
            });
            subs.push(sub);
        } catch (e) {
            console.warn(`[AgentWriter] 挂监听 ${label} 失败`, e);
        }
    }

    const first = render();
    log(`已开始监听 ${seconds} 秒（挂上 ${subs.length} 个事件）。跑一次 ② 后回来看结果。`);

    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    for (const sub of subs) {
        try { sub?.stop?.(); } catch { /* 忽略 */ }
    }
    const final = render();
    log('流式事件监听结束');
    return final || first;
}

/** 挂到 window，方便不开面板直接调用 */
export function exposeGlobals() {
    globalThis.awDiagnose = diagnose;
    globalThis.awProbe = probe;
    globalThis.awProbeSecret = probeSecret;
    globalThis.awProbeShape = probeShape;
    globalThis.awLastRequests = showLastRequests;
    globalThis.awProbeChannel = probeChannel;
    globalThis.awChannelPlan = dumpChannelPlan;
    globalThis.awProbeExact = probeExact;
    globalThis.awProbeViaTh = probeViaTavernHelper;
    globalThis.awSnapshot = compareSnapshot;
    globalThis.awWatchStream = watchStreamEvents;
}
