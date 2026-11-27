/**
 * Jarvis sphere — Client half.
 *
 * 在 shell.overlay（整帧浮层）里画一个全息神经元球：
 *   经纬线球壳 → 神经元节点/连线 → 越球数据弧 → 同心倾斜环 + 刻度
 *   → 水平扫描带 → 工具调用冲击波 → 挖空球心 → 四分之一分辨率的泛光 → HUD
 * 全部由 Host 的 /dsh-jarvis/state 驱动，整层穿透点击。
 */
window.__ModuleLoader__.load({
  id: 'dsh-jarvis-sphere',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var STATE_PATH = '/dsh-jarvis/state'
    /* 老版本实例可能占着主路径不放（Host 路由没随插件卸载释放），
       所以只认 build 够新的快照，主路径不达标时改投这个备用路径。 */
    var STATE_PATHS = ['/dsh-jarvis/state', '/dsh-jarvis/state-v2']
    var MIN_BUILD = 3
    var TAU = Math.PI * 2

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
    var HILITE = { dark: { r: 214, g: 250, b: 255 }, light: { r: 0, g: 44, b: 62 } }

    function rgba(c, a) {
      var v = a < 0 ? 0 : a > 1 ? 1 : a
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + v + ')'
    }

    function mix(a, b, t) {
      return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t),
      }
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

    /* 浏览器是否真的支持 ctx.filter（不支持时加了滤镜会糊成一片白） */
    var FILTER_OK = (function () {
      try {
        var a = document.createElement('canvas')
        var b = document.createElement('canvas')
        a.width = a.height = b.width = b.height = 9
        var ag = a.getContext('2d')
        var bg = b.getContext('2d')
        if (!ag || !bg) return false
        ag.fillStyle = '#fff'
        ag.fillRect(4, 4, 1, 1)
        bg.filter = 'blur(2px)'
        bg.drawImage(a, 0, 0)
        return bg.getImageData(2, 4, 1, 1).data[3] > 0
      } catch (err) {
        return false
      }
    })()

    /* 几何：斐波那契球节点 + k 近邻连线 */
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

    /* 全息球壳：纬线 + 经线，每条是闭合的三维圆 */
    function buildGlobe(segments) {
      var out = []
      var N = segments || 44
      var lats = [-62, -42, -22, 0, 22, 42, 62]
      for (var li = 0; li < lats.length; li++) {
        var lat = (lats[li] * Math.PI) / 180
        var y = Math.sin(lat)
        var r = Math.cos(lat)
        var pts = []
        for (var i = 0; i <= N; i++) {
          var a = (i / N) * TAU
          pts.push(Math.cos(a) * r, y, Math.sin(a) * r)
        }
        out.push(pts)
      }
      var lons = [0, 30, 60, 90, 120, 150]
      for (var oi = 0; oi < lons.length; oi++) {
        var lon = (lons[oi] * Math.PI) / 180
        var cl = Math.cos(lon)
        var sl = Math.sin(lon)
        var mp = []
        for (var j = 0; j <= N; j++) {
          var b = (j / N) * TAU
          mp.push(Math.cos(b) * cl, Math.sin(b), Math.cos(b) * sl)
        }
        out.push(mp)
      }
      return out
    }

    function SphereEngine(host) {
      this.host = host
      this.canvas = document.createElement('canvas')
      this.canvas.className = 'jvs-canvas'
      this.host.appendChild(this.canvas)
      this.ctx = this.canvas.getContext('2d')
      this.bloomCanvas = document.createElement('canvas')
      this.bloomCtx = this.bloomCanvas.getContext('2d')
      this.probe = document.createElement('div')
      this.probe.className = 'jvs-probe'
      this.probe.style.background = 'var(--dsw-alias-bg-base, #101418)'
      this.host.appendChild(this.probe)

      this.w = 0
      this.h = 0
      this.dpr = 1
      this.raf = 0
      this.destroyed = false

      this.nodes = []
      this.edges = []
      this.globe = []
      this.sparks = []
      this.waves = []
      this.arcs = []
      this.yaw = 0
      this.pitch = 0
      this.spin = 0
      this.energy = 0.1
      this.time = 0
      this.prev = 0
      this.sparkAccum = 0
      this.arcAccum = 0

      this.state = {
        running: false,
        streamRate: 0,
        toolRate: 0,
        activeTools: [],
        lastTool: '',
        counters: {},
        recent: [],
      }
      this.cfg = {
        enabled: true, nodeCount: 460, intensity: 1, opacity: 1,
        showHud: true, glow: true, color: 'cyan', offsetX: 0, offsetY: 0,
      }
      this.lastTools = -1
      this.dark = true
      this.blend = 'screen'

      /* 记忆投影与人格标记：都由 Host 的快照驱动 */
      this.memory = null
      this.persona = null
      this.memoryRef = null
      this.memorySlotsCache = null
      this.memoryBornAt = 0

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
      this.globe = buildGlobe(44)
      this.sparks = []
      this.arcs = []
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
      var bw = Math.max(1, Math.round(this.canvas.width / 4))
      var bh = Math.max(1, Math.round(this.canvas.height / 4))
      this.bloomCanvas.width = bw
      this.bloomCanvas.height = bh
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
      this.hilite = HILITE[dark ? 'dark' : 'light']
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
      if (typeof cfg.glow === 'boolean') this.cfg.glow = cfg.glow
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

    /** 上次成功的路径优先，其余按主路径、备用路径排。 */
    SphereEngine.prototype.pathCandidates = function () {
      var preferred = this.statePath
      var out = []
      if (preferred) out.push(preferred)
      for (var i = 0; i < STATE_PATHS.length; i++) {
        if (STATE_PATHS[i] !== preferred) out.push(STATE_PATHS[i])
      }
      return out
    }

    SphereEngine.prototype.candidates = function () {
      var bases = this.baseCandidates()
      var paths = this.pathCandidates()
      var out = []
      for (var b = 0; b < bases.length; b++) {
        for (var p = 0; p < paths.length; p++) out.push({ base: bases[b], path: paths[p] })
      }
      return out
    }

    /** 只接受本版本 Host 的快照，跳过老实例留下的冻结数据。 */
    function acceptState(data) {
      if (!data || typeof data !== 'object') return false
      var build = Number(data.build)
      return isFinite(build) && build >= MIN_BUILD
    }

    SphereEngine.prototype.pollLoop = function () {
      if (this.destroyed) return
      var self = this
      var candidates = this.candidates()
      var index = 0
      var attempt = function () {
        if (index >= candidates.length) {
          self.failures = (self.failures || 0) + 1
          return Promise.resolve()
        }
        var candidate = candidates[index++]
        return fetch(candidate.base + candidate.path, {
          credentials: candidate.base ? 'include' : 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (data) {
            if (!acceptState(data)) throw new Error('snapshot build ' + String(data && data.build))
            self.stateBase = candidate.base
            self.statePath = candidate.path
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
      /* 记忆投影：条目自身永不离开 Host，这里只拿到 hash/类型/重要度/年龄 */
      var nextMemory = data.memory && Array.isArray(data.memory.nodes) ? data.memory : null
      var prevMemoryTotal = this.memory && this.memory.ok ? Number(this.memory.total) || 0 : 0
      this.memory = nextMemory
      this.persona = data.persona && typeof data.persona === 'object' ? data.persona : null
      var nextMemoryTotal = nextMemory && nextMemory.ok ? Number(nextMemory.total) || 0 : 0
      /* 新写入一条记忆：亮一颗新光点，顺手划一道弧 */
      if (nextMemoryTotal > prevMemoryTotal) {
        this.memoryBornAt = this.time
        this.burst(0.45)
        this.spawnArc(1.1)
      }
      var tools = Number(this.state.counters.tools) || 0
      if (this.lastTools >= 0 && tools > this.lastTools) {
        var n = Math.min(3, tools - this.lastTools)
        for (var i = 0; i < n; i++) this.burst(0.5 + 0.15 * i)
      }
      this.lastTools = tools
      if (!prevRunning && busy) this.burst(0.35)
    }

    /** 一条记忆占一颗固定光点：hash 决定位置，重启后仍落在同一处 */
    SphereEngine.prototype.memorySlots = function (memory) {
      if (this.memoryRef === memory && this.memorySlotsCache) return this.memorySlotsCache
      var total = this.nodes.length || 1
      var used = {}
      var out = []
      for (var i = 0; i < memory.nodes.length; i++) {
        var entry = memory.nodes[i]
        if (!entry) continue
        var slot = ((entry.k >>> 0) % total + total) % total
        var guard = 0
        while (used[slot] && guard < total) {
          slot = (slot + 1) % total
          guard++
        }
        if (used[slot]) break
        used[slot] = 1
        var type = entry.t === 'user' ? 'user' : entry.t === 'space' ? 'space' : entry.t === 'doc' ? 'doc' : 'memory'
        out.push({
          idx: slot,
          t: type,
          i: Number(entry.i) || 0,
          a: Number(entry.a),
          f: !!entry.f,
        })
      }
      this.memoryRef = memory
      this.memorySlotsCache = out
      return out
    }

    /** 一次工具调用：冲击波 + 越球数据弧 + 火花 */
    SphereEngine.prototype.burst = function (strength) {
      this.waves.push({ r: 0.22, a: Math.min(1, strength), s: 1.5 + strength })
      if (this.waves.length > 5) this.waves.shift()
      for (var i = 0; i < 2; i++) this.spawnArc(0.8 + Math.random() * 0.5)
      for (var j = 0; j < 5; j++) this.spawnSpark(0.9)
    }

    SphereEngine.prototype.spawnSpark = function (speed) {
      if (!this.edges.length) return
      var e = this.edges[(Math.random() * this.edges.length) | 0]
      this.sparks.push({ e: e, t: 0, v: (0.55 + Math.random() * 0.7) * speed })
      if (this.sparks.length > 180) this.sparks.shift()
    }

    /** 越球数据弧：从一个节点沿大圆飞到另一个节点 */
    SphereEngine.prototype.spawnArc = function (speed) {
      var n = this.nodes.length
      if (n < 2) return
      var a = (Math.random() * n) | 0
      var b = (Math.random() * n) | 0
      if (a === b) b = (b + 7) % n
      this.arcs.push({ a: a, b: b, t: 0, v: (0.5 + Math.random() * 0.5) * speed })
      if (this.arcs.length > 6) this.arcs.shift()
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
      if (this.yaw > TAU) this.yaw -= TAU
      this.pitch = Math.sin(this.time * 0.17) * 0.34
      this.spin = this.time * 0.12

      var rate = 1.1 + this.energy * 24
      this.sparkAccum += rate * dt
      while (this.sparkAccum >= 1) {
        this.sparkAccum -= 1
        this.spawnSpark(0.8 + this.energy * 0.9)
      }
      // 空闲时也偶尔划一道数据弧，保持"活着"
      this.arcAccum += dt * (0.12 + this.energy * 1.1)
      while (this.arcAccum >= 1) {
        this.arcAccum -= 1
        this.spawnArc(0.6 + this.energy * 0.6)
      }

      for (var i = this.sparks.length - 1; i >= 0; i--) {
        var sp = this.sparks[i]
        sp.t += dt * sp.v
        if (sp.t >= 1) this.sparks.splice(i, 1)
      }
      for (var k = this.arcs.length - 1; k >= 0; k--) {
        var arc = this.arcs[k]
        arc.t += dt * arc.v
        if (arc.t >= 1) this.arcs.splice(k, 1)
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
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, w, hgt)

      var cfg = this.cfg
      if (!cfg.enabled) return
      var alphaScale = cfg.opacity
      if (alphaScale <= 0.001) return

      var pal = this.palette || PALETTES.dark
      var base = pal[cfg.color] || pal.cyan
      var accent = this.accent || ACCENT.dark
      var hi = this.hilite || HILITE.dark
      var energy = this.energy
      var lit = Math.min(1.3, energy)
      // 全息闪烁：极轻微的亮度抖动
      var flick = 1 + 0.028 * Math.sin(this.time * 11.3) + 0.016 * Math.sin(this.time * 23.7)

      var cx = w / 2 + cfg.offsetX
      var cy = hgt / 2 + cfg.offsetY
      var R = Math.min(w, hgt) * 0.315
      var f = 3.15

      var cosY = Math.cos(this.yaw)
      var sinY = Math.sin(this.yaw)
      var cosP = Math.cos(this.pitch)
      var sinP = Math.sin(this.pitch)

      // ---- 环境光晕 ----
      var glowR = R * (1.3 + 0.04 * Math.sin(this.time * 0.9) + energy * 0.12)
      var grad = ctx.createRadialGradient(cx, cy, R * 0.25, cx, cy, glowR)
      grad.addColorStop(0, rgba(base, 0.03 * alphaScale))
      grad.addColorStop(0.6, rgba(base, (0.045 + 0.02 * lit) * alphaScale * flick))
      grad.addColorStop(1, rgba(base, 0))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(cx, cy, glowR, 0, TAU)
      ctx.fill()

      var project = function (x, y, z) {
        var x1 = x * cosY + z * sinY
        var z1 = -x * sinY + z * cosY
        var y2 = y * cosP - z1 * sinP
        var z2 = y * sinP + z1 * cosP
        var sc = f / (f + z2)
        return [cx + x1 * sc * R, cy + y2 * sc * R, (z2 + 1) * 0.5]
      }

      // ---- 全息球壳：经纬线 ----
      ctx.lineWidth = 0.75
      var globeAlpha = (0.055 + 0.065 * lit) * alphaScale * flick
      for (var gi = 0; gi < this.globe.length; gi++) {
        var ring = this.globe[gi]
        ctx.strokeStyle = rgba(base, globeAlpha)
        ctx.beginPath()
        for (var pi = 0; pi < ring.length; pi += 3) {
          var pr = project(ring[pi], ring[pi + 1], ring[pi + 2])
          if (pi === 0) ctx.moveTo(pr[0], pr[1])
          else ctx.lineTo(pr[0], pr[1])
        }
        ctx.stroke()
      }

      // ---- 神经元投影 ----
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
      if (!this.pLight || this.pLight.length !== n) this.pLight = new Float32Array(n)
      var pLight = this.pLight
      // 光照方向：左上前方（z 越大越远，所以前方是 -z）
      var lx = -0.45 * cosP
      var ly = 0.60
      var lz = -0.66
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
        var dot = x1 * lx + y2 * ly + z2 * lz
        pLight[i] = dot > 1 ? 1 : dot < -1 ? -1 : dot
      }

      // ---- 连线（按深度三档批量） ----
      var edges = this.edges
      var edgeBase = (0.05 + 0.10 * lit) * alphaScale * flick
      var buckets = [[], [], []]
      for (var e = 0; e < edges.length; e++) {
        var ea = edges[e][0]
        var eb = edges[e][1]
        var depth = (pz[ea] + pz[eb]) * 0.5
        buckets[depth < 0.36 ? 0 : depth < 0.7 ? 1 : 2].push(ea, eb)
      }
      ctx.lineWidth = 0.7
      var tierAlpha = [0.22, 0.5, 1]
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

      // ---- 越球数据弧 + 飞行光点 ----
      for (var ai = 0; ai < this.arcs.length; ai++) {
        var arc = this.arcs[ai]
        var na = nodes[arc.a]
        var nb = nodes[arc.b]
        var steps = 14
        ctx.strokeStyle = rgba(accent, (0.22 + 0.32 * lit) * alphaScale * Math.sin(Math.PI * arc.t))
        ctx.lineWidth = 1.1
        ctx.beginPath()
        for (var st = 0; st <= steps; st++) {
          var tt = (st / steps) * Math.min(1, arc.t)
          var q = slerp(na, nb, tt)
          var pq = project(q.x, q.y, q.z)
          if (st === 0) ctx.moveTo(pq[0], pq[1])
          else ctx.lineTo(pq[0], pq[1])
        }
        ctx.stroke()
        var head = slerp(na, nb, arc.t)
        var ph = project(head.x, head.y, head.z)
        var hr = 2.2 + 2.4 * ph[2]
        ctx.fillStyle = rgba(accent, 0.9 * alphaScale)
        ctx.beginPath()
        ctx.arc(ph[0], ph[1], hr, 0, TAU)
        ctx.fill()
        ctx.fillStyle = rgba(hi, 0.55 * alphaScale)
        ctx.beginPath()
        ctx.arc(ph[0], ph[1], hr * 0.5, 0, TAU)
        ctx.fill()
      }

      // ---- 沿边火花：彗星头 + 短线拖尾 ----
      for (var ki = 0; ki < this.sparks.length; ki++) {
        var sp = this.sparks[ki]
        var a0 = sp.e[0]
        var a1 = sp.e[1]
        var tt2 = sp.t
        var sx = px[a0] + (px[a1] - px[a0]) * tt2
        var sy = py[a0] + (py[a1] - py[a0]) * tt2
        var sd = pz[a0] + (pz[a1] - pz[a0]) * tt2
        var sa = (0.3 + 0.55 * sd) * alphaScale * Math.sin(Math.PI * tt2)
        if (sa <= 0.01) continue
        var tail = tt2 - 0.09
        if (tail > 0) {
          var tx = px[a0] + (px[a1] - px[a0]) * tail
          var ty = py[a0] + (py[a1] - py[a0]) * tail
          ctx.strokeStyle = rgba(mix(accent, base, 0.4), sa * 0.5)
          ctx.lineWidth = 1.1 + 1.1 * sd
          ctx.beginPath()
          ctx.moveTo(tx, ty)
          ctx.lineTo(sx, sy)
          ctx.stroke()
        }
        ctx.fillStyle = rgba(mix(accent, hi, sd * 0.6), sa)
        ctx.beginPath()
        ctx.arc(sx, sy, 1.1 + 1.4 * sd, 0, TAU)
        ctx.fill()
      }

      // ---- 节点：深度 4 档 × 光照 3 档，共 12 次批量填充 ----
      var nodeAlpha = (0.26 + 0.4 * lit) * alphaScale
      var nodeAlphaTier = [0.10, 0.30, 0.62, 1]
      var nodeSizeTier = [0.55, 0.9, 1.35, 2.1]
      var lightMul = [0.5, 1, 1.55]
      var deep = pal.blue || base
      var nodeColorTier = [mix(base, deep, 0.75), mix(base, deep, 0.3), mix(base, hi, 0.35), mix(base, hi, 0.7)]
      var nb = [[null, null, null], [null, null, null], [null, null, null], [null, null, null]]
      for (var m = 0; m < n; m++) {
        var dd = pz[m]
        var si = dd < 0.28 ? 0 : dd < 0.52 ? 1 : dd < 0.76 ? 2 : 3
        var lv = Math.max(0, pLight[m]) * (0.35 + 0.65 * dd)
        var li = lv < 0.42 ? 0 : lv < 0.72 ? 1 : 2
        if (!nb[si][li]) nb[si][li] = []
        nb[si][li].push(m)
      }
      for (var si2 = 0; si2 < 4; si2++) {
        for (var li2 = 0; li2 < 3; li2++) {
          var bucket = nb[si2][li2]
          if (!bucket || !bucket.length) continue
          var a = nodeAlpha * nodeAlphaTier[si2] * lightMul[li2]
          if (a < 0.006) continue
          ctx.fillStyle = rgba(nodeColorTier[si2], a)
          ctx.beginPath()
          var radius = nodeSizeTier[si2]
          for (var q2 = 0; q2 < bucket.length; q2++) {
            var id = bucket[q2]
            ctx.moveTo(px[id] + radius, py[id])
            ctx.arc(px[id], py[id], radius, 0, TAU)
          }
          ctx.fill()
        }
      }

      // ---- 记忆光点：每颗都是一条记忆（用户画像 / 工作记忆 / 记忆空间 / 文档） ----
      var memory = this.memory
      if (memory && memory.ok && Array.isArray(memory.nodes) && memory.nodes.length) {
        var slots = this.memorySlots(memory)
        var memPalette = {
          user: pal.amber || accent,
          /* 工作记忆是最多的一类：偏白的冷光，才不会和球壳的青线糊在一起 */
          memory: mix(pal.cyan || base, hi, 0.6),
          space: pal.violet || base,
          doc: pal.green || base,
        }
        var born = this.memoryBornAt ? Math.max(0, 1 - (this.time - this.memoryBornAt) / 2.4) : 0
        for (var mm = 0; mm < slots.length; mm++) {
          var ms = slots[mm]
          var mIdx = ms.idx
          var mDepth = pz[mIdx]
          var mImp = ms.i < 0 ? 0 : ms.i > 2 ? 2 : ms.i
          // 旧记忆变暗但不熄灭：球上留下的都是真的记过的东西
          var ageFade = isFinite(ms.a) && ms.a >= 0 ? Math.max(0.42, 1 - ms.a / 150) : 0.85
          var tint = memPalette[ms.t] || base
          var coreA = (0.34 + 0.62 * mDepth) * alphaScale * ageFade
          if (coreA < 0.012) continue
          var mx = px[mIdx]
          var my = py[mIdx]
          var breath = ms.f || born > 0 ? Math.sin(this.time * 3.1 + mm * 0.7) * 0.5 + 0.5 : 0.22
          var twinkle = 0.78 + 0.22 * Math.sin(this.time * 2.2 + mm * 1.7)
          var mSize = 2.0 + mImp * 1.2
          var halo = mSize * (3.0 + 1.0 * breath + born * 2.4)
          ctx.fillStyle = rgba(tint, coreA * (0.16 + 0.2 * breath + 0.34 * born) * twinkle)
          ctx.beginPath()
          ctx.arc(mx, my, halo, 0, TAU)
          ctx.fill()
          ctx.fillStyle = rgba(mix(tint, hi, 0.62), Math.min(1, coreA * 1.25))
          ctx.beginPath()
          ctx.arc(mx, my, mSize * 0.78, 0, TAU)
          ctx.fill()
          ctx.strokeStyle = rgba(tint, coreA * (mImp >= 2 ? 0.62 : 0.34))
          ctx.lineWidth = mImp >= 2 ? 1 : 0.7
          ctx.beginPath()
          ctx.arc(mx, my, mSize * (1.75 + breath * 0.35), 0, TAU)
          ctx.stroke()
        }
      }

      // ---- 工具冲击波 ----
      for (var wi = 0; wi < this.waves.length; wi++) {
        var wave = this.waves[wi]
        var wr = R * wave.r
        ctx.strokeStyle = rgba(accent, wave.a * 0.35 * alphaScale)
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(cx, cy, wr, 0, TAU)
        ctx.stroke()
        ctx.strokeStyle = rgba(hi, wave.a * 0.12 * alphaScale)
        ctx.lineWidth = 4
        ctx.stroke()
      }

      // ---- 同心倾斜环 + 刻度（球体外的"仪表层"） ----
      var ringDefs = [
        { r: 1.12, squash: 0.40, tilt: -0.62, speed: 0.10, ticks: 96 },
        { r: 1.26, squash: 0.30, tilt: 0.42, speed: -0.08, ticks: 48 },
      ]
      for (var ri = 0; ri < ringDefs.length; ri++) {
        var rd = ringDefs[ri]
        var rr = R * rd.r
        var rot = this.spin * rd.speed * 8 + ri
        var ca = Math.cos(rd.tilt)
        var sa2 = Math.sin(rd.tilt)
        var ringAlpha = (0.09 + 0.12 * lit) * alphaScale * flick
        // 环本体
        ctx.strokeStyle = rgba(base, ringAlpha)
        ctx.lineWidth = 1
        ctx.beginPath()
        for (var ti = 0; ti <= 96; ti++) {
          var ang = (ti / 96) * TAU
          var ex0 = Math.cos(ang) * rr
          var ey0 = Math.sin(ang) * rr * rd.squash
          var rx0 = ex0 * ca - ey0 * sa2
          var ry0 = ex0 * sa2 + ey0 * ca
          if (ti === 0) ctx.moveTo(cx + rx0, cy + ry0)
          else ctx.lineTo(cx + rx0, cy + ry0)
        }
        ctx.stroke()
        // 刻度
        ctx.strokeStyle = rgba(base, ringAlpha * 1.5)
        ctx.lineWidth = 0.9
        ctx.beginPath()
        var step = TAU / rd.ticks
        for (var tk = 0; tk < rd.ticks; tk++) {
          var ta = tk * step + rot
          var major = tk % 10 === 0
          var outer = 1
          var inner = major ? 0.9 : 0.955
          var ax = Math.cos(ta) * rr * outer
          var ay = Math.sin(ta) * rr * rd.squash * outer
          var bx2 = Math.cos(ta) * rr * inner
          var by2 = Math.sin(ta) * rr * rd.squash * inner
          ctx.moveTo(cx + ax * ca - ay * sa2, cy + ax * sa2 + ay * ca)
          ctx.lineTo(cx + bx2 * ca - by2 * sa2, cy + bx2 * sa2 + by2 * ca)
        }
        ctx.stroke()
      }

      // ---- 准星括弧：4 段弧 + 端点，HUD 味道 ----
      var retR = R * 1.34
      var retAlpha = (0.16 + 0.16 * lit) * alphaScale * flick
      ctx.lineWidth = 2
      ctx.strokeStyle = rgba(base, retAlpha)
      for (var rb = 0; rb < 4; rb++) {
        var baseAng = Math.PI / 4 + rb * (Math.PI / 2)
        var spread = 0.30
        ctx.beginPath()
        ctx.arc(cx, cy, retR, baseAng - spread / 2, baseAng + spread / 2)
        ctx.stroke()
      }
      ctx.fillStyle = rgba(hi, retAlpha * 1.5)
      for (var rb2 = 0; rb2 < 4; rb2++) {
        var rba = Math.PI / 4 + rb2 * (Math.PI / 2)
        ctx.beginPath()
        ctx.arc(cx + Math.cos(rba - 0.15) * retR, cy + Math.sin(rba - 0.15) * retR, 1.7, 0, TAU)
        ctx.arc(cx + Math.cos(rba + 0.15) * retR, cy + Math.sin(rba + 0.15) * retR, 1.7, 0, TAU)
        ctx.fill()
      }

      // ---- 轮廓环：给球体一条清晰的边 ----
      ctx.strokeStyle = rgba(mix(base, hi, 0.25), (0.05 + 0.09 * lit) * alphaScale * flick)
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, TAU)
      ctx.stroke()

      // ---- 水平扫描带 ----
      if (energy > 0.12) {
        var period = 7.5
        var phase = ((this.time % period) / period)
        var scanY = cy - R * 1.02 + phase * R * 2.04
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, R * 1.0, 0, TAU)
        ctx.clip()
        var band = 30
        var sg = ctx.createLinearGradient(0, scanY - band, 0, scanY + band)
        sg.addColorStop(0, rgba(base, 0))
        sg.addColorStop(0.5, rgba(base, (0.022 + 0.045 * lit) * alphaScale))
        sg.addColorStop(1, rgba(base, 0))
        ctx.fillStyle = sg
        ctx.fillRect(cx - R, scanY - band, R * 2, band * 2)
        ctx.strokeStyle = rgba(hi, (0.045 + 0.07 * lit) * alphaScale)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx - R, scanY)
        ctx.lineTo(cx + R, scanY)
        ctx.stroke()
        ctx.restore()
      }

      // ---- 中空内缘：一圈"事件视界" ----
      var holeR = R * (0.585 + 0.012 * Math.sin(this.time * 0.7))

      // ---- 挖空球心：保证正文可读 ----
      var hole = ctx.createRadialGradient(cx, cy, holeR * 0.25, cx, cy, holeR)
      hole.addColorStop(0, 'rgba(0,0,0,0.62)')
      hole.addColorStop(0.7, 'rgba(0,0,0,0.4)')
      hole.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = hole
      ctx.beginPath()
      ctx.arc(cx, cy, holeR, 0, TAU)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'

      // ---- 事件视界虚线环（挖空之后再画，才不会被擦掉） ----
      ctx.setLineDash([7, 11])
      ctx.lineDashOffset = -this.time * 14
      ctx.strokeStyle = rgba(base, (0.10 + 0.12 * lit) * alphaScale)
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(cx, cy, holeR * 1.015, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])

      // ---- 泛光：四分之一分辨率亮部提取 + 模糊 + 加法合成 ----
      if (cfg.glow && FILTER_OK) {
        var bc = this.bloomCanvas
        var bx = this.bloomCtx
        if (bc.width > 1 && bc.height > 1) {
          bx.globalCompositeOperation = 'copy'
          bx.filter = 'brightness(0.75) contrast(2.6) blur(3px)'
          bx.drawImage(this.canvas, 0, 0, bc.width, bc.height)
          bx.filter = 'none'
          ctx.save()
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = 0.48 * Math.min(1, alphaScale * 1.2)
          ctx.drawImage(bc, 0, 0, this.canvas.width, this.canvas.height)
          ctx.restore()
        }
      }

      // ---- HUD（不过泛光，保证清晰） ----
      if (cfg.showHud && alphaScale > 0.15) {
        this.drawGauge(ctx, cx, cy, R, base, accent, hi, alphaScale)
        this.drawHud(ctx, cx, cy, R, base, accent, alphaScale)
      }
    }

    /** 球体底部的环形数据表：随模型输出速率变长变亮 */
    SphereEngine.prototype.drawGauge = function (ctx, cx, cy, R, base, accent, hi, alpha) {
      var s = this.state
      var rate = Math.min(1, s.streamRate / 16)
      var span = Math.PI * 0.62
      var start = Math.PI / 2 - span / 2
      var r = R * 1.02
      ctx.save()
      ctx.lineWidth = 3
      ctx.strokeStyle = rgba(base, 0.1 * alpha)
      ctx.beginPath()
      ctx.arc(cx, cy, r, start, start + span)
      ctx.stroke()
      if (rate > 0.01) {
        ctx.lineWidth = 3
        ctx.strokeStyle = rgba(s.running ? accent : base, 0.55 * alpha)
        ctx.beginPath()
        ctx.arc(cx, cy, r, start, start + span * rate)
        ctx.stroke()
        ctx.lineWidth = 1
        ctx.strokeStyle = rgba(hi, 0.5 * alpha)
        ctx.beginPath()
        ctx.arc(cx, cy, r, start, start + span * rate)
        ctx.stroke()
      }
      ctx.restore()
    }

    SphereEngine.prototype.drawHud = function (ctx, cx, cy, R, base, accent, alpha) {
      var s = this.state
      var tools = Number(s.counters.tools) || 0
      var turns = Number(s.counters.turns) || 0
      var memory = this.memory && this.memory.ok ? this.memory : null
      var head = this.persona && this.persona.active ? 'JARVIS  ·  ' : ''
      head += s.running ? 'ACTIVE' : 'STANDBY'
      if (memory && memory.total > 0) head += '  ·  ' + memory.total + ' MEM'
      if (tools > 0) head += '  ·  ' + tools + ' TOOLS'
      if (turns > 0) head += '  ·  ' + turns + ' TURNS'
      var detail = s.activeTools.length ? String(s.activeTools[s.activeTools.length - 1]) : ''
      if (!detail && memory && memory.ok) {
        /* 没有工具在跑时，底下一行报记忆库存：用户画像 / 工作记忆 / 空间 / 文档 */
        var parts = []
        if (memory.user) parts.push(memory.user + ' USER')
        if (memory.memory) parts.push(memory.memory + ' WORKING')
        if (memory.spaces) parts.push(memory.spaces + ' SPACES')
        if (memory.documents) parts.push(memory.documents + ' DOCS')
        detail = parts.length ? 'MEMORY  ' + parts.join('  ·  ') : ''
      }

      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      var y = cy + R * 1.03 + 8
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      ctx.fillStyle = rgba(s.running ? accent : base, (this.dark ? 0.26 : 0.42) * alpha)
      ctx.fillText(head, cx, y)
      if (detail) {
        ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        ctx.fillStyle = rgba(base, (this.dark ? 0.18 : 0.36) * alpha)
        ctx.fillText(String(detail).toUpperCase().slice(0, 30), cx, y + 13)
      }
      ctx.restore()
    }

    /** 大圆插值：两个单位向量之间的最短弧 */
    function slerp(a, b, t) {
      var dot = a.x * b.x + a.y * b.y + a.z * b.z
      if (dot > 0.9995) {
        var mx = a.x + (b.x - a.x) * t
        var my = a.y + (b.y - a.y) * t
        var mz = a.z + (b.z - a.z) * t
        var ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1
        return { x: mx / ml, y: my / ml, z: mz / ml }
      }
      if (dot < -0.9995) dot = -0.9995
      var theta = Math.acos(dot) * t
      var rx = b.x - a.x * dot
      var ry = b.y - a.y * dot
      var rz = b.z - a.z * dot
      var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
      rx /= rl
      ry /= rl
      rz /= rl
      var c = Math.cos(theta)
      var sn = Math.sin(theta)
      return { x: a.x * c + rx * sn, y: a.y * c + ry * sn, z: a.z * c + rz * sn }
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
