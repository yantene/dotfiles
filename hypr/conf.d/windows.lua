-- Window Rules
-- See https://wiki.hypr.land/Configuring/Basics/Window-Rules/
--
-- ルールは上から順に評価され、後にマッチしたものが優先される。

-- Default opacity for all windows
hl.window_rule({ match = { class = ".*" }, opacity = "0.97 0.9" })

-- クラスで float させるもの
local float_classes = {
  "pavucontrol",
  "blueman-manager",
  "nm-connection-editor",
  "xdg-desktop-portal-gtk",
  "org\\.gnome\\.Settings",
  "org\\.gnome\\.Calculator",
  "file-roller",
}

for _, class in ipairs(float_classes) do
  hl.window_rule({ match = { class = "^(" .. class .. ")$" }, float = true })
end

-- タイトルで float させるもの (ダイアログ・ユーティリティ窓)
local float_titles = {
  "Picture-in-Picture",
  "ピクチャー イン ピクチャー",
  "Open File",
  "Open Folder",
  "Save As",
  "ファイルを開く",
  "フォルダーを開く",
  "名前を付けて保存",
  "About",
}

for _, title in ipairs(float_titles) do
  hl.window_rule({ match = { title = "^(" .. title .. ")$" }, float = true })
end

-- Center floating windows
hl.window_rule({ match = { float = true, class = "^(Code)$" }, center = true })

-- Terminal transparency
hl.window_rule({ match = { class = "^(com\\.mitchellh\\.ghostty)$" }, opacity = "0.9" })

-- Scratchpad terminal (Super-Enter)
-- サイズと位置は conf.d/scratchpad.lua が waybar の reserved 領域を見て決めるため、
-- ここでは指定しない。
hl.window_rule({
  match = { class = "^(com\\.ghostty\\.scratchpad)$" },
  float = true,
  animation = "slidefadevert -100%",
})
