// client.mjs
//
// 模组的渲染端入口。做的事情只有一件：把一个音源注册进宿主。
//
// ⚠️ 注册通道是 folium.experimental['omni.providers']，不是 folium.registries.*。
// 实验接口不在 registries 下（见 src/mods/folium/experimental.ts 的 createFoliumExperimental），
// 并且只有在 mod.json 的 experimental 里选了 'omni.providers' 才可访问。

import { createHttp } from './lib/http.mjs';
import { createBilibiliProvider } from './providers/bilibili.mjs';
import { createLrclibBackend } from './providers/lyrics/lrclib.mjs';

const MOD_ID = 'neri-bridge';

export default function activate(folium) {
    const log = folium.log;
    const omniProviders = folium.experimental?.['omni.providers'];

    if (!omniProviders?.register) {
        // 清单漏了 experimental 或宿主版本不支持时，给出可读的提示而不是静默失效
        log?.error?.('omni.providers is unavailable; check the manifest experimental list');
        return undefined;
    }

    if (!folium.net?.fetch) {
        log?.error?.('net.fetch is unavailable; the net.fetch permission is required');
        return undefined;
    }

    const http = createHttp(folium, log);
    const lrclib = createLrclibBackend(http);

    const provider = createBilibiliProvider({ http, lrclib, log });
    const handle = omniProviders.register(provider);

    log?.info?.(`${MOD_ID}: registered provider ${handle?.id ?? provider.id}`);

    // 宿主停用模组时也会自动撤下注册，这里返回 disposer 是为了让卸载路径不依赖宿主的时序
    return () => {
        try {
            handle?.unregister?.();
        } catch (error) {
            log?.warn?.('failed to unregister provider', { message: String(error?.message ?? error) });
        }
    };
}
