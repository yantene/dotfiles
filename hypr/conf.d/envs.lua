-- Environment Variables
-- See https://wiki.hypr.land/Configuring/Advanced-and-Cool/Environment-variables/

local home = os.getenv("HOME") or ""
local runtime_dir = os.getenv("XDG_RUNTIME_DIR") or ""

-- XDG
hl.env("XDG_SESSION_TYPE", "wayland")
hl.env("XDG_SESSION_DESKTOP", "hyprland")
hl.env("XDG_CONFIG_HOME", home .. "/.config")
hl.env("XDG_CACHE_HOME", home .. "/.cache")
hl.env("XDG_DATA_HOME", home .. "/.local/share")

-- Wayland support for applications
hl.env("MOZ_ENABLE_WAYLAND", "1")
hl.env("QT_QPA_PLATFORM", "wayland")
hl.env("SDL_VIDEODRIVER", "wayland")
hl.env("_JAVA_AWT_WM_NONREPARENTING", "1")
hl.env("ELECTRON_OZONE_PLATFORM_HINT", "auto")

-- Theming
hl.env("GTK2_RC_FILES", home .. "/.gtkrc-2.0")
hl.env("QT_QPA_PLATFORMTHEME", "qt5ct")

-- Input method
hl.env("XMODIFIERS", "@im=fcitx")

-- Cursor
hl.env("HYPRLAND_LOG_WLR", "1")
hl.env("X_CURSOR_THEME", "Bibata-Modern-Classic")
hl.env("XCURSOR_SIZE", "24")

-- SSH
hl.env("SSH_AUTH_SOCK", runtime_dir .. "/ssh-agent.socket")

-- Editor
hl.env("EDITOR", "/usr/bin/nvim")
