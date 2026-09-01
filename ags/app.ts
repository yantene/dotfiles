import app from "ags/gtk4/app"
import { createRoot } from "ags"
import GLib from "gi://GLib"
import type Gdk from "gi://Gdk"
import style from "./style.css"
import Bar from "./widget/bar"

app.start({
  css: style,
  main() {
    /**
     * main() は起動時に一度しか呼ばれないので、ここでモニタ一覧を map しただけだと
     * その後の抜き差しに追従できない。外したモニタの window が残ってレイヤーサーフェスが
     * 他のモニタへ流れ、バーが積み重なる。増設したモニタにはバーが出ない。
     * さらに消えたバーの createPoll がそのまま回り続けるので、枚数分ポーラーが多重化する。
     *
     * App は Gdk.Display の items-changed を notify::monitors に中継してくれるので、
     * それを拾ってモニタごとのバーを張り直す。
     */
    const bars = new Map<Gdk.Monitor, () => void>()

    const sync = () => {
      const current = new Set(app.get_monitors())

      for (const [monitor, destroy] of bars) {
        if (!current.has(monitor)) {
          destroy()
          bars.delete(monitor)
        }
      }

      for (const monitor of current) {
        if (bars.has(monitor)) continue

        createRoot((dispose) => {
          const fragment = Bar(monitor)
          bars.set(monitor, () => {
            // モニタが消えてもレイヤーサーフェスは破棄されず、Hyprland が残った出力へ
            // 付け替えるため、明示的に伏せないとバーが積み重なる。
            // ただし destroy() は gtk_window_destroy の中で SIGSEGV になる
            // (直前に gdk_surface_get_display の GDK_IS_SURFACE アサーションが失敗する)。
            // visible = false ならアンマップだけで済むのでサーフェスを落とせる。
            for (const win of fragment) {
              try {
                win.visible = false
              } catch (e) {
                console.error(`failed to hide bar window: ${e}`)
              }
            }
            dispose()
          })
        })
      }
    }

    sync()

    /**
     * notify::monitors のハンドラ内で同期的に破棄すると、GDK がサーフェスを壊し終える前、
     * かつ g_signal_emit の入れ子の中で window.destroy() を呼ぶことになり、
     * gdk_surface_get_display の GDK_IS_SURFACE アサーション失敗を経て SIGSEGV で落ちた。
     * シグナルから抜けた後の idle にずらして処理する。
     * 抜き差し 1 回で notify が複数回飛ぶため、idle は 1 本だけ保つ。
     */
    let pending = 0
    app.connect("notify::monitors", () => {
      if (pending !== 0) return
      pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        pending = 0
        sync()
        return GLib.SOURCE_REMOVE
      })
    })
  },
})
