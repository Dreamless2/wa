/**
 * Post-install patch for baileys
 * Spoofs UserAgent and companion device props to present as Android (Pixel 10) WhatsApp client.
 * Without this, the server identifies us as a web client and withholds view-once media.
 */
import { readFileSync, writeFileSync } from 'fs'

const TARGET = './node_modules/baileys/lib/Utils/validate-connection.js'

let src = readFileSync(TARGET, 'utf-8')

// 1. Patch getUserAgent() — replace the hardcoded WEB/Desktop payload with Android
const oldUserAgent = `const getUserAgent = (config) => {
    return {
        appVersion: {
            primary: config.version[0],
            secondary: config.version[1],
            tertiary: config.version[2]
        },
        platform: proto.ClientPayload.UserAgent.Platform.WEB,
        releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
        osVersion: '0.1',
        device: 'Desktop',
        osBuildNumber: '0.1',
        localeLanguageIso6391: 'en',
        mnc: '000',
        mcc: '000',
        localeCountryIso31661Alpha2: config.countryCode
    };
};`

const newUserAgent = `const getUserAgent = (config) => {
    return {
        appVersion: {
            primary: 2,
            secondary: 26,
            tertiary: 16,
            quaternary: 73
        },
        platform: proto.ClientPayload.UserAgent.Platform.ANDROID,
        releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
        osVersion: '16',
        manufacturer: 'Google',
        device: 'frankel', 
        osBuildNumber: 'CP1A.260405.005',
        deviceBoard: 'frankel',
        deviceType: proto.ClientPayload.UserAgent.DeviceType.PHONE,
        phoneId: crypto.randomUUID(),
        localeLanguageIso6391: 'en',
        mnc: '001',
        mcc: '310',
        localeCountryIso31661Alpha2: 'US'
    };
};`

if (!src.includes('Platform.WEB')) {
    console.log('Already patched or source changed — skipping UserAgent patch')
} else {
    src = src.replace(oldUserAgent, newUserAgent)
    // Add crypto import if not present
    if (!src.includes("import crypto") && !src.includes("import { randomUUID }")) {
        src = `import crypto from 'crypto';\n` + src
    }
    console.log('Patched getUserAgent: Platform.ANDROID, DeviceType.PHONE, device=frankel')
}

// 2. Patch getWebInfo() — Android clients do NOT send webInfo at all
const oldWebInfo = `const getWebInfo = (config) => {
    let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER;
    if (config.syncFullHistory &&
        PLATFORM_MAP[config.browser[0]] &&
        config.browser[1] === 'Desktop') {
        webSubPlatform = PLATFORM_MAP[config.browser[0]];
    }
    return { webSubPlatform };
};`

const newWebInfo = `const getWebInfo = (config) => {
    return undefined;
};`

if (src.includes(oldWebInfo)) {
    src = src.replace(oldWebInfo, newWebInfo)
    console.log('Patched getWebInfo: returns undefined (Android clients omit webInfo)')
} else {
    console.log('getWebInfo not found as expected — may need manual check')
}

// 3. Patch getClientPayload() — omit webInfo when undefined, no webInfo field at all for Android
const oldClientPayload = `const getClientPayload = (config) => {
    const payload = {
        connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
        connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config)
    };
    payload.webInfo = getWebInfo(config);
    return payload;
};`

const newClientPayload = `const getClientPayload = (config) => {
    const payload = {
        connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
        connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
        userAgent: getUserAgent(config)
    };
    const webInfo = getWebInfo(config);
    if (webInfo) payload.webInfo = webInfo;
    return payload;
};`

if (src.includes(oldClientPayload)) {
    src = src.replace(oldClientPayload, newClientPayload)
    console.log('Patched getClientPayload: omits webInfo entirely')
} else {
    console.log('getClientPayload not found as expected — may need manual check')
}

// 4. Patch getPlatformType — force ANDROID_PHONE for companion device registration
const oldGetPlatformType = `const getPlatformType = (platform) => {
    const platformType = platform.toUpperCase();
    return (proto.DeviceProps.PlatformType[platformType] ||
        proto.DeviceProps.PlatformType.CHROME);
};`

const newGetPlatformType = `const getPlatformType = (platform) => {
    return proto.DeviceProps.PlatformType.ANDROID_PHONE;
};`

if (src.includes(oldGetPlatformType)) {
    src = src.replace(oldGetPlatformType, newGetPlatformType)
    console.log('Patched getPlatformType: always returns ANDROID_PHONE (16)')
} else {
    console.log('getPlatformType not found as expected — may need manual check')
}

writeFileSync(TARGET, src)
console.log('\nDone. Baileys will now register as an Android device.')
console.log('IMPORTANT: Delete auth_info_android_bypass/ before re-pairing — server remembers device type from registration.')
