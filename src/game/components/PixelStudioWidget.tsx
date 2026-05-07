import React, { useCallback, useEffect, useRef, useState } from 'react'

type Provider = 'gemini' | 'openai' | 'ollama'
type WorkerState = 'idle' | 'working' | 'busy' | 'overloaded'

const BUBBLE_LINES: Record<Provider, Record<WorkerState, string[]>> = {
  gemini: {
    idle: ['...waiting for input', 'Standby mode active', 'Conserving energy...', 'Crystal dim...'],
    working: ['Analyzing data...', 'Neural pathways engaged', 'Processing request', 'On it!'],
    busy: ['Multiple streams active!', 'Parallel computing!', 'Crystal core heating!', 'Load increasing!'],
    overloaded: ['CRYSTAL OVERLOAD!', 'THERMAL WARNING!!!', 'REBOOT REQUIRED!', 'SYSTEM MELTDOWN!'],
  },
  openai: {
    idle: ['_ READY', 'C:\\> waiting...', 'STANDBY.EXE', 'Awaiting tokens...'],
    working: ['EXECUTING...', 'TOKENS LOADED', 'INFERENCE RUNNING', 'Model active'],
    busy: ['HIGH LOAD DETECTED', 'RAM: 87%', 'CONTEXT FULL!', 'Queue growing...'],
    overloaded: ['ERROR 500', 'CRITICAL FAILURE', 'PROCESS KILLED!!', 'BSOD IMMINENT'],
  },
  ollama: {
    idle: ['*snores*', 'The runes grow dim...', 'Awaiting the ancients...', 'ZZZ...'],
    working: ['The runes stir!', 'Ancient wisdom flows', 'Incantation begun...', 'Monocle activated'],
    busy: ['Runes blazing!', 'Steam pressure rising!', 'Monocle heating!', 'All runes active!'],
    overloaded: ['RUNES EXPLODING!', 'STEAM VENTING!!!', 'MONOCLE SHATTERED!', 'MELTDOWN!!!'],
  },
}

interface AiTask {
  id: string
  provider: Provider
  kind: string
  model: string
  operation: string
  user: string
  status: string
  startedAt: number
  durationMs?: number
}

interface MonitorResponse {
  ok: boolean
  runningCount?: number
  runningByProvider?: Record<Provider, number>
  latest?: AiTask[]
}

const WIDGET_EXPANDED_W = 480
const SCENE_SCALE = 0.6
const WIDGET_CONTENT_H = 360
const TITLE_BAR_H = 34
const FRAME_W = 160
const FRAME_H = 128

const px = (n: number) => Math.round(n * SCENE_SCALE)

const PROVIDERS: Provider[] = ['gemini', 'openai', 'ollama']

const PROVIDER_CONFIG: Record<Provider, {
  color: string
  label: string
  left: number
  top: number
  zIndex: number
}> = {
  gemini: { color: '#34f4d0', label: 'GEMINI', left: 200, top: 357, zIndex: 20 },
  openai: { color: '#6ef08d', label: 'OPENAI', left: 152, top: 183, zIndex: 18 },
  ollama: { color: '#9b5cff', label: 'OLLAMA', left: 395, top: 262, zIndex: 19 },
}

const WORKER_SPECS: Record<WorkerState, { frames: number; durationMs: number }> = {
  idle: { frames: 2, durationMs: 1600 },
  working: { frames: 3, durationMs: 600 },
  busy: { frames: 3, durationMs: 360 },
  overloaded: { frames: 4, durationMs: 400 },
}

const NAMEPLATE_POS: Record<Provider, { left: number; top: number; w: number; h: number }> = {
  gemini: { left: 214, top: 348, w: 136, h: 24 },
  openai: { left: 166, top: 174, w: 136, h: 24 },
  ollama: { left: 414, top: 253, w: 136, h: 24 },
}


function assetPath(name: string): string {
  return `/game-assets/sprites/pixel-studio/${name}/sheet-transparent.png`
}


function getWorkerState(count: number): WorkerState {
  if (count >= 5) return 'overloaded'
  if (count >= 3) return 'busy'
  if (count >= 1) return 'working'
  return 'idle'
}

function emptyProviderCounts(): Record<Provider, number> {
  return { gemini: 0, openai: 0, ollama: 0 }
}

function normalizeProviderCounts(counts?: Record<Provider, number>): Record<Provider, number> {
  return {
    gemini: counts?.gemini ?? 0,
    openai: counts?.openai ?? 0,
    ollama: counts?.ollama ?? 0,
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function useSpeechBubble(
  provider: Provider,
  state: WorkerState,
  providerIndex: number,
): { text: string | null } {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let clearTimer: number | undefined
    let repeatTimer: number | undefined

    const triggerBubble = () => {
      const lines = BUBBLE_LINES[provider][state]
      const line = lines[Math.floor(Math.random() * lines.length)]
      setText(line)

      if (clearTimer !== undefined) {
        window.clearTimeout(clearTimer)
      }

      clearTimer = window.setTimeout(() => {
        setText(null)
      }, 2500)
    }

    const scheduleRepeat = () => {
      repeatTimer = window.setTimeout(() => {
        triggerBubble()
        scheduleRepeat()
      }, randomBetween(8000, 18000))
    }

    const initialTimer = window.setTimeout(() => {
      triggerBubble()
      scheduleRepeat()
    }, providerIndex * 2000 + randomBetween(0, 6000))

    return () => {
      window.clearTimeout(initialTimer)
      if (clearTimer !== undefined) {
        window.clearTimeout(clearTimer)
      }
      if (repeatTimer !== undefined) {
        window.clearTimeout(repeatTimer)
      }
    }
  }, [provider, state, providerIndex])

  return { text }
}

function WorkerSprite({ provider, state }: { provider: Provider; state: WorkerState }) {
  const spec = WORKER_SPECS[state]
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = spec.durationMs / spec.frames
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % spec.frames)
    }, interval)
    return () => window.clearInterval(timer)
  }, [provider, state, spec.durationMs, spec.frames])

  return (
    <div
      style={{
        width: px(FRAME_W),
        height: px(FRAME_H),
        overflow: 'hidden',
        backgroundImage: `url(/game-assets/sprites/pixel-studio/workstation-${provider}-${state}/sheet-transparent.png)`,
        backgroundSize: `${px(FRAME_W) * spec.frames}px ${px(FRAME_H)}px`,
        backgroundPosition: `${-px(FRAME_W) * frame}px 0px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  )
}

function SpeechBubble({
  provider,
  state,
  providerIndex,
  left,
  top,
  color,
}: {
  provider: Provider
  state: WorkerState
  providerIndex: number
  left: number
  top: number
  color: string
}) {
  const { text } = useSpeechBubble(provider, state, providerIndex)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (text === null) {
      setVisible(false)
      return
    }

    setVisible(true)
    const timer = window.setTimeout(() => {
      setVisible(false)
    }, 2200)

    return () => window.clearTimeout(timer)
  }, [text])

  if (text === null) return null

  return (
    <div
      className="ps-bubble-in"
      style={{
        position: 'absolute',
        left: px(left + 20),
        top: px(top - 48),
        zIndex: 200,
        padding: '5px 7px',
        background: 'rgba(13,18,32,0.92)',
        border: `1px solid ${color}`,
        borderRadius: 2,
        color: '#ffffff',
        fontFamily: 'var(--font-pixel)',
        fontSize: 5,
        lineHeight: '10px',
        whiteSpace: 'nowrap',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.3s',
        pointerEvents: 'none',
        boxShadow: `0 0 8px ${color}44`,
      }}
    >
      {text}
      <div
        style={{
          position: 'absolute',
          left: 8,
          bottom: -6,
          width: 0,
          height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: `6px solid ${color}`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 9,
          bottom: -4,
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '5px solid rgba(13,18,32,0.92)',
        }}
      />
    </div>
  )
}

function Workstation({
  provider,
  count,
  providerIndex,
}: {
  provider: Provider
  count: number
  providerIndex: number
}) {
  const cfg = PROVIDER_CONFIG[provider]
  const state = getWorkerState(count)
  const nameplate = NAMEPLATE_POS[provider]

  return (
    <>
      <SpeechBubble
        provider={provider}
        state={state}
        providerIndex={providerIndex}
        left={cfg.left}
        top={cfg.top}
        color={cfg.color}
      />
      <div
        style={{
          position: 'absolute',
          left: px(cfg.left),
          top: px(cfg.top),
          width: px(FRAME_W),
          height: px(FRAME_H),
          zIndex: cfg.zIndex,
          filter: state === 'overloaded' ? `drop-shadow(0 0 8px ${cfg.color})` : undefined,
        }}
      >
        <WorkerSprite provider={provider} state={state} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: px(nameplate.left),
          top: px(nameplate.top),
          width: px(nameplate.w),
          height: px(nameplate.h),
          backgroundImage: `url(${assetPath(`nameplate-${provider}`)})`,
          backgroundSize: `${px(nameplate.w)}px ${px(nameplate.h)}px`,
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated',
          zIndex: cfg.zIndex + 1,
        }}
      />
      {count > 0 && (
        <div
          style={{
            position: 'absolute',
            left: px(nameplate.left),
            top: px(nameplate.top) - 8,
            color: cfg.color,
            fontFamily: 'var(--font-pixel)',
            fontSize: 5,
            lineHeight: '10px',
            textShadow: `0 0 6px ${cfg.color}`,
            whiteSpace: 'nowrap',
            zIndex: cfg.zIndex + 2,
          }}
        >
          {count} JOB{count === 1 ? '' : 'S'}
        </div>
      )}
    </>
  )
}
function statusBadgeFrame(status: string): number {
  if (status === 'running' || status === 'active') return 0
  if (status === 'done' || status === 'completed' || status === 'success') return 1
  return 2
}

function RecentTasksPanel({ latest, backendOnline }: { latest: AiTask[]; backendOnline: boolean }) {
  const tasks = latest.slice(0, 5)
  // display at 1.17? scale: 224??62, 128??50; internal positions scaled accordingly
  const PW = px(380)
  const PH = px(215)
  const ROW_W = px(340)
  const ROW_H = px(30)
  const ROW_LEFT = px(20)
  const ROW_TOP_FIRST = px(58)
  const ROW_GAP = px(30)

  return (
    <div
      style={{
        position: 'absolute',
        left: px(400),
        top: px(375),
        width: PW,
        height: PH,
        backgroundImage: `url(${assetPath('recent-tasks-panel-bg')})`,
        backgroundSize: `${PW}px ${PH}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        zIndex: 30,
      }}
    >
      {!backendOnline ? (
        <div
          style={{
            position: 'absolute',
            left: ROW_LEFT,
            top: ROW_TOP_FIRST,
            color: '#ff4d5e',
            fontFamily: 'var(--font-pixel)',
            fontSize: 4,
            textShadow: '0 0 4px #ff4d5e',
          }}
        >
          OFFLINE
        </div>
      ) : tasks.length === 0 ? (
        <div
          style={{
            position: 'absolute',
            left: ROW_LEFT,
            top: ROW_TOP_FIRST,
            color: '#9aa5b8',
            fontFamily: 'var(--font-pixel)',
            fontSize: 4,
          }}
        >
          NO TASKS
        </div>
      ) : (
        tasks.map((task, i) => {
          const color = PROVIDER_CONFIG[task.provider]?.color ?? '#ffffff'
          const frame = statusBadgeFrame(task.status)
          const statusLabel = frame === 0 ? 'RUN' : frame === 1 ? 'DONE' : 'ERR'
          const statusColor = frame === 0 ? '#34f4d0' : frame === 1 ? '#6ef08d' : '#ff4d5e'

          return (
            <div
              key={task.id}
              style={{
                position: 'absolute',
                left: ROW_LEFT,
                top: ROW_TOP_FIRST + i * ROW_GAP,
                width: ROW_W,
                height: ROW_H,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: px(7),
                  top: px(9),
                  width: 4,
                  height: 4,
                  background: color,
                  boxShadow: `0 0 4px ${color}`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: px(20),
                  top: px(7),
                  right: px(70),
                  fontFamily: 'var(--font-pixel)',
                  fontSize: 4,
                  lineHeight: '10px',
                  color: '#e6f4ff',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {task.operation || task.kind || task.model}
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: px(206),
                  top: px(5),
                  width: px(48),
                  height: px(14),
                  backgroundImage: `url(${assetPath('recent-task-status-badges')})`,
                  backgroundSize: `${px(144)}px ${px(14)}px`,
                  backgroundPosition: `${-frame * px(48)}px 0px`,
                  backgroundRepeat: 'no-repeat',
                  imageRendering: 'pixelated',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: px(206),
                  top: px(6),
                  width: px(48),
                  fontFamily: 'var(--font-pixel)',
                  fontSize: 4,
                  lineHeight: '8px',
                  color: statusColor,
                  textAlign: 'center',
                  textShadow: '0 1px 0 rgba(0,0,0,0.8)',
                }}
              >
                {statusLabel}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

function StudioStatusPanel({
  runningByProvider,
  backendOnline,
}: {
  runningByProvider: Record<Provider, number>
  backendOnline: boolean
}) {
  function providerStatusLabel(count: number): string {
    if (count >= 5) return 'OVERLOAD'
    if (count >= 3) return 'BUSY'
    if (count >= 1) return 'WORKING'
    return 'IDLE'
  }

  function providerStatusColor(count: number): string {
    if (count >= 5) return '#ff4d5e'
    if (count >= 3) return '#f2a33a'
    if (count >= 1) return '#6ef08d'
    return '#5a6a7a'
  }

  const rows: { provider: Provider; label: string }[] = [
    { provider: 'gemini', label: 'GEMINI' },
    { provider: 'openai', label: 'OPENAI' },
    { provider: 'ollama', label: 'OLLAMA' },
  ]

  return (
    <div
      style={{
        position: 'absolute',
        left: px(20),
        top: px(462),
        width: px(224),
        height: px(128),
        backgroundImage: `url(${assetPath('studio-status-panel-bg')})`,
        backgroundSize: `${px(224)}px ${px(128)}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        zIndex: 30,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: px(14),
          top: px(36),
          display: 'flex',
          flexDirection: 'column',
          gap: px(10),
        }}
      >
        {rows.map(({ provider, label }) => {
          const count = runningByProvider[provider]
          const color = PROVIDER_CONFIG[provider].color
          const online = backendOnline
          const statusLabel = online ? providerStatusLabel(count) : 'OFFLINE'
          const statusColor = online ? providerStatusColor(count) : '#ff4d5e'

          return (
            <div
              key={provider}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: px(194),
                fontFamily: 'var(--font-pixel)',
                fontSize: 6,
                lineHeight: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <div
                  style={{
                    width: 4,
                    height: 4,
                    flexShrink: 0,
                    background: color,
                    boxShadow: `0 0 5px ${color}`,
                  }}
                />
                <span style={{ color: '#c8dce8', width: px(48) }}>{label}</span>
              </div>
              <span style={{ color: statusColor, width: px(74), textAlign: 'right', textShadow: `0 0 5px ${statusColor}` }}>
                {statusLabel}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StudioScene({
  runningByProvider,
  latest,
  backendOnline,
}: {
  runningByProvider: Record<Provider, number>
  latest: AiTask[]
  backendOnline: boolean
}) {
  return (
    <div
      style={{
        width: WIDGET_EXPANDED_W,
        height: WIDGET_CONTENT_H,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        className="ps-scene"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: WIDGET_EXPANDED_W,
          height: WIDGET_CONTENT_H,
          imageRendering: 'pixelated',
        }}
      >
        <img
          src={assetPath('studio-room-shell-bg')}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: WIDGET_EXPANDED_W,
            height: WIDGET_CONTENT_H,
            imageRendering: 'pixelated',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
        {PROVIDERS.map((provider, providerIndex) => (
          <Workstation
            key={provider}
            provider={provider}
            count={runningByProvider[provider]}
            providerIndex={providerIndex}
          />
        ))}
        <RecentTasksPanel latest={latest} backendOnline={backendOnline} />
        <StudioStatusPanel runningByProvider={runningByProvider} backendOnline={backendOnline} />
      </div>
    </div>
  )
}

export function PixelStudioWidget() {
  const [backendOnline, setBackendOnline] = useState(true)
  const [runningByProvider, setRunningByProvider] = useState<Record<Provider, number>>(emptyProviderCounts)
  const [latest, setLatest] = useState<AiTask[]>([])
  const [minimized, setMinimized] = useState(false)
  const [pos, setPos] = useState(() => ({
    x: 24,
    y: typeof window === 'undefined' ? 24 : Math.max(0, window.innerHeight - 400),
  }))
  const draggingRef = useRef(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })

  const pollMonitor = useCallback(async () => {
    try {
      const response = await fetch('/api/ai-agent/monitor')
      const data = (await response.json()) as MonitorResponse

      setBackendOnline(response.ok && data.ok)

      if (!response.ok || !data.ok) {
        setRunningByProvider(emptyProviderCounts())
        setLatest([])
        return
      }

      setRunningByProvider(normalizeProviderCounts(data.runningByProvider))
      setLatest((data.latest ?? []).slice(0, 4))
    } catch {
      setBackendOnline(false)
      setRunningByProvider(emptyProviderCounts())
      setLatest([])
    }
  }, [])

  useEffect(() => {
    void pollMonitor()
    const timer = window.setInterval(() => {
      void pollMonitor()
    }, 5000)

    return () => window.clearInterval(timer)
  }, [pollMonitor])

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent) => {
      if (!draggingRef.current) return

      const widgetW = minimized ? 180 : WIDGET_EXPANDED_W
      const widgetH = minimized ? TITLE_BAR_H : TITLE_BAR_H + WIDGET_CONTENT_H
      const maxX = Math.max(0, window.innerWidth - widgetW)
      const maxY = Math.max(0, window.innerHeight - widgetH)

      setPos({
        x: Math.min(Math.max(0, event.clientX - dragOffsetRef.current.x), maxX),
        y: Math.min(Math.max(0, event.clientY - dragOffsetRef.current.y), maxY),
      })
    }

    const onUp = () => {
      draggingRef.current = false
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [minimized])

  const onDragStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    draggingRef.current = true
    dragOffsetRef.current = {
      x: event.clientX - pos.x,
      y: event.clientY - pos.y,
    }
  }, [pos.x, pos.y])

  const totalJobs = PROVIDERS.reduce((sum, provider) => sum + runningByProvider[provider], 0)
  const accentColor = backendOnline ? '#34f4d0' : '#ff4d5e'
  const titleText = totalJobs > 0 ? `${totalJobs} JOB${totalJobs === 1 ? '' : 'S'}` : 'IDLE'

  return (
    <>
      <style>{`
        @keyframes ps-prop-smoke-anim { to { background-position-x: -128px; } }
        @keyframes ps-prop-alarm-light-anim { to { background-position-x: -32px; } }
        @keyframes ps-prop-sweat-anim { to { background-position-x: -24px; } }
        @keyframes ps-prop-monitor-glow { to { background-position-x: -96px; } }
        @keyframes ps-prop-spark-anim { to { background-position-x: -128px; } }
        .ps-scene img,
        .ps-scene div[style*="background-image"] {
          image-rendering: -webkit-optimize-contrast;
          image-rendering: crisp-edges;
          image-rendering: pixelated;
        }
        @keyframes ps-bubble-in {
          from { opacity: 0; transform: scale(0.8); }
          to   { opacity: 1; transform: scale(1); }
        }
        .ps-bubble-in {
          animation: ps-bubble-in 0.2s ease-out;
          transform-origin: bottom left;
        }
      `}</style>
      <div
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          zIndex: 9990,
          width: minimized ? 180 : WIDGET_EXPANDED_W,
          background: 'rgba(8,11,20,0.97)',
          border: `2px solid ${accentColor}`,
          boxShadow: `0 14px 36px rgba(0,0,0,0.56), 0 0 18px ${accentColor}55`,
          color: '#eafcff',
          userSelect: 'none',
        }}
      >
        <div
          onMouseDown={onDragStart}
          style={{
            height: TITLE_BAR_H,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '0 8px 0 10px',
            cursor: 'move',
            background: 'rgba(0,0,0,0.42)',
            borderBottom: minimized ? 'none' : `1px solid ${accentColor}55`,
            color: accentColor,
            fontFamily: 'var(--font-pixel)',
            textShadow: `0 0 7px ${accentColor}`,
          }}
        >
          <div
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: minimized ? 8 : 9,
              lineHeight: '12px',
            }}
          >
            ?? PIXEL STUDIO {titleText}
          </div>
          <button
            type="button"
            aria-label={minimized ? 'Expand Pixel Studio' : 'Minimize Pixel Studio'}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setMinimized((value) => !value)}
            style={{
              width: 24,
              height: 22,
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              background: 'rgba(0,0,0,0.45)',
              border: `1px solid ${accentColor}88`,
              color: accentColor,
              fontFamily: 'var(--font-pixel)',
              fontSize: 11,
              lineHeight: '11px',
              cursor: 'pointer',
            }}
          >
            {minimized ? '+' : '-'}
          </button>
        </div>
        {!minimized && (
          <StudioScene
            runningByProvider={runningByProvider}
            latest={latest}
            backendOnline={backendOnline}
          />
        )}
      </div>
    </>
  )
}
