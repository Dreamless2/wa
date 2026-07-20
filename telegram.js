import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { getDevice } from 'baileys'

const TIME_HOURS = process.env.DOWNLOADS_CLEANUP_INTERVAL_HOURS ? parseInt(process.env.DOWNLOADS_CLEANUP_INTERVAL_HOURS, 10) : 48
const DOWNLOADS_CLEANUP_INTERVAL_MS = TIME_HOURS * 60 * 60 * 1000

function loadEnv(path = './.env') {
    if (!existsSync(path)) return

    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue

        const separator = trimmed.indexOf('=')
        if (separator === -1) continue

        const key = trimmed.slice(0, separator).trim()
        let value = trimmed.slice(separator + 1).trim()
        value = value.replace(/\s+\/\/.*$/, '').replace(/^['"]|['"]$/g, '')
        if (key && process.env[key] === undefined) process.env[key] = value
    }
}

loadEnv()

const telegramConfig = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.CHAT_ID,
    sendRegularMedia: process.env.SEND_REGULAR_MEDIA === 'true',
    sendTextMessages: process.env.SEND_TEXT_MESSAGES === 'true',
    cleanDownloads: process.env.CLEAN_DOWNLOADS !== 'false',
}

const telegramEnabled = () => Boolean(telegramConfig.botToken && telegramConfig.chatId
    && !telegramConfig.botToken.includes('your_telegram_bot_token_here')
    && !telegramConfig.chatId.includes('your_chat_id_here'))

const telegramUrl = (method) => `https://api.telegram.org/bot${telegramConfig.botToken}/${method}`
const formatError = (err) => err?.stack || err?.message || String(err)

export function telegramBotConfig() {
    return {
        enabled: telegramEnabled(),
        chatId: telegramConfig.chatId ? String(telegramConfig.chatId) : null,
    }
}

export async function callTelegramBot(method, body, signal) {
    if (!telegramEnabled()) throw new Error('Telegram bot credentials are not configured.')

    const res = await fetch(telegramUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    })
    const response = await res.json().catch(() => null)

    if (!res.ok || !response?.ok) {
        const description = response?.description || `${res.status} ${res.statusText}`
        throw new Error(`Telegram ${method} failed: ${description}`)
    }

    return response.result
}

function messageDevice(messageId) {
    if (/^2A[0-9A-F]{18}$/i.test(messageId)) return 'ios-business'
    return getDevice(messageId)
}

export function senderDevice(msg) {
    return msg.key.id ? messageDevice(msg.key.id) : 'unknown'
}

export const shouldSendRegularMedia = () => telegramConfig.sendRegularMedia
export const shouldSendTextMessages = () => telegramConfig.sendTextMessages

export function telegramRuntimeConfig() {
    const hasCredentials = telegramEnabled()

    return {
        hasCredentials,
        sendViewOnce: hasCredentials,
        sendRegularMedia: hasCredentials && telegramConfig.sendRegularMedia,
        sendTextMessages: hasCredentials && telegramConfig.sendTextMessages,
        cleanDownloads: telegramConfig.cleanDownloads,
    }
}

export function senderMetadata(msg) {
    const remoteJid = msg.key.remoteJid
    const senderJid = msg.key.participant || remoteJid
    const name = msg.pushName || msg.verifiedBizName || 'unknown'
    const device = senderDevice(msg)

    return [
        `Name: ${name}`,
        `Sender JID: ${senderJid || 'unknown'}`,
        `Device : ${device}`,
        `Time: ${new Date().toISOString()}`,
    ].join('\n')
}

export async function sendTelegramText(text) {
    if (!telegramEnabled()) return

    await callTelegramBot('sendMessage', { chat_id: telegramConfig.chatId, text })
}

export async function sendTelegramMedia(buffer, filename, mediaType, caption) {
    if (!telegramEnabled()) return

    const form = new FormData()
    form.append('chat_id', telegramConfig.chatId)
    form.append('caption', caption.slice(0, 1024))

    let method = 'sendDocument'
    let field = 'document'
    let mimeType = 'application/octet-stream'

    if (mediaType === 'image') {
        method = 'sendPhoto'
        field = 'photo'
        mimeType = 'image/jpeg'
    } else if (mediaType === 'video') {
        method = 'sendVideo'
        field = 'video'
        mimeType = 'video/mp4'
    } else if (mediaType === 'voice') {
        method = 'sendVoice'
        field = 'voice'
        mimeType = 'audio/ogg'
    }

    form.append(field, new Blob([buffer], { type: mimeType }), basename(filename))

    const res = await fetch(telegramUrl(method), { method: 'POST', body: form })
    if (!res.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${await res.text()}`)
}

export function startDownloadsCleanup(downloadsDir) {
    if (!telegramConfig.cleanDownloads) {
        console.log('[Cleanup] Downloads cleanup disabled')
        return
    }

    const cleanup = async () => {
        try {
            mkdirSync(downloadsDir, { recursive: true })
            for (const entry of readdirSync(downloadsDir)) {
                rmSync(join(downloadsDir, entry), { recursive: true, force: true })
            }

            await sendTelegramText('cleaned downloads folder')
            console.log('[Cleanup] Cleaned downloads folder')
        } catch (err) {
            console.log(`[Cleanup] Failed: ${err.message}`)
            if (!err.message?.startsWith('Telegram sendMessage failed:')) {
                try {
                    await sendTelegramText(`[DOWNLOADS CLEANUP ERROR]\nTime: ${new Date().toISOString()}\n${formatError(err)}`)
                } catch {}
            }
        }
    }

    setInterval(cleanup, DOWNLOADS_CLEANUP_INTERVAL_MS)
}
