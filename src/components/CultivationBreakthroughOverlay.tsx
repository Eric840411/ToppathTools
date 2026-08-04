import { useEffect, useRef, type CSSProperties } from 'react'
import './CultivationBreakthroughOverlay.css'

type MotionMode = 'breath' | 'pillars' | 'corona' | 'soul' | 'ascend' | 'rift' | 'dual' | 'wheel' | 'lightning'

type BreakthroughRealm = {
  name: string
  slug: string
  epithet: string
  verse: string
  color: string
  secondary: string
  mode: MotionMode
}

export const BREAKTHROUGH_REALMS: BreakthroughRealm[] = [
  { name: '練氣期', slug: 'qi-refining', epithet: '引氣入體', verse: '一縷靈息，叩開仙途', color: '#78e4dc', secondary: '#c5fbf7', mode: 'breath' },
  { name: '築基期', slug: 'foundation', epithet: '道基初成', verse: '四柱鎮元，道基永固', color: '#67bde9', secondary: '#d3f2ff', mode: 'pillars' },
  { name: '金丹期', slug: 'golden-core', epithet: '一粒金丹', verse: '丹成如日，照徹靈臺', color: '#edc254', secondary: '#fff2ae', mode: 'corona' },
  { name: '元嬰期', slug: 'nascent-soul', epithet: '靈胎化嬰', verse: '靈胎初醒，神遊六合', color: '#b798ff', secondary: '#f0e7ff', mode: 'soul' },
  { name: '化神期', slug: 'spirit-transformation', epithet: '神遊太虛', verse: '神火離形，一念萬里', color: '#f2a574', secondary: '#ffe2bd', mode: 'ascend' },
  { name: '煉虛期', slug: 'void-refining', epithet: '煉虛合道', verse: '破界煉虛，星河俯首', color: '#8c76ff', secondary: '#d9d0ff', mode: 'rift' },
  { name: '合體期', slug: 'body-integration', epithet: '神形合一', verse: '陰陽交泰，神形歸一', color: '#69d8b2', secondary: '#f0ce72', mode: 'dual' },
  { name: '大乘期', slug: 'mahayana', epithet: '大道將成', verse: '法輪轉世，大道將成', color: '#f3d783', secondary: '#edfff8', mode: 'wheel' },
  { name: '渡劫期', slug: 'tribulation', epithet: '九霄問劫', verse: '九雷加身，一步登仙', color: '#a590ff', secondary: '#ffe08a', mode: 'lightning' },
]

export function getBreakthroughRealm(level: string) {
  return BREAKTHROUGH_REALMS.find(realm => realm.name === level) ?? null
}

type Particle = {
  angle: number
  radius: number
  speed: number
  size: number
  offset: number
  drift: number
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  realm: BreakthroughRealm,
  particles: Particle[],
  time: number,
  width: number,
  height: number,
) {
  const centerX = width / 2
  const centerY = height / 2
  const maxRadius = Math.hypot(width, height) * 0.48
  ctx.globalCompositeOperation = 'lighter'

  particles.forEach((particle, index) => {
    let x = centerX
    let y = centerY
    let alpha = 0.58
    let color = index % 3 === 0 ? realm.secondary : realm.color

    switch (realm.mode) {
      case 'breath': {
        const radius = 80 + ((particle.radius + time * particle.speed * 18) % Math.max(120, maxRadius * 0.55))
        const angle = particle.angle + time * particle.speed * 0.34
        x += Math.cos(angle) * radius
        y += Math.sin(angle) * radius * 0.58
        alpha = 0.3 + 0.32 * Math.sin(time * 1.8 + particle.offset) ** 2
        break
      }
      case 'pillars': {
        const column = index % 4
        const spread = Math.min(width, height) * 0.24
        const anchors = [[0, -spread], [spread, 0], [0, spread], [-spread, 0]]
        const anchor = anchors[column]
        x += anchor[0] + Math.sin(particle.offset) * 18
        y += anchor[1] - ((particle.radius + time * particle.speed * 76) % 210) + 105
        alpha = column === Math.floor(time * 2) % 4 ? 0.9 : 0.22
        break
      }
      case 'corona': {
        const angle = particle.angle
        const radius = 55 + ((particle.radius + time * particle.speed * 90) % Math.max(100, maxRadius * 0.66))
        x += Math.cos(angle) * radius
        y += Math.sin(angle) * radius
        alpha = 0.72 * (1 - radius / (maxRadius * 0.82))
        color = index % 2 ? '#fff0a1' : '#f3a928'
        break
      }
      case 'soul': {
        x += Math.sin(time * particle.speed + particle.offset) * (24 + particle.drift)
        y = height - ((particle.radius + time * particle.speed * 52) % height)
        alpha = 0.2 + 0.5 * Math.sin(time + particle.offset) ** 2
        break
      }
      case 'ascend': {
        x += Math.sin(time * 1.4 + particle.offset) * (45 + particle.drift)
        y = height - ((particle.radius + time * particle.speed * 92) % height)
        alpha = 0.26 + 0.5 * (1 - y / height)
        color = index % 2 ? '#ffcc8d' : '#f08a69'
        break
      }
      case 'rift': {
        const radius = Math.max(24, maxRadius - ((particle.radius + time * particle.speed * 68) % maxRadius))
        const angle = particle.angle - time * particle.speed * 0.72 + radius * 0.008
        x += Math.cos(angle) * radius
        y += Math.sin(angle) * radius * 0.66
        alpha = 0.28 + 0.55 * (1 - radius / maxRadius)
        break
      }
      case 'dual': {
        const stream = index % 2 === 0 ? 1 : -1
        const progress = ((particle.radius + time * particle.speed * 55) % height) / height
        y = height * (1 - progress)
        x += stream * Math.sin(progress * Math.PI * 4 + time) * Math.min(190, width * 0.22)
        color = stream === 1 ? '#68e2bd' : '#f2c75f'
        alpha = 0.64
        break
      }
      case 'wheel': {
        const spoke = (index % 8) * Math.PI / 4
        const radius = 90 + ((particle.radius + time * particle.speed * 22) % Math.max(100, maxRadius * 0.46))
        const angle = spoke + time * 0.34
        x += Math.cos(angle) * radius
        y += Math.sin(angle) * radius
        alpha = 0.35 + 0.35 * Math.sin(time * 1.5 + particle.offset) ** 2
        break
      }
      case 'lightning': {
        const strike = Math.floor(time * 8) % 9
        const branch = index % 9
        const angle = branch * Math.PI * 2 / 9 - Math.PI / 2
        const radius = 80 + (particle.radius % Math.max(120, maxRadius * 0.7))
        x += Math.cos(angle) * radius + Math.sin(particle.offset * 7) * 16
        y += Math.sin(angle) * radius + Math.cos(particle.offset * 5) * 16
        alpha = branch === strike ? 1 : 0.13
        color = branch === strike ? '#ffffff' : realm.color
        break
      }
    }

    ctx.beginPath()
    if (realm.mode === 'ascend' || realm.mode === 'lightning') {
      ctx.moveTo(x, y + 18)
      ctx.lineTo(x + Math.sin(particle.offset * 8) * 5, y - 18)
      ctx.lineWidth = Math.max(1, particle.size * 0.7)
      ctx.strokeStyle = color
      ctx.globalAlpha = Math.max(0, alpha)
      ctx.stroke()
    } else {
      ctx.arc(x, y, particle.size, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = Math.max(0, alpha)
      ctx.fill()
    }
  })
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

export function CultivationBreakthroughOverlay({ level, onComplete }: { level: string; onComplete: () => void }) {
  const realm = getBreakthroughRealm(level)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!realm) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const finishTimer = window.setTimeout(onComplete, 5600)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onComplete()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(finishTimer)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [onComplete, realm])

  useEffect(() => {
    if (!realm || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !context) return

    const particles: Particle[] = Array.from({ length: 58 + BREAKTHROUGH_REALMS.indexOf(realm) * 3 }, (_, index) => ({
      angle: (index / 61) * Math.PI * 2 + Math.random() * 0.32,
      radius: Math.random() * 620,
      speed: 0.5 + Math.random() * 1.25,
      size: 0.9 + Math.random() * 2.2,
      offset: Math.random() * Math.PI * 2,
      drift: Math.random() * 80,
    }))

    let animationFrame = 0
    let previousFrame = 0
    let elapsed = 0
    let width = window.innerWidth
    let height = window.innerHeight
    let dpr = 1

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }

    const render = (timestamp: number) => {
      animationFrame = window.requestAnimationFrame(render)
      if (timestamp - previousFrame < 1000 / 30) return
      const delta = previousFrame ? Math.min((timestamp - previousFrame) / 1000, 0.07) : 1 / 30
      previousFrame = timestamp
      elapsed += delta
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      drawParticles(context, realm, particles, elapsed, width, height)
    }

    resize()
    window.addEventListener('resize', resize)
    animationFrame = window.requestAnimationFrame(render)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', resize)
    }
  }, [realm])

  if (!realm) return null

  return (
    <div
      className={`breakthrough breakthrough--${realm.slug}`}
      style={{ '--breakthrough-color': realm.color, '--breakthrough-secondary': realm.secondary } as CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-label={`突破至${realm.name}`}
    >
      <div className="breakthrough__backdrop" />
      <canvas ref={canvasRef} className="breakthrough__canvas" aria-hidden="true" />
      <div className="breakthrough__beams" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
      </div>
      <div className="breakthrough__stage">
        <div className="breakthrough__ring breakthrough__ring--outer" aria-hidden="true" />
        <div className="breakthrough__ring breakthrough__ring--inner" aria-hidden="true" />
        <div className="breakthrough__emblem">
          <img src={`/themes/xianxia/realms-animated-v2/${realm.slug}.webp`} alt="" />
        </div>
        <div className="breakthrough__copy">
          <span>REALM BREAKTHROUGH</span>
          <small>境界突破</small>
          <h2>{realm.name}</h2>
          <strong>{realm.epithet}</strong>
          <p>{realm.verse}</p>
        </div>
      </div>
      <button type="button" className="breakthrough__skip" onClick={onComplete}>略過動畫</button>
    </div>
  )
}
