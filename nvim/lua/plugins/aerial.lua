return {
  "stevearc/aerial.nvim",
  opts = function(_, opts)
    opts.backends = {
      ["_"] = { "treesitter", "lsp", "man" },
      markdown = { "markdown", "lsp" },
      quarto = { "markdown", "lsp" },
    }
    return opts
  end,
}
