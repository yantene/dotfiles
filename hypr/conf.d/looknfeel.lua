-- Look and Feel Configuration (omarchy style)
-- See https://wiki.hypr.land/Configuring/Basics/Variables/

hl.config({
  general = {
    gaps_in = 4,
    gaps_out = 8,
    border_size = 2,
    col = {
      -- ags バーと同じシアン。フォーカス中はマゼンタへのグラデーション。
      -- Lua 設定では "色 色 角度" の文字列ではなく colors 配列で渡す
      active_border = { colors = { "rgba(00f0ffee)", "rgba(ff2a6dcc)" }, angle = 45 },
      inactive_border = "rgba(14303aee)",
    },
    layout = "dwindle",
  },

  decoration = {
    -- ags バーの島 (8px) に合わせる
    rounding = 8,

    blur = {
      enabled = true,
      size = 3,
      passes = 2,
    },

    shadow = {
      enabled = true,
      range = 12,
      render_power = 3,
      color = "rgba(00f0ff33)",
      color_inactive = "rgba(00000055)",
    },
  },

  animations = {
    enabled = true,
  },

  dwindle = {
    preserve_split = true,
    force_split = 2,
  },

  misc = {
    disable_hyprland_logo = true,
    disable_splash_rendering = true,
    background_color = "rgb(05080f)",
    vrr = 2,
    focus_on_activate = true,
    animate_manual_resizes = true,
    animate_mouse_windowdragging = false,
  },

  cursor = {
    hide_on_key_press = true,
    no_hardware_cursors = true,
  },

  -- カラーマネジメント無効化 (モニタ切替時のクラッシュ回避 GitHub #12871)
  render = {
    cm_enabled = false,
  },
})

-- omarchy style bezier curves
hl.curve("easeOutQuint", { type = "bezier", points = { { 0.22, 1 }, { 0.36, 1 } } })
hl.curve("easeInOutQuint", { type = "bezier", points = { { 0.83, 0 }, { 0.17, 1 } } })
hl.curve("easeInQuint", { type = "bezier", points = { { 0.64, 0 }, { 0.78, 0 } } })
hl.curve("overshot", { type = "bezier", points = { { 0.05, 0.9 }, { 0.1, 1.1 } } })

hl.animation({ leaf = "windows", enabled = true, speed = 4, bezier = "easeOutQuint", style = "popin 80%" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 4, bezier = "easeInQuint", style = "popin 80%" })
hl.animation({ leaf = "windowsMove", enabled = true, speed = 3, bezier = "easeInOutQuint" })
hl.animation({ leaf = "border", enabled = true, speed = 5, bezier = "easeOutQuint" })
hl.animation({ leaf = "borderangle", enabled = true, speed = 5, bezier = "easeOutQuint" })
hl.animation({ leaf = "fade", enabled = true, speed = 3, bezier = "easeOutQuint" })
hl.animation({ leaf = "workspaces", enabled = true, speed = 4, bezier = "easeInOutQuint", style = "slide" })
hl.animation({ leaf = "specialWorkspace", enabled = true, speed = 4, bezier = "easeOutQuint", style = "slidefadevert -20%" })
hl.animation({ leaf = "layers", enabled = true, speed = 3, bezier = "easeOutQuint", style = "fade" })

-- Smart gaps: ウィンドウが 1 つだけの場合はギャップ・角丸・ボーダーなし
hl.workspace_rule({ workspace = "w[tv1]", gaps_out = 0, gaps_in = 0, no_border = true, no_rounding = true })
hl.workspace_rule({ workspace = "f[1]", gaps_out = 0, gaps_in = 0, no_border = true, no_rounding = true })
