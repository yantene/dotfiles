#!/bin/bash

# OS情報を取得
distro="Arch Linux"
kernel=$(uname -r)
hostname=$(hostname)
uptime=$(uptime -p | sed 's/up //')
packages=$(pacman -Q | wc -l)

# Archロゴ (Nerd Fonts U+F303)
icon=$'\uf303'

# JSON形式で出力
printf '{"text": "%s", "tooltip": "󰣇 %s\\n󰌢 %s\\n󰒋 %s\\n󰅐 %s\\n󰏖 %s packages"}' \
  "$icon" "$distro" "$hostname" "$kernel" "$uptime" "$packages"
