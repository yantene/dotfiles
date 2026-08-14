-- Key Bindings Configuration (omarchy style with vim navigation)
-- See https://wiki.hypr.land/Configuring/Basics/Binds/

local mainMod = "SUPER"

-- hl.env() で設定した値は Lua 側からは参照できないため、ここで同等に組み立てる。
local config_home = os.getenv("XDG_CONFIG_HOME") or ((os.getenv("HOME") or "") .. "/.config")
local hypr_bin = config_home .. "/hypr/bin"

local scratchpad = require("./conf.d/scratchpad.lua")

-- Hyprland controls
hl.bind(mainMod .. " + SHIFT + Q", hl.dsp.exit(), { description = "Exit Hyprland" })
hl.bind(mainMod .. " + SHIFT + M", hl.dsp.exec_cmd(hypr_bin .. "/sysop"), { description = "System operations menu" })

-- Window operations
hl.bind(mainMod .. " + W", hl.dsp.window.close(), { description = "Close window" })
hl.bind(mainMod .. " + SHIFT + C", hl.dsp.window.close(), { description = "Close window" })
hl.bind(mainMod .. " + SHIFT + F", hl.dsp.window.fullscreen({ mode = "fullscreen" }), { description = "Toggle fullscreen" })
hl.bind(mainMod .. " + SHIFT + G", hl.dsp.window.float({ action = "toggle" }), { description = "Toggle floating" })
hl.bind(mainMod .. " + SHIFT + V", hl.dsp.layout("togglesplit"), { description = "Toggle split direction" })
hl.bind(mainMod .. " + SHIFT + B", hl.dsp.window.pseudo(), { description = "Toggle pseudo tiling" })

-- Application launchers
hl.bind(mainMod .. " + E", hl.dsp.exec_cmd("nautilus"), { description = "Open file manager" })
hl.bind(mainMod .. " + D", hl.dsp.exec_cmd("wofi --show drun"), { description = "Application launcher" })
hl.bind(mainMod .. " + SHIFT + RETURN", hl.dsp.exec_cmd("ghostty"), { description = "Open terminal" })
hl.bind(mainMod .. " + RETURN", scratchpad.toggle, { description = "Toggle scratchpad terminal" })

-- Volume control with swayosd
hl.bind("XF86AudioMute", hl.dsp.exec_cmd("swayosd-client --output-volume mute-toggle"), { description = "Toggle mute" })
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("swayosd-client --output-volume lower"), { description = "Volume down" })
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("swayosd-client --output-volume raise"), { description = "Volume up" })
hl.bind("XF86AudioMicMute", hl.dsp.exec_cmd("swayosd-client --input-volume mute-toggle"), { description = "Toggle microphone mute" })

-- Notification panel (ThinkPad F9)
hl.bind("XF86NotificationCenter", hl.dsp.exec_cmd("swaync-client -t"), { description = "Toggle notification panel" })

-- Screen brightness control with swayosd
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("swayosd-client --brightness raise"), { description = "Brightness up" })
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("swayosd-client --brightness lower"), { description = "Brightness down" })

-- Screenshot (grim + slurp)
hl.bind("Print", hl.dsp.exec_cmd([[bash -c 'slurp | grim -g - - | wl-copy && notify-send "Screenshot" "Region captured"']]),
  { description = "Screenshot region" })
hl.bind("SHIFT + Print",
  hl.dsp.exec_cmd([[bash -c 'hyprctl activewindow -j | jq -r "\"\\(.at[0]),\\(.at[1]) \\(.size[0])x\\(.size[1])\"" | grim -g - - | wl-copy && notify-send "Screenshot" "Window captured"']]),
  { description = "Screenshot focused window" })
hl.bind("CTRL + Print", hl.dsp.exec_cmd([[bash -c 'grim - | wl-copy && notify-send "Screenshot" "Screen captured"']]),
  { description = "Screenshot current monitor" })
hl.bind("CTRL + SHIFT + Print",
  hl.dsp.exec_cmd([[bash -c 'region=$(slurp) && sleep 5 && grim -g "$region" - | wl-copy && notify-send "Screenshot" "Region captured"']]),
  { description = "Screenshot region (5s delay)" })

-- Color picker
hl.bind(mainMod .. " + SHIFT + X", hl.dsp.exec_cmd("hyprpicker -a"), { description = "Pick color to clipboard" })

-- Focus / move / resize with vim keys (hjkl)
local directions = {
  { key = "H", name = "left", dir = "l", dx = -1, dy = 0 },
  { key = "L", name = "right", dir = "r", dx = 1, dy = 0 },
  { key = "K", name = "up", dir = "u", dx = 0, dy = -1 },
  { key = "J", name = "down", dir = "d", dx = 0, dy = 1 },
}

for _, d in ipairs(directions) do
  hl.bind(mainMod .. " + " .. d.key, hl.dsp.focus({ direction = d.dir }),
    { description = "Move focus " .. d.name })
  hl.bind(mainMod .. " + SHIFT + " .. d.key, hl.dsp.window.move({ direction = d.dir }),
    { description = "Move window " .. d.name })
  hl.bind(mainMod .. " + CTRL + " .. d.key, hl.dsp.window.resize({ x = d.dx * 50, y = d.dy * 50, relative = true }),
    { description = "Resize " .. d.name })
  hl.bind(mainMod .. " + CTRL + SHIFT + " .. d.key, hl.dsp.window.resize({ x = d.dx * 10, y = d.dy * 10, relative = true }),
    { description = "Resize " .. d.name .. " (fine)" })
end

-- Switch to / move window to workspaces 1-14
local workspace_keys = { "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "U", "I", "O", "P" }

for i, key in ipairs(workspace_keys) do
  hl.bind(mainMod .. " + " .. key, hl.dsp.focus({ workspace = i }),
    { description = "Switch to workspace " .. i })
  hl.bind(mainMod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = i }),
    { description = "Move to workspace " .. i })
end

-- Navigate workspaces
hl.bind(mainMod .. " + Z", hl.dsp.focus({ workspace = "e-1" }), { description = "Previous workspace" })
hl.bind(mainMod .. " + C", hl.dsp.focus({ workspace = "e+1" }), { description = "Next workspace" })
hl.bind(mainMod .. " + TAB", hl.dsp.focus({ workspace = "previous" }), { description = "Switch to previous workspace" })

-- Special workspace (scratchpad)
hl.bind(mainMod .. " + S", hl.dsp.workspace.toggle_special("magic"), { description = "Toggle scratchpad" })
hl.bind(mainMod .. " + SHIFT + S", hl.dsp.window.move({ workspace = "special:magic" }), { description = "Move to scratchpad" })

-- Mouse bindings
hl.bind(mainMod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }), { description = "Next workspace (scroll)" })
hl.bind(mainMod .. " + mouse_up", hl.dsp.focus({ workspace = "e-1" }), { description = "Previous workspace (scroll)" })
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })
