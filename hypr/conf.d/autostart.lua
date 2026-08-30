-- Autostart Applications
-- See https://wiki.hypr.land/Configuring/Basics/Autostart/

hl.on("hyprland.start", function()
  -- Core services
  hl.exec_cmd("dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP")

  -- Polkit authentication agent
  hl.exec_cmd("/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1")

  -- Status bar
  -- waybar から AGS (~/.config/ags) へ移行。戻す場合は下の行を入れ替える
  -- hl.exec_cmd("waybar")
  hl.exec_cmd("ags run")

  -- Input method
  hl.exec_cmd("fcitx5")

  -- Idle daemon
  hl.exec_cmd("hypridle")

  -- OSD (on-screen display)
  hl.exec_cmd("swayosd-server")
end)
