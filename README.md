# Squeeze screenshots into the smallest PNG — a lossless re-encoder

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Sasikianlarasati/png-squeeze-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Sasikianlarasati/png-squeeze-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for make.fun's **"Squeeze screenshots into the smallest PNG"** bounty ($100):
one Node program, `main.ts` at the repository root, that answers every instance of
a set — eight 1280×720 RGBA screenshots — by writing each one again as a PNG,
losslessly, in as few bytes as it can.

## How it works

For each screenshot `main.ts` decodes the stored input PNG, looks at what it
holds, and then tries every lossless form that can carry the pixels exactly:

- **Colour form:** a palette when the image has at most 256 colours (three entry
  orderings — most-used first, darkest first, first-seen first — with
  transparent entries first so `tRNS` stays short); grey or grey+alpha when
  every pixel is grey; RGB when opaque; RGBA otherwise; and a `tRNS` key when a
  single transparent colour is the only non-opaque value, so the alpha channel
  can be dropped entirely.
- **Filters:** one fixed filter for all rows, per-row minimum-sum, and per-row
  brute force, where each of the five filters is weighed by a real deflate of
  that row against the 32 KiB written before it.
- **Deflate:** every plan is screened with zlib level 6, the smallest file wins,
  and the winner is re-deflated at level 9 under two strategies.

The output PNG holds only `IHDR`, `PLTE`, `tRNS`, `IDAT` and `IEND`, bit depth
8, one zlib stream, every CRC correct. If anything unexpected happens for an
instance, it falls back to plain RGBA with a Paeth filter on every row at
level 9, so the instance is still answered. Everything is deterministic — no
clock, no randomness — so two executions write the same bytes.

## Practice-set result (kit's scorer, 8 instances)

| | Score (of 1,000,000) |
|---|---:|
| This entry | **704,887** |
| make.fun's scale compressor | 666,661 |
| House baseline, fixed-paeth 1.0.0 | 420,399 |

Runtime on the practice set: about 18 seconds of the 60-second wall budget.
