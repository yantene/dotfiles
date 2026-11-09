#!/usr/bin/env bash
# Claude Code の状況を、中身の分かるデスクトップ通知にする。
# 承認待ち・質問待ち・完了・エラー・push/マージで通知する。
# herdr の中なら、ワークスペース名と作業内容を添え、「開く」でその Claude のペインに移る。
# Ghostty にフォーカスがあり、herdr でそのペインを表示しているときは黙る。
# herdr の外なら、作業ディレクトリ名を添え、「開く」でその Claude を動かしている端末のウィンドウに移る。
# 受け取った入力は ~/.cache/claude-notify/<イベント名>.json に残す (イベントの中身の確認用)。

input="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0

# サブエージェントのイベントは通知しない
[ -n "$(jq -r '.agent_id // empty' <<<"$input")" ] && exit 0

event="$(jq -r '.hook_event_name // empty' <<<"$input")"

# 親をたどり、Hyprland のウィンドウを持つプロセス (端末) の PID を探す
find_window_pid() {
  local pids p
  pids="$(hyprctl clients -j 2>/dev/null | jq -r '.[].pid')" || return
  p=$PPID
  while [ "${p:-0}" -gt 1 ]; do
    grep -qx "$p" <<<"$pids" && { echo "$p"; return; }
    p="$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)"
  done
}

# hook はすぐ返す。通知は setsid で切り離した自分自身 (--deliver) が出す
# notify-send -A はクリックされるまで戻らず、hook のプロセスごと片付けられると「開く」が効かなくなる
# 切り離すと親をたどれなくなるため、端末の PID はここで調べて渡す
if [ "${1:-}" != --deliver ]; then
  log_dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-notify"
  mkdir -p "$log_dir" && printf '%s\n' "$input" >"$log_dir/${event:-unknown}.json"
  [ "${HERDR_ENV:-}" = 1 ] || export NOTIFY_WINDOW_PID="$(find_window_pid)"
  setsid -f bash "$0" --deliver <<<"$input" >/dev/null 2>&1
  exit 0
fi

notify() {
  session_id="$(jq -r '.session_id // empty' <<<"$input")"
  tool="$(jq -r '.tool_name // empty' <<<"$input")"

  case "$event" in
    PermissionRequest)
      # AskUserQuestion は PreToolUse の質問待ちで通知する
      [ "$tool" = AskUserQuestion ] && return
      kind=wait
      label="承認待ち: $tool"
      detail="$(jq -r '.tool_input | .command // .file_path // .url // .pattern // .description // (tostring)' <<<"$input")"
      ;;
    PreToolUse)
      [ "$tool" = AskUserQuestion ] || return
      kind=wait
      label="質問待ち"
      detail="$(jq -r '.tool_input.questions[0] | .question + "\n" + ([.options[]?.label] | map("・" + .) | join("\n"))' <<<"$input")"
      ;;
    Notification)
      kind=wait
      label="入力待ち"
      detail="$(jq -r '.message // empty' <<<"$input")"
      ;;
    Stop)
      kind=done
      label="完了"
      detail="$(jq -r '.last_assistant_message // empty' <<<"$input")"
      ;;
    StopFailure)
      kind=error
      label="エラーで停止"
      detail="$(jq -r '.error_type // .error // .reason // .message // empty' <<<"$input")"
      ;;
    PostToolUse)
      command="$(jq -r '.tool_input.command // empty' <<<"$input")"
      grep -qE '\bgit\s+push\b|\bgh\s+pr\s+merge\b' <<<"$command" || return
      [ "$(jq -r '.tool_response.interrupted // false' <<<"$input")" = true ] && return
      kind=ship
      if grep -qE '\bgh\s+pr\s+merge\b' <<<"$command"; then label="PR をマージした"; else label="push した"; fi
      detail="$command"
      ;;
    *) return ;;
  esac

  # herdr の中なら、session_id から herdr のペインを引く。移動したペインは環境変数の HERDR_PANE_ID が古いまま残るため
  # 引けなければ herdr の外と同じ扱いにする
  agent=""
  if [ "${HERDR_ENV:-}" = 1 ]; then
    agent="$(herdr agent list 2>/dev/null | jq -c --arg sid "$session_id" '[.result.agents[]? | select(.agent_session.value == $sid)][0] // empty')"
  fi

  active_class="$(hyprctl activewindow -j 2>/dev/null | jq -r '.class // empty')"
  if [ -n "$agent" ]; then
    pane_id="$(jq -r '.pane_id' <<<"$agent")"
    workspace_id="$(jq -r '.workspace_id' <<<"$agent")"
    focused="$(jq -r '.focused' <<<"$agent")"
    activity="$(jq -r '.terminal_title_stripped // empty' <<<"$agent")"
    place="$(herdr workspace get "$workspace_id" 2>/dev/null | jq -r '.result.workspace.label // empty')"

    # Ghostty にフォーカスがあり、herdr でこのペインを表示しているなら、見ているので黙る
    [ "$active_class" = com.mitchellh.ghostty ] && [ "$focused" = true ] && return
  else
    # herdr の外では、端末のどのタブを見ているかまでは分からないので、黙らずに出す
    activity=""
    place="$(basename "$(jq -r '.cwd // empty' <<<"$input")")"
  fi

  case "$kind" in
    wait) urgency=critical; sound=dialog-warning ;;
    error) urgency=critical; sound=dialog-error ;;
    ship) urgency=normal; sound=complete ;;
    *) urgency=normal; sound=complete ;;
  esac

  # 本文は Pango markup。切り詰めは変換前に行い、タグや実体参照を途中で切らないようにする
  body="$(sed -E \
    -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/^#{1,6} +(.*)$/<b>\1<\/b>/' \
    -e 's/\*\*([^*]+)\*\*/<b>\1<\/b>/g' \
    -e 's/`([^`]+)`/<tt>\1<\/tt>/g' \
    -e 's/\*\*//g' -e 's/`//g' \
    -e 's/^([[:space:]]*)[-*] /\1• /' \
    -e '/^[[:space:]]*$/d' <<<"${detail:0:300}")"
  if [ -n "$activity" ]; then
    activity_markup="$(sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$activity")"
    body="$body"$'\n'"<i>作業: $activity_markup</i>"
  fi

  canberra-gtk-play -i "$sound" >/dev/null 2>&1 &
  action="$(timeout 600 notify-send -a "Claude Code" -u "$urgency" -i claude-desktop \
    -A default=開く -A open=開く "[${place:-Claude}] $label" "$body" 2>/dev/null)"
  # default は通知の本体のクリック、open はボタン
  [ "$action" = open ] || [ "$action" = default ] || return
  if [ -n "$agent" ]; then
    herdr agent focus "$pane_id" >/dev/null 2>&1
    hyprctl dispatch focuswindow class:com.mitchellh.ghostty >/dev/null 2>&1
  elif [ -n "${NOTIFY_WINDOW_PID:-}" ]; then
    hyprctl dispatch focuswindow "pid:$NOTIFY_WINDOW_PID" >/dev/null 2>&1
  fi
}

notify </dev/null >/dev/null 2>&1
exit 0
