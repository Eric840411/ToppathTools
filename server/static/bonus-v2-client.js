;(function () {
  'use strict'

  var sessionId = String(window.__bonusV2Session || '')
  if (!sessionId) return

  if (window.__bonusV2Stop) {
    try { window.__bonusV2Stop() } catch (_) {}
  }

  var OriginalWebSocket = window.WebSocket
  var processedRounds = new Set()
  var activeSockets = new Map()
  var pendingReports = []
  var retryTimer = null
  var stopped = false
  var roundCount = 0
  var currentStatus = 'ready'

  var COLOR_MAP = {
    801: '黃',
    802: '白',
    803: '粉',
    804: '藍',
    805: '紅',
    806: '綠'
  }

  function parseBonusData(data143) {
    var result = { single_m2: [], single_m3: [], any_double: null, any_triple: null }
    for (var _i = 0, _a = Object.entries(data143); _i < _a.length; _i += 1) {
      var key = _a[_i][0]
      var val = _a[_i][1]
      var k = Number(key)
      if (k >= 801 && k <= 806) {
        var color = COLOR_MAP[k] ?? `色${k}`
        if (val?.matchColors === 2) result.single_m2.push({ color: color, rate: val.rate ?? 0 })
        else if (val?.matchColors === 3) result.single_m3.push({ color: color, rate: val.rate ?? 0 })
      } else if (k === 807) {
        result.any_double = { color: COLOR_MAP[val?.bonusColor] ?? String(val?.bonusColor ?? ''), rate: val?.rate ?? 0 }
      } else if (k === 808) {
        result.any_triple = { color: COLOR_MAP[val?.bonusColor] ?? String(val?.bonusColor ?? ''), rate: val?.rate ?? 0 }
      }
    }
    return result
  }

  function setStatus(status) {
    currentStatus = status
    updateHud()
  }

  function statusColor() {
    if (currentStatus === 'online') return '#22c55e'
    if (currentStatus === 'buffered' || currentStatus === 'ready') return '#f59e0b'
    return '#ef4444'
  }

  function ensureHud() {
    var old = document.getElementById('bonus-v2-client-hud')
    if (old) old.remove()

    var hud = document.createElement('div')
    hud.id = 'bonus-v2-client-hud'
    hud.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:10px 12px',
      'border:1px solid rgba(148,163,184,.35)',
      'border-radius:10px',
      'background:rgba(15,23,42,.92)',
      'color:#fff',
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 10px 30px rgba(15,23,42,.28)'
    ].join(';')

    var dot = document.createElement('span')
    dot.id = 'bonus-v2-client-dot'
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#f59e0b;display:inline-block;flex:0 0 auto'
    hud.appendChild(dot)

    var text = document.createElement('span')
    text.id = 'bonus-v2-client-text'
    text.textContent = 'Bonus V2: 0 rounds'
    hud.appendChild(text)

    var stopBtn = document.createElement('button')
    stopBtn.type = 'button'
    stopBtn.textContent = 'Stop'
    stopBtn.style.cssText = 'border:0;border-radius:7px;background:#ef4444;color:#fff;font-weight:700;padding:6px 10px;cursor:pointer'
    stopBtn.addEventListener('click', stop)
    hud.appendChild(stopBtn)

    document.documentElement.appendChild(hud)
  }

  function updateHud() {
    var dot = document.getElementById('bonus-v2-client-dot')
    var text = document.getElementById('bonus-v2-client-text')
    if (dot) dot.style.background = statusColor()
    if (text) text.textContent = 'Bonus V2: ' + roundCount + ' rounds' + (pendingReports.length ? ' (' + pendingReports.length + ' pending)' : '')
  }

  function postRound(round) {
    return fetch('/api/gs/bonus-v2-client/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, round: round })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }).then(function (json) {
      if (!json || !json.ok) throw new Error('report failed')
    })
  }

  function enqueueReport(round) {
    var item = { round: round, nextAt: Date.now(), delay: 5000 }
    pendingReports.push(item)
    flushReports()
  }

  function flushReports() {
    if (stopped) return
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    var now = Date.now()
    var ready = pendingReports.filter(function (item) { return item.nextAt <= now })
    if (!ready.length) return scheduleRetry()

    Promise.all(ready.map(function (item) {
      return postRound(item.round).then(function () {
        var idx = pendingReports.indexOf(item)
        if (idx >= 0) pendingReports.splice(idx, 1)
        setStatus('online')
      }).catch(function () {
        item.nextAt = Date.now() + item.delay
        item.delay = Math.min(30000, item.delay * 2)
        setStatus('buffered')
      })
    })).then(scheduleRetry)
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return
    if (!pendingReports.length) {
      updateHud()
      return
    }
    var nextAt = pendingReports.reduce(function (min, item) { return Math.min(min, item.nextAt) }, Infinity)
    var delay = Math.max(1000, Math.min(5000, nextAt - Date.now()))
    retryTimer = setTimeout(function () {
      retryTimer = null
      flushReports()
    }, delay)
    updateHud()
  }

  function processRawFrame(raw) {
    if (stopped || typeof raw !== 'string') return
    if (raw.startsWith('$#|#$')) raw = raw.slice(5)
    if (!raw.startsWith('{') && !raw.startsWith('[')) return
    try {
      var data = JSON.parse(raw)
      if (data.e === 'notify' && data.d && data.d.v && data.d.v[3] === 'prepareBonusResult') {
        var roundId = String((((data.d || {}).v || [])[10] || [])[0] || '')
        if (roundId && processedRounds.has(roundId)) return
        if (roundId) processedRounds.add(roundId)
        var data143 = data.d && data.d.v && data.d.v[10] && data.d.v[10][143]
        if (data143 && typeof data143 === 'object' && Object.keys(data143).length > 0) {
          var parsed = parseBonusData(data143)
          roundCount++
          enqueueReport(parsed)
          updateHud()
        }
      }
    } catch (_) {}
  }

  function readMessageData(data) {
    if (typeof data === 'string') {
      processRawFrame(data)
    } else if (data instanceof ArrayBuffer) {
      processRawFrame(new TextDecoder().decode(data))
    } else if (data && typeof Blob !== 'undefined' && data instanceof Blob) {
      data.text().then(processRawFrame).catch(function () {})
    }
  }

  function PatchedWebSocket(url, protocols) {
    var ws = arguments.length > 1 ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url)
    var handler = function (event) { readMessageData(event.data) }
    OriginalWebSocket.prototype.addEventListener.call(ws, 'message', handler)
    activeSockets.set(ws, handler)
    setStatus('online')
    return ws
  }

  PatchedWebSocket.prototype = OriginalWebSocket.prototype
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED
  window.WebSocket = PatchedWebSocket

  function stop() {
    if (stopped) return
    stopped = true
    window.WebSocket = OriginalWebSocket
    if (retryTimer) clearTimeout(retryTimer)
    activeSockets.forEach(function (handler, ws) {
      try { OriginalWebSocket.prototype.removeEventListener.call(ws, 'message', handler) } catch (_) {}
    })
    activeSockets.clear()
    var hud = document.getElementById('bonus-v2-client-hud')
    if (hud) hud.remove()
    delete window.__bonusV2Stop
  }

  window.__bonusV2Stop = stop
  ensureHud()
  setStatus('ready')
})()
