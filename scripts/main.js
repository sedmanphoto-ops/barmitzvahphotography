const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const { exec } = require('child_process')

app.dock?.hide()

let tray = null
let win = null
let watcherInterval = null
let uploadedFiles = new Set()
let isWatching = false
let currentConfig = null

// ─── Speak a warning using macOS say ─────────────────────────────────────────
function speak(message) {
  exec(`say "${message}"`, (err) => {
    if (err) console.warn('Could not run say:', err.message)
  })
}

// ─── Persistent config storage ───────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    }
  } catch (e) {}
  return { apiUrl: 'https://www.proschoolphotos.com', supabaseUrl: '', supabaseKey: '', jobs: [] }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

// ─── Upload directly to Supabase Storage ─────────────────────────────────────
function uploadToSupabase(filepath, filename, config) {
  return new Promise((resolve) => {
    try {
      const fileData = fs.readFileSync(filepath)
      const supabaseUrl = config.supabaseUrl.replace(/\/$/, '')
      const storagePath = `${config.accountId}/${config.jobId}/${filename}`
      const uploadUrl = `${supabaseUrl}/storage/v1/object/job-images/${storagePath}`

      const url = new URL(uploadUrl)
      const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      const lib = isLocal ? http : https

      const options = {
        hostname: url.hostname,
        port: url.port || (isLocal ? 3000 : 443),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': fileData.length,
          'Authorization': `Bearer ${config.supabaseKey}`,
          'x-upsert': 'true',
        },
      }

      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve({ ok: true, storagePath })
          } else {
            resolve({ ok: false, error: `Supabase storage HTTP ${res.statusCode}: ${data}` })
          }
        })
      })
      req.on('error', (err) => resolve({ ok: false, error: err.message }))
      req.write(fileData)
      req.end()
    } catch (err) {
      resolve({ ok: false, error: err.message })
    }
  })
}

// ─── Notify API to do matching (small JSON payload only) ─────────────────────
function notifyApi(filename, storagePath, exifCaptureTime, config) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({
        filename,
        storagePath,
        accountId: config.accountId,
        exifCaptureTime,
      })

      const apiUrl = new URL(`/api/jobs/${config.jobId}/upload`, config.apiUrl)
      const isLocal = apiUrl.hostname === 'localhost' || apiUrl.hostname === '127.0.0.1'

      const options = {
        hostname: apiUrl.hostname,
        port: apiUrl.port || (isLocal ? 3000 : 443),
        path: apiUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }

      const req = (isLocal ? http : https).request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve({ ok: res.statusCode === 200, matched: json.matched, body: json })
          } catch {
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data}` })
          }
        })
      })
      req.on('error', (err) => resolve({ ok: false, error: err.message }))
      req.write(body)
      req.end()
    } catch (err) {
      resolve({ ok: false, error: err.message })
    }
  })
}

// ─── Read EXIF capture time from JPEG ────────────────────────────────────────
function readExifTime(filepath) {
  try {
    const fd = fs.openSync(filepath, 'r')
    const buf = Buffer.alloc(65536)
    fs.readSync(fd, buf, 0, 65536, 0)
    fs.closeSync(fd)

    const str = buf.toString('binary')
    const match = str.match(/(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})/)
    if (match) {
      const [datePart, timePart] = match[1].split(' ')
      const isoDate = datePart.replace(/:/g, '-') + 'T' + timePart
      return new Date(isoDate).toISOString()
    }
    return new Date().toISOString()
  } catch (e) {
    return new Date().toISOString()
  }
}

// ─── Watch a folder ──────────────────────────────────────────────────────────
function startWatching(config) {
  if (isWatching) stopWatching()

  const watchPath = config.folder
  if (!fs.existsSync(watchPath)) {
    sendToRenderer('log', { type: 'error', msg: `Folder not found: ${watchPath}` })
    return false
  }

  if (!config.supabaseUrl || !config.supabaseKey) {
    sendToRenderer('log', { type: 'error', msg: 'Supabase URL and Key are required — check Settings' })
    return false
  }

  uploadedFiles.clear()
  isWatching = true
  currentConfig = config

  try {
    fs.readdirSync(watchPath).forEach(f => {
      if (f.match(/\.(jpg|jpeg|JPG|JPEG)$/)) uploadedFiles.add(f)
    })
  } catch (e) {}

  sendToRenderer('log', { type: 'info', msg: `Watching: ${watchPath}` })
  sendToRenderer('status', { watching: true })
  updateTray()

  watcherInterval = setInterval(async () => {
    if (!fs.existsSync(watchPath)) {
      sendToRenderer('log', { type: 'error', msg: 'Watch folder disappeared!' })
      return
    }

    let files
    try {
      files = fs.readdirSync(watchPath).filter(f => f.match(/\.(jpg|jpeg|JPG|JPEG)$/i))
    } catch (e) { return }

    for (const filename of files) {
      if (uploadedFiles.has(filename)) continue
      uploadedFiles.add(filename)

      const filepath = path.join(watchPath, filename)

      // Wait for Lightroom to finish writing
      await new Promise(r => setTimeout(r, 1500))
      if (!fs.existsSync(filepath)) continue

      sendToRenderer('log', { type: 'uploading', msg: `Uploading: ${filename}` })

      // Step 1: Upload file directly to Supabase Storage (up to 3 attempts)
      let uploadResult = { ok: false, error: 'not started' }
      for (let attempt = 1; attempt <= 3; attempt++) {
        uploadResult = await uploadToSupabase(filepath, filename, config)
        if (uploadResult.ok) break
        if (attempt < 3) {
          sendToRenderer('log', { type: 'uploading', msg: `${filename} — retry ${attempt}/2...` })
          await new Promise(r => setTimeout(r, 2000 * attempt))
        }
      }
      if (!uploadResult.ok) {
        sendToRenderer('log', { type: 'error', msg: `${filename} — storage upload failed after 3 attempts: ${uploadResult.error}` })
        continue
      }

      // Step 2: Read EXIF time
      const exifCaptureTime = readExifTime(filepath)

      // Step 3: Notify API to record and match (tiny JSON only, up to 3 attempts)
      let apiResult = { ok: false, error: 'not started' }
      for (let attempt = 1; attempt <= 3; attempt++) {
        apiResult = await notifyApi(filename, uploadResult.storagePath, exifCaptureTime, config)
        if (apiResult.ok) break
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt))
      }

      if (apiResult.ok) {
        if (apiResult.matched) {
          sendToRenderer('log', { type: 'success', msg: `${filename} — ✅ matched` })
        } else {
          sendToRenderer('log', { type: 'warn', msg: `${filename} — ⚠️ unmatched (no session)` })
          speak('Warning. Photo taken without an active session. Please check the queue.')
        }
        sendToRenderer('increment', {})
      } else {
        sendToRenderer('log', { type: 'error', msg: `${filename} — API error after 3 attempts: ${apiResult.error}` })
      }
    }
  }, 2000)

  return true
}

function stopWatching() {
  if (watcherInterval) { clearInterval(watcherInterval); watcherInterval = null }
  isWatching = false
  currentConfig = null
  sendToRenderer('status', { watching: false })
  updateTray()
}

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return
  tray.setTitle(isWatching ? ' ●' : '')
  tray.setToolTip(`ProSchoolPhotos Uploader — ${isWatching ? 'Watching' : 'Idle'}`)
  const menu = Menu.buildFromTemplate([
    { label: 'ProSchoolPhotos Watcher', enabled: false },
    { type: 'separator' },
    { label: isWatching ? '● Watching — click to open' : '○ Idle — click to open', click: () => showWindow() },
    { type: 'separator' },
    { label: isWatching ? 'Stop Watcher' : 'Start Watcher', click: () => { if (isWatching) stopWatching(); else showWindow() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { stopWatching(); app.quit() } }
  ])
  tray.setContextMenu(menu)
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  win.show()
  win.focus()
  app.dock?.show()
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 680,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    backgroundColor: '#0f1117',
  })

  win.loadFile('renderer.html')
  win.once('ready-to-show', () => {
    win.show()
    const cfg = loadConfig()
    sendToRenderer('init', { config: cfg, watching: isWatching, currentConfig })
  })
  win.on('close', (e) => { e.preventDefault(); win.hide(); app.dock?.hide() })
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig())
ipcMain.handle('save-config', (_, cfg) => { saveConfig(cfg); return true })
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    message: 'Select the folder Lightroom saves tethered photos to',
    defaultPath: path.join(require('os').homedir(), 'Desktop', 'tether_folder'),
  })
  return result.canceled ? null : result.filePaths[0]
})
ipcMain.handle('start-watching', (_, config) => {
  const ok = startWatching(config)
  if (ok) {
    const cfg = loadConfig()
    const existing = cfg.jobs.findIndex(j => j.jobId === config.jobId)
    const entry = { name: config.name, jobId: config.jobId, accountId: config.accountId, folder: config.folder, apiUrl: config.apiUrl }
    if (existing >= 0) cfg.jobs[existing] = entry; else cfg.jobs.unshift(entry)
    cfg.jobs = cfg.jobs.slice(0, 5)
    saveConfig(cfg)
  }
  return ok
})
ipcMain.handle('stop-watching', () => { stopWatching(); return true })
ipcMain.handle('get-status', () => ({ watching: isWatching, currentConfig }))
ipcMain.handle('open-dashboard', () => { const cfg = loadConfig(); shell.openExternal(`${cfg.apiUrl || 'https://www.proschoolphotos.com'}/dashboard`) })

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const icon = nativeImage.createEmpty()
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setTitle('')
  tray.setToolTip('ProSchoolPhotos Uploader')
  tray.on('click', () => showWindow())
  updateTray()
  createWindow()
})

app.on('window-all-closed', (e) => e.preventDefault?.())
app.on('activate', () => showWindow())
app.on('before-quit', () => stopWatching())
