import makeWASocket, { DisconnectReason, downloadMediaMessage, jidNormalizedUser, BufferJSON } from 'baileys'
import pino from 'pino'
import { writeFileSync, mkdirSync } from 'fs'
import qrcode from 'qrcode-terminal'
import { DatabaseSync } from 'node:sqlite'
import { senderDevice, senderMetadata, sendTelegramMedia, sendTelegramText, shouldSendRegularMedia, shouldSendTextMessages, startDownloadsCleanup, telegramRuntimeConfig } from './telegram.js'
import express from 'express'

const express = require('express');
const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Running')
})

app.listen(port, () => {
  console.log(`Listening on port ${port}`)
})


const DOWNLOADS_DIR = './downloads'
mkdirSync(DOWNLOADS_DIR, { recursive: true })

const TIME_HOURS = process.env.DOWNLOADS_CLEANUP_INTERVAL_HOURS ? parseInt(process.env.DOWNLOADS_CLEANUP_INTERVAL_HOURS, 10) : 48

const PERSONAL_SUFFIXES = ['@s.whatsapp.net', '@lid', '@c.us']

const FILE_SIZE_LIMIT = process.env.FILE_SIZE_LIMIT_BYTES ? parseInt(process.env.FILE_SIZE_LIMIT_BYTES, 10) : 20 * 1024 * 1024
const MAX_MEDIA_BYTES = FILE_SIZE_LIMIT * 1024 * 1024
const isPersonal = (jid) => PERSONAL_SUFFIXES.some(s => jid?.endsWith(s))

const PRESENCE_INTERVAL_MIN_MS = 4 * 60_000
const PRESENCE_INTERVAL_MAX_MS = 80 * 60_000
const PRESENCE_BLIP_MIN_MS = 1_000
const PRESENCE_BLIP_MAX_MS = 120_000
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
let activeWhatsAppSocket = null

const db = new DatabaseSync('whatsapp_auth.sqlite')

db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_auth (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )
`)

async function useNativeSQLiteAuthState(sessionId = 'default') {
    const readData = (id) => {
        try {
            const stmt = db.prepare('SELECT data FROM whatsapp_auth WHERE id = ?')
            const row = stmt.get(`${sessionId}_${id}`)
            if (row) {
                return JSON.parse(row.data, BufferJSON.reviver)
            }
        } catch (error) {
            console.log(`[Native SQLite Error] Erro ao ler ${id}:`, error.message)
        }
        return null
    }

    const writeData = (id, data) => {
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer)
            const stmt = db.prepare(`
                INSERT INTO whatsapp_auth (id, data) 
                VALUES (?, ?) 
                ON CONFLICT(id) DO UPDATE SET data = excluded.data
            `)
            stmt.run(`${sessionId}_${id}`, serialized)
        } catch (error) {
            console.log(`[Native SQLite Error] Erro ao escrever ${id}:`, error.message)
        }
    }

    const removeData = (id) => {
        try {
            const stmt = db.prepare('DELETE FROM whatsapp_auth WHERE id = ?')
            stmt.run(`${sessionId}_${id}`)
        } catch (error) {
            console.log(`[Native SQLite Error] Erro ao deletar ${id}:`, error.message)
        }
    }

    const creds = (await readData('creds')) || (await import('baileys')).initAuthCreds()

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = readData(`${type}-${id}`)
                            if (type === 'app-state-sync-key' && value) {
                                value = (await import('baileys')).proto.Message.AppStateSyncKeyData.fromObject(value)
                            }
                            data[id] = value
                        })
                    )
                    return data
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            const key = `${category}-${id}`
                            if (value) {
                                writeData(key, value)
                            } else {
                                removeData(key)
                            }
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    }
}

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

function printStartupConfig() {
    const config = telegramRuntimeConfig()
    const will = (enabled) => enabled ? 'will' : 'will not'
    const credentials = config.hasCredentials ? 'present' : 'not present'
    const credentialWarning = config.hasCredentials ? '' : ' (Telegram sends disabled)'

    console.log([
        '',
        'waview started, checking for auth...',
        '--------------------------------------',
        `Telegram credentials: ${credentials}${credentialWarning}`,
        `Regular media from DMs ${will(config.sendRegularMedia)} be sent to Telegram`,
        `Text messages ${will(config.sendTextMessages)} be sent to Telegram`,
        `View once messages ${will(config.sendViewOnce)} be sent to Telegram`,
        `Downloads folder ${will(config.cleanDownloads)} be cleaned every ${TIME_HOURS} hours`,
        '',
    ].join('\n'))
}

printStartupConfig()
startDownloadsCleanup(DOWNLOADS_DIR)

process.on('unhandledRejection', (err) => {
    console.log(`[Unhandled Rejection] ${formatError(err)}`)
    void notifyTelegramEvent('UNHANDLED REJECTION', formatError(err))
})

process.on('uncaughtException', (err) => {
    console.log(`[Uncaught Exception] ${formatError(err)}`)
    void notifyTelegramEvent('UNCAUGHT EXCEPTION', formatError(err))
})

async function startSpoofedSession() {
    const { state, saveCreds } = await useNativeSQLiteAuthState('android_bypass_session')
    let presenceTimer = null

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        // THE BYPASS: Register as an Android companion device
        browser: ['Pixel 10', 'WhatsApp', '2.26.16.73'],
        syncFullHistory: false
    })

    sock.ev.on('creds.update', saveCreds)

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
                `Error: ${formatError(lastDisconnect?.error || 'unknown')}`,
            ].join('\n'))
            if (shouldReconnect) startSpoofedSession()
        } else if (connection === 'open') {
            activeWhatsAppSocket = sock
            const ownJid = jidNormalizedUser(sock.user?.id)
            console.log(`Connected as ${ownJid}. Waiting for View Once messages...`)

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
                console.log('Payload:', JSON.stringify(inner, null, 2))

                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    const filename = `${DOWNLOADS_DIR}/viewonce_${Date.now()}.${ext}`
                    writeFileSync(filename, buffer)
                    console.log(`Saved: ${filename} (${buffer.length} bytes)`)
                    try {
                        const telegramCaption = formatMediaCaption(`[VIEW ONCE] ${mediaType}`, metadata, caption)
                        await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                    } catch (err) {
                        console.log(`[VIEW ONCE] Telegram send failed: ${err.message}`)
                    }
                } catch (err) {
                    console.log(`Download failed: ${err.message}`)
                    void notifyTelegramEvent('VIEW ONCE DOWNLOAD ERROR', `${metadata}\n\n${formatError(err)}`)
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
                            const filename = `${DOWNLOADS_DIR}/${mediaType}_${Date.now()}.${ext}`
                            writeFileSync(filename, buffer)
                            console.log(`[DM Media] ${shortSender} → Saved ${mediaType}: ${filename} (${buffer.length} bytes)`)
                            if (shouldSendRegularMedia()) {
                                try {
                                    const telegramCaption = formatMediaCaption(`[DM MEDIA] ${mediaType}`, metadata, caption)
                                    await sendTelegramMedia(buffer, filename, mediaType, telegramCaption)
                                } catch (err) {
                                    console.log(`[DM Media] ${shortSender} → Telegram send failed: ${err.message}`)
                                }
                            }
                        } catch (err) {
                            console.log(`[DM Media] ${shortSender} → Download failed: ${err.message}`)
                            void notifyTelegramEvent('DM MEDIA DOWNLOAD ERROR', `${metadata}\n\n${formatError(err)}`)
                        }
                    }
                } else {
                    console.log(`[Normal] ${shortSender}: ${text || '[Non-text]'}`)
                    console.log(`from device : ${senderDevice(msg)}`)
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