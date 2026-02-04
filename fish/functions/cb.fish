function cb
  # Avoid the fish builtin test command
  # https://github.com/fish-shell/fish-shell/issues/3792
  if command test -p /dev/stdin -o -f /dev/stdin
    # copy
    if type -q wl-copy
      wl-copy
    else if type -q xclip
      xclip -selection clipboard
    end
  else
    # paste
    if type -q wl-paste
      wl-paste
    else if type -q xclip
      xclip -o -selection clipboard
    end
  end
end
