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
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    var STATE_PATH = '/dsh-jarvis/state'
    /* 老版本实例可能占着主路径不放（Host 路由没随插件卸载释放），
       所以只认 build 够新的快照，主路径不达标时改投这个备用路径。 */
    var STATE_PATHS = ['/dsh-jarvis/state', '/dsh-jarvis/state-v2']
    var MIN_BUILD = 4
    var TAU = Math.PI * 2

    var CSS = [
      '.jvs-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;}',
      '.jvs-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;}',
      '.jvs-probe{position:absolute;width:0;height:0;opacity:0;pointer-events:none;}',
      /* 沉浸模式：把页面底色压暗、让面板半透明，球成为主视觉 */
      'html.jvs-immersive body{background:#05070c !important;}',
      'html.jvs-stage body{background:#05070c !important;}',
      'html.jvs-stage .jvs-hud{pointer-events:none;}',
      'html.jvs-stage [data-jvs-chat]{position:fixed !important;top:60px !important;right:16px !important;bottom:16px !important;left:auto !important;width:min(46vw,760px) !important;height:auto !important;z-index:40 !important;border-radius:16px;border:1px solid rgba(120,200,255,0.22);background:rgba(6,9,16,0.88);box-shadow:0 24px 60px rgba(0,0,0,0.55);backdrop-filter:blur(10px);overflow-y:auto !important;}',
      'html.jvs-stage [data-jvs-chat] *{max-width:100%;}',
      'html.jvs-stage [data-jvs-side]{opacity:0.62;transition:opacity 200ms ease;}',
      'html.jvs-stage [data-jvs-side]:hover{opacity:1;}',
      'html.jvs-ball,html.jvs-ball body{background:transparent !important;}',
      'html.jvs-ball body *{visibility:hidden !important;}',
      'html.jvs-ball canvas,html.jvs-ball canvas *{visibility:visible !important;}',
      'html.jvs-ball [data-jvs-chat],html.jvs-ball [data-jvs-chat] *{visibility:visible !important;}',
      'html.jvs-ball [data-jvs-open],html.jvs-ball [data-jvs-open] *{visibility:visible !important;}',
      'html.jvs-ball .jvs-mode-pill,html.jvs-ball .jvs-drawer-btn,html.jvs-ball .jvs-dock-btn,html.jvs-ball .jvs-drag{visibility:visible !important;}',
      'html.jvs-ball [data-jvs-chat]{background:rgba(6,9,16,0.96) !important;left:0 !important;right:0 !important;bottom:0 !important;top:auto !important;width:100% !important;max-width:none !important;height:300px !important;transform:none !important;border-radius:0 !important;border-left:none !important;border-right:none !important;border-bottom:none !important;overflow-y:auto !important;}',
      'html.jvs-ball [data-jvs-side],html.jvs-ball [data-jvs-rail]{border-radius:14px;}',
      'html.jvs-ball .jvs-mode-pill{top:28px;left:50%;right:auto;transform:translateX(-50%);}',
      'html.jvs-ball .jvs-drawer-btn.jvs-left{left:6px;top:44%;}',
      'html.jvs-ball .jvs-drawer-btn.jvs-right{right:6px;top:44%;}',
      'html.jvs-ball .jvs-dock-btn{bottom:26px;}',
      '.jvs-drag{position:fixed;top:0;left:50%;transform:translateX(-50%);width:min(52%,420px);height:20px;z-index:2147483001;-webkit-app-region:drag;display:none;cursor:move;}',
      'html.jvs-ball .jvs-drag{display:block;}',
      'html.jvs-ball [data-jvs-chat]{border-radius:16px;bottom:64px;}',
      'html.jvs-full [data-jvs-side]{position:fixed !important;left:0;top:0;bottom:0;width:min(22vw,300px) !important;height:auto !important;z-index:70;background:rgba(5,8,14,0.97);border-right:1px solid rgba(120,200,255,0.15);transform:translateX(-101%);transition:transform 180ms ease;overflow-y:auto !important;}',
      'html.jvs-full [data-jvs-side][data-jvs-open]{transform:none;}',
      'html.jvs-full [data-jvs-rail]{position:fixed !important;right:0;top:0;bottom:0;left:auto !important;width:min(24vw,340px) !important;max-height:none !important;height:auto !important;z-index:70;background:rgba(5,8,14,0.97);border-left:1px solid rgba(120,200,255,0.15);transform:translateX(101%);transition:transform 180ms ease;overflow-y:auto !important;border-radius:0;box-shadow:none;}',
      'html.jvs-full [data-jvs-rail][data-jvs-open]{transform:none;}',
      'html.jvs-full [data-jvs-chat]{position:fixed !important;left:50% !important;transform:translate(-50%,115%) !important;bottom:0 !important;top:auto !important;width:min(1040px,96vw) !important;height:min(46vh,520px) !important;z-index:40 !important;border-radius:18px 18px 0 0;border:1px solid rgba(120,200,255,0.22);border-bottom:none;background:rgba(6,9,16,0.94);box-shadow:0 -18px 60px rgba(0,0,0,0.6);backdrop-filter:blur(12px);overflow-y:auto !important;transition:transform 200ms ease;}',
      'html.jvs-full [data-jvs-chat][data-jvs-open]{transform:translate(-50%,0) !important;}',
      '.jvs-drawer-btn{position:fixed;top:50%;transform:translateY(-50%);z-index:80;width:26px;height:54px;border-radius:8px;border:1px solid rgba(120,200,255,0.25);background:rgba(6,10,18,0.85);color:#8fd3ff;font:14px ui-monospace,monospace;cursor:pointer;pointer-events:auto;display:none;}',
      'html.jvs-full .jvs-drawer-btn{display:block;}',
      '.jvs-drawer-btn.jvs-left{left:0;border-radius:0 8px 8px 0;}',
      '.jvs-drawer-btn.jvs-right{right:0;border-radius:8px 0 0 8px;}',
      '.jvs-dock-btn{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:80;padding:5px 14px;border-radius:999px;border:1px solid rgba(120,200,255,0.3);background:rgba(6,10,18,0.9);color:#8fd3ff;font:12px ui-monospace,monospace;cursor:pointer;pointer-events:auto;display:none;letter-spacing:0.08em;}',
      'html.jvs-full .jvs-dock-btn{display:block;}',
      '.jvs-win{position:fixed;top:6px;right:10px;z-index:2147483002;display:flex;gap:6px;pointer-events:auto;}',
      '.jvs-win button{width:26px;height:22px;border-radius:6px;border:1px solid rgba(120,200,255,0.28);background:rgba(6,10,18,0.85);color:#8fd3ff;font:12px ui-monospace,monospace;cursor:pointer;line-height:1;}',
      '.jvs-win button:hover{border-color:rgba(140,220,255,0.7);}',
      '.jvs-mode-pill{position:fixed;top:58px;right:16px;z-index:2147483000;padding:4px 10px;border-radius:999px;border:1px solid rgba(120,200,255,0.28);background:rgba(6,10,18,0.88);color:#8fd3ff;font:11px ui-monospace,monospace;cursor:pointer;pointer-events:auto;}',
      'html.jvs-stage [data-jvs-rail]{position:fixed !important;left:16px !important;bottom:16px !important;top:auto !important;right:auto !important;width:min(24vw,300px) !important;max-height:32vh !important;height:auto !important;z-index:41 !important;border-radius:14px;border:1px solid rgba(120,200,255,0.18);background:rgba(6,9,16,0.9);box-shadow:0 18px 40px rgba(0,0,0,0.5);overflow:auto !important;backdrop-filter:blur(10px);}',
      'html.jvs-immersive [data-jvs-panel]{background-color:rgba(6,9,16,0.55) !important;backdrop-filter:blur(3px) saturate(110%);-webkit-backdrop-filter:blur(3px) saturate(110%);border-radius:10px;}',
      'html.jvs-immersive textarea,html.jvs-immersive [contenteditable="true"]{background-color:rgba(6,9,16,0.45) !important;}',
      '.jvs-panel{position:absolute;z-index:2147483000;min-width:260px;max-width:380px;max-height:60vh;overflow:auto;pointer-events:auto;padding:10px 12px;border-radius:10px;border:1px solid rgba(120,200,255,0.25);background:rgba(6,10,18,0.92);color:#cfe8ff;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 10px 30px rgba(0,0,0,0.45);backdrop-filter:blur(6px);}'.replace('}','}'),
      '.jvs-panel h4{margin:0 0 6px;font-size:12px;letter-spacing:0.08em;color:#8fd3ff;display:flex;justify-content:space-between;align-items:center;}',
      '.jvs-panel .jvs-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 8px;}',
      '.jvs-panel .jvs-tabs button{pointer-events:auto;cursor:pointer;font:11px ui-monospace,monospace;color:#9fd8ff;background:rgba(120,200,255,0.08);border:1px solid rgba(120,200,255,0.25);border-radius:6px;padding:2px 6px;}',
      '.jvs-panel .jvs-close{pointer-events:auto;cursor:pointer;background:none;border:none;color:#8fd3ff;font-size:14px;line-height:1;}',
      '.jvs-panel .jvs-row{display:flex;gap:8px;padding:2px 0;border-bottom:1px dashed rgba(120,200,255,0.12);}',
      '.jvs-panel .jvs-row b{flex:0 0 auto;color:#7fb6d8;font-weight:500;}',
      '.jvs-panel .jvs-row span{flex:1 1 auto;word-break:break-all;}',
    ].join('')

    /* 调色板：深色主题发光，浅色主题换深青配合 multiply */
    var BALL_SPHERE = 860
    var BALL_HEIGHT = 1180
    var BALL_DOCK = 300

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
        showHud: true, glow: true, color: 'cyan', offsetX: 0, offsetY: 0, gauge: 'glow', stage: false, full: false,
      }
      this.lastTools = -1
      this.dark = true
      this.blend = 'screen'

      /* 记忆投影与人格标记：都由 Host 的快照驱动 */
      this.memory = null
      this.persona = null
      this.health = null
      this.chronicle = null
      this.alerts = null
      this.pulses = []
      this.lastPulse = 0
      this.memoryRef = null
      this.memorySlotsCache = null
      this.memoryBornAt = 0

      this.immersive = false
      this.onKey = null
      this.panel = null
      this.onClick = null
      this.onKeyDown = null
      this.root = this.host
      /* controls created by an earlier engine instance keep their old closures:
         remove every one of them before this instance creates its own. */
      var staleControls = document.querySelectorAll('.jvs-drawer-btn,.jvs-dock-btn,.jvs-mode-pill,.jvs-mode-exit,.jvs-drag')
      for (var staleIndex = 0; staleIndex < staleControls.length; staleIndex += 1) {
        if (staleControls[staleIndex].parentNode) staleControls[staleIndex].parentNode.removeChild(staleControls[staleIndex])
      }
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
      this.bindKeys()
      this.ensureModePill()
      this.ensureWinControls()
      this.bindPanel()
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
      if (this.onKey) window.removeEventListener('keydown', this.onKey, true)
      this.unbindPanel()
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



    /** Deterministic surface point for one pulse, so a repeated id lands twice. */
    SphereEngine.prototype.pulsePoint = function (seq) {
      var n = Math.abs(Math.floor(seq)) || 1
      var u = ((n * 2654435761) % 1000) / 1000
      var v = ((n * 40503) % 1000) / 1000
      var theta = u * Math.PI * 2
      var phi = Math.acos(2 * v - 1)
      return { x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) }
    }

    /** Keep only fresh ripples: the trail should read as "recent", not history. */
    SphereEngine.prototype.adoptPulses = function (list) {
      var now = Date.now()
      var newest = this.lastPulse || 0
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i]
        if (!item || typeof item.s !== 'number' || item.s <= (this.lastPulse || 0)) continue
        if (item.s > newest) newest = item.s
        this.pulses.push({ s: item.s, k: String(item.k || 'tool'), at: Number(item.t) || now, p: this.pulsePoint(item.s) })
      }
      this.lastPulse = newest
      var cutoff = now - 30000
      var kept = []
      for (var j = 0; j < this.pulses.length; j += 1) {
        if (this.pulses[j].at >= cutoff) kept.push(this.pulses[j])
      }
      this.pulses = kept
      if (this.pulses.length > 24) this.pulses.splice(0, this.pulses.length - 24)
    }

    /** Draw the trail: expanding rings on the sphere, fading over ~30 s. */
    SphereEngine.prototype.drawPulses = function (ctx, project, R, alpha, cx, cy) {
      if (!this.pulses || !this.pulses.length) return
      var now = Date.now()
      var saved = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      for (var i = 0; i < this.pulses.length; i += 1) {
        var pulse = this.pulses[i]
        var age = (now - pulse.at) / 30000
        if (age < 0 || age > 1) continue
        var point = project(pulse.p.x, pulse.p.y, pulse.p.z * 0.6)
        if (typeof cx === 'number' && typeof cy === 'number') {
          var ddx = point[0] - cx
          var ddy = point[1] - cy
          var dist = Math.sqrt(ddx * ddx + ddy * ddy)
          var floorR = R * 0.62
          if (dist > 0.001 && dist < floorR) {
            var push = floorR / dist
            point[0] = cx + ddx * push
            point[1] = cy + ddy * push
          }
        }
        var fade = 1 - age
        var tint = pulse.k === 'error' ? (this.alert || { r: 255, g: 120, b: 120 }) : (this.palette && this.palette.violet) || { r: 120, g: 200, b: 255 }
        var grow = 0.35 + age * 2.2
        var radius = R * 0.055 * grow
        ctx.lineWidth = Math.max(0.8, 1.6 * fade)
        ctx.strokeStyle = rgba(tint, (pulse.k === 'error' ? 0.62 : 0.46) * fade * alpha)
        ctx.beginPath()
        ctx.arc(point[0], point[1], radius, 0, TAU)
        ctx.stroke()
        ctx.fillStyle = rgba(tint, (pulse.k === 'error' ? 0.35 : 0.2) * fade * alpha)
        ctx.beginPath()
        ctx.arc(point[0], point[1], Math.max(0.8, R * 0.008 * fade), 0, TAU)
        ctx.fill()
      }
      ctx.globalCompositeOperation = saved
    }

    /** Screen-space sphere geometry, mirroring draw()'s centre and radius. */
    SphereEngine.prototype.sphereGeometry = function () {
      var w = this.w || window.innerWidth
      var hgt = this.h || window.innerHeight
      var cfg = this.cfg || {}
      var cx = w / 2 + (Number(cfg.offsetX) || 0)
      var cy = hgt / 2 + (Number(cfg.offsetY) || 0)
      var fullGeo = this.fullGeometry ? this.fullGeometry() : null
      if (fullGeo) return fullGeo
      var stageGeo = this.stageGeometry ? this.stageGeometry() : null
      if (stageGeo) return stageGeo
      var fullGeo = this.fullGeometry ? this.fullGeometry() : null
      var stageGeo = fullGeo || (this.stageGeometry ? this.stageGeometry() : null)
      var R = stageGeo ? stageGeo.R : Math.min(w, hgt) * (this.immersive ? 0.46 : 0.315)
      if (stageGeo) {
        cx = stageGeo.cx
        cy = stageGeo.cy
      }
      return { cx: cx, cy: cy, R: R }
    }

    /** Close the detail panel if it is open. */
    SphereEngine.prototype.closePanel = function () {
      if (this.panel && this.panel.parentNode) this.panel.parentNode.removeChild(this.panel)
      this.panel = null
      this.panelAnchor = null
    }

    /** Fetch one detail kind and render it into the panel. */
    SphereEngine.prototype.loadPanel = function (kind, anchor) {
      var self = this
      var host = this.root
      if (!host) return
      if (!this.panel) {
        var panel = document.createElement('div')
        panel.className = 'jvs-panel'
        panel.setAttribute('role', 'dialog')
        panel.setAttribute('aria-label', 'JARVIS 详情')
        panel.addEventListener('click', function (event) { event.stopPropagation() })
        /* mounted on body: the overlay root is aria-hidden and clips overflow */
        document.body.appendChild(panel)
        this.panel = panel
      }
      var panelEl = this.panel
      if (anchor) {
        var maxLeft = Math.max(8, (window.innerWidth || 0) - 400)
        panelEl.style.left = Math.min(Math.max(8, anchor.x + 12), maxLeft) + 'px'
        panelEl.style.top = Math.min(Math.max(8, anchor.y + 12), Math.max(8, (window.innerHeight || 0) - 120)) + 'px'
        this.panelAnchor = { x: anchor.x, y: anchor.y }
      }
      var tabs = ['overview', 'memory', 'alerts', 'recap', 'backup', 'doctor', 'chronicle']
      var labels = { overview: '状态', memory: '记忆', alerts: '提醒', recap: '待复盘', backup: '备份', doctor: '自检', chronicle: '编年史' }
      panelEl.innerHTML = '<h4><span>JARVIS</span><button class="jvs-close" aria-label="关闭">×</button></h4>'
      var closeBtn = panelEl.querySelector('.jvs-close')
      if (closeBtn) closeBtn.onclick = function () { self.closePanel() }
      var tabRow = document.createElement('div')
      tabRow.className = 'jvs-tabs'
      for (var i = 0; i < tabs.length; i++) {
        ;(function (name) {
          var button = document.createElement('button')
          button.type = 'button'
          button.textContent = labels[name]
          if (name === kind) button.style.borderColor = 'rgba(140,220,255,0.8)'
          button.onclick = function () { self.loadPanel(name, null) }
          tabRow.appendChild(button)
        })(tabs[i])
      }
      panelEl.appendChild(tabRow)
      var body = document.createElement('div')
      body.textContent = '读取中…'
      panelEl.appendChild(body)
      fetch('/dsh-jarvis/detail?kind=' + encodeURIComponent(kind), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
          if (!response || !response.ok) throw new Error('HTTP ' + String((response && response.status) || 0))
          return response.json()
        })
        .then(function (data) {
          if (!self.panel || self.panel !== panelEl) return
          body.textContent = ''
          if (!data || data.ok === false) {
            body.textContent = '读取失败：' + String((data && (data.error || data.reason)) || 'unknown')
            return
          }
          for (var j = 0; j < (data.items || []).length; j++) {
            var row = document.createElement('div')
            row.className = 'jvs-row'
            var key = document.createElement('b')
            key.textContent = data.items[j].label
            var value = document.createElement('span')
            value.textContent = data.items[j].value
            row.appendChild(key)
            row.appendChild(value)
            body.appendChild(row)
          }
          if (!(data.items || []).length) body.textContent = '（无内容）'
          self.fitPanel(panelEl)
        })
        .catch(function (err) {
          if (self.panel === panelEl) body.textContent = '读取失败：' + String(err && err.message)
        })
    }


    /** Keep the panel fully visible, flipping above the anchor when needed. */
    SphereEngine.prototype.fitPanel = function (panelEl) {
      if (!panelEl) return
      var viewport = window.innerHeight || 800
      var height = panelEl.offsetHeight || 0
      var top = parseFloat(panelEl.style.top) || 8
      if (top + height > viewport - 8) {
        var anchorPoint = this.panelAnchor || { y: top - 12 }
        var above = anchorPoint.y - height - 12
        top = above >= 8 ? above : Math.max(8, viewport - height - 8)
        panelEl.style.top = top + 'px'
      }
      panelEl.style.maxHeight = Math.max(120, viewport - top - 8) + 'px'
    }

    /** Click inside the sphere opens the panel; clicks elsewhere are ignored. */
    SphereEngine.prototype.bindPanel = function () {
      var self = this
      if (this.onClick) return
      this.onClick = function (event) {
        if (self.panel) {
          if (self.panel.contains(event.target)) return
          self.closePanel()
          return
        }
        /* never steal a click that belongs to the page: selecting text, pressing
           a button, focusing the composer or following a link stays untouched */
        if (!self.cfg || !self.cfg.enabled || Number(self.cfg.opacity) <= 0.001) return
        /* in the full stage a click dismisses an open drawer before opening the panel */
        var openedDrawer = document.querySelector('[data-jvs-open]')
        if (openedDrawer && self.full) {
          openedDrawer.removeAttribute('data-jvs-open')
          return
        }
        var selection = ''
        try {
          selection = String((window.getSelection() || {}).toString() || '')
        } catch (err) {
          selection = ''
        }
        if (selection) return
        var target = event.target
        if (target && target.closest && target.closest('button,a,input,textarea,select,[contenteditable="true"],[role="button"]')) return
        var geo = self.sphereGeometry()
        var dx = event.clientX - geo.cx
        var dy = event.clientY - geo.cy
        if (dx * dx + dy * dy > geo.R * geo.R) return
        self.loadPanel('overview', { x: event.clientX, y: event.clientY })
      }
      this.onKeyDown = function (event) {
        if (event && event.key === 'Escape') self.closePanel()
      }
      window.addEventListener('click', this.onClick, true)
      window.addEventListener('keydown', this.onKeyDown, true)
    }

    /** Detach the panel listeners. */
    SphereEngine.prototype.unbindPanel = function () {
      if (this.onClick) window.removeEventListener('click', this.onClick, true)
      if (this.onKeyDown) window.removeEventListener('keydown', this.onKeyDown, true)
      this.onClick = null
      this.onKeyDown = null
      this.closePanel()
    }

    /** 沉浸模式：球占满视口，把对话面板改成半透明，一键可还原。 */
    SphereEngine.prototype.setImmersive = function (on) {
      this.immersive = !!on
      try {
        document.documentElement.classList.toggle('jvs-immersive', this.immersive)
        window.localStorage.setItem('jarvis:immersive', this.immersive ? '1' : '0')
      } catch (err) {
        void err
      }
      if (this.immersive) this.tagPanels()
      this.ensureModePill()
      this.onResize()
    }

    /** 从输入框往上找几层容器，标成半透明面板（不依赖类名）。 */
    SphereEngine.prototype.tagPanels = function () {
      var doc = document
      var marked = doc.querySelectorAll('[data-jvs-panel]')
      for (var i = 0; i < marked.length; i += 1) marked[i].removeAttribute('data-jvs-panel')
      var seed = doc.querySelector('textarea') || doc.querySelector('[role="main"]') || doc.querySelector('main')
      if (!seed) return
      var node = seed
      for (var depth = 0; depth < 5 && node && node !== doc.body; depth += 1) {
        try {
          node.setAttribute('data-jvs-panel', '1')
        } catch (err) {
          void err
        }
        node = node.parentElement
      }
      var main = doc.querySelector('[role="main"]')
      if (main) main.setAttribute('data-jvs-panel', '1')
    }


    /** Find the chat column: the first tall, wide ancestor of the composer. */
    SphereEngine.prototype.chatColumn = function () {
      var seed = document.querySelector('textarea') || document.querySelector('[role="main"]')
      var node = seed
      var best = null
      while (node && node !== document.body) {
        try {
          var rect = node.getBoundingClientRect()
          if (rect && rect.height > window.innerHeight * 0.5 && rect.width > window.innerWidth * 0.4) {
            best = { node: node, width: rect.width }
          }
        } catch (err) {
          void err
        }
        node = node.parentElement
      }
      return best
    }

    /** Stage (档 2): the sphere owns the centre, the conversation floats beside it. */
    SphereEngine.prototype.setStage = function (on) {
      this.stage = !!on
      try {
        document.documentElement.classList.toggle('jvs-stage', this.stage)
        window.localStorage.setItem('jarvis:stage', this.stage ? '1' : '0')
      } catch (err) {
        void err
      }
      if (this.stage) this.liftChatCard()
      else this.restoreChatCard()
      this.onResize()
    }





    /** Minimise/close buttons and a drag strip: the window has no title bar. */
    SphereEngine.prototype.ensureWinControls = function () {
      var self = this
      if (!document.querySelector('.jvs-win')) {
        var box = document.createElement('div')
        box.className = 'jvs-win'
        var min = document.createElement('button')
        min.type = 'button'
        min.textContent = '—'
        min.setAttribute('aria-label', '最小化')
        min.onclick = function (event) {
          event.stopPropagation()
          self.postShape('min')
        }
        var close = document.createElement('button')
        close.type = 'button'
        close.textContent = '×'
        close.setAttribute('aria-label', '关闭')
        close.onclick = function (event) {
          event.stopPropagation()
          self.postShape('close')
        }
        box.appendChild(min)
        box.appendChild(close)
        document.body.appendChild(box)
      }
      if (!document.querySelector('.jvs-drag')) {
        var drag = document.createElement('div')
        drag.className = 'jvs-drag'
        drag.setAttribute('aria-hidden', 'true')
        document.body.appendChild(drag)
      }
    }

    SphereEngine.prototype.postShape = function (mode) {
      try {
        fetch('/dsh-jarvis/shape', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: mode }),
          credentials: 'same-origin',
        }).catch(function () {})
      } catch (err) {
        void err
      }
    }

    /** Ball mode: the desktop window is transparent, only the sphere is painted. */
    SphereEngine.prototype.setBall = function (on) {
      var self = this
      this.ball = !!on
      try {
        document.documentElement.classList.toggle('jvs-ball', this.ball)
        window.localStorage.setItem('jarvis:ball', this.ball ? '1' : '0')
      } catch (err) {
        void err
      }
      if (this.ball) {
        try {
          this.setFull(true)
          var chatOpen = document.querySelector('[data-jvs-chat]')
          if (chatOpen) chatOpen.setAttribute('data-jvs-open', '1')
          this.ensureWinControls()
        } catch (layoutErr) {
          this.reportLayout('ball layout failed: ' + String(layoutErr && layoutErr.message), 'error', [])
        }
      } else {
        var dragNode = document.querySelector('.jvs-drag')
        if (dragNode && dragNode.parentNode) dragNode.parentNode.removeChild(dragNode)
      }
      this.ensureModePill()
      try {
        fetch('/dsh-jarvis/shape', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: this.ball ? 'ball' : 'rect' }),
          credentials: 'same-origin',
        }).then(function (response) {
          return response.json()
        }).then(function (data) {
          self.reportLayout('shape ' + (data && data.ok ? 'ok' : 'failed') + ' ' + JSON.stringify(data).slice(0, 160), 'shape', [])
        }).catch(function (err) {
          self.reportLayout('shape fetch failed: ' + String(err && err.message), 'shape', [])
        })
      } catch (err) {
        void err
      }
      this.onResize()
    }

    /** One pill that always offers the other mode, in either mode. */
    SphereEngine.prototype.ensureModePill = function () {
      var self = this
      var pill = document.querySelector('.jvs-mode-pill')
      if (!pill) {
        pill = document.createElement('button')
        pill.type = 'button'
        pill.className = 'jvs-mode-pill'
        pill.onclick = function (event) {
          event.stopPropagation()
          if (self.ball) {
            self.setBall(false)
            self.setFull(false)
            self.setStage(false)
          } else {
            self.setStage(false)
            self.setBall(true)
          }
        }
        document.body.appendChild(pill)
      }
      pill.textContent = this.ball ? '原版模式' : '球模式'
      pill.setAttribute('aria-label', this.ball ? '切回原版客户端' : '把客户端变成球')
    }

    /** Full (档 3): the sphere is the whole screen, the conversation docks below. */
    SphereEngine.prototype.setFull = function (on) {
      this.full = !!on
      try {
        document.documentElement.classList.toggle('jvs-full', this.full)
        window.localStorage.setItem('jarvis:full', this.full ? '1' : '0')
      } catch (err) {
        void err
      }
      if (this.full) {
        if (!this.stage) this.liftChatCard()
        this.ensureDrawers()
        var open = document.querySelectorAll('[data-jvs-open]')
        for (var i = 0; i < open.length; i += 1) open[i].removeAttribute('data-jvs-open')
      } else {
        this.removeDrawers()
        if (!this.stage) this.restoreChatCard()
      }
      this.ensureModePill()
      this.onResize()
    }

    /** The two edge buttons and the collapse button exist only while full is on. */
    SphereEngine.prototype.ensureDrawers = function () {
      var self = this
      if (!document.querySelector('.jvs-drawer-btn.jvs-left')) {
        var left = document.createElement('button')
        left.type = 'button'
        left.className = 'jvs-drawer-btn jvs-left'
        left.setAttribute('aria-label', '会话列表')
        left.textContent = '☰'
        left.onclick = function (event) {
          event.stopPropagation()
          var side = document.querySelector('[data-jvs-side]')
          if (!side) return
          if (side.hasAttribute('data-jvs-open')) side.removeAttribute('data-jvs-open')
          else side.setAttribute('data-jvs-open', '1')
        }
        document.body.appendChild(left)
      }
      if (!document.querySelector('.jvs-drawer-btn.jvs-right')) {
        var right = document.createElement('button')
        right.type = 'button'
        right.className = 'jvs-drawer-btn jvs-right'
        right.setAttribute('aria-label', '侧边面板')
        right.textContent = '▤'
        right.onclick = function (event) {
          event.stopPropagation()
          var rail = document.querySelector('[data-jvs-rail]')
          if (!rail) return
          if (rail.hasAttribute('data-jvs-open')) rail.removeAttribute('data-jvs-open')
          else rail.setAttribute('data-jvs-open', '1')
        }
        document.body.appendChild(right)
      }
      if (!document.querySelector('.jvs-dock-btn')) {
        var dock = document.createElement('button')
        dock.type = 'button'
        dock.className = 'jvs-dock-btn'
        dock.textContent = '对话'
        dock.setAttribute('aria-label', '打开对话抽屉')
        dock.onclick = function (event) {
          event.stopPropagation()
          var chat = document.querySelector('[data-jvs-chat]')
          if (!chat) return
          if (chat.hasAttribute('data-jvs-open')) chat.removeAttribute('data-jvs-open')
          else chat.setAttribute('data-jvs-open', '1')
        }
        document.body.appendChild(dock)
      }
      if (!document.querySelector('.jvs-mode-exit')) {
        var exit = document.createElement('button')
        exit.type = 'button'
        exit.className = 'jvs-mode-exit'
        exit.textContent = '原版模式'
        exit.onclick = function (event) {
          event.stopPropagation()
          self.setFull(false)
          self.setStage(false)
        }
        document.body.appendChild(exit)
      }
      this.markRegions()
      if (!this.drawerClick) {
        this.drawerClick = function (event) {
          if (!self.full) return
          var target = event.target
          if (target && target.closest && (target.closest('[data-jvs-open]') || target.closest('.jvs-drawer-btn'))) return
          var opened = document.querySelectorAll('[data-jvs-open]')
          for (var i = 0; i < opened.length; i += 1) opened[i].removeAttribute('data-jvs-open')
        }
        window.addEventListener('click', this.drawerClick, true)
      }
    }

    SphereEngine.prototype.markRegions = function () {
      var frame = null
      var rail = document.querySelector('[data-rightbar-col]')
      if (rail) frame = rail.parentElement
      if (frame && frame.children) {
        for (var i = 0; i < frame.children.length; i += 1) {
          var child = frame.children[i]
          if (child.hasAttribute('data-rightbar-col')) child.setAttribute('data-jvs-rail', '1')
        }
      }
      var chat = this.chatRegion || (this.findChatRegion() || {}).node
      if (chat) chat.setAttribute('data-jvs-chat', '1')
      var side = this.sideRegion
      if (!side && frame && frame.children && frame.children.length) {
        for (var j = 0; j < frame.children.length; j += 1) {
          var candidate = frame.children[j]
          var rect = candidate.getBoundingClientRect()
          if (rect.width > 100 && rect.width < window.innerWidth * 0.4 && rect.height > window.innerHeight * 0.5
            && !candidate.hasAttribute('data-jvs-chat') && !candidate.hasAttribute('data-jvs-rail')) {
            side = candidate
            break
          }
        }
      }
      if (side) side.setAttribute('data-jvs-side', '1')
    }

    SphereEngine.prototype.removeDrawers = function () {
      if (this.drawerClick) {
        window.removeEventListener('click', this.drawerClick, true)
        this.drawerClick = null
      }
      var names = ['.jvs-drawer-btn', '.jvs-dock-btn', '.jvs-mode-exit']
      for (var i = 0; i < names.length; i += 1) {
        var nodes = document.querySelectorAll(names[i])
        for (var j = 0; j < nodes.length; j += 1) {
          if (nodes[j].parentNode) nodes[j].parentNode.removeChild(nodes[j])
        }
      }
      var opened = document.querySelectorAll('[data-jvs-open]')
      for (var k = 0; k < opened.length; k += 1) opened[k].removeAttribute('data-jvs-open')
      var collapsed = document.querySelectorAll('[data-jvs-collapsed]')
      for (var m = 0; m < collapsed.length; m += 1) collapsed[m].removeAttribute('data-jvs-collapsed')
    }

    SphereEngine.prototype.fullGeometry = function () {
      if (!this.full) return null
      var w = this.w || window.innerWidth
      var hgt = this.h || window.innerHeight
      if (this.ball) {
        /* the window region is a full-width circle followed by the dock strip */
        var side = Math.min(w, BALL_SPHERE)
        return { cx: side / 2, cy: side / 2, R: side / 2 - 6 }
      }
      var radius = Math.min(w, hgt) * 0.40
      var cy = Math.min(hgt - radius - 12, Math.max(radius + 12, hgt * 0.40))
      return { cx: w * 0.5, cy: cy, R: radius }
    }
    /** Pick the conversation column: a tall, wide ancestor with a tall sibling. */
    SphereEngine.prototype.findChatRegion = function () {
      var w = window.innerWidth
      var hgt = window.innerHeight
      var seed = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
      /* The layout frame is a row: sidebar / center / rightbar. The right sidebar
         carries a stable data attribute, so the center column is the sibling of it
         that contains the composer. This survives hashed class names. */
      var rail = document.querySelector('[data-rightbar-col]')
      var frame = rail && rail.parentElement
      if (!frame) {
        var probeFrame = document.querySelector('textarea')
        while (probeFrame && probeFrame.parentElement && probeFrame.parentElement !== document.body) probeFrame = probeFrame.parentElement
        frame = probeFrame
      }
      if (frame && frame.children && frame.children.length > 1) {
        for (var fi = 0; fi < frame.children.length; fi += 1) {
          var child = frame.children[fi]
          var cr2 = child.getBoundingClientRect()
          if (cr2.width > 100 && cr2.width < w * 0.4 && cr2.height > hgt * 0.5) {
            this.sideWidth = cr2.width
            child.setAttribute('data-jvs-side', '1')
            this.sideRegion = child
            break
          }
        }
      }
      if (frame && seed) {
        var walk = seed
        while (walk && walk.parentElement && walk.parentElement !== frame) walk = walk.parentElement
        if (walk && walk !== frame && frame.contains(walk)) {
          return { node: walk, chain: [], reason: 'center column (frame sibling)' }
        }
      }
      var node = seed
      var fallback = null
      var chain = []
      while (node && node !== document.body) {
        var rect = node.getBoundingClientRect()
        var tag = String(node.tagName || '').toLowerCase()
        var cls = typeof node.className === 'string' ? node.className.split(/\s+/)[0] : ''
        if (chain.length < 8) chain.push(tag + (cls ? '.' + cls : '') + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height))
        if (rect.width > w * 0.45 && rect.height > hgt * 0.5) {
          var parent = node.parentElement
          var side = false
          if (parent) {
            for (var i = 0; i < parent.children.length; i += 1) {
              var child = parent.children[i]
              if (child === node) continue
              var cr = child.getBoundingClientRect()
              if (cr.width > 80 && cr.width < w * 0.45 && cr.height > hgt * 0.4) { side = true; break }
            }
          }
          if (side) return { node: node, chain: chain, reason: 'tall sibling' }
          if (node.parentElement !== document.body) fallback = { node: node, chain: chain, reason: 'widest tall ancestor' }
        }
        node = node.parentElement
      }
      if (fallback) return fallback
      /* fallbacks that do not depend on siblings */
      var landmark = document.querySelector('[role="main"]')
      if (landmark && landmark.parentElement !== document.body) {
        return { node: landmark, chain: chain, reason: 'role=main fallback' }
      }
      var probe = document.querySelector('textarea')
      while (probe && probe !== document.body) {
        var cls = typeof probe.className === 'string' ? probe.className : ''
        if (/main|chat|conversation/i.test(cls)) {
          return { node: probe, chain: chain, reason: 'class fallback' }
        }
        probe = probe.parentElement
      }
      return null
    }

    /** Report what the page measured, so the host can show it in the doctor. */
    SphereEngine.prototype.reportLayout = function (pick, mode, chain) {
      try {
        var body = JSON.stringify({
          pick: pick || '',
          mode: mode || '',
          size: (this.w || window.innerWidth) + 'x' + (this.h || window.innerHeight),
          chain: (chain || []).join('|'),
        })
        fetch('/dsh-jarvis/detail', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          credentials: 'same-origin',
        }).catch(function () {})
      } catch (err) {
        void err
      }
    }

    SphereEngine.prototype.liftChatCard = function () {
      var picked = this.findChatRegion()
      if (!picked) {
        this.reportLayout('', 'no candidate', [])
        return
      }
      var self = this
      this.chatRegion = picked.node
      picked.node.setAttribute('data-jvs-chat', '1')
      var rail = document.querySelector('[data-rightbar-col]')
      if (rail && !rail.contains(picked.node)) {
        this.railRegion = rail
        rail.setAttribute('data-jvs-rail', '1')
      }
      if (this.chatWatch) clearInterval(this.chatWatch)
      /* React re-renders can drop the attribute; re-mark it while the mode is on. */
      this.chatWatch = setInterval(function () {
        if (!self.stage) return
        if (!self.chatRegion || !self.chatRegion.isConnected) {
          var again = self.findChatRegion()
          if (again) self.chatRegion = again.node
          else return
        }
        if (!self.chatRegion.getAttribute('data-jvs-chat')) self.chatRegion.setAttribute('data-jvs-chat', '1')
        if (self.railRegion && self.railRegion.isConnected && !self.railRegion.getAttribute('data-jvs-rail')) {
          self.railRegion.setAttribute('data-jvs-rail', '1')
        }
      }, 800)
      this.reportLayout(
        picked.reason + ' · ' + String(picked.node.tagName || '').toLowerCase() + (typeof picked.node.className === 'string' && picked.node.className ? '.' + picked.node.className.split(/\s+/)[0] : ''),
        'lifted',
        picked.chain,
      )
    }

    SphereEngine.prototype.restoreChatCard = function () {
      if (this.chatWatch) {
        clearInterval(this.chatWatch)
        this.chatWatch = null
      }
      if (this.chatRegion) {
        try {
          this.chatRegion.removeAttribute('data-jvs-chat')
        } catch (err) {
          void err
        }
      }
      if (this.railRegion) {
        try {
          this.railRegion.removeAttribute('data-jvs-rail')
        } catch (err) {
          void err
        }
      }
      this.chatRegion = null
      this.railRegion = null
    }

    SphereEngine.prototype.stageGeometry = function () {
      var w = this.w || window.innerWidth
      var hgt = this.h || window.innerHeight
      if (!this.stage) return null
      var reserved = Math.min(Math.max(w * 0.46, 380), 780)
      var side = Number(this.sideWidth) || 0
      var free = Math.max(320, w - reserved - side)
      return { cx: side + free * 0.5, cy: hgt * 0.45, R: Math.min(free, hgt) * (this.immersive ? 0.40 : 0.34) }
    }
    /** Ctrl+Shift+J 切换沉浸模式；状态存 localStorage，刷新后保持。 */
    SphereEngine.prototype.bindKeys = function () {
      if (this.onKey) return
      var self = this
      this.onKey = function (event) {
        if (!event || !event.ctrlKey || !event.shiftKey) return
        var key = String(event.key || '').toLowerCase()
        if (key !== 'j' && key !== 'k' && key !== 'l') return
        event.preventDefault()
        if (key === 'j') self.setImmersive(!self.immersive)
        else if (key === 'k') self.setStage(!self.stage)
        else self.setFull(!self.full)
      }
      window.addEventListener('keydown', this.onKey, true)
      var saved = '0'
      try {
        saved = window.localStorage.getItem('jarvis:immersive') || '0'
      } catch (err) {
        saved = '0'
      }
      if (saved === '1') this.setImmersive(true)
      var savedStage = '0'
      try {
        savedStage = window.localStorage.getItem('jarvis:stage') || '0'
      } catch (err) {
        savedStage = '0'
      }
      if (savedStage === '1') this.setStage(true)
      var savedFull = '0'
      try {
        savedFull = window.localStorage.getItem('jarvis:full') || '0'
      } catch (err) {
        savedFull = '0'
      }
      var savedBall = '0'
      try {
        savedBall = window.localStorage.getItem('jarvis:ball') || '0'
      } catch (err) {
        savedBall = '0'
      }
      if (savedBall === '1') {
        this.setBall(true)
        return
      }
      if (savedFull === '1') {
        this.fullApplied = true
        this.setFull(true)
      } else if (savedFull === '0') {
        this.fullApplied = true
      }
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
      this.alert = dark ? { r: 255, g: 120, b: 120 } : { r: 170, g: 30, b: 30 }
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
      if (typeof cfg.gauge === 'string') this.cfg.gauge = cfg.gauge
      if (typeof cfg.stage === 'boolean' && cfg.stage !== !!this.stage) this.setStage(cfg.stage)
      if (typeof cfg.full === 'boolean' && !this.fullApplied) {
        this.fullApplied = true
        if (cfg.full !== !!this.full) this.setFull(cfg.full)
      }
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
      /* 记忆投影：条目自身永不离开 Host，这里只拿到聚类槽位/类型/重要度/年龄 */
      var nextMemory = data.memory && Array.isArray(data.memory.slots) ? data.memory : null
      var prevMemoryTotal = this.memory && this.memory.ok ? Number(this.memory.total) || 0 : 0
      this.memory = nextMemory
      this.persona = data.persona && typeof data.persona === 'object' ? data.persona : null
      /* 仪表：记忆容量压力 + 错误/子代理计数，球体用它决定"要不要提醒你" */
      this.health = data.health && typeof data.health === 'object' ? data.health : null
      this.chronicle = data.chronicle && typeof data.chronicle === 'object' ? data.chronicle : null
      this.diagnostics = data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : null
      this.alerts = data.alerts && typeof data.alerts === 'object' ? data.alerts : null
      this.adoptPulses(Array.isArray(data.pulses) ? data.pulses : [])
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

    /**
     * 一组记忆占一颗光点：Host 已按 hash 聚类，这里只把槽位映射到球面节点。
     * 条目再多也只是同一颗光点更亮，不会因为上限被截断。
     */
    SphereEngine.prototype.memorySlots = function (memory) {
      if (this.memoryRef === memory && this.memorySlotsCache) return this.memorySlotsCache
      var total = this.nodes.length || 1
      var list = Array.isArray(memory.slots) ? memory.slots : []
      var out = []
      for (var i = 0; i < list.length; i++) {
        var entry = list[i]
        if (!entry) continue
        var raw = Number(entry.s)
        if (!isFinite(raw)) continue
        var type =
          entry.t === 'user' ? 'user'
            : entry.t === 'space' ? 'space'
              : entry.t === 'mixed' ? 'mixed'
                : 'memory'
        out.push({
          idx: ((raw % total) + total) % total,
          t: type,
          i: Number(entry.i) || 0,
          a: Number(entry.a),
          f: !!entry.f,
          n: Math.max(1, Number(entry.n) || 1),
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

      /* ball mode: paint a soft dark orb so the sphere reads on the desktop,
         everything outside the circle stays transparent */
      if (this.ball) {
        var ballSide = Math.min(w, hgt)
        var ballR = ballSide / 2 - 6
        var orb = ctx.createRadialGradient(ballSide / 2, ballSide / 2, ballR * 0.2, ballSide / 2, ballSide / 2, ballR)
        orb.addColorStop(0, 'rgba(4,7,12,0.92)')
        orb.addColorStop(0.72, 'rgba(4,7,12,0.80)')
        orb.addColorStop(1, 'rgba(4,7,12,0)')
        ctx.fillStyle = orb
        ctx.beginPath()
        ctx.arc(ballSide / 2, ballSide / 2, ballR, 0, Math.PI * 2)
        ctx.fill()
      }

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
      var fullGeo = this.fullGeometry ? this.fullGeometry() : null
      var stageGeo = fullGeo || (this.stageGeometry ? this.stageGeometry() : null)
      var R = stageGeo ? stageGeo.R : Math.min(w, hgt) * (this.immersive ? 0.46 : 0.315)
      if (stageGeo) {
        cx = stageGeo.cx
        cy = stageGeo.cy
      }
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
      /* Memory fill lives in the dust itself: the fuller the store, the more
         the constellation of memories lights up. No extra ring needed. */
      var memFill = 0.7
      var memoryLevel = 0
      if (this.health) {
        var mv = Number(this.health.memoryRatio) || 0
        memoryLevel = mv < 0 ? 0 : mv > 1 ? 1 : mv
        memFill = 0.66 + 0.40 * memoryLevel
      }
      var nodeAlpha = (0.26 + 0.4 * lit) * alphaScale * memFill
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
          var radius = nodeSizeTier[si2] * (0.9 + 0.28 * (memFill - 0.66))
          for (var q2 = 0; q2 < bucket.length; q2++) {
            var id = bucket[q2]
            ctx.moveTo(px[id] + radius, py[id])
            ctx.arc(px[id], py[id], radius, 0, TAU)
          }
          ctx.fill()
        }
      }

      // ---- 记忆光点：一颗光点可能是一组记忆（Host 按 hash 聚类，永不上限截断） ----
      var memory = this.memory
      if (memory && memory.ok && Array.isArray(memory.slots) && memory.slots.length) {
        var slots = this.memorySlots(memory)
        var memPalette = {
          user: pal.amber || accent,
          /* 工作记忆是最多的一类：偏白的冷光，才不会和球壳的青线糊在一起 */
          memory: mix(pal.cyan || base, hi, 0.6),
          space: pal.violet || base,
          mixed: mix(pal.amber || accent, pal.cyan || base, 0.5),
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
          /* 抱团的光点更亮更大：n 条记忆挤在同一个槽里时，用对数放大读得出来 */
          var weight = Math.log(1 + ms.n) / Math.LN2
          var coreA = (0.34 + 0.62 * mDepth) * alphaScale * ageFade * Math.min(1.9, 1 + 0.22 * weight)
          if (coreA < 0.012) continue
          var mx = px[mIdx]
          var my = py[mIdx]
          var breath = ms.f || born > 0 ? Math.sin(this.time * 3.1 + mm * 0.7) * 0.5 + 0.5 : 0.22
          var twinkle = 0.78 + 0.22 * Math.sin(this.time * 2.2 + mm * 1.7)
          var mSize = (2.0 + mImp * 1.2) * (1 + Math.min(0.55, 0.16 * weight))
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

      // ---- 文档刻度环：文档归档再多，也只是环上的刻度更密更亮 ----
      var docTicks = memory && memory.ok && Array.isArray(memory.docTicks) ? memory.docTicks : null
      if (docTicks && docTicks.length) {
        var ringR = R * 1.06
        var ringSquash = 0.4
        var ringTilt = -0.62
        var cTilt = Math.cos(ringTilt)
        var sTilt = Math.sin(ringTilt)
        var docRot = this.spin * 0.1 * 8
        var docColor = pal.green || base
        for (var di = 0; di < docTicks.length; di++) {
          var count = Number(docTicks[di]) || 0
          if (count <= 0) continue
          var ang = (di / docTicks.length) * TAU + docRot
          var ex = Math.cos(ang) * ringR
          var ey = Math.sin(ang) * ringR * ringSquash
          var dx = cx + ex * cTilt - ey * sTilt
          var dy = cy + ex * sTilt + ey * cTilt
          var tickLen = 2 + Math.min(7, Math.log(1 + count) / Math.LN2) * 1.4
          var tickA = (0.1 + Math.min(0.55, count * 0.09)) * alphaScale
          ctx.strokeStyle = rgba(docColor, tickA)
          ctx.lineWidth = count > 2 ? 1.4 : 1
          ctx.beginPath()
          ctx.moveTo(dx, dy)
          ctx.lineTo(dx + Math.cos(ang) * tickLen, dy + Math.sin(ang) * tickLen * ringSquash)
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
        if (alphaScale > 0.15) this.drawPulses(ctx, project, R, alphaScale, cx, cy)
      this.drawGauge(ctx, cx, cy, R, base, accent, hi, alphaScale)
        this.drawHud(ctx, cx, cy, R, base, accent, alphaScale)
      }
    }

    /** Blend two palette colours; t is clamped to 0..1. */
    SphereEngine.prototype.mixRgb = function (a, b, t) {
      var k = t < 0 ? 0 : t > 1 ? 1 : t
      return {
        r: Math.round(a.r + (b.r - a.r) * k),
        g: Math.round(a.g + (b.g - a.g) * k),
        b: Math.round(a.b + (b.b - a.b) * k),
      }
    }

    /**
     * Soft pressure rendering: no outside arcs. The memory ratio becomes a halo
     * around the sphere, the context ratio becomes the colour of the light the
     * core gives off (cool blue → violet → warning red), and the stream rate
     * already drives the pulse. White is never forced: every tint comes from the
     * theme palette.
     */
    /**
     * Rim light instead of a ring: two soft crescents graze the sphere from
     * opposite sides — a cool one for the memory store, a warm one for context
     * pressure — while the fill itself lives in the node dust and the centre
     * bloom. Nothing forms a closed circle, so the silhouette stays a sphere
     * rather than a dial.
     */
    /**
     * Nothing glows outward in normal operation: the sphere stays a clean
     * silhouette so text laid over it keeps its contrast. Fill is already
     * encoded in the node dust; this only draws a thin edge line when a
     * reading crosses its warning line, where a warning wants to be seen.
     */
    SphereEngine.prototype.drawGaugeGlow = function (ctx, cx, cy, R, base, accent, hi, alpha) {
      var health = this.health
      if (!health) return
      var pal = this.palette || {}
      var clamp = function (v) {
        var n = Number(v) || 0
        return n < 0 ? 0 : n > 1 ? 1 : n
      }
      var memory = clamp(health.memoryRatio)
      var pressure = clamp(health.contextRatio)
      var clock = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
      var breath = 0.75 + Math.sin(clock / 1800) * 0.25
      var edge = function (tint, width, peak) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineWidth = width
        ctx.strokeStyle = rgba(tint, peak * alpha * breath)
        ctx.beginPath()
        ctx.arc(cx, cy, R * 1.004, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      // past 85%: a thin ring hugging the silhouette, never a field of light
      if (memory >= 0.85) edge(accent, 2.0, 0.30)
      if (pressure >= 0.85) edge(this.alert || accent, 2.4, 0.38)
    }
    /** Pick the gauge style; `arc` keeps the previous look for comparison. */
    SphereEngine.prototype.drawGauge = function (ctx, cx, cy, R, base, accent, hi, alpha) {
      var style = this.cfg && this.cfg.gauge === 'arc' ? 'arc' : 'glow'
      if (style === 'arc') {
        this.drawGaugeArc(ctx, cx, cy, R, base, accent, hi, alpha)
        return
      }
      this.drawGaugeGlow(ctx, cx, cy, R, base, accent, hi, alpha)
    }
    /** 球体底部的环形数据表：随模型输出速率变长变亮 */
    SphereEngine.prototype.drawGaugeArc = function (ctx, cx, cy, R, base, accent, hi, alpha) {
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

      // 记忆容量压力：外一圈更细的表，超过 85% 才明显发琥珀色
      var health = this.health
      var pressure = health ? Math.max(0, Math.min(1, Number(health.memoryRatio) || 0)) : 0
      /* 压力弧在球体上方，避免压到底部 HUD 文字；半径按 R 比例，窗口再小也不重叠 */
      var topStart = -Math.PI / 2 - span / 2
      if (pressure > 0.01) {
        var pr = R * 1.045
        ctx.lineWidth = 1.6
        ctx.strokeStyle = rgba(base, 0.08 * alpha)
        ctx.beginPath()
        ctx.arc(cx, cy, pr, topStart, topStart + span)
        ctx.stroke()
        var over = pressure >= 0.85
        var tint = over ? accent : base
        ctx.lineWidth = over ? 2.4 : 1.6
        ctx.strokeStyle = rgba(tint, (over ? 0.6 : 0.3) * alpha)
        ctx.beginPath()
        ctx.arc(cx, cy, pr, topStart, topStart + span * pressure)
        ctx.stroke()
      }

      // 上下文压力：再外一圈，最忙的会话离压缩还有多远
      var contextRatio = health ? Math.max(0, Math.min(1, Number(health.contextRatio) || 0)) : 0
      if (contextRatio > 0.01) {
        var cr = R * 1.07
        ctx.lineWidth = 1.4
        ctx.strokeStyle = rgba(base, 0.07 * alpha)
        ctx.beginPath()
        ctx.arc(cx, cy, cr, topStart, topStart + span)
        ctx.stroke()
        var hot = contextRatio >= 0.85
        var ctxTint = hot ? this.alert : (this.palette && this.palette.violet) || base
        ctx.lineWidth = hot ? 2.2 : 1.4
        ctx.strokeStyle = rgba(ctxTint, (hot ? 0.62 : 0.34) * alpha)
        ctx.beginPath()
        ctx.arc(cx, cy, cr, topStart, topStart + span * contextRatio)
        ctx.stroke()
      }
      ctx.restore()
    }

    /** Display width of a HUD string, counting CJK as two cells. */
    function hudCells(text) {
      var s = String(text || '')
      var width = 0
      for (var i = 0; i < s.length; i += 1) {
        var code = s.charCodeAt(i)
        width += code >= 0x2e80 ? 2 : 1
      }
      return width
    }

    /** Clip a HUD string to a cell budget without splitting a pair. */
    function hudClip(text, budget) {
      var s = String(text || '')
      var width = 0
      var out = ''
      for (var i = 0; i < s.length; i += 1) {
        var code = s.charCodeAt(i)
        var add = code >= 0x2e80 ? 2 : 1
        if (width + add > budget) break
        out += s.charAt(i)
        width += add
      }
      return out
    }
    SphereEngine.prototype.drawHud = function (ctx, cx, cy, R, base, accent, alpha) {
      var s = this.state
      var tools = Number(s.counters.tools) || 0
      var memory = this.memory && this.memory.ok ? this.memory : null
      var health = this.health
      var pressure = health ? Math.min(1, Math.max(0, Number(health.memoryRatio) || 0)) : 0
      var contextRatio = health ? Math.min(1, Math.max(0, Number(health.contextRatio) || 0)) : 0
      var schedules = health ? Number(health.schedulesActive) || 0 : 0
      var errors = health ? Number(health.recentErrors) || 0 : 0
      var nextDue = health && health.nextDueAt ? Date.parse(health.nextDueAt) : 0
      var head = this.persona && this.persona.active ? 'JARVIS' : ''
      var headParts = []
      if (head) headParts.push(head)
      headParts.push(s.running ? '运行中' : '待机')
      /* 告警排在最前：窗口窄时丢末尾的 TASKS/TOOLS，绝不丢错误提示 */
      if (errors > 0) headParts.push('!' + errors + ' 错误')
      var diagStatus = this.diagnostics ? String(this.diagnostics.status || '') : ''
      if (diagStatus === 'fail') headParts.push('自检异常')
      else if (diagStatus === 'degraded') headParts.push('自检')
      var alertCount = this.alerts ? Number(this.alerts.count) || 0 : 0
      if (alertCount > 0) headParts.push(alertCount + ' 提醒')
      if (memory && memory.total > 0) {
        headParts.push(memory.total + ' 记忆' + (pressure > 0 ? ' ' + Math.round(pressure * 100) + '%' : ''))
      }
      if (contextRatio > 0) headParts.push('上下文 ' + Math.round(contextRatio * 100) + '%')
      var todayTurns = this.chronicle ? Number(this.chronicle.todayTurns) || 0 : 0
      if (todayTurns > 0) headParts.push('今日 ' + todayTurns)
      if (schedules > 0) headParts.push(schedules + ' 任务')
      if (tools > 0) headParts.push(tools + ' 工具')
      head = ''
      for (var hp = 0; hp < headParts.length; hp++) {
        var joined = head ? head + ' · ' + headParts[hp] : headParts[hp]
        if (head && hudCells(joined) > 96) break
        head = joined
      }
      var detail = s.activeTools.length ? String(s.activeTools[s.activeTools.length - 1]) : ''
      if (!detail && nextDue > 0) {
        var minsLeft = Math.max(0, Math.round((nextDue - Date.now()) / 60000))
        detail = minsLeft < 60 ? '下次 ' + minsLeft + ' 分钟' : minsLeft < 1440 ? '下次 ' + Math.round(minsLeft / 60) + ' 小时' : '下次 ' + Math.round(minsLeft / 1440) + ' 天'
      }
      if (!detail && memory && memory.ok) {
        /* 没有工具在跑时，底下一行报记忆库存：用户画像 / 工作记忆 / 空间 / 文档 */
        var parts = []
        if (memory.user) parts.push(memory.user + ' 画像')
        if (memory.memory) parts.push(memory.memory + ' 工作')
        if (memory.spaces) parts.push(memory.spaces + ' 空间')
        if (memory.documents) parts.push(memory.documents + ' 文档')
        detail = parts.length ? '记忆 ' + parts.join(' · ') : ''
      }

      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      var y = this.immersive ? 92 : cy + R * 1.03 + 8
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      var worst = Math.max(pressure, contextRatio)
      var headTint = errors > 0
        ? this.alert
        : worst >= 0.85
          ? accent
          : s.running ? accent : base
      var headAlpha = errors > 0 ? (this.dark ? 0.55 : 0.6) : (this.dark ? 0.26 : 0.42)
      ctx.fillStyle = rgba(headTint, headAlpha * alpha)
      ctx.fillText(head, cx, y)
      if (this.immersive) {
        ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        ctx.fillStyle = rgba(base, (this.dark ? 0.22 : 0.4) * alpha)
        ctx.fillText('沉浸模式 · Ctrl+Shift+J 还原', cx, y + 16)
      }
      if (detail) {
        ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        ctx.fillStyle = rgba(base, (this.dark ? 0.18 : 0.36) * alpha)
        ctx.fillText(hudClip(String(detail), 46), cx, y + (this.immersive ? 31 : 13))
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



