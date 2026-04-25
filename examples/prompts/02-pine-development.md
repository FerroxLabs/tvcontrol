# Pine Script development with Claude

Pair programming on Pine scripts, using the live TradingView compiler
(server-side, so the editor panel doesn't have to be open for most of this).

---

## "Write me a simple strategy from scratch"

> *Write me a Pine v6 strategy that goes long when RSI(14) crosses above 30
> and exits when it crosses below 70. Compile it with `pine_check` before
> showing it to me. If the compile fails, fix it and re-compile until it's
> green.*

**Tools fired:** `pine_check` (possibly multiple times as Claude iterates)

**Expected:** Claude drafts the script, calls `pine_check`, reads the
`compiled` / `error_count` / `errors` response, and iterates.

**Gotcha:** Claude sometimes returns code without compiling. If the reply
doesn't mention "compiled successfully" or show a `pine_check` result,
push back with "did you actually compile it?"

---

## "Debug my current Pine script"

> *Read my current Pine Editor contents with `pine_get_source`, compile it
> with `pine_smart_compile`, and if there are errors, walk me through each
> one and suggest fixes. Don't rewrite the whole script — just the lines
> that need changing.*

**Tools fired:** `pine_get_source`, `pine_smart_compile`, `pine_get_errors`

**Gotcha:** the Pine Editor panel must be open in the app for these to
work. If Claude says "editor not available," open the Pine Editor from
the bottom dock and retry.

---

## "Inject this script into my editor and compile"

> *Take this Pine code, push it into my editor with `pine_set_source`, run
> `pine_smart_compile`, and tell me whether it's green. If there are errors
> fix them in place and show me the final version.*
>
> ```pine
> //@version=6
> indicator("My Draft", overlay=true)
> length = input.int(20, "Length")
> plot(ta.sma(close, length))
> ```

**Tools fired:** `pine_set_source`, `pine_smart_compile`, `pine_get_errors`

**Expected:** the code ends up in your Pine Editor, compiles, and the
indicator loads on your chart.

---

## "Static analysis only (no TradingView needed)"

> *I've got a Pine script saved at `/tmp/mystrat.pine`. Run `pine_analyze` on
> it and list any bugs the static analyzer catches. Don't try to compile it
> against TradingView.*

**Tools fired:** `pine_analyze`

**Why this is useful:** `pine_analyze` runs locally — no CDP, no TV.
Perfect for CI or pre-commit style checks. Catches things like
out-of-bounds array access, type mismatches, and obvious typos.

---

## "Save the current script to my TradingView account"

> *I've got my current Pine script compiling. Save it to my TradingView
> cloud as "My RSI Strategy v2" using `pine_save`.*

**Tools fired:** `pine_save`

**Gotcha:** `pine_save` sends a Ctrl+S to the Pine Editor, so the editor
panel has to be open and focused. If it fails, ask Claude to open the
Pine Editor panel first (`ui_open_panel` with `panel: "pine-editor"`).

---

## "Iterate on inputs without rewriting"

> *My strategy has a `length` input. Change the input default to 50 by
> editing the source, re-compile with `pine_check`, and show me the diff.
> Don't change anything else.*

**Tools fired:** `pine_get_source`, `pine_check`, `pine_set_source`

Claude will do a minimal edit and re-compile in-place. Good for
quick-iteration parameter tuning without losing your chart state.

---

## Anti-patterns

- **"Compile and save"** without specifying — Claude may call `pine_save`
  before compile is green and overwrite your saved script with a broken
  version. Say "compile first, confirm green, **then** save."
- **"Just fix it"** on a large script — without compile output to ground
  the fix, Claude will guess. Always run `pine_check` or `pine_smart_compile`
  first and paste the errors.
- **Asking for the full source of a complex indicator** — `pine_get_source`
  can return 200 KB of code. Ask for the specific function you care about,
  or a summary of the file.
