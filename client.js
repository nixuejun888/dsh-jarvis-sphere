/**
 * Jarvis sphere — Client half.
 *
 * 在 shell.overlay（整帧浮层）里画一个神经元球：节点 + 连线 + 沿边跑的能量脉冲，
 * 由 Host 的 /dsh-jarvis/state 驱动（运行状态、模型流式速率、工具调用）。
 * 浮层穿透点击，不抢任何交互；球心挖空，聊天正文落在暗处。
 */
window.__ModuleLoader__.load({
  id: 'dsh-jarvis-sphere',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var STATE_PATH = '/dsh-jarvis/state'

    var CSS = [
      '.jvs-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;}',
      '.jvs-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;}',
      '.jvs-probe{position:absolute;width:0;height:0;opacity:0;pointer-events:none;}',
    ].join('')

    /* 调色板：深色主题发光，浅色主题换深青配合 multiply */
    var PALETTES = {
      dark: {
        cyan: { r: 64, g: 220, b: 255 },
        blue: { r: 96, g: 160, b: 255 },
        green: { r: 88, g: 255, b: 190 },
        amber: { r: 255, g: 190, b: 96 },
        violet: { r: 182, g: 136, b: 255 },
      },
      light: {
        cyan: { r: 4, g: 116, b: 152 },
        blue: { r: 24, g: 82, b: 170 },
        green: { r: 4, g: 118, b: 88 },
        amber: { r: 150, g: 82, b: 4 },
        violet: { r: 96, g: 52, b: 170 },
      },
    }
    var ACCENT = { dark: { r: 255, g: 176, b: 64 }, light: { r: 150, g: 74, b: 4 } }

    function rgba(c, a) {
      var v = a < 0 ? 0 : a > 1 ? 1 : a
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + v + ')'
    }

    function parseColor(text) {
      var s = String(text || '').trim()
      if (!s) return null
      if (s.charAt(0) === '#') {
        var hex = s.slice(1)
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
        if (hex.length < 6) return null
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
      }
      var m = /rgba?\(([^)]+)\)/.exec(s)
      if (!m) return null
      var parts = m[1].split(',').map(parseFloat)
      if (parts.length < 3 || parts.some(function (n) { return !isFinite(n) })) return null
      return [parts[0], parts[1], parts[2]]
    }

    function luminance(rgb) {
      return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
    }

    /* 几何：斐波那契球 + k 近邻连线 */
    function buildNodes(count) {
      var pts = []
      var ga = Math.PI * (3 - Math.sqrt(5))
      var n = Math.max(2, count)
      for (var i = 0; i < n; i++) {
        var y = 1 - (i / (n - 1)) * 2
        var r = Math.sqrt(Math.max(0, 1 - y * y))
        var th = ga * i
        pts.push({ x: Math.cos(th) * r, y: y, z: Math.sin(th) * r })
      }
      return pts
    }

    function buildEdges(pts, k) {
      var edges = []
      var seen = {}
      var n = pts.length
      for (var i = 0; i < n; i++) {
        var a = pts[i]
        var best = []
        for (var j = 0; j < n; j++) {
          if (j === i) continue
          var b = pts[j]
          var dx = a.x - b.x
          var dy = a.y - b.y
          var dz = a.z - b.z
          var d = dx * dx + dy * dy + dz * dz
          if (best.length < k) {
            best.push({ j: j, d: d })
            if (best.length === k) best.sort(function (p, q) { return p.d - q.d })
          } else if (d < best[k - 1].d) {
            best[k - 1] = { j: j, d: d }
            best.sort(function (p, q) { return p.d - q.d })
          }
        }
        for (var x = 0; x < best.length; x++) {
          var lo = Math.min(i, best[x].j)
          var hi = Math.max(i, best[x].j)
          var key = lo + ':' + hi
          if (seen[key]) continue
          seen[key] = 1
          edges.push([lo, hi])
        }
      }
      return edges
    }

    function SphereEngine(host) {
      this.host = host
      this.canvas = document.createElement('canvas')
      this.canvas.className = 'jvs-canvas'
      this.host.appendChild(this.canvas)
      this.ctx = this.canvas.getContext('2d')
      this.probe = document.createElement('div')
      this.probe.className = 'jvs-probe'
      this.probe.style.background = 'var(--dsw-alias-bg-base, #101418)'
      this.host.appendChild(this.probe)

      this.w = 0
      this.h = 0
      this.dpr = 1
      this.raf = 0
      this.destroyed = false
      this.draws = 0

      this.nodes = []
      this.edges = []
      this.sparks = []
      this.waves = []
      this.yaw = 0
      this.pitch = 0
      this.spin = 0
      this.energy = 0.1
      this.time = 0
      this.prev = 0
      this.sparkAccum = 0

      this.state = {
        running: false,
        streamRate: 0,
        toolRate: 0,
        activeTools: [],
        lastTool: '',
        counters: {},
        recent: [],
      }
      this.cfg = { enabled: true, nodeCount: 460, intensity: 1, opacity: 1, showHud: true, color: 'cyan', offsetX: 0, offsetY: 0 }
      this.lastTools = -1
      this.dark = true
      this.blend = 'screen'

      this.onResize = this.onResize.bind(this)
      this.frame = this.frame.bind(this)

      this.resizeObserver = null
      try {
        this.resizeObserver = new ResizeObserver(this.onResize)
        this.resizeObserver.observe(this.host)
      } catch (err) {
        window.addEventListener('resize', this.onResize)
      }
      this.onResize()
      this.rebuild(this.cfg.nodeCount)
      this.detectTheme()

      this.raf = window.requestAnimationFrame(this.frame)
      this.pollLoop()
      this.themeTimer = window.setInterval(this.detectTheme.bind(this), 2500)
    }

    SphereEngine.prototype.destroy = function () {
      this.destroyed = true
      if (this.raf) window.cancelAnimationFrame(this.raf)
      if (this.themeTimer) window.clearInterval(this.themeTimer)
      if (this.pollTimer) window.clearTimeout(this.pollTimer)
      if (this.resizeObserver) this.resizeObserver.disconnect()
      else window.removeEventListener('resize', this.onResize)
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas)
      if (this.probe && this.probe.parentNode) this.probe.parentNode.removeChild(this.probe)
    }

    SphereEngine.prototype.rebuild = function (count) {
      this.nodes = buildNodes(count)
      this.edges = buildEdges(this.nodes, 3)
      this.sparks = []
      this.px = null
    }

    SphereEngine.prototype.onResize = function () {
      var rect = this.host.getBoundingClientRect()
      var w = Math.max(1, Math.round(rect.width || window.innerWidth))
      var hgt = Math.max(1, Math.round(rect.height || window.innerHeight))
      var dpr = Math.min(2, window.devicePixelRatio || 1)
      if (w === this.w && hgt === this.h && dpr === this.dpr) return
      this.w = w
      this.h = hgt
      this.dpr = dpr
      this.canvas.width = Math.round(w * dpr)
      this.canvas.height = Math.round(hgt * dpr)
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    /** 跟随主题令牌判断明暗，决定发光配色与混合模式。 */
    SphereEngine.prototype.detectTheme = function () {
      var raw = ''
      try {
        raw = window.getComputedStyle(this.probe).backgroundColor
      } catch (err) {
        raw = ''
      }
      var rgb = parseColor(raw)
      var dark = rgb ? luminance(rgb) < 0.5 : true
      this.dark = dark
      this.blend = dark ? 'screen' : 'multiply'
      if (this.canvas.style.mixBlendMode !== this.blend) this.canvas.style.mixBlendMode = this.blend
      this.palette = PALETTES[dark ? 'dark' : 'light']
      this.accent = ACCENT[dark ? 'dark' : 'light']
    }

    SphereEngine.prototype.applyConfig = function (cfg) {
      if (!cfg || typeof cfg !== 'object') return
      if (typeof cfg.nodeCount === 'number' && cfg.nodeCount !== this.cfg.nodeCount) {
        this.cfg.nodeCount = cfg.nodeCount
        this.rebuild(cfg.nodeCount)
      }
      if (typeof cfg.enabled === 'boolean') this.cfg.enabled = cfg.enabled
      if (typeof cfg.intensity === 'number') this.cfg.intensity = cfg.intensity
      if (typeof cfg.opacity === 'number') this.cfg.opacity = cfg.opacity
      if (typeof cfg.showHud === 'boolean') this.cfg.showHud = cfg.showHud
      if (typeof cfg.color === 'string') this.cfg.color = cfg.color
      if (typeof cfg.offsetX === 'number') this.cfg.offsetX = cfg.offsetX
      if (typeof cfg.offsetY === 'number') this.cfg.offsetY = cfg.offsetY
      this.canvas.style.display = this.cfg.enabled ? 'block' : 'none'
    }

    /** 桌面端页面是 dsh-app://，传输层公布的是宿主 HTTP 源。 */
    function transportBase() {
      try {
        var t = window.__DSH_TRANSPORT__
        if (t && typeof t.streamBaseUrl === 'string' && t.streamBaseUrl) return String(t.streamBaseUrl).replace(/\/+$/, '')
      } catch (err) {
        void err
      }
      return ''
    }

    SphereEngine.prototype.baseCandidates = function () {
      var list = []
      if (this.stateBase !== undefined) list.push(this.stateBase)
      if (list.indexOf('') === -1) list.push('')
      var base = transportBase()
      if (base && list.indexOf(base) === -1) list.push(base)
      return list
    }

    SphereEngine.prototype.pollLoop = function () {
      if (this.destroyed) return
      var self = this
      var bases = this.baseCandidates()
      var index = 0
      var attempt = function () {
        if (index >= bases.length) {
          self.failures = (self.failures || 0) + 1
          return Promise.resolve()
        }
        var base = bases[index++]
        return fetch(base + STATE_PATH, {
          credentials: base ? 'include' : 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (data) {
            self.stateBase = base
            self.failures = 0
            self.applyState(data)
          })
          .catch(function () {
            return attempt()
          })
      }
      attempt().then(function () {
        if (self.destroyed) return
        var busy = self.state.running || self.energy > 0.3
        var delay = self.failures ? 1600 : busy ? 140 : 450
        self.pollTimer = window.setTimeout(function () { self.pollLoop() }, delay)
      })
    }

    SphereEngine.prototype.applyState = function (data) {
      if (!data || typeof data !== 'object') return
      this.applyConfig(data.cfg)
      var prevRunning = this.state.running
      var sinceTool = Number(data.sinceTool)
      // 运行态由真实活动判定：有流式输出 / 有工具在跑 / 刚跑过工具。
      var busy =
        !!data.running ||
        (Number(data.streamRate) || 0) > 0.2 ||
        (Number(data.toolRate) || 0) > 0 ||
        (Array.isArray(data.activeTools) && data.activeTools.length > 0) ||
        (isFinite(sinceTool) && sinceTool >= 0 && sinceTool < 3000)
      this.state = {
        running: busy,
        streamRate: Number(data.streamRate) || 0,
        toolRate: Number(data.toolRate) || 0,
        activeTools: Array.isArray(data.activeTools) ? data.activeTools : [],
        lastTool: String(data.lastTool || ''),
        counters: data.counters && typeof data.counters === 'object' ? data.counters : {},
        recent: Array.isArray(data.recent) ? data.recent : [],
      }
      var tools = Number(this.state.counters.tools) || 0
      if (this.lastTools >= 0 && tools > this.lastTools) {
        var n = Math.min(4, tools - this.lastTools)
        for (var i = 0; i < n; i++) this.burst(0.5 + 0.15 * i)
      }
      this.lastTools = tools
      if (!prevRunning && busy) this.burst(0.35)
    }

    SphereEngine.prototype.burst = function (strength) {
      this.waves.push({ r: 0.2, a: Math.min(1, strength), s: 1.5 + strength })
      if (this.waves.length > 5) this.waves.shift()
      for (var i = 0; i < 5; i++) this.spawnSpark(0.9)
    }

    SphereEngine.prototype.spawnSpark = function (speed) {
      if (!this.edges.length) return
      var e = this.edges[(Math.random() * this.edges.length) | 0]
      this.sparks.push({ e: e, t: 0, v: (0.55 + Math.random() * 0.7) * speed })
      if (this.sparks.length > 200) this.sparks.shift()
    }

    SphereEngine.prototype.frame = function (now) {
      if (this.destroyed) return
      this.raf = window.requestAnimationFrame(this.frame)
      if (document.hidden) {
        this.prev = now
        return
      }
      var dt = this.prev ? Math.min(0.05, (now - this.prev) / 1000) : 0.016
      this.prev = now
      this.time += dt
      this.update(dt)
      this.draw()
    }

    SphereEngine.prototype.update = function (dt) {
      var s = this.state
      var cfg = this.cfg
      var target =
        (s.running ? 0.5 : 0.09) +
        Math.min(0.5, s.streamRate / 9) +
        Math.min(0.4, s.toolRate / 2.2)
      target *= cfg.intensity
      if (target > 1.7) target = 1.7
      this.energy += (target - this.energy) * Math.min(1, dt * 2.6)
      if (this.energy < 0.03) this.energy = 0.03

      this.yaw += dt * (0.085 + this.energy * 0.42)
      if (this.yaw > Math.PI * 2) this.yaw -= Math.PI * 2
      this.pitch = Math.sin(this.time * 0.17) * 0.34
      this.spin = Math.sin(this.time * 0.5) * 0.06

      var rate = 1.1 + this.energy * 24
      this.sparkAccum += rate * dt
      while (this.sparkAccum >= 1) {
        this.sparkAccum -= 1
        this.spawnSpark(0.8 + this.energy * 0.9)
      }
      for (var i = this.sparks.length - 1; i >= 0; i--) {
        var sp = this.sparks[i]
        sp.t += dt * sp.v
        if (sp.t >= 1) this.sparks.splice(i, 1)
      }
      for (var w = this.waves.length - 1; w >= 0; w--) {
        var wave = this.waves[w]
        wave.r += dt * wave.s * 0.5
        wave.a -= dt * 1.1
        if (wave.a <= 0) this.waves.splice(w, 1)
      }
    }

    SphereEngine.prototype.draw = function () {
      var ctx = this.ctx
      var w = this.w
      var hgt = this.h
      if (!w || !hgt) return
      ctx.clearRect(0, 0, w, hgt)

      var cfg = this.cfg
      if (!cfg.enabled) return
      var alphaScale = cfg.opacity
      if (alphaScale <= 0.001) return

      this.draws += 1
      var pal = this.palette || PALETTES.dark
      var base = pal[cfg.color] || pal.cyan
      var accent = this.accent || ACCENT.dark
      var energy = this.energy
      var lit = Math.min(1.3, energy)

      var cx = w / 2 + cfg.offsetX
      var cy = hgt / 2 + cfg.offsetY
      var R = Math.min(w, hgt) * 0.335
      var f = 3.15

      var cosY = Math.cos(this.yaw)
      var sinY = Math.sin(this.yaw)
      var cosP = Math.cos(this.pitch)
      var sinP = Math.sin(this.pitch)

      /* 背景光晕 */
      var glowR = R * (1.24 + 0.05 * Math.sin(this.time * 0.9) + energy * 0.14)
      var grad = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, glowR)
      grad.addColorStop(0, rgba(base, 0.045 * alphaScale))
      grad.addColorStop(0.58, rgba(base, (0.05 + 0.02 * lit) * alphaScale))
      grad.addColorStop(1, rgba(base, 0))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2)
      ctx.fill()

      /* 投影 */
      var nodes = this.nodes
      var n = nodes.length
      if (!this.px || this.px.length !== n) {
        this.px = new Float32Array(n)
        this.py = new Float32Array(n)
        this.pz = new Float32Array(n)
      }
      var px = this.px
      var py = this.py
      var pz = this.pz
      for (var i = 0; i < n; i++) {
        var p = nodes[i]
        var x1 = p.x * cosY + p.z * sinY
        var z1 = -p.x * sinY + p.z * cosY
        var y2 = p.y * cosP - z1 * sinP
        var z2 = p.y * sinP + z1 * cosP
        var sc = f / (f + z2)
        px[i] = cx + x1 * sc * R
        py[i] = cy + y2 * sc * R
        pz[i] = (z2 + 1) * 0.5
      }

      /* 连线：按深度分三档批量描边，一次 stroke 画完一档 */
      var edges = this.edges
      var edgeBase = (0.1 + 0.19 * lit) * alphaScale
      var buckets = [[], [], []]
      for (var e = 0; e < edges.length; e++) {
        var ea = edges[e][0]
        var eb = edges[e][1]
        var depth = (pz[ea] + pz[eb]) * 0.5
        var tier = depth < 0.36 ? 0 : depth < 0.7 ? 1 : 2
        buckets[tier].push(ea, eb)
      }
      ctx.lineWidth = 0.7
      var tierAlpha = [0.3, 0.62, 1]
      for (var t = 0; t < 3; t++) {
        var seg = buckets[t]
        if (!seg.length) continue
        ctx.strokeStyle = rgba(base, edgeBase * tierAlpha[t])
        ctx.beginPath()
        for (var s = 0; s < seg.length; s += 2) {
          ctx.moveTo(px[seg[s]], py[seg[s]])
          ctx.lineTo(px[seg[s + 1]], py[seg[s + 1]])
        }
        ctx.stroke()
      }

      /* 能量脉冲 */
      var accentAlpha = alphaScale
      for (var k2 = 0; k2 < this.sparks.length; k2++) {
        var sp = this.sparks[k2]
        var a0 = sp.e[0]
        var a1 = sp.e[1]
        var tt = sp.t
        var sx = px[a0] + (px[a1] - px[a0]) * tt
        var sy = py[a0] + (py[a1] - py[a0]) * tt
        var sd = pz[a0] + (pz[a1] - pz[a0]) * tt
        var sa = (0.32 + 0.5 * sd) * accentAlpha * Math.sin(Math.PI * tt)
        if (sa <= 0.01) continue
        ctx.fillStyle = rgba(accent, sa)
        ctx.beginPath()
        ctx.arc(sx, sy, 1.1 + 1.5 * sd, 0, Math.PI * 2)
        ctx.fill()
      }

      /* 节点：按深度分四档批量填充 */
      var nodeAlpha = (0.28 + 0.42 * lit) * alphaScale
      var nodeBuckets = [[], [], [], []]
      for (var m = 0; m < n; m++) {
        var dd = pz[m]
        var bi = dd < 0.28 ? 0 : dd < 0.52 ? 1 : dd < 0.76 ? 2 : 3
        nodeBuckets[bi].push(m)
      }
      var nodeAlphaTier = [0.22, 0.45, 0.72, 1]
      var nodeSizeTier = [0.7, 1.05, 1.45, 2]
      for (var nb = 0; nb < 4; nb++) {
        var idx = nodeBuckets[nb]
        if (!idx.length) continue
        ctx.fillStyle = rgba(base, nodeAlpha * nodeAlphaTier[nb])
        ctx.beginPath()
        var radius = nodeSizeTier[nb]
        for (var q = 0; q < idx.length; q++) {
          var id = idx[q]
          ctx.moveTo(px[id] + radius, py[id])
          ctx.arc(px[id], py[id], radius, 0, Math.PI * 2)
        }
        ctx.fill()
      }

      /* 工具调用冲击波 */
      for (var wi = 0; wi < this.waves.length; wi++) {
        var wave = this.waves[wi]
        ctx.beginPath()
        ctx.arc(cx, cy, R * wave.r, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(accent, wave.a * 0.3 * alphaScale)
        ctx.lineWidth = 1.4
        ctx.stroke()
      }

      /* 轨道环 */
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(this.spin)
      var ringR = R * 1.05
      ctx.strokeStyle = rgba(base, (0.1 + 0.13 * lit) * alphaScale)
      ctx.lineWidth = 0.9
      ctx.beginPath()
      ctx.ellipse(0, 0, ringR, ringR * 0.3, this.time * 0.12, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = rgba(base, (0.06 + 0.09 * lit) * alphaScale)
      ctx.beginPath()
      ctx.ellipse(0, 0, ringR * 0.995, ringR * 0.995, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      /* 中空内缘：一圈淡淡的「事件视界」，把球心框出来 */
      var holeR = R * (0.55 + 0.015 * Math.sin(this.time * 0.7))
      ctx.strokeStyle = rgba(base, (0.07 + 0.1 * lit) * alphaScale)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, holeR, 0, Math.PI * 2)
      ctx.stroke()

      /* 挖空球心，保证正文可读 */
      var hole = ctx.createRadialGradient(cx, cy, holeR * 0.25, cx, cy, holeR)
      hole.addColorStop(0, 'rgba(0,0,0,0.6)')
      hole.addColorStop(0.7, 'rgba(0,0,0,0.38)')
      hole.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = hole
      ctx.beginPath()
      ctx.arc(cx, cy, holeR, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'

      if (cfg.showHud && alphaScale > 0.15) this.drawHud(ctx, cx, cy, R, base, accent, alphaScale)
    }

    SphereEngine.prototype.drawHud = function (ctx, cx, cy, R, base, accent, alpha) {
      var s = this.state
      var tools = Number(s.counters.tools) || 0
      var turns = Number(s.counters.turns) || 0
      var head = s.running ? 'ACTIVE' : 'STANDBY'
      if (tools > 0) head += '  ·  ' + tools + ' TOOLS'
      if (turns > 0) head += '  ·  ' + turns + ' TURNS'
      // 只有真的有工具在跑时才显示名字，避免常驻水印压住正文
      var detail = s.activeTools.length ? String(s.activeTools[s.activeTools.length - 1]) : ''

      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      var y = cy + R * 1.03
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      ctx.fillStyle = rgba(s.running ? accent : base, (this.dark ? 0.24 : 0.4) * alpha)
      ctx.fillText(head, cx, y)
      if (detail) {
        ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        ctx.fillStyle = rgba(base, (this.dark ? 0.17 : 0.34) * alpha)
        ctx.fillText(String(detail).toUpperCase().slice(0, 30), cx, y + 13)
      }
      ctx.restore()
    }

    function JarvisSphere() {
      var ref = React.useRef(null)
      React.useEffect(function () {
        var host = ref.current
        if (!host) return undefined
        var engine
        try {
          engine = new SphereEngine(host)
        } catch (err) {
          // 画不出来也不能影响宿主界面：只留一条控制台线索。
          try {
            console.error('[jarvis-sphere] engine failed:', err)
          } catch (e2) {
            void e2
          }
          return undefined
        }
        return function () { engine.destroy() }
      }, [])
      return h('div', { ref: ref, className: 'jvs-root', 'aria-hidden': 'true' },
        h('style', null, CSS))
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'jarvis-sphere', order: -50, label: 'Jarvis sphere' },
            JarvisSphere,
          )
        })
      },
    }
  },
})
