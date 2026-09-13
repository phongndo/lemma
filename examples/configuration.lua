local lemma = require("lemma")
local keymap = lemma.keymap
local ctx = lemma.context

lemma.setup({
  input = { preset = "default", prefix = "C-b" },
  terminal = { scrollback_lines = 100000 },
  ui = { status_line = true },
  launch = { default_program = { "/bin/sh", "-l" } },
})

ctx.set("resize", {
  label = "RESIZE",
  lifetime = "persistent",
  unbound = "consume",
})

keymap.set("normal", "M-d", "split_left_right")
keymap.set("normal", "M-r", ctx.push("resize"))
keymap.set("resize", "q", ctx.pop())
keymap.del("normal", "Cmd-c")
