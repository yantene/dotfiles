import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createBinding, createComputed, createEffect, createState, onCleanup, For, With } from "ags"
import type { Accessor } from "ags"
import { createPoll } from "ags/time"
import { readFile } from "ags/file"
import { execAsync, subprocess, type Process } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalHyprland from "gi://AstalHyprland"
import AstalBattery from "gi://AstalBattery"
import AstalTray from "gi://AstalTray"
import AstalWp from "gi://AstalWp"

// waybar の ext/workspaces の format-icons 相当
const WORKSPACE_ICONS: Record<number, string> = {
  1: "1", 2: "2", 3: "3", 4: "4", 5: "5",
  6: "6", 7: "7", 8: "8", 9: "9", 10: "0",
}

const BATTERY_ICONS = ["󰂎", "󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"]

/**
 * 秒境界にアラインした時計。
 * createPoll(1000) だと起動時の位相がそのまま残り、実時間の秒が変わってから
 * 最大 1 秒近く遅れて表示される (実測で 512ms ずれた)。
 */
function createAlignedClock(format: string) {
  const now = () => GLib.DateTime.new_now_local().format(format)!
  const [time, setTime] = createState(now())

  let id = 0
  const step = () => {
    const untilNextSecond = 1000 - (GLib.get_real_time() % 1000000) / 1000
    id = setTimeout(() => {
      setTime(now())
      step()
    }, Math.max(1, Math.ceil(untilNextSecond)))
  }
  step()
  onCleanup(() => clearTimeout(id))

  return time
}

/**
 * Workspace.focus() は例外も投げず何も起きなかった。Hyprland 0.54 以降は
 * ディスパッチの引数が Lua 式として評価されるため、旧来の `dispatch workspace N`
 * は構文エラーになる。生の IPC に Lua 形式で投げれば確実に通る (応答 "ok" を確認済み)。
 */
function focusWorkspace(id: number) {
  AstalHyprland.get_default().message(`dispatch hl.dsp.focus({ workspace = "${id}" })`)
}

function Workspaces() {
  const hypr = AstalHyprland.get_default()
  const workspaces = createBinding(hypr, "workspaces")
  const focused = createBinding(hypr, "focusedWorkspace")

  const focusRelative = (dir: number) => {
    const list = [...hypr.workspaces].sort((a, b) => a.id - b.id)
    const i = list.findIndex((w) => w.id === hypr.focusedWorkspace?.id)
    const next = list[i + dir]
    if (next) focusWorkspace(next.id)
  }

  return (
    <box class="workspaces" $={onVerticalScroll((dy) => focusRelative(dy > 0 ? 1 : -1))}>
      <For each={workspaces((list) => [...list].sort((a, b) => a.id - b.id))} id={(ws) => ws.id}>
        {(ws: AstalHyprland.Workspace) => (
          <button
            class={focused((f) => (f?.id === ws.id ? "workspace active" : "workspace"))}
            onClicked={() => focusWorkspace(ws.id)}
          >
            <label label={WORKSPACE_ICONS[ws.id] ?? "+"} />
          </button>
        )}
      </For>
    </box>
  )
}

function Battery({ onToggle }: { onToggle: (x: number) => void }) {
  const bat = AstalBattery.get_default()
  const percentage = createBinding(bat, "percentage")
  const charging = createBinding(bat, "charging")

  const icon = (pctValue: number, chg: boolean) => {
    if (chg) return "󰂄"
    return pickIcon(BATTERY_ICONS, pctValue)
  }

  // waybar の battery.critical:not(.charging) は CSS ではなくこちらで解決する
  return (
    <HudButton
      cls={createComputed(() => {
        const p = percentage()
        if (charging()) return "battery charging"
        return p <= 0.15 ? "battery critical" : p <= 0.3 ? "battery warning" : "battery"
      })}
      onToggle={onToggle}
    >
      <box class="mod-row" spacing={5}>
        <label class="mod-icon" label={createComputed(() => icon(percentage(), charging()))} />
        <label class="mod-value" label={percentage((p) => pct(p * 100))} />
      </box>
    </HudButton>
  )
}

/**
 * GTK4 ではスクロールはシグナルではなくイベントコントローラなので、
 * ウィジェット実体を受け取る $ で後付けする。
 */
const onVerticalScroll = (handler: (dy: number) => void) => (self: Gtk.Widget) => {
  const ctrl = new Gtk.EventControllerScroll({
    flags: Gtk.EventControllerScrollFlags.VERTICAL,
  })
  ctrl.connect("scroll", (_c, _dx, dy) => {
    handler(dy)
    return true
  })
  self.add_controller(ctrl)
}

/**
 * 定期更新される数値は桁数が変わると横幅が動いて隣がガタつく。
 * モノスペースなので、右詰めで桁を固定すれば幅が安定する。
 */
const pct = (v: number) => `${String(Math.round(v)).padStart(3, " ")}%`
const degC = (v: number) => `${String(Math.round(v)).padStart(2, " ")}°C`

/** waybar の states 相当。しきい値でクラス名を足す */
const level = (base: string, v: number, warning: number, critical: number) =>
  v >= critical ? `${base} critical` : v >= warning ? `${base} warning` : base

/** 配列から段階的にアイコンを選ぶ */
const pickIcon = (icons: string[], ratio: number) =>
  icons[Math.min(icons.length - 1, Math.max(0, Math.round(ratio * (icons.length - 1))))]

const SCRATCHPAD_HTOP = `${GLib.get_user_config_dir()}/hypr/bin/scratchpad-htop`

/**
 * アクセサの値を時系列で溜める。スパークライン用。
 */
function createHistory(source: Accessor<number>, length = 60) {
  const [history, setHistory] = createState<number[]>([])
  // createPoll の初期値 (0) がそのまま履歴に入ると、range スケールで
  // 最小値に居座って波形を潰すので最初の 1 点は捨てる
  let seeded = false

  createEffect(() => {
    const v = source()
    if (!seeded) {
      seeded = true
      return
    }
    setHistory((prev) => [...prev, v].slice(-length))
  })

  return history
}

/**
 * cairo で折れ線と下側の塗りを描く。GTK にグラフ用のウィジェットは無いので
 * DrawingArea に直接描く。waybar が文字しか出せなかったのは waybar の
 * format 文字列の制約で、GTK 側の制約ではない。
 */
function Sparkline({
  values,
  max = 100,
  width = 46,
  height = 13,
  rgb = [0.3, 0.82, 0.88],
  scale = "peak",
  headroom = 1.25,
}: {
  values: Accessor<number[]>
  max?: number
  width?: number
  height?: number
  rgb?: [number, number, number]
  /**
   * absolute: 常に 0..max。使用率のように絶対値が意味を持つ系列向け
   * peak    : 0..直近ピーク * headroom。低負荷でも潰れない
   * range   : 直近の最小..最大。変動幅が小さい系列の揺れを拾う
   */
  scale?: "absolute" | "peak" | "range"
  /** peak モードで天井をピーク値の何倍に取るか */
  headroom?: number
}) {
  return (
    <drawingarea
      class="sparkline"
      $={(self: Gtk.DrawingArea) => {
        self.set_content_width(width)
        self.set_content_height(height)
        self.set_valign(Gtk.Align.CENTER)

        self.set_draw_func((_area, cr, w, h) => {
          const data = values.get()
          if (data.length < 2) return

          const [r, g, b] = rgb
          // autoScale: 低負荷でも波形が潰れないよう直近の最大値に合わせて伸ばす。
          // 使用率のように絶対値そのものが意味を持つ系列は固定スケールにする。
          const peak = data.reduce((a, v) => Math.max(a, v), 0)
          const floor = scale === "range" ? data.reduce((a, v) => Math.min(a, v), Infinity) : 0
          const ceiling =
            scale === "absolute"
              ? max
              : scale === "range"
                ? Math.max(peak, floor + max * 0.01)
                : Math.min(max, Math.max(peak * headroom, max * 0.15))

          const span = Math.max(ceiling - floor, 1e-6)
          const step = w / (data.length - 1)
          const y = (v: number) => h - 1 - ((Math.min(Math.max(v, floor), ceiling) - floor) / span) * (h - 2)

          // 下側の塗り
          cr.moveTo(0, h)
          data.forEach((v, i) => cr.lineTo(i * step, y(v)))
          cr.lineTo(w, h)
          cr.closePath()
          cr.setSourceRGBA(r, g, b, 0.14)
          cr.fill()

          // 発光を模した太い下地 -> その上に細い本線
          data.forEach((v, i) => (i === 0 ? cr.moveTo(0, y(v)) : cr.lineTo(i * step, y(v))))
          cr.setSourceRGBA(r, g, b, 0.25)
          cr.setLineWidth(3.5)
          cr.stroke()

          data.forEach((v, i) => (i === 0 ? cr.moveTo(0, y(v)) : cr.lineTo(i * step, y(v))))
          cr.setSourceRGBA(r, g, b, 1)
          cr.setLineWidth(1.2)
          cr.stroke()
        })

        onCleanup(values.subscribe(() => self.queue_draw()))
      }}
    />
  )
}

/** /proc/stat のコア別行から、コアごとの使用率を出す */
function createCoreUsage() {
  const last: { busy: number; total: number }[] = []

  return createPoll<number[]>([], 1000, () => {
    const rows = readFile("/proc/stat").split("\n").filter((l) => /^cpu\d+/.test(l))
    return rows.map((line, i) => {
      const v = line.split(/\s+/).slice(1).map(Number)
      const total = v.reduce((a, b) => a + b, 0)
      const busy = total - v[3] - (v[4] ?? 0)
      const prev = last[i]
      last[i] = { busy, total }
      return prev && total > prev.total ? ((busy - prev.busy) / (total - prev.total)) * 100 : 0
    })
  })
}

/** コア別使用率を縦バーで並べる。80% 超えたコアはマゼンタに転ぶ */
function CoreBars({ cores }: { cores: Accessor<number[]> }) {
  return (
    <drawingarea
      class="core-bars"
      $={(self: Gtk.DrawingArea) => {
        self.set_content_width(260)
        self.set_content_height(54)

        self.set_draw_func((_area, cr, w, h) => {
          const data = cores.get()
          if (!data.length) return

          const gap = 3
          const bw = (w - gap * (data.length - 1)) / data.length

          data.forEach((v, i) => {
            const x = i * (bw + gap)
            const bh = Math.max(2, (Math.min(v, 100) / 100) * h)
            const hot = v > 80
            const [r, g, b] = hot ? [1, 0.2, 0.33] : [0.97, 0.96, 0.23]

            // 空きスロット
            cr.setSourceRGBA(0, 0.94, 1, 0.1)
            cr.rectangle(x, 0, bw, h)
            cr.fill()

            // 実値。発光を模して薄い外側 -> 濃い内側の順に重ねる
            cr.setSourceRGBA(r, g, b, 0.25)
            cr.rectangle(x - 1, h - bh - 1, bw + 2, bh + 1)
            cr.fill()
            cr.setSourceRGBA(r, g, b, 0.95)
            cr.rectangle(x, h - bh, bw, bh)
            cr.fill()
          })
        })

        onCleanup(cores.subscribe(() => self.queue_draw()))
      }}
    />
  )
}

/** メモリの内訳を積み上げの横バーで描く */
function MemoryBar({ mem }: { mem: Accessor<{ used: number; cached: number; total: number }> }) {
  return (
    <drawingarea
      class="mem-bar"
      $={(self: Gtk.DrawingArea) => {
        self.set_content_width(260)
        self.set_content_height(14)

        self.set_draw_func((_area, cr, w, h) => {
          const m = mem.get()
          if (!m.total) return

          const usedW = (m.used / m.total) * w
          const cachedW = (m.cached / m.total) * w

          cr.setSourceRGBA(0, 0.94, 1, 0.1)
          cr.rectangle(0, 0, w, h)
          cr.fill()

          cr.setSourceRGBA(0.49, 0.96, 0.63, 0.9)
          cr.rectangle(0, 0, usedW, h)
          cr.fill()

          cr.setSourceRGBA(0.71, 0.49, 0.96, 0.65)
          cr.rectangle(usedW, 0, cachedW, h)
          cr.fill()
        })

        onCleanup(mem.subscribe(() => self.queue_draw()))
      }}
    />
  )
}

const gib = (kb: number) => (kb / 1048576).toFixed(1)

function SystemHud() {
  const cores = createCoreUsage()

  const mem = createPoll({ used: 0, cached: 0, total: 0, swapUsed: 0, swapTotal: 0 }, 2000, () => {
    const t = readFile("/proc/meminfo")
    const kb = (key: string) => Number(t.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0)
    const total = kb("MemTotal")
    const used = total - kb("MemAvailable")
    const cached = Math.max(0, kb("Cached") + kb("SReclaimable") - kb("Shmem"))
    const swapTotal = kb("SwapTotal")
    return { used, cached, total, swapUsed: swapTotal - kb("SwapFree"), swapTotal }
  })

  const load = createPoll("", 5000, () => readFile("/proc/loadavg").split(" ").slice(0, 3).join("  "))

  const procs = createPoll("", 3000, () =>
    execAsync(["bash", "-c", "ps -eo pcpu,pmem,comm --sort=-pcpu --no-headers | head -8"])
      .then((out) =>
        out
          .trim()
          .split("\n")
          // 計測に使った ps / bash 自身が上位に居座るので落とす
          .filter((l) => !/\b(ps|bash|grep)$/.test(l.trim()))
          .slice(0, 5)
          .map((l) => {
            const [cpu, memp, ...rest] = l.trim().split(/\s+/)
            return `${cpu.padStart(5)}%  ${memp.padStart(4)}%  ${rest.join(" ").slice(0, 18)}`
          })
          .join("\n"),
      )
      .catch(() => "---"),
  )

  return (
    <box class="hud" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <label class="hud-title" label="◤ SYSTEM MONITOR ◢" />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <box>
          <label class="hud-section" label="CPU CORES" hexpand halign={Gtk.Align.START} />
          <label class="hud-value" label={load((l) => `LOAD ${l}`)} />
        </box>
        <CoreBars cores={cores} />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <box>
          <label class="hud-section" label="MEMORY" hexpand halign={Gtk.Align.START} />
          <label class="hud-value" label={mem((m) => `${gib(m.used)} / ${gib(m.total)} GiB`)} />
        </box>
        <MemoryBar mem={mem} />
        <box>
          <label class="hud-legend used" label="■ USED" hexpand halign={Gtk.Align.START} />
          <label class="hud-legend cached" label="■ CACHE" hexpand halign={Gtk.Align.START} />
          <label
            class="hud-value"
            label={mem((m) => (m.swapTotal ? `SWAP ${gib(m.swapUsed)} / ${gib(m.swapTotal)}` : "SWAP ---"))}
          />
        </box>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <label class="hud-section" label="TOP PROCESSES" halign={Gtk.Align.START} />
        <label class="hud-mono" label={procs} halign={Gtk.Align.START} />
      </box>
    </box>
  )
}

/** HUD 内の「項目名 ....... 値」の 1 行 */
function HudRow({ name, value, cls }: { name: string; value: Accessor<string>; cls?: string }) {
  return (
    <box>
      <label class="hud-key" label={name} hexpand halign={Gtk.Align.START} />
      <label class={`hud-val ${cls ?? ""}`} label={value} halign={Gtk.Align.END} />
    </box>
  )
}

type MemInfo = {
  total: number
  free: number
  available: number
  buffers: number
  cached: number
  shmem: number
  dirty: number
  swapTotal: number
  swapFree: number
}

function readMemInfo(): MemInfo {
  const t = readFile("/proc/meminfo")
  const kb = (key: string) => Number(t.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0)
  return {
    total: kb("MemTotal"),
    free: kb("MemFree"),
    available: kb("MemAvailable"),
    buffers: kb("Buffers"),
    cached: Math.max(0, kb("Cached") + kb("SReclaimable") - kb("Shmem")),
    shmem: kb("Shmem"),
    dirty: kb("Dirty"),
    swapTotal: kb("SwapTotal"),
    swapFree: kb("SwapFree"),
  }
}

/** used / buffers / cached / free を積み上げた内訳バー */
function MemoryBreakdown({ info }: { info: Accessor<MemInfo> }) {
  return (
    <drawingarea
      class="mem-breakdown"
      $={(self: Gtk.DrawingArea) => {
        self.set_content_width(280)
        self.set_content_height(18)

        self.set_draw_func((_area, cr, w, h) => {
          const m = info.get()
          if (!m.total) return

          const used = m.total - m.available
          const segments: [number, [number, number, number], number][] = [
            [used, [0.49, 0.96, 0.63], 0.95],
            [m.buffers, [0.97, 0.96, 0.23], 0.8],
            [m.cached, [0.71, 0.49, 0.96], 0.7],
          ]

          cr.setSourceRGBA(0, 0.94, 1, 0.1)
          cr.rectangle(0, 0, w, h)
          cr.fill()

          let x = 0
          for (const [kb, [r, g, b], a] of segments) {
            const seg = (kb / m.total) * w
            cr.setSourceRGBA(r, g, b, a)
            cr.rectangle(x, 0, seg, h)
            cr.fill()
            x += seg
          }
        })

        onCleanup(info.subscribe(() => self.queue_draw()))
      }}
    />
  )
}

function MemoryHud() {
  const info = createPoll<MemInfo>(readMemInfo(), 2000, readMemInfo)
  const usedPct = info((m) => (m.total ? ((m.total - m.available) / m.total) * 100 : 0))
  const history = createHistory(usedPct)

  const procs = createPoll("", 3000, () =>
    execAsync(["bash", "-c", "ps -eo pmem,rss,comm --sort=-pmem --no-headers | head -6"])
      .then((out) =>
        out
          .trim()
          .split("\n")
          .map((l) => {
            const [pmem, rss, ...rest] = l.trim().split(/\s+/)
            return `${pmem.padStart(5)}%  ${(Number(rss) / 1024).toFixed(0).padStart(5)}M  ${rest.join(" ").slice(0, 16)}`
          })
          .join("\n"),
      )
      .catch(() => "---"),
  )

  return (
    <box class="hud" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <label class="hud-title" label="◤ MEMORY ◢" />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <box>
          <label class="hud-section" label="ALLOCATION" hexpand halign={Gtk.Align.START} />
          <label class="hud-value" label={usedPct((p) => `${p.toFixed(1)}%`)} />
        </box>
        <MemoryBreakdown info={info} />
        <box spacing={10}>
          <label class="hud-legend used" label="■ USED" />
          <label class="hud-legend buffers" label="■ BUF" />
          <label class="hud-legend cached" label="■ CACHE" />
          <label class="hud-legend free" label="■ FREE" hexpand halign={Gtk.Align.START} />
        </box>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <label class="hud-section" label="DETAIL" halign={Gtk.Align.START} />
        <HudRow name="TOTAL" value={info((m) => `${gib(m.total)} GiB`)} />
        <HudRow name="USED" value={info((m) => `${gib(m.total - m.available)} GiB`)} cls="used" />
        <HudRow name="AVAILABLE" value={info((m) => `${gib(m.available)} GiB`)} />
        <HudRow name="CACHED" value={info((m) => `${gib(m.cached)} GiB`)} cls="cached" />
        <HudRow name="BUFFERS" value={info((m) => `${gib(m.buffers)} GiB`)} cls="buffers" />
        <HudRow name="SHARED" value={info((m) => `${gib(m.shmem)} GiB`)} />
        <HudRow name="DIRTY" value={info((m) => `${(m.dirty / 1024).toFixed(0)} MiB`)} />
        <HudRow
          name="SWAP"
          value={info((m) => (m.swapTotal ? `${gib(m.swapTotal - m.swapFree)} / ${gib(m.swapTotal)} GiB` : "---"))}
        />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <label class="hud-section" label="HISTORY (60s)" halign={Gtk.Align.START} />
        <Sparkline values={history} width={280} height={44} scale="range" rgb={[0.49, 0.96, 0.63]} />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <label class="hud-section" label="TOP CONSUMERS" halign={Gtk.Align.START} />
        <label class="hud-mono" label={procs} halign={Gtk.Align.START} />
      </box>
    </box>
  )
}

type HudKind = "cpu" | "memory" | "network" | "clock" | "battery" | "thermal"

/**
 * HUD を開くボタン。HUD は独立した layer surface なので、
 * 自分の実座標を測って呼び出し側に渡す。
 */
function HudButton({
  cls,
  onToggle,
  tooltip,
  children,
}: {
  cls: Accessor<string> | string
  onToggle: (x: number) => void
  tooltip?: Accessor<string>
  children: JSX.Element
}) {
  let btn: Gtk.Widget | null = null

  return (
    <button
      class={cls}
      hasTooltip={tooltip ? true : false}
      tooltipMarkup={tooltip}
      $={(self: Gtk.Widget) => {
        btn = self
      }}
      onClicked={() => {
        const root = btn?.get_root() as Gtk.Widget | null
        if (!btn || !root) return onToggle(0)
        onToggle(Math.round(btn.compute_bounds(root)[1].get_x()))
      }}
    >
      {children}
    </button>
  )
}

/** 全 hwmon から温度センサーを集める */
type Sensor = { key: string; chip: string; label: string; temp: number }

function readSensors(): Sensor[] {
  const base = "/sys/class/hwmon"
  const out: Sensor[] = []

  const dir = Gio.File.new_for_path(base)
  const chips = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
  let chipInfo: Gio.FileInfo | null

  while ((chipInfo = chips.next_file(null)) !== null) {
    const path = `${base}/${chipInfo.get_name()}`
    let chip: string
    try {
      chip = readFile(`${path}/name`).trim()
    } catch {
      continue
    }

    const entries = Gio.File.new_for_path(path).enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    let entry: Gio.FileInfo | null

    while ((entry = entries.next_file(null)) !== null) {
      const m = entry.get_name().match(/^temp(\d+)_input$/)
      if (!m) continue

      let label = `TEMP${m[1]}`
      try {
        label = readFile(`${path}/temp${m[1]}_label`).trim()
      } catch {
        // label を持たないチップも多い
      }

      try {
        const temp = Number(readFile(`${path}/${entry.get_name()}`)) / 1000
        if (temp > 0 && temp < 200) out.push({ key: `${chip}/${m[1]}`, chip, label, temp })
      } catch {
        // 読めないセンサーは飛ばす
      }
    }
  }

  return out.sort((a, b) => b.temp - a.temp)
}

function ThermalHud() {
  const sensors = createPoll<Sensor[]>(readSensors(), 3000, readSensors)
  const hottest = sensors((list) => (list.length ? list[0] : null))

  return (
    <box class="hud" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <label class="hud-title" label="◤ THERMAL ◢" />

      <label
        class={createComputed(() => {
          const h = hottest()
          return `hud-bigclock ${h && h.temp >= 80 ? "critical" : ""}`
        })}
        label={hottest((h) => (h ? `${Math.round(h.temp)}°C` : "---"))}
      />
      <label class="hud-subclock" label={hottest((h) => (h ? `PEAK  ${h.chip.toUpperCase()}  ${h.label}` : ""))} />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
        <label class="hud-section" label="ALL SENSORS" halign={Gtk.Align.START} />
        <For each={sensors} id={(s: Sensor) => s.key}>
          {(s: Sensor) => (
            <box spacing={8}>
              <label class="hud-key" label={`${s.chip} ${s.label}`.toUpperCase().slice(0, 22)} hexpand halign={Gtk.Align.START} />
              <levelbar
                class={s.temp >= 80 ? "temp-bar critical" : s.temp >= 65 ? "temp-bar warning" : "temp-bar"}
                value={Math.min(1, s.temp / 100)}
                widthRequest={90}
                valign={Gtk.Align.CENTER}
              />
              <label class="hud-val" label={`${Math.round(s.temp)}°C`} />
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

/** ネットワーク HUD */
function NetworkHud() {
  const speed = createNetSpeed()
  const down = createHistory(speed((s) => s.down))
  const up = createHistory(speed((s) => s.up))
  const wifi = createWifi()

  const total = createPoll({ rx: 0, tx: 0 }, 3000, () => {
    let rx = 0
    let tx = 0
    for (const line of readFile("/proc/net/dev").split("\n").slice(2)) {
      const [rawName, rest] = line.split(":")
      if (!rest) continue
      const name = rawName.trim()
      if (name === "lo" || /^(docker|br-|veth|virbr)/.test(name)) continue
      const f = rest.trim().split(/\s+/).map(Number)
      rx += f[0]
      tx += f[8]
    }
    return { rx, tx }
  })

  const ifaces = createPoll<{ name: string; state: string; addr: string }[]>([], 5000, () =>
    execAsync(["ip", "-j", "addr"])
      .then((out) =>
        (JSON.parse(out) as any[])
          .filter((i) => i.ifname !== "lo" && !/^(docker|br-|veth|virbr)/.test(i.ifname))
          .map((i) => ({
            name: i.ifname as string,
            state: (i.operstate as string) ?? "?",
            addr: (i.addr_info ?? []).find((a: any) => a.family === "inet")?.local ?? "---",
          })),
      )
      .catch(() => []),
  )

  const gib = (b: number) => (b / 1073741824).toFixed(2)

  return (
    <box class="hud" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <label class="hud-title" label="◤ NETWORK ◢" />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <box>
          <label class="hud-section" label="DOWNLINK" hexpand halign={Gtk.Align.START} />
          <label class="hud-value" label={speed((s) => fmtBytes(s.down) + "/s")} />
        </box>
        <Sparkline values={down} width={280} height={38} max={5e6} rgb={[0, 0.94, 1]} />
        <box>
          <label class="hud-section" label="UPLINK" hexpand halign={Gtk.Align.START} />
          <label class="hud-value" label={speed((s) => fmtBytes(s.up) + "/s")} />
        </box>
        <Sparkline values={up} width={280} height={38} max={2e6} rgb={[1, 0.16, 0.43]} />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <label class="hud-section" label="LINK" halign={Gtk.Align.START} />
        <HudRow name="SSID" value={wifi((w) => (w.connected ? w.ssid : "---"))} />
        <HudRow name="IFACE" value={wifi((w) => w.iface || "---")} />
        <HudRow name="RX TOTAL" value={total((t) => `${gib(t.rx)} GiB`)} />
        <HudRow name="TX TOTAL" value={total((t) => `${gib(t.tx)} GiB`)} cls="used" />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <label class="hud-section" label="INTERFACES" halign={Gtk.Align.START} />
        <For each={ifaces} id={(i) => i.name}>
          {(i: { name: string; state: string; addr: string }) => (
            <box>
              <label class="hud-key" label={i.name.toUpperCase()} hexpand halign={Gtk.Align.START} />
              <label class={`hud-val ${i.state === "UP" ? "" : "muted"}`} label={`${i.addr}  ${i.state}`} />
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

// 経度順
const TIMEZONES: [string, string][] = [
  ["SAN FRANCISCO", "America/Los_Angeles"],
  ["NEW YORK", "America/New_York"],
  ["UTC", "UTC"],
  ["LONDON", "Europe/London"],
  ["SINGAPORE", "Asia/Singapore"],
  ["TOKYO", "Asia/Tokyo"],
]

/** 年内の日数 (閏年を考慮) */
function daysInYear() {
  const y = GLib.DateTime.new_now_local().get_year()
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365
}

/** 今年がどこまで進んだか (%) */
function yearProgress() {
  const now = GLib.DateTime.new_now_local()
  const y = now.get_year()
  const start = GLib.DateTime.new_local(y, 1, 1, 0, 0, 0)!.to_unix()
  const end = GLib.DateTime.new_local(y + 1, 1, 1, 0, 0, 0)!.to_unix()
  return ((now.to_unix() - start) / (end - start)) * 100
}

/**
 * Swatch インターネット時間 (.beat)。1998 年に提唱された、
 * タイムゾーンを廃して 1 日を 1000 拍に割る時刻表現。基準は BMT = UTC+1。
 */
function swatchBeat() {
  const utc = GLib.DateTime.new_now_utc()
  const secs = (((utc.get_hour() + 1) % 24) * 3600 + utc.get_minute() * 60 + utc.get_seconds()) | 0
  return Math.floor(secs / 86.4)
}

/** 月齢。2000-01-06 18:14 UTC の新月を起点にした概算 */
function moonPhase() {
  const SYNODIC = 29.530588853
  const NEW_MOON = 947182440 // 2000-01-06 18:14 UTC
  const days = (GLib.DateTime.new_now_utc().to_unix() - NEW_MOON) / 86400
  const age = ((days % SYNODIC) + SYNODIC) % SYNODIC
  const icons = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"]
  const icon = icons[Math.floor((age / SYNODIC) * 8) % 8]
  return `${icon} ${age.toFixed(1)}d`
}

/** 時計 HUD */
function ClockHud() {
  const tick = createAlignedClock("%s")

  const zone = (id: string) =>
    tick(() => {
      const tz = GLib.TimeZone.new_identifier(id)
      if (!tz) return "---"
      const dt = GLib.DateTime.new_now(tz)
      // get_utc_offset はマイクロ秒。夏時間の有無がここに現れる
      const offset = dt.get_utc_offset() / 3_600_000_000
      const sign = offset >= 0 ? "+" : "-"
      const abs = Math.abs(offset)
      const hh = Math.floor(abs)
      const mm = Math.round((abs - hh) * 60)
      return `${dt.format("%m/%d %H:%M")}  ${sign}${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}`
    })

  const bootTime = createPoll("", 60_000, () => {
    const up = Number(readFile("/proc/uptime").split(" ")[0])
    const boot = GLib.DateTime.new_now_local().to_unix() - Math.floor(up)
    return GLib.DateTime.new_from_unix_local(boot).format("%m/%d %H:%M")!
  })

  const uptime = createPoll("", 30_000, () => {
    const secs = Number(readFile("/proc/uptime").split(" ")[0])
    const d = Math.floor(secs / 86400)
    const h = Math.floor((secs % 86400) / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
  })

  return (
    <box class="hud" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <label class="hud-title" label="◤ CHRONOMETER ◢" />

      <label class="hud-bigclock" label={tick(() => GLib.DateTime.new_now_local().format("%H:%M:%S")!)} />
      <label class="hud-subclock" label={tick(() => GLib.DateTime.new_now_local().format("%Y-%m-%d  %A")!)} />

      <box class="hud-calendar" halign={Gtk.Align.CENTER}>
        <Gtk.Calendar />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <label class="hud-section" label="WORLD" halign={Gtk.Align.START} />
        {TIMEZONES.map(([name, id]) => (
          <HudRow name={name} value={zone(id)} />
        ))}
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <label class="hud-section" label="SYSTEM TIME" halign={Gtk.Align.START} />
        <HudRow name="UNIX" value={tick(() => String(GLib.DateTime.new_now_local().to_unix()))} />
        <HudRow name="ISO WEEK" value={tick(() => GLib.DateTime.new_now_local().format("W%V / %G")!)} />
        <HudRow name="DAY OF YEAR" value={tick(() => `${GLib.DateTime.new_now_local().format("%j")} / ${daysInYear()}`)} />
        <HudRow name="YEAR" value={tick(() => `${yearProgress().toFixed(2)}%`)} />
        <HudRow name="SWATCH" value={tick(() => `@${String(swatchBeat()).padStart(3, "0")}`)} cls="beat" />
        <HudRow name="MOON" value={tick(() => moonPhase())} />
        <HudRow name="BOOT" value={bootTime} />
        <HudRow name="UPTIME" value={uptime} cls="used" />
      </box>
    </box>
  )
}

/**
 * バッテリー HUD
 *
 * UPower の表示用デバイス (AstalBattery.get_default) は集約値しか持たず、
 * energy_full / design / cycle_count が 0 で返る。容量系は sysfs から直接読む。
 */
function readBatteryCell() {
  const base = "/sys/class/power_supply/BAT0"
  const num = (f: string) => {
    try {
      return Number(readFile(`${base}/${f}`))
    } catch {
      return 0
    }
  }
  const str = (f: string) => {
    try {
      // model_name には非 ASCII のごみが混ざることがある
      return readFile(`${base}/${f}`).trim().replace(/[^\x20-\x7e]/g, "")
    } catch {
      return "---"
    }
  }

  return {
    energyNow: num("energy_now") / 1e6,
    energyFull: num("energy_full") / 1e6,
    energyDesign: num("energy_full_design") / 1e6,
    power: num("power_now") / 1e6,
    voltage: num("voltage_now") / 1e6,
    cycles: num("cycle_count"),
    tech: str("technology"),
    vendor: str("manufacturer"),
    model: str("model_name"),
  }
}

/** 設計容量に対する現在の満充電容量を横バーで描く */
function HealthBar({ cell }: { cell: Accessor<ReturnType<typeof readBatteryCell>> }) {
  return (
    <drawingarea
      class="mem-breakdown"
      $={(self: Gtk.DrawingArea) => {
        self.set_content_width(280)
        self.set_content_height(14)

        self.set_draw_func((_area, cr, w, h) => {
          const c = cell.get()
          if (!c.energyDesign) return

          const health = c.energyFull / c.energyDesign
          const now = c.energyNow / c.energyDesign

          cr.setSourceRGBA(0, 0.94, 1, 0.1)
          cr.rectangle(0, 0, w, h)
          cr.fill()

          // 劣化して失われた分まで含めた満充電容量
          cr.setSourceRGBA(0.71, 0.49, 0.96, 0.45)
          cr.rectangle(0, 0, health * w, h)
          cr.fill()

          // 現在の残量
          cr.setSourceRGBA(0, 0.94, 1, 0.95)
          cr.rectangle(0, 0, now * w, h)
          cr.fill()
        })

        onCleanup(cell.subscribe(() => self.queue_draw()))
      }}
    />
  )
}

function BatteryHud() {
  const bat = AstalBattery.get_default()
  const percentage = createBinding(bat, "percentage")
  const charging = createBinding(bat, "charging")
  const toEmpty = createBinding(bat, "timeToEmpty")
  const toFull = createBinding(bat, "timeToFull")

  const cell = createPoll(readBatteryCell(), 10_000, readBatteryCell)
  const history = createHistory(percentage((p) => p * 100))

  const hhmm = (secs: number) =>
    secs > 0 ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m` : "---"

  return (
    <box class="hud" orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <label class="hud-title" label="◤ POWER CELL ◢" />

      <label
        class={createComputed(() => `hud-bigclock ${percentage() <= 0.15 && !charging() ? "critical" : ""}`)}
        label={percentage((p) => `${Math.round(p * 100)}%`)}
      />
      <label
        class="hud-subclock"
        label={createComputed(() =>
          charging() ? `CHARGING  ${hhmm(toFull())}` : `DISCHARGING  ${hhmm(toEmpty())}`,
        )}
      />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <box>
          <label class="hud-section" label="CAPACITY" hexpand halign={Gtk.Align.START} />
          <label
            class="hud-value"
            label={cell((c) => (c.energyDesign ? `HEALTH ${((c.energyFull / c.energyDesign) * 100).toFixed(1)}%` : "---"))}
          />
        </box>
        <HealthBar cell={cell} />
        <box spacing={10}>
          <label class="hud-legend free" label="■ NOW" />
          <label class="hud-legend cached" label="■ FULL" />
          <label class="hud-legend" label="■ LOST" hexpand halign={Gtk.Align.START} />
        </box>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
        <label class="hud-section" label="CELL" halign={Gtk.Align.START} />
        <HudRow name="DRAW" value={cell((c) => `${c.power.toFixed(2)} W`)} cls="used" />
        <HudRow name="VOLTAGE" value={cell((c) => `${c.voltage.toFixed(2)} V`)} />
        <HudRow name="ENERGY" value={cell((c) => `${c.energyNow.toFixed(1)} / ${c.energyFull.toFixed(1)} Wh`)} />
        <HudRow name="DESIGN" value={cell((c) => `${c.energyDesign.toFixed(1)} Wh`)} cls="cached" />
        <HudRow name="CYCLES" value={cell((c) => (c.cycles ? String(c.cycles) : "---"))} />
        <HudRow name="TECH" value={cell((c) => c.tech)} />
        <HudRow name="VENDOR" value={cell((c) => c.vendor)} />
        <HudRow name="MODEL" value={cell((c) => c.model)} />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
        <label class="hud-section" label="LEVEL HISTORY" halign={Gtk.Align.START} />
        <Sparkline values={history} width={280} height={40} scale="range" rgb={[0, 0.94, 1]} />
      </box>
    </box>
  )
}

function Cpu({ onToggle }: { onToggle: (x: number) => void }) {
  // /proc/stat は累積値なので、前回との差分から使用率を出す
  let last = { busy: 0, total: 0 }
  const usage = createPoll(0, 1000, () => {
    const v = readFile("/proc/stat").split("\n")[0].split(/\s+/).slice(1).map(Number)
    const total = v.reduce((a, b) => a + b, 0)
    const busy = total - v[3] - (v[4] ?? 0) // idle + iowait を除いた分
    const d = { busy: busy - last.busy, total: total - last.total }
    last = { busy, total }
    return d.total > 0 ? (d.busy / d.total) * 100 : 0
  })

  const history = createHistory(usage)

  return (
    <HudButton cls={usage((u) => level("cpu", u, 70, 90))} onToggle={onToggle}>
      <box class="mod-row" spacing={5}>
        <label class="mod-icon" label="󰻠" />
        <label class="mod-value" label={usage(pct)} />
        <Sparkline values={history} rgb={[0.97, 0.96, 0.23]} />
      </box>
    </HudButton>
  )
}

function Memory({ onToggle }: { onToggle: (x: number) => void }) {
  const usage = createPoll(0, 1000, () => {
    const t = readFile("/proc/meminfo")
    const kb = (key: string) => Number(t.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0)
    const total = kb("MemTotal")
    return total > 0 ? ((total - kb("MemAvailable")) / total) * 100 : 0
  })

  const history = createHistory(usage)

  return (
    <HudButton cls={usage((u) => level("memory", u, 70, 90))} onToggle={onToggle}>
      <box class="mod-row" spacing={5}>
        <label class="mod-icon" label="󰍛" />
        <label class="mod-value" label={usage(pct)} />
        <Sparkline values={history} rgb={[0.49, 0.96, 0.63]} scale="range" />
      </box>
    </HudButton>
  )
}

/**
 * hwmon の番号は起動ごとに変わるため、チップ名から引く。
 * waybar は /sys/class/hwmon/hwmon6/temp1_input を直書きしていた。
 */
function findHwmon(chip: string, sensor = "temp1"): string | null {
  const base = "/sys/class/hwmon"
  const dir = Gio.File.new_for_path(base)
  const iter = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
  let info: Gio.FileInfo | null
  while ((info = iter.next_file(null)) !== null) {
    const path = `${base}/${info.get_name()}`
    try {
      if (readFile(`${path}/name`).trim() === chip) return `${path}/${sensor}_input`
    } catch {
      // name を持たない hwmon は読み飛ばす
    }
  }
  return null
}

function Temperature({ onToggle }: { onToggle: (x: number) => void }) {
  const cpuPath = findHwmon("k10temp")
  const gpuPath = findHwmon("amdgpu")

  const read = (path: string | null) => (path ? Number(readFile(path)) / 1000 : 0)
  const temps = createPoll({ cpu: 0, gpu: 0 }, 2000, () => ({ cpu: read(cpuPath), gpu: read(gpuPath) }))

  const row = (name: string, value: Accessor<number>) => (
    <box class="mod-row" spacing={4}>
      <label class="temp-name" label={name} />
      <label
        class={value((c) => `temp-value ${c >= 80 ? "critical" : c >= 65 ? "warning" : ""}`)}
        label={value(degC)}
      />
    </box>
  )

  return (
    <HudButton cls="temperature" onToggle={onToggle}>
      <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
        {row("CPU", temps((t) => t.cpu))}
        {row("GPU", temps((t) => t.gpu))}
      </box>
    </HudButton>
  )
}

/**
 * この環境は NetworkManager ではなく iwd + systemd-networkd を使っているため、
 * libnm ベースの AstalNetwork は何も返さない。iwd の D-Bus を直接見る。
 *
 * iwd は接続中ネットワークのオブジェクトパスの末尾に SSID を 16 進で埋めているので、
 * Station の ConnectedNetwork だけ見れば SSID が復元できる。
 */
function createWifi() {
  const [wifi, setWifi] = createState({ connected: false, ssid: "", iface: "" })

  try {
    const om = Gio.DBusProxy.new_for_bus_sync(
      Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
      "net.connman.iwd", "/", "org.freedesktop.DBus.ObjectManager", null,
    )
    const objects = om
      .call_sync("GetManagedObjects", null, Gio.DBusCallFlags.NONE, -1, null)
      .recursiveUnpack()[0] as Record<string, Record<string, Record<string, unknown>>>

    const stationPath = Object.keys(objects).find((path) => "net.connman.iwd.Station" in objects[path])
    if (!stationPath) return wifi

    const iface = (objects[stationPath]["net.connman.iwd.Device"]?.Name as string) ?? ""
    const station = Gio.DBusProxy.new_for_bus_sync(
      Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
      "net.connman.iwd", stationPath, "net.connman.iwd.Station", null,
    )

    const update = () => {
      const state = station.get_cached_property("State")?.unpack() as string | undefined
      const netPath = station.get_cached_property("ConnectedNetwork")?.unpack() as string | undefined
      const hex = netPath?.split("/").pop()?.split("_")[0] ?? ""
      const bytes = new Uint8Array(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? [])
      setWifi({ connected: state === "connected", ssid: new TextDecoder().decode(bytes), iface })
    }

    update()
    station.connect("g-properties-changed", update)
    onCleanup(() => station.run_dispose())
  } catch (e) {
    console.error("iwd の D-Bus に接続できない:", e)
  }

  return wifi
}

/** /proc/net/wireless の link 品質 (0-70) を % に直す */
function wifiStrength(iface: string): number {
  try {
    const line = readFile("/proc/net/wireless").split("\n").find((l) => l.trim().startsWith(`${iface}:`))
    const link = Number(line?.split(/\s+/).filter(Boolean)[2]?.replace(".", "") ?? 0)
    return Math.round((link / 70) * 100)
  } catch {
    return 0
  }
}

function Network({ onToggle }: { onToggle: (x: number) => void }) {
  const wifi = createWifi()
  const strength = createPoll(0, 5000, () => wifiStrength(wifi.get().iface))

  return (
    <HudButton
      cls={wifi((w) => (w.connected ? "network" : "network disconnected"))}
      onToggle={onToggle}
      tooltip={createComputed(() => {
        const w = wifi()
        return w.connected ? `󰤨 ${w.ssid}\n󱄙 ${strength()}%\n󱂇 ${w.iface}` : "未接続"
      })}
    >
      <box class="mod-row" spacing={5} halign={Gtk.Align.START}>
        <label class="mod-icon" label={wifi((w) => (w.connected ? "󰤨" : "󰤭"))} />
        <label class="mod-value ssid" label={wifi((w) => (w.connected ? w.ssid : "---"))} />
      </box>
    </HudButton>
  )
}

function Volume() {
  const speaker = AstalWp.get_default()!.defaultSpeaker
  const volume = createBinding(speaker, "volume")
  const mute = createBinding(speaker, "mute")

  const icon = (vol: number, muted: boolean) => {
    const dev = speaker.icon ?? ""
    if (muted) return dev.includes("bluetooth") ? "󰂲" : "󰝟"
    if (dev.includes("headphone") || dev.includes("headset")) return "󰋎"
    if (dev.includes("bluetooth")) return "󰂯"
    return pickIcon(["󰕿", "󰖀", "󰕾"], vol)
  }

  return (
    <button
      class={mute((m) => (m ? "volume muted" : "volume"))}
      hasTooltip={false}
      onClicked={() => execAsync(["pavucontrol"]).catch(() => {})}
      $={onVerticalScroll((dy) => {
        speaker.volume = Math.min(1, Math.max(0, speaker.volume - dy * 0.02))
      })}
    >
      <box class="mod-row" spacing={5}>
        <label class="mod-icon" label={createComputed(() => icon(volume(), mute()))} />
        <label class="mod-value" label={createComputed(() => (mute() ? "  --%" : pct(volume() * 100)))} />
      </box>
    </button>
  )
}

/**
 * waybar では scripts/os-info.sh を呼んでいたが、設定ファイル 1 つで完結させたいので
 * ここに畳み込む。ホスト名は GLib から直接取れる。
 */
function Logo() {
  const tooltip = createPoll("", 3_600_000, async () => {
    const sh = (c: string) => execAsync(["bash", "-c", c]).then((o) => o.trim()).catch(() => "-")
    const [kernel, uptime, packages] = await Promise.all([
      sh("uname -r"),
      sh("uptime -p | sed 's/up //'"),
      sh("pacman -Q | wc -l"),
    ])
    return [
      "󰣇 Arch Linux",
      `󰌢 ${GLib.get_host_name()}`,
      `󰒋 ${kernel}`,
      `󰅐 ${uptime}`,
      `󰏖 ${packages} packages`,
    ].join("\n")
  })

  return <label class="logo" label="" tooltipMarkup={tooltip} />
}

/** waybar の scripts/ip-info.sh 相当。設定に畳み込んである */
function Ip() {
  const info = createPoll(
    { v4: "---", v6: "---", host: "-", tooltip: "接続なし" },
    300_000,
    async () => {
      const curl = (args: string[]) => execAsync(["curl", "-s", "--max-time", "5", ...args]).then((o) => o.trim())
      const [v4, v6] = await Promise.all([
        curl(["-4", "icanhazip.com"]).catch(() => ""),
        curl(["-6", "icanhazip.com"]).catch(() => ""),
      ])
      const addr = v4 || v6
      if (!addr) return { v4: "---", v6: "---", host: "-", tooltip: "接続なし" }

      const fields = "query,isp,as,reverse,country,city,mobile,proxy,hosting"
      const j = JSON.parse(await curl([`http://ip-api.com/json/${addr}?fields=${fields}`]))
      const yn = (b: boolean) => (b ? "Yes" : "No")

      return {
        v4: v4 || "---",
        v6: v6 || "---",
        host: j.reverse || "-",
        tooltip: [
          `󰇧 ${j.reverse || "-"}`,
          `󱂇 ${j.as || "-"}`,
          `󰇖 ${j.isp || "-"}`,
          `󰀄 ${j.city || "-"}, ${j.country || "-"}`,
          `󰄜 Mobile: ${yn(j.mobile)}`,
          `󰒍 VPN/Proxy: ${yn(j.proxy)}`,
          `󰒋 Hosting: ${yn(j.hosting)}`,
        ].join("\n"),
      }
    },
  )

  return (
    <box class="ip" tooltipMarkup={info((i) => i.tooltip)} hasTooltip>
      <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
        <box class="mod-row">
          <label class="ip-line" label={info((i) => `4 ${i.v4}`)} halign={Gtk.Align.START} />
        </box>
        <box class="mod-row">
          <label class="ip-line v6" label={info((i) => `6 ${i.v6}`)} halign={Gtk.Align.START} />
        </box>
      </box>
    </box>
  )
}

const NOTIFICATION_ICONS: Record<string, string> = {
  notification: "󰂚",
  none: "󰂜",
  "dnd-notification": "󰂛",
  "dnd-none": "󰪑",
  "inhibited-notification": "󰂚",
  "inhibited-none": "󰂜",
  "dnd-inhibited-notification": "󰂛",
  "dnd-inhibited-none": "󰪑",
}

/**
 * swaync-client -swb はパイプに繋ぐとブロックバッファリングされて流れてこないため、
 * swaync の D-Bus を直接見る。SubscribeV2 シグナルで状態変化が飛んでくる。
 */
function createSwayncState() {
  const [state, setState] = createState({ count: 0, dnd: false, inhibited: false })

  try {
    const cc = Gio.DBusProxy.new_for_bus_sync(
      Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
      "org.erikreider.swaync.cc", "/org/erikreider/swaync/cc", "org.erikreider.swaync.cc", null,
    )

    const [dnd, , count, inhibited] = cc
      .call_sync("GetSubscribeData", null, Gio.DBusCallFlags.NONE, -1, null)
      .recursiveUnpack()[0] as [boolean, boolean, number, boolean]
    setState({ count, dnd, inhibited })

    cc.connect("g-signal", (_p, _sender, signal, params) => {
      if (signal !== "SubscribeV2") return
      const [c, d, , i] = params.recursiveUnpack() as [number, boolean, boolean, boolean]
      setState({ count: c, dnd: d, inhibited: i })
    })
    onCleanup(() => cc.run_dispose())
  } catch (e) {
    console.error("swaync の D-Bus に接続できない:", e)
  }

  return state
}

function Notification() {
  const state = createSwayncState()

  // waybar の format-icons のキーは dnd / inhibited / 通知有無の組み合わせでできている
  const iconKey = (s: { count: number; dnd: boolean; inhibited: boolean }) =>
    [s.dnd ? "dnd" : null, s.inhibited ? "inhibited" : null, s.count > 0 ? "notification" : "none"]
      .filter(Boolean)
      .join("-")

  return (
    <button
      class="notification"
      hasTooltip={false}
      onClicked={() => execAsync(["swaync-client", "-t", "-sw"]).catch(() => {})}
      $={(self: Gtk.Widget) => {
        const rightClick = new Gtk.GestureClick({ button: 3 })
        rightClick.connect("pressed", () => {
          execAsync(["swaync-client", "-d", "-sw"]).catch(() => {})
        })
        self.add_controller(rightClick)
      }}
    >
      <label label={state((s) => NOTIFICATION_ICONS[iconKey(s)] || "󰂜")} />
    </button>
  )
}

/** 外部 API を叩く共通処理。Soup でも書けるが curl のほうが短い */
function fetchJson<T>(url: string): Promise<T> {
  return execAsync(["curl", "-sSL", "--max-time", "10", url]).then((out) => JSON.parse(out) as T)
}

/** WMO の天気コード -> Nerd Font のアイコン */
const WEATHER_ICONS: Record<number, string> = {
  0: "󰖙",
  1: "󰖕", 2: "󰖕", 3: "󰖐",
  45: "󰖑", 48: "󰖑",
  51: "󰖗", 53: "󰖗", 55: "󰖗",
  56: "󰙿", 57: "󰙿",
  61: "󰖖", 63: "󰖖", 65: "󰖖",
  66: "󰙿", 67: "󰙿",
  71: "󰖘", 73: "󰖘", 75: "󰖘", 77: "󰖘",
  80: "󰖖", 81: "󰖖", 82: "󰖖",
  85: "󰖘", 86: "󰖘",
  95: "󰙾", 96: "󰙾", 99: "󰙾",
}

function Weather() {
  const data = createPoll(
    { temp: 0, code: -1, city: "", wind: 0, humidity: 0 },
    900_000,
    async () => {
      const geo = await fetchJson<{ lat: number; lon: number; city: string }>(
        "http://ip-api.com/json/?fields=lat,lon,city",
      )
      const w = await fetchJson<{
        current: { temperature_2m: number; weather_code: number; wind_speed_10m: number; relative_humidity_2m: number }
      }>(
        `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
          "&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto",
      )
      return {
        temp: w.current.temperature_2m,
        code: w.current.weather_code,
        city: geo.city,
        wind: w.current.wind_speed_10m,
        humidity: w.current.relative_humidity_2m,
      }
    },
  )

  return (
    <box
      class="weather"
      tooltipMarkup={data((d) => [`󰍹 ${d.city}`, `󰔏 ${d.temp}°C`, `󰖎 ${d.humidity}%`, `󰈐 ${d.wind} km/h`].join("\n"))}
      hasTooltip
    >
      <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
        <box class="mod-row" spacing={5}>
          <label class="mod-icon" label={data((d) => (d.code < 0 ? "󰼯" : (WEATHER_ICONS[d.code] ?? "󰼯")))} />
          <label class="mod-value" label={data((d) => degC(d.temp))} />
        </box>
        <box class="mod-row" spacing={5}>
          <label class="mod-icon" label="󰖎" />
          <label class="mod-value" label={data((d) => `${String(d.humidity).padStart(3)}%`)} />
        </box>
      </box>
    </box>
  )
}

type Quote = { price: number; change: number }

/** Yahoo Finance の非公式エンドポイント。UA を付けないと弾かれる */
function fetchQuote(symbol: string): Promise<Quote> {
  return execAsync([
    "curl", "-sSL", "--max-time", "10", "-A", "Mozilla/5.0",
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
  ])
    .then((out) => {
      const meta = JSON.parse(out).chart.result[0].meta
      return { price: meta.regularMarketPrice as number, change: meta.regularMarketChangePercent as number }
    })
    .catch(() => ({ price: 0, change: 0 }))
}

/** /proc/net/dev の差分から実効スループットを出す。NM も iwd も出してくれない値 */
function createNetSpeed() {
  let last = { rx: 0, tx: 0, at: 0 }

  return createPoll({ down: 0, up: 0 }, 1000, () => {
    let rx = 0
    let tx = 0
    for (const line of readFile("/proc/net/dev").split("\n").slice(2)) {
      const [rawName, rest] = line.split(":")
      if (!rest) continue
      const name = rawName.trim()
      // 仮想インターフェースは実トラフィックではないので除く
      if (name === "lo" || /^(docker|br-|veth|virbr)/.test(name)) continue
      const f = rest.trim().split(/\s+/).map(Number)
      rx += f[0]
      tx += f[8]
    }

    const at = GLib.get_monotonic_time() / 1e6
    const dt = at - last.at
    const speed =
      last.at > 0 && dt > 0
        ? { down: Math.max(0, (rx - last.rx) / dt), up: Math.max(0, (tx - last.tx) / dt) }
        : { down: 0, up: 0 }
    last = { rx, tx, at }
    return speed
  })
}

/** 単位が変わっても幅が動かないよう 5 文字に固定する */
const fmtBytes = (b: number) =>
  b >= 1e6
    ? `${(b / 1e6).toFixed(1).padStart(4, " ")}M`
    : b >= 1e3
      ? `${String(Math.round(b / 1e3)).padStart(4, " ")}K`
      : `${String(Math.round(b)).padStart(4, " ")}B`

function NetSpeed() {
  const speed = createNetSpeed()
  const down = createHistory(speed((s) => s.down))
  const up = createHistory(speed((s) => s.up))

  return (
    <box class="netspeed mod-row" spacing={12}>
      <box spacing={5}>
        <label class="mod-icon net-down" label="↓" />
        <label class="mod-value net-down" label={speed((s) => fmtBytes(s.down))} />
        <Sparkline values={down} max={5e6} width={38} height={12} rgb={[0, 0.94, 1]} />
      </box>
      <box spacing={5}>
        <label class="mod-icon net-up" label="↑" />
        <label class="mod-value net-up" label={speed((s) => fmtBytes(s.up))} />
        <Sparkline values={up} max={2e6} width={38} height={12} rgb={[1, 0.16, 0.43]} />
      </box>
    </box>
  )
}

/**
 * 「銘柄名 価格 変動率」の 1 行。
 * 3 段に積むので行高 12px。2 段の島 (18px x 2) と合計が揃う。
 */
function quoteRow(name: string, unit: string, q: Accessor<Quote>, decimals = 0) {
  const fmt = (v: number) =>
    decimals > 0
      ? v.toFixed(decimals)
      : Math.round(v).toLocaleString("en-US")

  return (
    <box class="mod-row-sm" spacing={4}>
      <label class="quote-name" label={name} />
      <label
        class="quote-price"
        label={q((v) => (v.price ? `${unit}${fmt(v.price).padStart(7, " ")}` : `${unit}    ---`))}
      />
      <label
        class={q((v) => `quote-change ${v.price === 0 ? "" : v.change >= 0 ? "up" : "down"}`)}
        label={q((v) =>
          v.price === 0 ? "      " : `${v.change >= 0 ? "▲" : "▼"}${Math.abs(v.change).toFixed(2).padStart(5, " ")}%`,
        )}
      />
    </box>
  )
}

function Market() {
  const market = createPoll(
    { n225: { price: 0, change: 0 }, spx: { price: 0, change: 0 }, usd: { price: 0, change: 0 } },
    300_000,
    async () => {
      const [n225, spx, usd] = await Promise.all([fetchQuote("^N225"), fetchQuote("^GSPC"), fetchQuote("JPY=X")])
      return { n225, spx, usd }
    },
  )

  const line = (label: string, q: { price: number; change: number }, unit: string, d = 0) =>
    `${label.padEnd(11)} ${unit}${d ? q.price.toFixed(d) : q.price.toLocaleString("en-US")}  ${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)}%`

  return (
    <box
      class="market"
      hasTooltip
      tooltipMarkup={market((m) =>
        [
          line("NIKKEI 225", m.n225, "¥"),
          line("S&amp;P 500", m.spx, "$"),
          line("USD / JPY", m.usd, "¥", 3),
        ].join("\n"),
      )}
    >
      <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
        {quoteRow("N225", "¥", market((m) => m.n225))}
        {quoteRow("SPX", "$", market((m) => m.spx))}
        {quoteRow("USD", "¥", market((m) => m.usd), 2)}
      </box>
    </box>
  )
}

function Clock({ onToggle }: { onToggle: (x: number) => void }) {
  const tick = createAlignedClock("%s")

  return (
    <HudButton cls="clock" onToggle={onToggle}>
      <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
        <box class="mod-row clock-row-date">
          <label
            class="clock-date"
            label={tick(() => GLib.DateTime.new_now_local().format("%Y-%m-%d %a")!)}
            halign={Gtk.Align.END}
            hexpand
          />
        </box>
        <box class="mod-row clock-row-time">
          <label
            class="clock-time"
            label={tick(() => GLib.DateTime.new_now_local().format("%H:%M:%S")!)}
            halign={Gtk.Align.END}
            hexpand
          />
        </box>
      </box>
    </HudButton>
  )
}

/**
 * SNI トレイ。AstalTray が StatusNotifierWatcher との交渉をやってくれる。
 * waybar が先に Watcher を握っていても Host として登録するので共存できる。
 *
 * menubutton は左クリックでメニューを開くウィジェットなので使えない。
 * SNI の作法では ItemIsMenu が false のとき、左クリックは Activate、
 * 右クリックがコンテキストメニューになる。手元のアイテムは全て false だった。
 */
function TrayItem({ item }: { item: AstalTray.TrayItem }) {
  return (
    <button
      class="tray-item"
      tooltipMarkup={createBinding(item, "tooltipMarkup")}
      onClicked={() => (item.isMenu ? null : item.activate(0, 0))}
      $={(self: Gtk.Widget) => {
        self.insert_action_group("dbusmenu", item.actionGroup)

        let menu: Gtk.PopoverMenu | null = null
        // fcitx5 (Mozc) は notify::menu-model を毎秒 5 回近く飛ばしてくる。
        // その度に set_menu_model を呼ぶと PopoverMenu が内部の GtkStack を
        // 組み直し、同名ページの追加に失敗した分のウィジェットが毎秒 1MB 積もる。
        // 30 分ほどでヒープが 1.7GB に達しメインループが停止した。
        // 通知では dirty を立てるだけにして、実際の再構築はメニューを開く時に遅らせる。
        let dirty = true

        const ensureMenu = () => {
          if (!item.menuModel) {
            menu?.unparent()
            menu = null
            dirty = false
            return
          }
          if (!menu) {
            menu = Gtk.PopoverMenu.new_from_model(item.menuModel)
            menu.set_parent(self)
          } else if (dirty) {
            menu.set_menu_model(item.menuModel)
          }
          dirty = false
        }

        const handler = item.connect("notify::menu-model", () => {
          dirty = true
        })

        const openMenu = () => {
          // dbusmenu の作法。開く直前にアプリ側へ通知して中身を更新させる
          item.about_to_show()
          ensureMenu()
          menu?.popup()
        }

        const rightClick = new Gtk.GestureClick({ button: 3 })
        rightClick.connect("pressed", openMenu)
        self.add_controller(rightClick)

        // ItemIsMenu が true のアイテムは左クリックでもメニューを出す
        if (item.isMenu) {
          const leftClick = new Gtk.GestureClick({ button: 1 })
          leftClick.connect("pressed", openMenu)
          self.add_controller(leftClick)
        }

        onCleanup(() => {
          item.disconnect(handler)
          menu?.unparent()
        })
      }}
    >
      <image gicon={createBinding(item, "gicon")} pixelSize={16} />
    </button>
  )
}

function Tray() {
  const items = createBinding(AstalTray.get_default(), "items")

  return (
    <box class="tray">
      <For each={items} id={(item: AstalTray.TrayItem) => item.itemId}>
        {(item: AstalTray.TrayItem) => <TrayItem item={item} />}
      </For>
    </box>
  )
}

/**
 * waybar の idle_inhibitor は zwp_idle_inhibit_manager_v1 を直接叩いていたが、
 * GJS からは Wayland プロトコルを叩けないので systemd-inhibit を保持して代替する。
 * hypridle が systemd の idle inhibitor を尊重するかは要検証。
 */
function IdleInhibitor() {
  const [active, setActive] = createState(false)
  let held: Process | null = null

  onCleanup(() => held?.kill())

  const toggle = () => {
    if (held) {
      held.kill()
      held = null
      setActive(false)
      return
    }
    held = subprocess([
      "systemd-inhibit", "--what=idle", "--who=ags-bar", "--why=manual toggle",
      "sleep", "infinity",
    ])
    setActive(true)
  }

  return (
    <button class={active((a) => (a ? "idle-inhibitor activated" : "idle-inhibitor"))} onClicked={toggle}>
      <label label={active((a) => (a ? "󰛊" : "󰾪"))} />
    </button>
  )
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
  const [hud, setHud] = createState<HudKind | null>(null)
  const [hudX, setHudX] = createState(0)

  const toggleHud = (kind: HudKind) => (x: number) => {
    setHudX(x)
    setHud((current) => (current === kind ? null : kind))
  }

  return (
    <>
    <window
      visible={hud((h) => h !== null)}
      name="hud"
      class="HudWindow"
      namespace="ags-hud"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      anchor={TOP | LEFT}
      marginTop={6}
      marginLeft={hudX}
      application={app}
    >
      <box class="hud-frame">
        <With value={hud}>
          {(kind: HudKind | null) =>
            kind === "cpu" ? (
              <SystemHud />
            ) : kind === "memory" ? (
              <MemoryHud />
            ) : kind === "network" ? (
              <NetworkHud />
            ) : kind === "clock" ? (
              <ClockHud />
            ) : kind === "battery" ? (
              <BatteryHud />
            ) : kind === "thermal" ? (
              <ThermalHud />
            ) : (
              <box />
            )
          }
        </With>
      </box>
    </window>

    <window
      visible
      name="bar"
      class="Bar"
      namespace="ags-bar"
      keymode={Astal.Keymode.ON_DEMAND}
      gdkmonitor={gdkmonitor}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | LEFT | RIGHT}
      application={app}
    >
      <centerbox
      >
        <box $type="start" spacing={8}>
          <Logo />
          <box class="island workspaces-island" valign={Gtk.Align.CENTER}>
            <Workspaces />
          </box>
        </box>

        <box $type="center" />

        <box $type="end" spacing={8}>
          <box
            class="island island-system"
            orientation={Gtk.Orientation.VERTICAL}
            valign={Gtk.Align.CENTER}
          >
            <Cpu onToggle={toggleHud("cpu")} />
            <Memory onToggle={toggleHud("memory")} />
          </box>
          <box
            class="island island-thermal"
            valign={Gtk.Align.CENTER}
          >
            <Temperature onToggle={toggleHud("thermal")} />
          </box>
          <box
            class="island island-net"
            orientation={Gtk.Orientation.VERTICAL}
            valign={Gtk.Align.CENTER}
          >
            <Network onToggle={toggleHud("network")} />
            <NetSpeed />
          </box>
          <box class="island island-ip" valign={Gtk.Align.CENTER}>
            <Ip />
          </box>
          <box class="island island-power" orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
            <Volume />
            <Battery onToggle={toggleHud("battery")} />
          </box>
          <box class="island island-weather" valign={Gtk.Align.CENTER}>
            <Weather />
          </box>
          <box class="island island-market" valign={Gtk.Align.CENTER}>
            <Market />
          </box>
          <box class="island island-time" valign={Gtk.Align.CENTER}>
            <Clock onToggle={toggleHud("clock")} />
          </box>
          <box class="island island-tray" valign={Gtk.Align.CENTER}>
            <Tray />
            <Notification />
            <IdleInhibitor />
          </box>
        </box>
      </centerbox>
    </window>
    </>
  )
}
