# Graduation sprint

This bot trades only SOL pump.fun bonding curves that are already in a fast launch burst. A coin becomes eligible when at least 60% of the initial real-token reserve has been sold (`1 - real_token_reserves / 793.1e12`) and all observed trades so far occurred in the same slot. The one-slot filter is deliberate: in the published dev window, this subset was much more predictive of a completed graduation than slow, multi-slot accumulation.

On an eligible trade the bot buys up to 0.5 SOL, limited by the replay's 1% per-curve reserve cap. It will not buy dust, exceed the five-position cap, double-submit a pending buy, or open new positions during a 30% equity drawdown. Buys allow 20% replay slippage because the fill is two slots later.

The position exits on the first of: eight subsequent trades, a 30% marked profit, or a 40% marked loss. A complete curve is left to the harness's normal close. Sells are whole-position orders and allow 50% slippage. Every decision is a pure function of the hello/batch/mark state; there is no clock, network, or random source.
