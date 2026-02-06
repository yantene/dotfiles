#!/bin/bash

v4=$(curl -4s --max-time 3 icanhazip.com 2>/dev/null)
v6=$(curl -6s --max-time 3 icanhazip.com 2>/dev/null)
ip=${v4:-$v6}

if [ -z "$ip" ]; then
  printf '{"text":"-","tooltip":"No connection"}'
  exit 0
fi

info=$(curl -s --max-time 5 "http://ip-api.com/json/$ip?fields=query,isp,as,reverse,country,city,mobile,proxy,hosting")

query=$(echo "$info" | jq -r '.query // "-"')
isp=$(echo "$info" | jq -r '.isp // "-"')
as=$(echo "$info" | jq -r '.as // "-"')
rev=$(echo "$info" | jq -r '.reverse // "-"')
country=$(echo "$info" | jq -r '.country // "-"')
city=$(echo "$info" | jq -r '.city // "-"')
mobile=$(echo "$info" | jq -r 'if .mobile then "Yes" else "No" end')
proxy=$(echo "$info" | jq -r 'if .proxy then "Yes" else "No" end')
hosting=$(echo "$info" | jq -r 'if .hosting then "Yes" else "No" end')

tooltip="󰩟 ${v4:--}
󰩟 ${v6:--}
󰇧 $rev
󱂇 $as
󰇖 $isp
󰀄 $city, $country
󰄜 Mobile: $mobile
󰒍 VPN/Proxy: $proxy
󰒋 Hosting: $hosting"

# JSON エスケープ
tooltip=$(printf '%s' "$tooltip" | jq -Rs .)

printf '{"text":"%s","alt":"%s","tooltip":%s}' "$rev" "$query" "$tooltip"
