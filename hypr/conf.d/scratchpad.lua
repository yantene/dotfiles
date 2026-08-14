-- Scratchpad terminal
--
-- bin/scratchpad (bash + jq) を Lua に統合したもの。
-- ウィンドウ生成待ちの sleep ポーリングは window.open イベントで置き換えている。

local CLASS = "com.ghostty.scratchpad"
local SPECIAL = "special:scratchpad"

-- フォーカス中モニタの 90% x 20%、左右中央・上部 (waybar が確保した領域の下)
local function position(win)
  local monitor = win.monitor or hl.get_monitor_at_cursor()
  if not monitor then
    return
  end

  local monitor_width = monitor.width / monitor.scale
  local monitor_height = monitor.height / monitor.scale

  hl.dispatch(hl.dsp.window.resize({
    x = math.floor(monitor_width * 0.9),
    y = math.floor(monitor_height * 0.2),
    relative = false,
    window = win,
  }))
  hl.dispatch(hl.dsp.window.move({
    x = math.floor(monitor.x + monitor_width * 0.05),
    y = math.floor(monitor.y + (monitor.reserved.top or 0)),
    relative = false,
    window = win,
  }))
end

local function toggle()
  local win = hl.get_windows({ class = CLASS })[1]

  if not win then
    hl.exec_cmd("ghostty --class=" .. CLASS)
    return -- 位置合わせは window.open 側で行う
  end

  local workspace = win.workspace

  if workspace and workspace.special then
    -- 隠れている → 現在のワークスペースへ引き出す
    local current = hl.get_active_workspace()
    if current then
      hl.dispatch(hl.dsp.window.move({ workspace = current.id, follow = false, window = win }))
    end
    hl.dispatch(hl.dsp.focus({ window = win }))
    position(win)
  else
    hl.dispatch(hl.dsp.window.move({ workspace = SPECIAL, follow = false, window = win }))
  end
end

hl.on("window.open", function(win)
  if win and win.class == CLASS then
    position(win)
  end
end)

-- bin/scratchpad-htop から hyprctl eval 経由で呼べるように公開する。
_G.toggle_scratchpad = toggle

return { toggle = toggle }
