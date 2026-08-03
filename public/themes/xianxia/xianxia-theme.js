(() => {
  'use strict'

  const body = document.body
  const navButtons = [...document.querySelectorAll('[data-view-target]')]
  const views = [...document.querySelectorAll('[data-view]')]
  const pageTitle = document.querySelector('[data-page-title]')
  const toast = document.querySelector('[data-toast]')
  let toastTimer = 0

  const showToast = (message) => {
    if (!toast) return
    toast.textContent = message
    toast.classList.add('is-visible')
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2800)
  }

  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.viewTarget
      navButtons.forEach((item) => item.classList.toggle('is-active', item === button))
      views.forEach((view) => view.classList.toggle('is-active', view.dataset.view === target))
      if (pageTitle) pageTitle.textContent = button.dataset.title || button.textContent.trim()
      body.classList.remove('is-menu-open')
    })
  })

  document.querySelectorAll('[data-realm-value]').forEach((button) => {
    button.addEventListener('click', () => {
      const realm = button.dataset.realmValue || 'moon'
      body.dataset.realm = realm
      document.querySelectorAll('[data-realm-value]').forEach((item) => {
        item.classList.toggle('is-active', item === button)
      })
      showToast(realm === 'moon' ? '已切換至玄月靈境' : '已切換至赤霄火境')
    })
  })

  document.querySelector('[data-mobile-menu]')?.addEventListener('click', () => {
    body.classList.toggle('is-menu-open')
  })

  document.querySelector('[data-video-toggle]')?.addEventListener('click', (event) => {
    const isOff = body.dataset.video === 'off'
    body.dataset.video = isOff ? 'on' : 'off'
    event.currentTarget.textContent = isOff ? '暫停動態背景' : '啟用動態背景'
    showToast(isOff ? '動態背景已啟用' : '動態背景已暫停')
  })

  document.querySelectorAll('.xx-btn').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      const rect = button.getBoundingClientRect()
      const ripple = document.createElement('span')
      const size = Math.max(rect.width, rect.height)
      ripple.className = 'xx-ripple'
      ripple.style.width = `${size}px`
      ripple.style.height = `${size}px`
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`
      button.appendChild(ripple)
      window.setTimeout(() => ripple.remove(), 650)
    })
  })

  document.querySelector('[data-run-inspection]')?.addEventListener('click', (event) => {
    const button = event.currentTarget
    button.classList.add('is-loading')
    window.setTimeout(() => {
      button.classList.remove('is-loading')
      showToast('巡檢任務已送入執行佇列')
    }, 1200)
  })

  document.querySelector('[data-search]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase()
    document.querySelectorAll('[data-searchable]').forEach((row) => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query)
    })
  })

  document.querySelectorAll('[data-local-search]').forEach((input) => {
    input.addEventListener('input', () => {
      const scope = input.dataset.localSearch
      const query = input.value.trim().toLowerCase()
      document.querySelectorAll(`[data-scope="${scope}"]`).forEach((item) => {
        item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query)
      })
    })
  })

  document.querySelectorAll('[data-filter-group]').forEach((group) => {
    group.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        const scope = group.dataset.filterGroup
        const status = button.dataset.filter
        group.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('is-active', item === button))
        document.querySelectorAll(`[data-scope="${scope}"]`).forEach((item) => {
          item.hidden = status !== 'all' && item.dataset.status !== status
        })
      })
    })
  })

  document.querySelectorAll('[data-record]').forEach((record) => {
    record.addEventListener('click', () => {
      document.querySelectorAll('[data-record]').forEach((item) => item.classList.toggle('is-selected', item === record))
      const detail = document.querySelector('[data-record-detail]')
      if (!detail) return
      detail.querySelector('[data-detail-key]').textContent = record.dataset.key
      detail.querySelector('[data-detail-title]').textContent = record.dataset.title
      detail.querySelector('[data-detail-stage]').textContent = record.dataset.stage
      detail.querySelector('[data-detail-description]').textContent = record.dataset.description
      detail.querySelector('[data-detail-owner]').textContent = record.dataset.owner
      detail.querySelector('[data-detail-priority]').textContent = record.dataset.priority
    })
  })

  document.querySelectorAll('[data-demo-action]').forEach((button) => {
    button.addEventListener('click', () => showToast(button.dataset.demoAction || '操作已完成'))
  })

  const wait = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration))

  document.querySelector('[data-run-suite]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    const steps = [...document.querySelectorAll('[data-suite-steps] .xx-step')]
    const progress = document.querySelector('[data-suite-progress]')
    const status = document.querySelector('[data-suite-status]')
    const consoleBox = document.querySelector('[data-suite-console]')
    button.classList.add('is-loading')
    status.textContent = '執行中'
    consoleBox.innerHTML = ''

    const messages = ['環境與 Token 檢查完成', '測試帳號與機台資料建立完成', '12 筆案例執行完成，11 通過、1 失敗', '報告與畫面證據已彙整']
    for (let index = 0; index < steps.length; index += 1) {
      steps[index].classList.add('is-running')
      await wait(520)
      steps[index].classList.remove('is-running')
      steps[index].classList.add('is-done')
      progress.style.width = `${(index + 1) * 25}%`
      const line = document.createElement('div')
      line.className = 'xx-console-line'
      line.textContent = messages[index]
      consoleBox.appendChild(line)
    }
    button.classList.remove('is-loading')
    status.textContent = '11 通過 / 1 失敗'
    showToast('試煉執行完成，報告已產生')
  })

  document.querySelector('[data-osm-run]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    const status = document.querySelector('[data-osm-status]')
    const consoleBox = document.querySelector('[data-osm-console]')
    button.classList.add('is-loading')
    status.textContent = '巡檢中'
    const messages = ['驗證 Auth Token 與環境路由', '取得 Channel 873 機台清單', '比對 Hourly Meter 與 Game Record', '送出 ImageRecon 畫面比對', '巡檢完成：發現 3 筆 Meter 差異']
    for (const message of messages) {
      await wait(360)
      const line = document.createElement('div')
      line.className = 'xx-console-line'
      line.textContent = message
      consoleBox.appendChild(line)
      consoleBox.scrollTop = consoleBox.scrollHeight
    }
    button.classList.remove('is-loading')
    status.textContent = '完成 / 3 項需覆核'
    showToast('靈機巡檢已完成')
  })

  document.querySelectorAll('[data-agent-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const node = button.closest('.xx-node')
      const badge = node.querySelector('.xx-badge')
      const name = node.querySelector('h3').textContent
      const action = button.dataset.agentAction
      if (action === 'detail') {
        showToast(`${name}：狀態、日誌與資源明細已展開`)
        return
      }
      if (action === 'restart') {
        button.classList.add('is-loading')
        badge.textContent = '重啟中'
        await wait(900)
        button.classList.remove('is-loading')
        node.dataset.status = 'idle'
        badge.classList.remove('xx-badge--ember')
        badge.textContent = '待命'
        button.textContent = '指派'
        button.dataset.agentAction = 'assign'
        showToast(`${name} 已恢復連線`)
        return
      }
      if (action === 'pause') {
        node.dataset.status = 'idle'
        badge.textContent = '已暫停'
        button.textContent = '繼續'
        button.dataset.agentAction = 'assign'
        showToast(`${name} 已暫停`)
        return
      }
      node.dataset.status = 'working'
      badge.textContent = '執行中'
      button.textContent = '暫停'
      button.dataset.agentAction = 'pause'
      showToast(`${name} 已接收新任務`)
    })
  })

  document.querySelectorAll('[data-doc]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-doc]').forEach((item) => item.classList.toggle('is-active', item === button))
      document.querySelector('.xx-document [data-doc-title]').textContent = button.dataset.docTitle
      document.querySelector('.xx-document [data-doc-kicker]').textContent = button.dataset.docKicker
      document.querySelector('.xx-document [data-doc-summary]').textContent = button.dataset.docSummary
    })
  })

  document.querySelectorAll('[data-setting-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.settingTarget
      document.querySelectorAll('[data-setting-target]').forEach((item) => item.classList.toggle('is-active', item === button))
      document.querySelectorAll('[data-setting-pane]').forEach((pane) => pane.classList.toggle('is-active', pane.dataset.settingPane === target))
    })
  })

  document.querySelectorAll('.xx-switch').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.getAttribute('aria-checked') !== 'true'
      button.setAttribute('aria-checked', String(next))
    })
  })

  document.querySelector('[data-save-settings]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.classList.add('is-loading')
    await wait(720)
    button.classList.remove('is-loading')
    showToast('陣法設定已儲存')
  })

  const ambient = document.querySelector('.xx-ambient')
  if (ambient) {
    for (let index = 0; index < 20; index += 1) {
      const particle = document.createElement('span')
      particle.style.left = `${4 + Math.random() * 92}%`
      particle.style.bottom = `${-15 - Math.random() * 80}px`
      particle.style.animationDelay = `${Math.random() * -18}s`
      ambient.appendChild(particle)
    }
  }
})()
