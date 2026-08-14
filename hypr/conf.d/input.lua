-- See https://wiki.hypr.land/Configuring/Basics/Variables/ for more
hl.config({
  input = {
    kb_layout = "us",
    kb_variant = "",
    kb_model = "",
    kb_options = "",
    kb_rules = "",

    follow_mouse = 1,

    touchpad = {
      natural_scroll = true,
      clickfinger_behavior = true,
    },

    sensitivity = 0, -- -1.0 - 1.0, 0 means no modification.
  },
})

hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })
