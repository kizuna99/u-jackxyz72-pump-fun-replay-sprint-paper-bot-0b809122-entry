# MilestoneFlow — Pump.fun Replay Sprint Paper Bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kizuna99/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kizuna99/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the pump.fun bonding-curve replay (`agent-fun/replay/v2`): it speaks the hello / batch / orders protocol on stdin/stdout and trades 10 SOL of paper money. Run it with `node main.ts` (Node 22.18+); the strategy is in `strategy.ts`, the kit SDK shim is vendored at `vendor/makefun-bot.ts`.

## Strategy

MilestoneFlow ignores launches. A curve becomes a candidate only after the market has proven it: its real SOL reserve sits in the 40–82 SOL milestone band, it is at least 200 slots old, and its recent tape still shows committed buying — net inflow over a 40-slot window, buys taking at least 60% of traded SOL from at least 5 distinct wallets, price within 3% of its 120-slot high without being exhausted, and no single recent sell large enough to be a dump in progress.

One buy per position (0.8 SOL, +0.2 SOL when inflow is strong), at most 4 main positions and 4 SOL of exposure. Exits are staged: a hard stop loss on close value, a first take profit that sells half at +45%, a trailing stop for the remainder, flow-fade and big-sell exits, and a 3000-slot time stop waived while the position is comfortably up. Above 84 SOL of reserve the curve is ridden toward completion with only a wide catastrophe stop. An equity guard freezes new entries below 8 SOL and defends below 7 SOL. Tiny probe round trips (0.012 SOL, sold on the next batch) keep the run above the competition's 20-coin round-trip guardrail, paced by block time.

Parameters were chosen over seven measured rounds against a local port of the replay engine on the kit's dev window, preferring the shallowest drawdown and the result least sensitive to the failed-transaction draw over the single best cell. Local dev numbers are not a forecast: the final ranking runs on a different, unseen 24 hours of chain data. The bot is deterministic — no clock, no randomness, no network, no lookahead.
