-- Hyprland Configuration (omarchy style)
--
-- 相対パスの require は本ファイルのあるディレクトリを基準に解決される。
-- 読み込み順に意味があるため、ワイルドカードではなく個別に列挙する
-- (workspaces のキャッチオールより後に monitors の個別ルールを置く必要がある)。

require("./conf.d/envs.lua")
require("./conf.d/autostart.lua")
require("./conf.d/input.lua")
require("./conf.d/looknfeel.lua")
require("./conf.d/workspaces.lua")
require("./conf.d/monitors.lua")
require("./conf.d/windows.lua")
require("./conf.d/scratchpad.lua")
require("./conf.d/device.lua")
require("./conf.d/bindings.lua")
